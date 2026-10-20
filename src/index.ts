/**
 * Pins multiple ScrollTrigger effects with native position:sticky instead of GSAP pinning, by
 * wrapping the shared container in nested sticky layers. This is the only public entry point;
 * every other module under src/ is internal.
 */

import {
  applyStickyPosition,
  captureInlinePosition,
  describeElement,
  documentTop,
  liftAboveStickyWrapper,
  measureDocumentHeightWithoutPinRanges,
  measureDocumentMaxScroll,
  measureUsedHeight,
  measureViewportHeight,
  resetStickyPosition,
  resolveElement,
  resolveEndTrigger,
  resolveRoot,
  restoreInlinePosition,
  stripStickyPositions,
  unwrapPin,
  wrapPin,
} from './dom';
import {
  clearDormancy,
  isWebKit,
  rebuildDormancy,
  registerDormancyClient,
  takeGsapRefreshRestore,
  releaseDormant,
  unregisterDormancyClient,
} from './dormancy';
import type { DormancyClient, ScrollTriggerClassLike } from './dormancy';
import { createScrollMarginSync } from './scrollMargin';
import { buildStructure, isDomOrderStale, unbuildCover, unbuildStructure } from './structure';
import {
  dwellBeforeReach,
  dwellConsumedAt,
  planLayers,
  TIE_TOLERANCE_PX,
} from './freezeWindow';
import type { LayerMeasurement } from './freezeWindow';
import { measureLayer } from './measure';
import {
  classifyPosition,
  prefixSpacedRelativeEnd,
  resolveAnchorTop,
  resolveDwell,
  resolveMaxOffset,
  resolveMaybeFn,
} from './position';
import type { ClassifiedPosition, PositionInput } from './position';
import { EXCLUDED_VAR_KEYS } from './vars';
import type {
  CoverLayer,
  CreateOverlapScrollOptions,
  CreateResolvedTriggerOptions,
  CreateStickyPinOptions,
  CreateStickyTriggerOptions,
  Layer,
  PinLayer,
  StickyScrollTriggerOptions,
} from './types';

export type {
  CreateOverlapScrollOptions,
  CreateResolvedTriggerOptions,
  CreateStickyPinOptions,
  CreateStickyTriggerOptions,
  StickyScrollTriggerOptions,
} from './types';
export type { EndInput, EndValue, PositionInput } from './position';
export type { NestedStickyOptimization } from './dormancy';

// createStickyPin's `top`, converted into the clause form that everything downstream works with.
// Why it's a separate option at all: see the rejection in #refreshPinLayers.
const topToStartClause = (top: number | (() => number)): PositionInput => {
  const toClause = (value: number): string => {
    if (!Number.isFinite(value)) {
      throw new Error(
        `StickyScrollTrigger: createStickyPin's top must be a finite number, got ${value}.`,
      );
    }

    return `top ${value}px`;
  };

  return typeof top === 'function' ? () => toClause(top()) : toClause(top);
};

// Converts createStickyPin's resolved end into the absolute scroll position where the pin lets go.
// engageScroll is where position:sticky takes hold, which a dwell counts from, the same as a Scene
// layer's freezeStart (freezeWindow.ts's EndSpec). toScroll turns an element's natural reach
// point into the scroll that really gets it there. Each form is read the way GSAP reads it:
// - a dwell ('+=400', '+=100%', the latter against the viewport): that distance past engageScroll,
//   with endTrigger ignored. Only a value that both starts with '+=' and holds no space is one, so
//   an ordinary clause carrying an offset ('bottom top+=40') resolves against endTrigger below, as
//   does the spaced '+=' form once prefixSpacedRelativeEnd has given it the start's element token.
// - an absolute scroll position (a bare number): that position, independent of engageScroll and
//   endTrigger alike. Same idea as an absolute start for Scene/Cover layers (see measure.ts's
//   resolveStartSpec).
// - a position clause: where endTrigger's own side reaches the viewport's.
// classifiedEnd excludes 'max' rather than handling it, because #refreshPinLayers rejects that
// first. The exclusion makes that rejection a precondition the compiler checks. A 'max'
// branch here would instead be dead code that starts running if the caller ever moves its throw.
const resolvePinReleaseScroll = (
  endTrigger: HTMLElement,
  classifiedEnd: Exclude<ClassifiedPosition, { kind: 'max' }>,
  engageScroll: number,
  viewportHeight: number,
  toScroll: (element: HTMLElement, reachedAt: number) => number,
): number => {
  switch (classifiedEnd.kind) {
    case 'dwell':
      return engageScroll + resolveDwell(classifiedEnd.value, viewportHeight);

    case 'absolute':
      return classifiedEnd.value;

    case 'clause':
      return toScroll(
        endTrigger,
        documentTop(endTrigger)
        - resolveAnchorTop(classifiedEnd.value, measureUsedHeight(endTrigger), viewportHeight),
      );
  }
};

// What this module reads off the captured ScrollTrigger class.
type ScrollTriggerClass = {
  refresh(safe?: boolean): void;
  getScrollFunc?(element: Window): unknown;
  isScrolling?(): boolean;
  isUpdating?: unknown;
} & ScrollTriggerClassLike;

const removeItem = <T>(list: T[], item: T): void => {
  const index = list.indexOf(item);

  if (index !== -1) list.splice(index, 1);
};

// The content at the viewport's top edge: where it sits in the unpadded layout, and how much of
// each Scene layer's dwell the scroll has gone through to get there.
type ContentPosition = {
  natural: number;
  // By trigger, unique among the layers registered at a time. Infinity for a freeze the scroll
  // is past.
  consumed: Map<HTMLElement, number>;
};

// Shared by the layer and pin registration paths, which both reject an already-registered trigger.
const hasDuplicateTrigger = (
  list: readonly { trigger: HTMLElement }[],
  trigger: HTMLElement,
): boolean => list.some((existing) => existing.trigger === trigger);
// Instances whose last kill came mid-scroll and still hold their structure.
const pendingDisarms = new Set<StickyScrollTrigger>();

// Content to keep in place after a last kill, until it is (see #disarmKeepingContent). cls
// outlives a destroy() in between, for GSAP's scroll cache.
type PendingKeep = {
  owner: StickyScrollTrigger;
  position: ContentPosition;
  cls: ScrollTriggerClass | null;
  onlyAtRest: boolean;
  cancelled: boolean;
};

const pendingKeeps = new Set<PendingKeep>();
// Counts structures taken down by any instance. Only such a rebuild moves a container under
// windows measured before it; a change with none (in a stuck ancestor's offset, say) isn't one.
let unbuildCount = 0;
// How often held work checks isScrolling(), the condition GSAP holds its own refresh on, so it
// waits as long (a finger held down, or ScrollTrigger.disable() mid-scroll). A poll, not
// scrollEnd: ScrollTrigger.killAll() drops every listener, and GSAP also fires scrollEnd from the
// first scroll event after a pause.
const REST_POLL_MS = 100;

// Runs each step even if an earlier one throws. The first error is thrown; later ones go off the
// stack, so none is lost.
const runEach = (...steps: (() => void)[]): void => {
  let failure: { error: unknown } | null = null;

  steps.forEach((step) => {
    try {
      step();
    } catch (error) {
      if (!failure) {
        failure = { error };
      } else {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  });

  if (failure) throw (failure as { error: unknown }).error;
};

export default class StickyScrollTrigger {
  #rootElement: HTMLElement;
  // The set of layers that "should" exist. Changes immediately on register, kill, and reorder.
  #layers: Layer[] = [];
  // The layers last built into the DOM. A layer that a kill removed from `#layers` stays here until
  // the batch's rebuild: a Scene one still built, a cover one already unbuilt by the kill.
  #builtLayers: Layer[] = [];
  // The outermost container's top and unbuildCount when the windows were measured, null before.
  // Another instance's rebuild above moves the container, and the windows with it.
  #measuredStructure: { top: number; unbuilds: number } | null = null;
  // Restore callbacks for cover layers' z-order. Kept in a WeakMap so destroy() can call them
  // even without going through GSAP's onKill.
  #coverRestoreByLayer = new WeakMap<CoverLayer, () => void>();
  #built = false;
  #dirty = false; // Set true when a trigger is added/removed; rebuilt on the next refresh().
  #outermostContainer: HTMLDivElement | null = null;
  #destroyed = false;
  #rebuildScheduled = false;
  // Set by a kill whose catch-up hasn't run: the next refresh() keeps the content in place.
  #keepContentPending = false;
  // The batch held for the end of the scroll, and the timer that polls for it.
  #deferredRun: (() => void) | null = null;
  #restTimer: ReturnType<typeof setTimeout> | null = null;
  // A last kill's content to keep, until #applyPendingKeep.
  #pendingKeep: PendingKeep | null = null;
  // The ScrollTrigger class, read at runtime off the `self` GSAP passes to its callbacks, so gsap
  // is never imported (see #scheduleRebuild). Null until the first onKill/onRefreshInit, and
  // again after destroy().
  #scrollTriggerClass: ScrollTriggerClass | null = null;
  // Independent of Scene/Cover layers, implemented with plain position:sticky alone.
  #pinLayers: PinLayer[] = [];
  // Keeps scroll-margin-top on same-page-link targets in step with the current freeze windows,
  // so the browser's own scroll-into-view accounts for Scene layer dwell (see scrollMargin.ts).
  // Null while the instance is disarmed.
  #scrollMarginSync: ReturnType<typeof createScrollMarginSync> | null = null;
  #scrollMarginTargets: string | null;
  // True while a layer or pin is registered (see #arm).
  #armed = false;
  // Watches the DOM through one GSAP refresh, from this instance's last refresh() on (see
  // #createAutoRefreshHandler).
  #dispatchObserver: MutationObserver | null = null;
  // This instance's share of the page-level dormancy table, or null where it stays off (see
  // dormancy.ts).
  #dormancyClient: DormancyClient | null = null;

  constructor(root: string | HTMLElement, options: StickyScrollTriggerOptions = {}) {
    this.#rootElement = resolveRoot(root);

    const scrollMarginTargets = options.scrollMarginTargets === undefined
      ? '[id]'
      : options.scrollMarginTargets;

    // Validated here rather than inside refresh(): refresh() runs from GSAP's own dispatch, so
    // an uncaught SyntaxError from querySelectorAll on an invalid selector would abort every
    // other ScrollTrigger's refresh on the page.
    if (scrollMarginTargets !== null) {
      try {
        this.#rootElement.querySelectorAll(scrollMarginTargets);
      } catch {
        throw new Error(
          `StickyScrollTrigger: scrollMarginTargets "${scrollMarginTargets}" is not a `
          + 'valid CSS selector.',
        );
      }
    }

    // Unlike scrollMarginTargets, null isn't a value here: it gets the error rather than 'auto'.
    const optimization = options.nestedStickyOptimization === undefined
      ? 'auto'
      : options.nestedStickyOptimization;

    if (!['auto', 'always', 'off'].includes(optimization)) {
      throw new Error(
        `StickyScrollTrigger: nestedStickyOptimization must be 'auto', 'always' or 'off', got `
        + `${String(optimization)}.`,
      );
    }

    this.#scrollMarginTargets = scrollMarginTargets;

    // Other engines don't slow down with depth, so 'auto' leaves them at this one check.
    if (optimization === 'always' || (optimization === 'auto' && isWebKit())) {
      this.#dormancyClient = {
        mode: optimization,
        ownedElements: () => this.#ownedStickyElements(),
      };
    }
  }

  // Page-level side effects start with the first layer or pin, not at construction: an instance
  // created per gsap.matchMedia setup and never destroyed acts on the page only while it has one.
  #arm(): void {
    // Registering again before the scroll stopped: the rebuild reuses the structure. As at rest
    // (see #disarmKeepingContent), the setup puts the dwell back, so the content isn't kept.
    if (pendingDisarms.delete(this)) this.#keepContentPending = false;

    if (this.#armed) return;

    this.#armed = true;

    pendingKeeps.forEach((keep) => {
      if (keep.owner.#overlaps(this)) keep.cancelled = true;
    });
    this.#scrollMarginSync = createScrollMarginSync(this.#rootElement, this.#scrollMarginTargets);

    if (this.#dormancyClient) registerDormancyClient(this.#dormancyClient);
  }

  // The last kill hands the page back as destroy() does, at once unless the page is scrolling,
  // and the next registration arms the instance again. The scheduled batch still refreshes GSAP
  // for the triggers left.
  #disarmIfEmpty(): void {
    if (this.#armed && !this.#destroyed && !this.#layers.length && !this.#pinLayers.length) {
      if (pendingDisarms.has(this)) return;

      // Mid-scroll, the structure stays until the scroll stops, so the content keeps its place
      // without a scroll mid-fling (see #scheduleRebuild).
      if (!this.#scrollTriggerClass?.isRefreshing && this.#scrolling()) {
        pendingDisarms.add(this);
        // An update no scroll started (ScrollTrigger.update(), say) is over by the microtask.
        queueMicrotask(() => this.#settleWhenAtRest());

        return;
      }

      // GSAP marks a scroll only after scrollStart and the first update (ScrollTrigger.js:387-388),
      // so a kill from a scroll listener ahead of it reads as at rest: its keep is dropped if a
      // scroll has begun by the time it runs.
      this.#disarmKeepingContent(true, true);
    }
  }

  // A registration expects the page back as it was, on this container and any around or inside
  // it, before it reads the DOM (a cover's default is trigger.nextElementSibling; a selector can
  // use child combinators). The setup puts the dwell back, so the content stays put without a
  // scroll (see #disarmKeepingContent); mid-scroll it isn't kept, as for destroy(). Only create*
  // calls release a hold, and one that throws in validation has released it already.
  #flushOverlappingDisarms(): void {
    // A registration on a destroyed instance throws without registering anything.
    if (this.#destroyed) return;

    pendingDisarms.forEach((other) => {
      // This instance's own hold is #arm's to cancel. createResolvedTrigger registers nothing: it
      // measures the held structure, as resolveScrollPosition does, and the batch's GSAP refresh
      // measures it again.
      if (other !== this && other.#overlaps(this)) other.#flushPendingDisarmForRevert();
    });
  }

  // A kill from a trigger callback runs inside GSAP's update, where the first scroll after a pause
  // still reads as not scrolling. isUpdating is undocumented, so a missing one reads as false.
  #scrolling(): boolean {
    const cls = this.#scrollTriggerClass;

    return Boolean(cls?.isScrolling?.() || cls?.isUpdating === true);
  }

  // Tears down and, with keepContent, keeps the content at the viewport's top in place once the
  // task is over, unless an instance on an overlapping container has armed since: a setup run
  // again (a gsap.context revert and re-run, say) puts the dwell back, as with GSAP's own pins,
  // and keeping the content would shift it by that dwell. The keep runs before GSAP next measures
  // (in the batch's refreshInit or before its ScrollTrigger.refresh(), else in a microtask);
  // inside GSAP's refresh it moves the record at once. onlyAtRest drops it if a scroll has begun.
  #disarmKeepingContent(keepContent: boolean, onlyAtRest = false): void {
    // With nothing built there is no dwell to take off.
    const position = keepContent && this.#built ? this.#naturalScrollTop(this.#builtLayers) : null;

    this.#keepContentPending = false;
    this.#disarm();

    if (!position) return;

    // GSAP clears the record once it has scrolled back (ScrollTrigger.js:551-562), and a kill
    // from onRefresh or the update after it comes later: then the keep waits for the end of the
    // refresh like any other.
    if (this.#gsapScrollRecord()) {
      this.#keepContent(position);

      return;
    }

    // Only instances armed from now on cancel it: one armed all along puts nothing back.
    // One left from an earlier last kill in this task was cancelled by the registration since.
    if (this.#pendingKeep) pendingKeeps.delete(this.#pendingKeep);

    this.#pendingKeep = {
      owner: this,
      position,
      cls: this.#scrollTriggerClass,
      onlyAtRest,
      cancelled: false,
    };
    pendingKeeps.add(this.#pendingKeep);
    queueMicrotask(() => this.#applyPendingKeep());
  }

  #applyPendingKeep(): void {
    const keep = this.#pendingKeep;

    if (!keep) return;

    this.#pendingKeep = null;
    pendingKeeps.delete(keep);

    if (keep.cancelled || (keep.onlyAtRest && keep.cls?.isScrolling?.())) return;

    this.#keepContent(keep.position, keep.cls);
  }

  #overlaps(other: StickyScrollTrigger): boolean {
    return this.#rootElement.contains(other.#rootElement)
      || other.#rootElement.contains(this.#rootElement);
  }

  // Runs what a kill held for the end of the scroll once GSAP no longer reports one: the last
  // kill's teardown first, so the batch's GSAP refresh measures without it.
  #settleWhenAtRest(): void {
    if (this.#destroyed || this.#restTimer !== null) return;

    if (this.#scrollTriggerClass?.isScrolling?.()) {
      this.#restTimer = setTimeout(() => {
        this.#restTimer = null;
        this.#settleWhenAtRest();
      }, REST_POLL_MS);

      return;
    }

    const run = this.#deferredRun;

    this.#deferredRun = null;

    runEach(() => this.#flushPendingDisarm(), () => run?.());
  }

  #flushPendingDisarm(keepContent = true, onlyAtRest = false): void {
    if (pendingDisarms.delete(this) && !this.#destroyed && !this.#layers.length
      && !this.#pinLayers.length) {
      this.#disarmKeepingContent(keepContent, onlyAtRest);
    }
  }

  // Mid-scroll the content isn't kept: the scroll would stop a fling, and a revert that a new
  // setup follows is the usual case. Inside GSAP's update alone, whether a scroll has begun shows
  // only once the update is over.
  #flushPendingDisarmForRevert(): void {
    this.#flushPendingDisarm(!this.#scrollTriggerClass?.isScrolling?.(), true);
  }

  #disarm(): void {
    this.#armed = false;

    // Even with no client of its own, its wrappers were ancestors in the other instances' ranges.
    unregisterDormancyClient(this.#dormancyClient);

    // Before #unbuild removes the outermost container, which hosts the scroll-driven ramps.
    this.#scrollMarginSync?.restore();
    this.#scrollMarginSync = null;
    this.#restoreCoverLifts();
    this.#unbuild();
    this.#builtLayers = [];
  }

  // Every element this instance has made sticky: the wrappers still built, and the wrapped pins.
  #ownedStickyElements(): HTMLElement[] {
    return [
      ...this.#builtLayers.flatMap((layer) => (layer.wrapper ? [layer.wrapper] : [])),
      ...this.#wrappedPinTriggers(),
    ];
  }

  #wrappedPinTriggers(): HTMLElement[] {
    return this.#pinLayers.flatMap(({ trigger, inner }) => (inner ? [trigger] : []));
  }

  #unbuild() {
    if (!this.#built) return;

    unbuildStructure(this.#rootElement, this.#builtLayers, this.#outermostContainer);
    unbuildCount += 1;
    this.#measuredStructure = null;
    this.#outermostContainer = null;
    this.#built = false;
  }

  #build() {
    this.#outermostContainer = buildStructure(this.#rootElement, this.#layers);
    // buildStructure sorts layers into DOM order; keep a copy of the result.
    this.#builtLayers = [...this.#layers];
    this.#built = true;
    this.#dirty = false;
  }

  // A kill's catch-up before GSAP measures: a held last kill's teardown (GSAP measures now, so it
  // goes now), the rebuild, and a last kill's content keep.
  #catchUp(): void {
    this.#flushPendingDisarm();
    this.refresh();
    this.#applyPendingKeep();
  }

  // Defers teardown and rebuild to a microtask, or to a GSAP refresh later in the task, so kills
  // within the same task coalesce into one refresh(). Rebuilding per kill would be O(n^2), and
  // moving the shared container's subtree each time breaks iframes and focus. The last kill
  // tears down without a rebuild instead (see #disarmIfEmpty), which still moves the subtree only
  // once. While the page scrolls, both wait for the scroll to stop.
  //
  // GSAP doesn't re-read function-valued start/end until ScrollTrigger.refresh() is called, so
  // refresh() alone would leave GSAP's cache holding stale freezeStart/freezeEnd. The microtask
  // calls ScrollTrigger.refresh() right after to keep the two in sync; a GSAP refresh measures
  // after its refreshInit anyway.
  #scheduleRebuild() {
    if (this.#destroyed) return;

    // Set even with the batch already scheduled, since a refresh() after an earlier kill clears it.
    // Nothing built has no dwell to take off.
    if (this.#built) this.#keepContentPending = true;

    if (this.#rebuildScheduled) return;

    this.#rebuildScheduled = true;

    // Lets that GSAP refresh measure without the killed layers, even with no layer left to run
    // refresh() from its own onRefreshInit.
    const cls = this.#scrollTriggerClass;

    const onRefreshInit = () => {
      if (!this.#rebuildScheduled || this.#destroyed) return undefined;

      try {
        this.#catchUp();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      } finally {
        this.#rebuildScheduled = false;
      }

      const restoreDormancy = takeGsapRefreshRestore();

      return restoreDormancy ? { render: () => restoreDormancy() } : undefined;
    };

    cls?.addEventListener?.('refreshInit', onRefreshInit);

    const run = () => {
      // Off the stack: GSAP's dispatch maps over its live listener array.
      cls?.removeEventListener?.('refreshInit', onRefreshInit);

      if (!this.#rebuildScheduled) return;

      this.#rebuildScheduled = false;

      if (this.#destroyed) return;

      this.#catchUp();

      // self.constructor is an undocumented GSAP implementation detail, so this skips silently
      // in case it ever changes.
      if (typeof this.#scrollTriggerClass?.refresh === 'function') this.#scrollTriggerClass.refresh();
    };

    queueMicrotask(() => {
      // While the page scrolls, the killed layers' padding stays until the scroll stops, as GSAP
      // holds its own refresh: keeping the content in place then needs no scroll mid-fling.
      if (this.#rebuildScheduled && !this.#destroyed && cls?.isScrolling?.()) {
        const earlier = this.#deferredRun;

        // An earlier batch a GSAP refresh ran still has its listener to drop.
        this.#deferredRun = earlier
          ? () => runEach(earlier, run)
          : run;
        this.#settleWhenAtRest();

        return;
      }

      run();
    });
  }

  // Reads the ScrollTrigger class off the `self` that onKill/onRefreshInit pass in, so gsap is
  // never imported (see #scheduleRebuild). Shared by #registerLayer's and createStickyPin's
  // handlers.
  //
  // Does nothing once destroyed: destroy() leaves these handlers registered, and a later kill()
  // or refreshInit would otherwise re-capture the class.
  #captureScrollTriggerClass(self: ScrollTrigger) {
    if (this.#destroyed) return;

    this.#scrollTriggerClass = self.constructor as unknown as ScrollTriggerClass;
  }

  // Binds refresh() to the refreshInit GSAP itself fires (resize/load), so callers get the right
  // ordering without writing ScrollTrigger.addEventListener('refreshInit', refresh) themselves.
  // Every layer's handler can refresh: GSAP runs all refreshInit listeners before it measures
  // anything, so a callback with no refresh() after it would leave its layout changes out of the
  // freeze window.
  #createAutoRefreshHandler(
    userOnRefreshInit: ScrollTrigger.Vars['onRefreshInit'],
  ): ScrollTrigger.Vars['onRefreshInit'] {
    return (self) => {
      this.#captureScrollTriggerClass(self);

      // GSAP dispatches refreshInit before any measurement, so a callback that puts something in
      // place to be measured expects to run before refresh() too. This call stays outside the
      // guard below: a plain ScrollTrigger's onRefreshInit gets the same unguarded dispatch.
      const result = userOnRefreshInit?.(self);
      // GSAP's refresh calls this once per layer before it measures anything. A call after the
      // first refreshes again only if this layer's own callback ran (it may have changed anything,
      // a variable a function-valued end reads included) or the DOM has changed since: otherwise
      // it would compute the same thing, at a cost that grows with the depth on every call.
      const inGsapRefresh = this.#scrollTriggerClass?.isRefreshing === true;
      const unchanged = inGsapRefresh && !userOnRefreshInit && this.#dispatchObserver !== null
        && this.#dispatchObserver.takeRecords().length === 0;

      // GSAP's dispatch is `_listeners[type].map(f => f())` with no try/catch, so an error escaping
      // here would stop every later listener and every trigger's own refresh. The catch rethrows
      // off the stack instead of swallowing, since a stale freeze window with no signal is worse.
      try {
        if (!unchanged) this.refresh();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }

      if (inGsapRefresh) this.#watchGsapRefresh();

      // GSAP reverts an animation a refreshInit listener returns, once the refresh is done
      // (ScrollTrigger.js's `refreshInits.forEach(...render(-1))`). The same call puts back the
      // nested-sticky state when the table took GSAP's class too late to listen itself.
      const restoreDormancy = takeGsapRefreshRestore();

      if (!restoreDormancy) return result;

      return {
        render: (time: number) => {
          (result as { render?: (time: number) => unknown } | undefined)?.render?.(time);
          restoreDormancy();
        },
      };
    };
  }

  // Starts watching for the rest of GSAP's refresh, or drops what this instance's own refresh()
  // just wrote. The watch ends with that refresh's 'refresh' event, so a second GSAP refresh in the
  // same task starts from a refresh() again; the microtask ends one that threw before the event.
  #watchGsapRefresh(): void {
    if (this.#dispatchObserver) {
      this.#dispatchObserver.takeRecords();

      return;
    }

    const observer = new MutationObserver(() => {});
    const cls = this.#scrollTriggerClass;

    const end = () => {
      observer.disconnect();

      if (this.#dispatchObserver === observer) this.#dispatchObserver = null;

      // Off the stack: GSAP's dispatch maps over its live listener array.
      queueMicrotask(() => cls?.removeEventListener?.('refresh', end));
    };

    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    this.#dispatchObserver = observer;
    cls?.addEventListener?.('refresh', end);
    queueMicrotask(end);
  }

  // Wraps any not-yet-built pin layer. Must run before #refreshScenesAndCovers measures Scene and
  // Cover positions: the wrappers stop trigger's margins from collapsing with its siblings', so
  // wrapping still moves whatever sits below it, even though #reservePinSpace gives the height
  // itself back.
  #wrapUnwrappedPins() {
    this.#pinLayers.forEach((layer) => {
      if (layer.outer) return;

      // Captured when the pin first wraps trigger, not back at registration, so a caller that
      // restyles trigger in between still gets those values back on teardown. Nothing has written
      // to trigger's position/top yet.
      layer.savedPosition = captureInlinePosition(layer.trigger);

      const wrapped = wrapPin(layer.trigger);

      layer.outer = wrapped.outer;
      layer.inner = wrapped.inner;
    });
  }

  // Sizes every wrapped pin's outer to trigger's own margin box, so registering a pin leaves the
  // page the height it had without one. outer can't simply keep its natural height once the
  // refresh is done: inner holds the pin range, which runs far past trigger itself.
  //
  // While inner is cleared, though, that natural height is the margin box already, since outer is
  // a formatting context and trigger's margins land inside it instead of collapsing out. So the
  // measurement below clears and reads back instead of adding up trigger's own height and margins,
  // and the browser resolves the box at full precision, through whatever box-sizing, borders,
  // floats or line boxes trigger happens to have.
  //
  // This has to run before #refreshScenesAndCovers measures, since the height it writes is part of
  // the flow. Left to #refreshPinLayers, it would measure every Scene layer against the previous
  // refresh's height whenever a trigger's own height had changed, with no later pass to correct
  // it.
  #reservePinSpace() {
    const wrapped = this.#pinLayers.flatMap(({ outer, inner }) =>
      outer && inner ? [{ outer, inner, range: inner.style.height }] : [],
    );

    // Every pin is cleared before any is measured, so a pin nested inside another's trigger
    // doesn't hold that trigger open at the range it's about to replace. Clearing inner as well
    // keeps a percentage-height trigger resolving against its natural container.
    wrapped.forEach(({ outer, inner }) => {
      outer.style.height = '';
      inner.style.height = '';
    });

    // Read in full before anything is written back, so all the writes share one reflow instead of
    // forcing one per pin.
    const reserved = wrapped.map(({ outer }) => measureUsedHeight(outer));

    wrapped.forEach(({ outer }, index) => {
      outer.style.height = `${reserved[index]}px`;
    });
    // The ranges go back rather than staying cleared, so #resetPinState still snapshots the last
    // successful refresh's values and its rollback has something to restore. They're sealed inside
    // outer either way, so #refreshScenesAndCovers measures the same layout with them present.
    wrapped.forEach(({ inner, range }) => {
      inner.style.height = range;
    });
  }

  // #wrapUnwrappedPins's counterpart. Nulling outer keeps it idempotent: destroy() and a kill
  // both run over the same layer, and a second unwrap would put savedPosition back over whatever
  // inline position/top the caller has set on trigger since the first.
  #unwrapPinLayer(layer: PinLayer): boolean {
    if (!layer.outer) return false;

    releaseDormant([layer.trigger]);
    unwrapPin(layer.outer, layer.trigger, layer.savedPosition);
    layer.outer = null;
    layer.inner = null;

    return true;
  }

  // Snapshots and resets every Scene/Cover wrapper's sticky state, returning a function that puts
  // it back. Callers must call that function before they return.
  //
  // A wrapper that's currently stuck (the page is scrolled into its freeze window when this runs)
  // shifts documentTop for everything nested inside it, by however far scroll has advanced past
  // that wrapper's engagement point (see ARCHITECTURE.md's "Two-pass position measurement"). A
  // Scene layer's own dwell is a difference of two documentTop calls sharing the same stuck
  // ancestors, so the shift cancels out there; measuring an arbitrary element (a pin's
  // trigger/endTrigger, or resolveScrollPosition's element) has no such guarantee.
  // #refreshScenesAndCovers shares this helper for its own pass 1, but restores only on the
  // throwing path (see the catch there for why). The wrappers the DOM holds, as #engagedWindows
  // counts them: a killed layer's stay until its catch-up runs.
  #resetSceneCoverStickyState(): () => void {
    return stripStickyPositions(
      this.#builtLayers.flatMap(({ wrapper }) => (wrapper ? [wrapper] : [])),
    );
  }

  // Snapshots and resets every wrapped pin's own sticky state, returning a function that puts it
  // back. A stuck pin shifts documentTop for its trigger and everything inside it, as a stuck
  // wrapper does (see #resetSceneCoverStickyState).
  #resetPinStickyState(): () => void {
    return stripStickyPositions(this.#wrappedPinTriggers());
  }

  // Both resets above, for a measurement that can land anywhere on the page.
  #resetStickyState(): () => void {
    const restoreSceneCoverStickyState = this.#resetSceneCoverStickyState();
    const restorePinStickyState = this.#resetPinStickyState();

    return () => {
      restorePinStickyState();
      restoreSceneCoverStickyState();
    };
  }

  // Pass 1 of the pin refresh: snapshots and strips every pin's own sticky top and spacer height,
  // returning a function that puts them back. #refreshPinLayers then measures a natural position
  // rather than the previous refresh's result.
  //
  // outer's reserved height is left alone. It's what the page actually renders, so it's what
  // documentTop should see, and #reservePinSpace rewrites it from a fresh measurement every
  // refresh, so a throw in pass 2 can't strand a stale one.
  #resetPinState(): () => void {
    const snapshots = this.#pinLayers.map((layer) => ({
      layer,
      position: captureInlinePosition(layer.trigger),
      height: layer.inner ? layer.inner.style.height : '',
    }));

    snapshots.forEach(({ layer }) => {
      resetStickyPosition(layer.trigger);

      if (layer.inner) layer.inner.style.height = '';
    });

    return () => {
      snapshots.forEach(({ layer, position, height }) => {
        restoreInlinePosition(layer.trigger, position);

        if (layer.inner) layer.inner.style.height = height;
      });
    };
  }

  #refreshPins(viewportHeight: number) {
    if (!this.#pinLayers.length) return;

    // #refreshScenesAndCovers already finished applying its own (possibly-stuck) sticky state by
    // the time this runs, so trigger/endTrigger measurement below needs its own reset. This is a
    // separate pass 1/pass 2 split from #resetPinState's, which only concerns pins' own previous
    // sticky/spacer state.
    const restoreSceneCoverStickyState = this.#resetSceneCoverStickyState();
    const restorePinState = this.#resetPinState();

    // Pass 2 throws on a rejected option value (an absolute start, a 'max' end) while both resets
    // above have their CSS stripped. Without the restores below, the Scene/Cover wrappers and
    // every pin from the throwing one onward would stay stripped until a later refresh()
    // succeeded. The bad value doesn't have to be there from the start either: a function-valued
    // option can begin returning one long after setup, on a refresh GSAP itself triggers.
    try {
      this.#refreshPinLayers(viewportHeight, measureDocumentHeightWithoutPinRanges());
    } catch (error) {
      // catch rather than finally (see #refreshScenesAndCovers' catch for why). The Scene/Cover
      // reset below is measurement scaffolding that nothing rewrites, so it stays a finally.
      restorePinState();

      throw error;
    } finally {
      restoreSceneCoverStickyState();
    }
  }

  // Pass 2 of the pin refresh, run once #resetPinState has stripped the previous values.
  // Recomputes pin layers' sticky top and spacer height. Pinning here is plain position:sticky, so
  // unlike Scene/Cover layers this never hands GSAP an absolute scroll position. The spacer height
  // spans from trigger's natural top to the release scroll resolvePinReleaseScroll returns, plus
  // the sticky top, trigger's own height and its bottom margin (a sticky element unpins once its
  // margin box catches up to the bottom of its containing block). A pin inside the shared
  // container stands still with it through every freeze, so its range, measured in the
  // container's own coordinates, leaves out the dwell gone by at release.
  //
  // Every pin is measured before any is written: a pin inside an earlier pin's trigger would
  // otherwise be read with that pin stuck, off by its stuck offset.
  #refreshPinLayers(viewportHeight: number, documentHeight: number) {
    const planned = this.#pinLayers.flatMap((layer) => {
      if (!layer.inner) return [];

      // start comes first so a spaced '+=' end can take its element token, which is also the order
      // GSAP resolves the two in (ScrollTrigger.js:1384-1391).
      const resolvedStart = resolveMaybeFn(layer.start);
      const resolvedEnd = prefixSpacedRelativeEnd(resolvedStart, resolveMaybeFn(layer.end));
      const classifiedEnd = classifyPosition(resolvedEnd);

      // A pin's range never changes the document height, so 'max' has no self-reference here; it's
      // rejected for now so that accepting it later breaks nothing. Rejecting it here is what lets
      // resolvePinReleaseScroll take an end that excludes 'max'. Its place ahead of the
      // absolute-start check below decides which error a pin with both bad values reports.
      if (classifiedEnd.kind === 'max') {
        throw new Error(
          `StickyScrollTrigger: createStickyPin's end "${resolvedEnd}" uses GSAP's 'max' keyword, `
          + 'which isn\'t supported here. Use a position clause against endTrigger, such as '
          + '\'top top\'.',
        );
      }

      const triggerTop = documentTop(layer.trigger);
      const triggerHeight = measureUsedHeight(layer.trigger);
      const triggerMarginBottom = parseFloat(getComputedStyle(layer.trigger).marginBottom) || 0;
      const classifiedStart = classifyPosition(resolvedStart);

      // A bare number keeps GSAP's meaning, an absolute scroll position, which a pin can't act on.
      // A Scene layer honors one because its freeze window is a scroll range to begin with and its
      // sticky top follows from that range (see freezeWindow.ts's planLayers). A pin
      // runs the other way: topPx below is the only value it has, and the scroll position it
      // engages at (triggerTop - topPx) follows from that. Inverting it would mean already knowing
      // triggerTop, and anyone who does would write the px distance directly, which is what `top`
      // is for.
      if (classifiedStart.kind === 'absolute') {
        throw new Error(
          `StickyScrollTrigger: createStickyPin's start "${resolvedStart}" is an absolute scroll `
          + 'position (GSAP reads any bare number this way). A pin can\'t act on one: it '
          + 'engages when position:sticky engages, so start says where trigger sits in the '
          + `viewport while pinned. Use the top option (top: ${resolvedStart}) for a px distance `
          + `from the viewport's top edge, or a position clause such as 'top top'.`,
        );
      }

      // 'max' and a dwell reach resolveAnchorTop here for the reason measure.ts's resolveStartSpec
      // gives.
      const topPx = resolveAnchorTop(classifiedStart.value, triggerHeight, viewportHeight);
      const toScroll = (element: HTMLElement, reachedAt: number) =>
        this.#addDwellBeforeReach(element, reachedAt);
      const releaseScroll = resolvePinReleaseScroll(
        layer.endTrigger,
        classifiedEnd,
        toScroll(layer.trigger, triggerTop - topPx),
        viewportHeight,
        toScroll,
      );
      const frozenAtRelease = this.#rootElement.contains(layer.trigger)
        ? dwellConsumedAt(releaseScroll, this.#engagedWindows())
        : 0;
      const height = releaseScroll - frozenAtRelease - triggerTop + topPx + triggerHeight
        + triggerMarginBottom;
      // Nothing contains inner's overflow, so a range running past the page's end would make the
      // page taller. Such a pin can't release before the scroll runs out anyway, so the range
      // stops at the end. Wrappers carrying the pin down don't matter: all three engines leave
      // sticky offsets out of the scrollable area. jsdom reports no height, so there's no end.
      const room = documentHeight > 0 ? documentHeight - triggerTop : Infinity;

      return [{ layer, topPx, range: Math.max(0, Math.min(height, room)) }];
    });

    // A later pin's start/end function can kill an earlier one, which unwraps it.
    planned.forEach(({ layer, topPx, range }) => {
      if (!layer.inner) return;

      applyStickyPosition(layer.trigger, topPx);
      layer.inner.style.height = `${range}px`;
    });
  }

  // Recomputes each layer's sticky top, padding height, and start/end. This disables sticky on
  // every wrapper before the two passes below run, and puts it back if either one throws.
  #refreshScenesAndCovers(viewportHeight: number) {
    if (!this.#layers.length) return;

    const active = this.#layers.filter((layer) => layer.wrapper !== null);

    if (!active.length) return;

    const restoreStickyState = this.#resetSceneCoverStickyState();
    // Put back whether or not planning throws. #refreshPins rewrites pins after a success anyway,
    // but a throw skips it and would leave every pin unstuck.
    const restorePinStickyState = this.#resetPinStickyState();

    try {
      this.#planLayerPositions(viewportHeight, active);
    } catch (error) {
      // The same window and reasoning as #refreshPins' `finally`. The one difference is `catch`
      // rather than `finally`: pass 2 writes the new sticky state itself, so after a successful
      // pass the snapshot holds what that pass replaced, and restoring it would undo the lot.
      restoreStickyState();

      throw error;
    } finally {
      restorePinStickyState();
    }
  }

  // Pass 1 measures every layer's natural position, then pass 2 (planLayers) works out every
  // window and applies sticky and padding. Keeping them separate is what stops an
  // earlier layer's applied sticky from throwing off a later layer's measurement.
  // Forward references are resolved inside planLayers rather than by this pass ordering. An
  // endTrigger outside the shared container isn't at the right position until padding
  // is finalized, so pass 2 runs a second time in that case alone (cover layers only;
  // measure.ts's resolveEndSpec rejects it for Scene layers).
  // The arithmetic lives in freezeWindow.ts's planLayers, which touches no DOM; this function only
  // measures and writes.
  #planLayerPositions(viewportHeight: number, active: readonly Layer[]) {
    // Scene layers' wrappers line up at the start of the nested container, so every layer's
    // natural position aligns here.
    const structureTop = this.#outermostContainer ? documentTop(this.#outermostContainer) : 0;

    this.#measuredStructure = { top: structureTop, unbuilds: unbuildCount };

    // Registered trigger element -> index. If endTrigger is among these, its already-computed
    // natural absolute position can be reused.
    const indexByTrigger = new Map<HTMLElement, number>();

    active.forEach((layer, index) => {
      indexByTrigger.set(layer.trigger, index);
    });

    // Pass 1: with every wrapper's sticky disabled, measure each layer's trigger/wrapper/cover
    // natural absolute position together.
    const measured: LayerMeasurement[] = active.map((layer, ownIndex) =>
      measureLayer(this.#rootElement, viewportHeight, layer, ownIndex, indexByTrigger),
    );
    // Pass 2: leave the arithmetic to planLayers; this only supplies measuring
    // (measureLiveEndTriggerTop) and writing (onPlanned).
    // documentMaxScroll starts at 0, since no Scene layer's padding has been written yet and the
    // true value isn't known. The placeholder is harmless: only cover layers may use 'max', and a
    // cover layer's freezeEnd feeds into no other layer's measurement, so it's corrected below
    // before anything reads it a second time.
    let documentMaxScroll = 0;
    // Sticky goes on only after the last pass: the reads below would otherwise lay out every
    // wrapper sticky, the cost dormancy.ts avoids. What they read (the document's height, an
    // element outside the container) doesn't depend on it.
    const stickyTops = new Map<HTMLElement, number>();
    const applyLayers = () =>
      planLayers(measured, {
        viewportHeight,
        structureTop,
        documentMaxScroll,
        measureLiveEndTriggerTop: (index) => documentTop(active[index].endTrigger),
        onPlanned: (index, plan) => {
          const layer = active[index];

          layer.freezeStart = plan.freezeStart;
          layer.freezeEnd = plan.freezeEnd;
          layer.engagedStart = plan.engagedStart;
          layer.engagedEnd = plan.engagedEnd;

          if (!layer.wrapper) return;

          stickyTops.set(layer.wrapper, plan.stickyTop);

          if (layer.kind === 'scene' && layer.padding && plan.paddingHeight !== null) {
            layer.padding.style.height = `${plan.paddingHeight}px`;
          }
        },
      });

    applyLayers();

    // Only re-run pass 2 when some layer references an endTrigger outside the container (it
    // can't be at the right position until every layer's padding has been finalized), or when
    // some cover layer's end is 'max' (the document's true max scroll position is only known
    // once every Scene layer's dwell padding above has actually been written).
    const needsLiveRemeasure = measured.some(
      (measurement) => measurement.end.mode === 'clause' && measurement.end.measureLive,
    );
    const needsMaxRemeasure = measured.some((measurement) => measurement.end.mode === 'max');

    if (needsMaxRemeasure) documentMaxScroll = measureDocumentMaxScroll(viewportHeight);

    if (needsLiveRemeasure || needsMaxRemeasure) applyLayers();

    stickyTops.forEach((top, wrapper) => applyStickyPosition(wrapper, top));
  }

  // Public entry point. Rebuilds the nesting if triggers were added/removed, and recomputes
  // both the Scene/Cover layers and the pin layers.
  refresh(): void {
    // A last kill's structure waits for the scroll to stop, not for a rebuild with no layers.
    if (this.#destroyed || !this.#armed || pendingDisarms.has(this)) return;

    let failure: { error: unknown } | null = null;
    // Only a kill's catch-up keeps the content in place; a resize keeps GSAP's scroll number.
    const position = this.#keepContentPending ? this.#naturalScrollTop(this.#builtLayers) : null;

    this.#keepContentPending = false;

    try {
      this.#refreshLayout();
    } catch (error) {
      failure = { error };
    }

    // After every sticky value is written, and on a throw too: the restores there put back
    // whatever the table expects, and the table has to follow what this refresh did manage.
    try {
      rebuildDormancy(this.#scrollTriggerClass);
    } catch (error) {
      // Every demoted element goes back to sticky. The table's error goes out off the stack, so
      // #scheduleRebuild still reaches GSAP's refresh; the refresh's own error is the one thrown.
      clearDormancy();
      queueMicrotask(() => {
        throw error;
      });
    }

    // Reading the scroll forces a layout, so both reads wait until the table has demoted the far
    // layers: with every wrapper sticky, that layout is the cost dormancy avoids.
    this.#scrollMarginSync?.applyRamps();

    // A failed rebuild leaves part of the layout unpadded, and the next refresh puts it back.
    if (!failure && position !== null) this.#keepContent(position);

    if (failure) throw failure.error;
  }

  // GSAP's record of the scroll it returns to after measuring, while one of its refreshes runs.
  // rec is undocumented, so this skips silently if it ever changes.
  #gsapScrollRecord(): { rec: number } | null {
    if (!this.#scrollTriggerClass?.isRefreshing) return null;

    const scrollFunc = this.#scrollTriggerClass.getScrollFunc?.(window) as
      { rec?: unknown } | undefined;

    return scrollFunc && typeof scrollFunc.rec === 'number' && scrollFunc.rec
      ? scrollFunc as { rec: number }
      : null;
  }

  // Where the content at the viewport's top edge sits in the unpadded layout, given the layers
  // the DOM holds, and how far into each Scene layer's freeze the scroll is. The scroll is read in
  // the layout the windows were measured in: another instance's catch-up earlier in the task may
  // have rebuilt above this container and scrolled.
  #naturalScrollTop(layers: readonly Layer[]): ContentPosition {
    const measured = this.#measuredStructure;
    const moved = measured && this.#outermostContainer && measured.unbuilds !== unbuildCount
      ? documentTop(this.#outermostContainer) - measured.top
      : 0;
    const scroll = (this.#gsapScrollRecord()?.rec ?? window.scrollY) - moved;
    const consumed = new Map<HTMLElement, number>();

    layers.forEach((layer) => {
      if (layer.kind !== 'scene') return;

      consumed.set(layer.trigger, scroll > layer.engagedEnd
        ? Infinity
        : dwellConsumedAt(scroll, this.#engagedWindows([layer])));
    });

    return {
      natural: scroll - dwellConsumedAt(scroll, this.#engagedWindows(layers)) + moved,
      consumed,
    };
  }

  // Scrolls so that content is at the viewport's top edge again, under the windows the DOM now
  // holds. Inside GSAP's refresh it moves the record GSAP scrolls back to instead. An absolute
  // target, so it doesn't add to whatever the browser's scroll anchoring has already done.
  #keepContent(
    position: ContentPosition,
    cls: ScrollTriggerClass | null = this.#scrollTriggerClass,
  ): void {
    const target = this.#keptScrollTop(position);
    const record = this.#gsapScrollRecord();

    if (record) {
      record.rec = target;

      return;
    }

    // With no record to move (rec 0 at the top), GSAP still sets the scroll once it has measured.
    if (cls?.isRefreshing) return;

    // Whole pixels: GSAP's scroll function below rounds what it is given and scrolls there too.
    if (Math.abs(window.scrollY - target) >= 0.5) {
      window.scrollTo({ top: Math.round(target), behavior: 'instant' });
    }

    // GSAP caches the scroll until the scroll event, and a trigger created before then scrolls
    // back to the cached number once it has measured (ScrollTrigger.js:1265, 1565). GSAP's scroll
    // function updates the cache but also scrolls, so it runs only when the cache is off.
    // Undocumented, so skipped if absent.
    const scrollFunc = cls?.getScrollFunc?.(window) as ((value?: number) => unknown) | undefined;

    if (typeof scrollFunc !== 'function') return;

    const cached = scrollFunc();

    if (typeof cached !== 'number' || Math.abs(cached - window.scrollY) >= 0.5) {
      scrollFunc(window.scrollY);
    }
  }

  // Each Scene layer still built keeps the dwell the scroll had gone through, capped at its new
  // length, so its scrub and anything outside the container stay put. A freeze the scroll is past
  // counts its new length in full. Where two freezes tie at one natural start (an inner trigger
  // at its outer's top), the earlier one counts in full. A layer registered again on its trigger
  // since counts as the killed one did, as a GSAP pin reverted and created again keeps its
  // progress; any other new layer counts as dwellBeforeReach would.
  #keptScrollTop({ natural, consumed }: ContentPosition): number {
    let earlierDwell = 0;
    let target = natural;

    this.#builtLayers
      .flatMap((layer) => (layer.kind === 'scene' ? [layer] : []))
      .sort((a, b) => a.engagedStart - b.engagedStart)
      .forEach((layer) => {
        const dwell = layer.engagedEnd - layer.engagedStart;
        const before = consumed.get(layer.trigger);

        if (before !== undefined) {
          target += Math.min(before, dwell);
        } else if (layer.engagedStart < natural + earlierDwell - TIE_TOLERANCE_PX) {
          target += dwell;
        }

        earlierDwell += dwell;
      });

    return target;
  }

  #refreshLayout(): void {
    // Checks DOM-order changes as well as dirty (layer count changes),
    // since a reorder with no additions/removals never sets dirty.
    if (this.#dirty || !this.#built || isDomOrderStale(this.#layers)) {
      this.#unbuild();
      this.#build();
    }

    // The lift comes off before the pin wrapping below captures a pin trigger's own inline
    // position, so a value the lift wrote there is never mistaken for the caller's.
    this.#restoreCoverLifts();

    try {
      // Both must happen before #refreshScenesAndCovers measures Scene/Cover positions (see each
      // one's own comment for why).
      this.#wrapUnwrappedPins();
      this.#reservePinSpace();
    } finally {
      // It goes back on after the build and the pin wrapping, so it walks the sibling chain those
      // leave behind rather than the elements they moved out of it. In a finally because wrapPin
      // throws for a trigger detached since registration, and the covering side would sit behind
      // the sticky wrapper until the next successful refresh() (see #resetPinState for the same
      // rollback on the pin side).
      this.#liftCovers();
    }

    // Measured once here so Scene/Cover layers and pin layers share a single reading rather than
    // forcing two layout reflows, and skipped entirely when nothing is registered.
    // window.innerHeight is avoided because it fluctuates with a mobile browser's address bar
    // showing and hiding (see measureViewportHeight).
    const viewportHeight
      = this.#layers.length || this.#pinLayers.length ? measureViewportHeight() : 0;

    this.#refreshScenesAndCovers(viewportHeight);
    // A pin layer's spacer height spans the Scene layer dwell padding between trigger
    // and endTrigger, so it's measured only after #refreshScenesAndCovers has finalized padding.
    this.#refreshPins(viewportHeight);
    // Last, because these values derive from the freeze windows the passes above settle, and
    // nothing measures layout afterwards for the style written here to disturb.
    this.#syncScrollMargins();
  }

  #coverLayers(): CoverLayer[] {
    return this.#layers.filter((layer): layer is CoverLayer => layer.kind === 'cover');
  }

  // Takes every cover layer's z-order lift off. Registration alone can't be the last word: a
  // sibling added since has never been raised, and a property the author's own CSS has turned on
  // since is still held down by the value the lift wrote while it was unset.
  //
  // All of them come off before any goes back on. Interleaved, a layer sharing siblings with one
  // already re-lifted would read that write back as an author value and leave them low.
  #restoreCoverLifts(): void {
    this.#coverLayers().forEach((layer) => this.#coverRestoreByLayer.get(layer)?.());
  }

  // #restoreCoverLifts's counterpart, and the only thing that raises a sibling the page has grown
  // since the last refresh.
  //
  // The walk starts from whatever holds cover's own place among the siblings, which is the pin's
  // wrapper when cover is itself a pin trigger: cover sits inside outer{ inner{ cover } } by then,
  // so starting from cover would reach cover alone.
  #liftCovers(): void {
    this.#coverLayers().forEach((layer) => {
      const pin = this.#pinLayers.find(({ trigger }) => trigger === layer.cover);

      this.#coverRestoreByLayer.set(layer, liftAboveStickyWrapper(pin?.outer ?? layer.cover));
    });
  }

  // Hands the current Scene layer freeze windows to the scroll-margin bookkeeping, along with the
  // outermost container as the host for the scroll-driven ramps. That container is built by this
  // module and is an ancestor of every target, which is what lets the ramps reach them by
  // inheritance without ever styling an element the caller owns. Targets are measured the way
  // resolveScrollPosition measures its element, with every wrapper's sticky state reset.
  #syncScrollMargins(): void {
    this.#scrollMarginSync?.sync(
      this.#engagedWindows(),
      this.#outermostContainer,
      (targets) => {
        if (!targets.length) return [];

        const restoreStickyState = this.#resetStickyState();
        const tops = targets.map((target) => documentTop(target));

        restoreStickyState();

        return tops;
      },
    );
  }

  // PassThroughVars (types.ts) excludes these only at the TypeScript level; a plain JS/JSON
  // caller can still hand them through in `rest`. Rejected here too, so GSAP never silently
  // receives them (see vars.ts for why each one is excluded).
  #assertNoExcludedVars(rest: object, context: string): void {
    const found = EXCLUDED_VAR_KEYS.filter((key) => key in rest);

    if (found.length === 0) return;

    throw new Error(
      `${context}: ${found.join(', ')} ${found.length > 1 ? 'are' : 'is'} not supported here; `
      + 'this module handles pinning and the scroll axis itself.',
    );
  }

  // Throws `message` if any entry in `list` already uses `trigger`. #registerLayer and
  // createStickyPin each check both #layers and #pinLayers, with a message specific to the call
  // site.
  #assertTriggerAvailable(
    list: readonly { trigger: HTMLElement }[],
    trigger: HTMLElement,
    message: string,
  ): void {
    if (hasDuplicateTrigger(list, trigger)) throw new Error(message);
  }

  // A cover layer moves and styles trigger's siblings, and a Scene layer measures trigger against
  // the container it wraps, so both need trigger inside it. createStickyPin wraps trigger alone
  // and stays exempt; see #assertTriggerNotEnclosingRoot for its one restriction.
  #assertTriggerInsideRoot(trigger: HTMLElement, context: string): void {
    // contains() reports true for the container itself, so that case needs its own branch.
    if (trigger === this.#rootElement) {
      throw new Error(
        `${context}: trigger ${describeElement(trigger)} is the shared container itself. Point `
        + 'trigger at an element inside the container.',
      );
    }

    if (!this.#rootElement.contains(trigger)) {
      throw new Error(
        `${context}: trigger ${describeElement(trigger)} is outside the shared container. Point `
        + 'trigger at an element inside it, or use createStickyPin, which works on either side.',
      );
    }
  }

  // A pin trigger may sit on either side of the container, since wrapPin only wraps trigger itself.
  // The exception is one that encloses it; contains() covers the container itself and any of its
  // ancestors.
  #assertTriggerNotEnclosingRoot(trigger: HTMLElement, context: string): void {
    if (!trigger.contains(this.#rootElement)) return;

    const relation = trigger === this.#rootElement
      ? 'is the shared container itself'
      : 'is an ancestor of the shared container';

    throw new Error(
      `${context}: trigger ${describeElement(trigger)} ${relation}. A pin makes trigger itself `
      + 'position:sticky inside a box holding the pin range, so the container and every layer\'s '
      + 'dwell padding would be pinned along with it. Pin an element that doesn\'t contain the '
      + 'container.',
    );
  }

  // Registers a layer and builds the ScrollTrigger start/end that track the freeze window.
  // This doesn't call refresh() itself (calling it on every registration would be O(n^2));
  // call refresh() once after registering.
  #registerLayer(
    layer: Layer,
    onKill: ScrollTrigger.Vars['onKill'],
    rest: ScrollTrigger.Vars,
  ): ScrollTrigger.Vars {
    if (this.#destroyed) {
      throw new Error(
        'StickyScrollTrigger: cannot register a new layer after destroy() has been called.',
      );
    }

    // Using the same element as the trigger of two layers would make it ambiguous which one
    // another layer's endTrigger points at, so this is rejected at registration time.
    this.#assertTriggerAvailable(
      this.#layers,
      layer.trigger,
      `StickyScrollTrigger: ${describeElement(layer.trigger)} is already registered as a `
      + 'trigger for another layer. Each element can be used once per controller instance, '
      + 'across createStickyTrigger and createOverlapScroll: reusing one makes endTrigger '
      + 'resolution ambiguous.',
    );

    // A pin wraps trigger itself via wrapPin(), so reusing the element here would wrap it a
    // second time via wrapScene/wrapCover, leaving two conflicting sticky behaviors.
    this.#assertTriggerAvailable(
      this.#pinLayers,
      layer.trigger,
      `StickyScrollTrigger: ${describeElement(layer.trigger)} is already registered as a `
      + 'pin trigger (createStickyPin). Using the same element as both a Scene/Cover trigger and '
      + 'a pin trigger wraps it twice and produces conflicting position:sticky behavior.',
    );

    this.#arm();
    this.#layers.push(layer);
    this.#dirty = true;

    return {
      ...rest,
      trigger: layer.trigger,
      // Pinning is handled by sticky, so GSAP never pins. start/end return the freeze
      // window's absolute scroll position (px).
      start: () => layer.freezeStart,
      // GSAP swaps a falsy end for "100% 0" and refreshes synchronously inside its constructor,
      // so a freezeEnd still 0 from registration is nudged to a tiny non-zero value rather than
      // letting the trigger be born with a bogus window before refresh() ever runs.
      end: () => layer.freezeEnd || 0.001,
      // Every refresh rewrites padding height and sticky top, so this defaults to true and
      // function-valued tween props get re-measured too. An explicit value is respected.
      invalidateOnRefresh: rest.invalidateOnRefresh ?? true,
      // Removes the layer when GSAP kills it (a matchMedia switch, say). It leaves `#layers`
      // immediately; a Scene layer's wrappers stay until the teardown #scheduleRebuild defers,
      // or, for the last layer or pin, until the scroll stops (see #disarmIfEmpty).
      onKill: (self) => {
        this.#captureScrollTriggerClass(self);

        removeItem(this.#layers, layer);
        this.#dirty = true;
        this.#scheduleRebuild();
        this.#disarmIfEmpty();
        onKill?.(self);
      },
      onRefreshInit: this.#createAutoRefreshHandler(rest.onRefreshInit),
    };
  }

  // Builds the ScrollTrigger config for an effect that sticky-pins a Scene. Registration order
  // doesn't matter, since refresh() builds in DOM order.
  // start/end default to GSAP's own defaults for a pinned trigger:
  // - start (ScrollTrigger.js:1339, `vars.start || (... pin ? "0 0" : "0 100%")`): trigger's own
  //   top reaching the viewport's top.
  // - end (ScrollTrigger.js:1401, `parsedEnd || (parsedEndTrigger ? "100% 0" : max)`): endTrigger's
  //   own bottom edge reaching the viewport's top edge, so dwell for endTrigger's own height plus
  //   the dwell of the Scene layers nested inside it, rather than a fixed distance.
  //   parsedEndTrigger defaults to trigger itself and so is always truthy, which makes "100% 0"
  //   GSAP's real default whether or not pinning is used.
  createStickyTrigger({
    trigger: triggerInput,
    start = '0 0',
    end = '100% 0',
    endTrigger: endTriggerInput,
    onKill,
    ...rest
  }: CreateStickyTriggerOptions): ScrollTrigger.Vars {
    this.#assertNoExcludedVars(rest, 'createStickyTrigger');
    this.#flushOverlappingDisarms();

    const trigger = resolveElement(triggerInput, 'createStickyTrigger');

    this.#assertTriggerInsideRoot(trigger, 'createStickyTrigger');

    const endTrigger = resolveEndTrigger(trigger, endTriggerInput, 'createStickyTrigger');

    return this.#registerLayer(
      {
        kind: 'scene',
        trigger,
        endTrigger,
        container: null,
        wrapper: null,
        padding: null,
        start,
        end,
        freezeStart: 0,
        freezeEnd: 0,
        engagedStart: 0,
        engagedEnd: 0,
      },
      onKill,
      rest,
    );
  }

  // Registers an overlap-scroll effect: the elements from right after trigger onward cover
  // trigger. Creates no tween and no dwell padding, and the returned Vars only describes the
  // freeze window, which the caller passes to ScrollTrigger.create().
  createOverlapScroll({
    trigger: triggerInput,
    cover,
    start = 'bottom bottom',
    end = null,
    endTrigger: endTriggerInput,
    onKill,
    ...rest
  }: CreateOverlapScrollOptions): ScrollTrigger.Vars {
    this.#assertNoExcludedVars(rest, 'createOverlapScroll');
    this.#flushOverlappingDisarms();

    const trigger = resolveElement(triggerInput, 'createOverlapScroll');

    // Ahead of the cover checks below, so an outside trigger is reported as such rather than as a
    // cover problem.
    this.#assertTriggerInsideRoot(trigger, 'createOverlapScroll');

    const endTrigger = resolveEndTrigger(trigger, endTriggerInput, 'createOverlapScroll');
    const coverElement = cover === undefined ? trigger.nextElementSibling : resolveElement(cover, 'createOverlapScroll');

    if (!(coverElement instanceof HTMLElement)) {
      throw new Error(
        `createOverlapScroll: cover element (trigger.nextElementSibling) not found for trigger `
        + `${describeElement(trigger)}`,
      );
    }

    if (coverElement.parentNode !== trigger.parentNode) {
      throw new Error(
        `createOverlapScroll: cover ${describeElement(coverElement)} must be a sibling of trigger `
        + describeElement(trigger),
      );
    }

    const layer: CoverLayer = {
      kind: 'cover',
      trigger,
      endTrigger,
      cover: coverElement,
      wrapper: null,
      start,
      end,
      freezeStart: 0,
      freezeEnd: 0,
      engagedStart: 0,
      engagedEnd: 0,
    };
    // liftAboveStickyWrapper runs only after #registerLayer succeeds: a layer rejected as a
    // duplicate never reaches `#layers`, so neither onKill nor destroy() could find it to restore.
    const vars = this.#registerLayer(
      layer,
      (self) => {
        // Read out of the map rather than closed over: #liftCovers replaces the restore on every
        // refresh, and the one made here stops matching the elements actually lifted.
        this.#coverRestoreByLayer.get(layer)?.();
        // The wrapper holds trigger's siblings, which matchMedia's next setup reads in the same
        // task (the default cover is trigger.nextElementSibling). It moves only what the deferred
        // teardown would, so it can come off now.
        unbuildCover(layer);
        onKill?.(self);
      },
      rest,
    );

    // Usage that skips ScrollTrigger.create() never fires GSAP's onKill, so destroy() needs its
    // own handle on the restore.
    this.#coverRestoreByLayer.set(layer, liftAboveStickyWrapper(coverElement));

    return vars;
  }

  // Pins a small element with plain position:sticky. It starts once trigger naturally arrives at
  // that position and releases once endTrigger's end clause reaches the viewport. Unlike
  // Scene/Cover layers, this wraps trigger alone in outer{ inner{ trigger } }, so it's free of
  // nested-sticky lag on either side of the shared container, whatever the registration or DOM
  // order.
  //
  // The returned Vars does nothing on the ScrollTrigger side and keeps start/end at their
  // defaults. It exists so the caller can pass it to ScrollTrigger.create() and get the hooks:
  // onKill cleans up after an individual kill (it drops the layer from pinLayers and undoes
  // outer), and onRefreshInit binds refresh() to the refreshInit GSAP fires on resize/load, so
  // the caller doesn't write ScrollTrigger.addEventListener('refreshInit', refresh) by hand.
  //
  // endTrigger and end default to GSAP's own, as createStickyTrigger's do:
  // endTrigger falls back to trigger (ScrollTrigger.js:1338, `vars.endTrigger || trigger`) and end
  // to 'bottom top' (ScrollTrigger.js:1401, `parsedEnd || (parsedEndTrigger ? "100% 0" : max)`,
  // where parsedEndTrigger is always truthy). Omitting both holds the pin for trigger's own
  // height, matching GSAP's pin: true.
  // 'top top' can't be the end default: resolved against trigger itself it names the pin's own
  // engagement point, so the pin would release the moment it engages.
  createStickyPin({
    trigger: triggerInput,
    start,
    top,
    endTrigger: endTriggerInput,
    end = 'bottom top',
    onKill,
    ...rest
  }: CreateStickyPinOptions): ScrollTrigger.Vars {
    this.#assertNoExcludedVars(rest, 'createStickyPin');
    this.#flushOverlappingDisarms();

    if (this.#destroyed) {
      throw new Error(
        'StickyScrollTrigger: cannot register a new pin after destroy() has been called.',
      );
    }

    // Both name the pinned position, so accepting both would mean silently picking a winner.
    if (start !== undefined && top !== undefined) {
      throw new Error(
        'StickyScrollTrigger: createStickyPin accepts either start or top, not both '
        + '(top: 20 is start: \'top 20px\'). Use top for a plain px distance from the viewport\'s '
        + 'top edge, start for anything else.',
      );
    }

    const trigger = resolveElement(triggerInput, 'createStickyPin');
    const endTrigger = resolveEndTrigger(trigger, endTriggerInput, 'createStickyPin');

    this.#assertTriggerNotEnclosingRoot(trigger, 'createStickyPin');

    this.#assertTriggerAvailable(
      this.#pinLayers,
      trigger,
      `StickyScrollTrigger: ${describeElement(trigger)} is already registered as a pin trigger.`,
    );

    // The reverse direction of the same-kind check on #registerLayer's side (see its comment).
    this.#assertTriggerAvailable(
      this.#layers,
      trigger,
      `StickyScrollTrigger: ${describeElement(trigger)} is already registered as a trigger for `
      + 'another layer (createStickyTrigger/createOverlapScroll). Using the same element as both '
      + 'a Scene/Cover trigger and a pin trigger wraps it twice and produces conflicting '
      + 'position:sticky behavior.',
    );

    const layer: PinLayer = {
      trigger,
      // Only initializes the field: #wrapUnwrappedPins overwrites it before anything reads it.
      savedPosition: captureInlinePosition(trigger),
      outer: null,
      inner: null,
      start: top === undefined ? start ?? 'top top' : topToStartClause(top),
      endTrigger,
      end,
    };

    this.#arm();
    this.#pinLayers.push(layer);

    return {
      ...rest,
      trigger,
      onKill: (self) => {
        this.#captureScrollTriggerClass(self);

        removeItem(this.#pinLayers, layer);

        // outer reserves trigger's own height, so unwrapping gives back no height, but it does
        // restore the margin collapsing between trigger and its siblings that the wrappers
        // blocked. That still moves everything below, invalidating every later Scene layer's
        // freeze window. A pin that was never wrapped moved nothing.
        if (this.#unwrapPinLayer(layer)) this.#scheduleRebuild();

        this.#disarmIfEmpty();
        onKill?.(self);
      },
      onRefreshInit: this.#createAutoRefreshHandler(rest.onRefreshInit),
    };
  }

  // Returns the absolute scroll position (px) a GSAP-standard position clause points to, for any
  // element inside the shared container, registered as a layer or not. Nested sticky delays an
  // inner element's on-screen movement by the dwell of every Scene layer that freezes before it
  // gets there, which plain GSAP ScrollTrigger knows nothing about, so this adds that dwell (see
  // freezeWindow.ts's dwellBeforeReach) back onto the static documentTop. Cover layers are
  // excluded, never having changed the document height. Call this only after refresh() has run.
  resolveScrollPosition(
    elementInput: string | HTMLElement,
    position: PositionInput,
  ): number {
    const element = resolveElement(elementInput, 'resolveScrollPosition');
    const resolved = resolveMaybeFn(position);
    const viewportHeight = measureViewportHeight();
    const classified = classifyPosition(resolved);

    switch (classified.kind) {
      // 'max' isn't relative to element at all: it's GSAP's scrollerMax, optionally offset. This
      // function registers no layer and adds no document height, so unlike Scene/Cover layers and
      // createStickyPin it can measure directly, with no circularity. Per this function's
      // contract, refresh() has already finalized every Scene layer's dwell padding by now.
      case 'max':
        return measureDocumentMaxScroll(viewportHeight)
          + resolveMaxOffset(classified.value, viewportHeight);

      // A fixed scroll position, independent of `element` entirely (see measure.ts's
      // resolveStartSpec).
      case 'absolute':
        return classified.value;

      // This takes one position at a time, with no start for a dwell to count from, so '+=500'
      // resolves as the clause it looks like. createResolvedTrigger's end applies the real dwell
      // meaning itself before delegating here.
      case 'dwell':
      case 'clause':
        return this.#resolveClauseScrollPosition(element, classified.value, viewportHeight);
    }
  }

  // resolveScrollPosition ends here for a clause, and for a dwell too (see the switch there for
  // why a dwell lands in the clause arithmetic).
  // element can sit anywhere in the shared container and isn't guaranteed to share stuck
  // ancestors with anything, so (like createStickyPin's trigger/endTrigger) its documentTop
  // needs its own reset rather than the cancellation a Scene layer's own dwell relies on. A
  // stuck ancestor here is a real possibility: once refresh() has applied a wrapper's
  // position:sticky, the browser engages and disengages it natively as scroll changes, including
  // during the documented function-valued start/end pattern GSAP re-evaluates on its own refresh.
  #resolveClauseScrollPosition(
    element: HTMLElement,
    clause: string,
    viewportHeight: number,
  ): number {
    const anchorOffset = resolveAnchorTop(clause, measureUsedHeight(element), viewportHeight);
    const restoreStickyState = this.#resetStickyState();
    const reachedAt = documentTop(element) - anchorOffset;

    restoreStickyState();

    return this.#addDwellBeforeReach(element, reachedAt);
  }

  // The scroll that really brings element to reachedAt, its natural reach point. Only elements
  // inside the shared container lag behind the nesting. One after it already has every layer's
  // dwell padding in its documentTop, so adding the dwell would count it twice.
  #addDwellBeforeReach(element: HTMLElement, reachedAt: number): number {
    if (!this.#rootElement.contains(element)) return reachedAt;

    return reachedAt + dwellBeforeReach(reachedAt, this.#engagedWindows());
  }

  // Where the page stands still for each Scene layer, in the shape freezeWindow.ts's and
  // scrollMargin.ts's helpers take. By default the layers the DOM holds: a killed layer's padding
  // stays until its catch-up runs, which can wait for the end of a scroll.
  #engagedWindows(
    layers: readonly Layer[] = this.#builtLayers,
  ): { freezeStart: number; freezeEnd: number }[] {
    return layers.flatMap((layer) => (layer.kind === 'scene'
      ? [{ freezeStart: layer.engagedStart, freezeEnd: layer.engagedEnd }]
      : []));
  }

  // Returns the absolute scroll position (px) at which element's own top edge reaches the
  // viewport's top edge ('top top'), for an element that might belong to any one of several
  // StickyScrollTrigger instances on the page. A same-page anchor link is the usual case: the
  // caller doesn't know in advance which shared container the target lives in, and applying the
  // wrong instance's dwell to a target it never delayed corrupts the result. So this finds the
  // instance whose container actually contains element and delegates to its resolveScrollPosition.
  // Reading #rootElement off any instance passed in, not just its own, works because private
  // fields are scoped to the class body rather than to `this`. An element outside every given
  // instance's container is measured directly, with no dwell to correct for.
  static getScrollTop(
    elementInput: string | HTMLElement,
    instances: readonly StickyScrollTrigger[],
  ): number {
    const element = resolveElement(elementInput, 'StickyScrollTrigger.getScrollTop');
    const owner = instances.find((instance) => instance.#rootElement.contains(element));

    if (owner) return owner.resolveScrollPosition(element, 'top top');

    // A pin can sit outside its own container, and element may be one or sit inside one.
    const restores = instances.map((instance) => instance.#resetPinStickyState());
    const top = documentTop(element);

    restores.forEach((restore) => restore());

    return top;
  }

  // A thin wrapper that calls resolveScrollPosition for trigger/start and endTrigger/end together,
  // building Vars for plain GSAP ScrollTrigger. Registers no layer: it has no freeze window and
  // sits outside refresh()'s scope.
  // start/end take GSAP's defaults for a trigger that doesn't pin, the only ones that can apply
  // here: pin is excluded from PassThroughVars, so these Vars never pin. GSAP spells them "0 100%"
  // (ScrollTrigger.js:1339) and "100% 0" (1401, see createStickyTrigger above); the keyword form
  // below says the same thing.
  createResolvedTrigger({
    trigger: triggerInput,
    start = 'top bottom',
    end = 'bottom top',
    endTrigger: endTriggerInput,
    ...rest
  }: CreateResolvedTriggerOptions): ScrollTrigger.Vars {
    this.#assertNoExcludedVars(rest, 'createResolvedTrigger');
    this.#flushOverlappingDisarms();

    const trigger = resolveElement(triggerInput, 'createResolvedTrigger');
    const endTrigger = resolveEndTrigger(trigger, endTriggerInput, 'createResolvedTrigger');

    return {
      ...rest,
      trigger,
      start: () => this.resolveScrollPosition(trigger, start),
      end: () => {
        const resolvedEnd = resolveMaybeFn(end);
        const classifiedEnd = classifyPosition(resolvedEnd);

        // A dwell counts its distance from the resolved start with endTrigger ignored, the way
        // GSAP and every other end path here read it (resolvePinReleaseScroll, measure.ts's
        // resolveEndSpec).
        // resolveScrollPosition has no dwell branch, so without this a '+=' end resolves against
        // endTrigger, and a '%' one scales against its height rather than the viewport.
        if (classifiedEnd.kind === 'dwell') {
          return this.resolveScrollPosition(trigger, start)
            + resolveDwell(classifiedEnd.value, measureViewportHeight());
        }

        // Both branches read start: the dwell above for its base, the spaced '+=' form below to
        // prefix its element token, which resolveScrollPosition can't do since it takes one
        // position at a time and never sees a start clause (Vars hand GSAP resolved numbers, so
        // GSAP's own prefixing never runs). GSAP shares no scope between the two callbacks, so a
        // function-valued start runs again here; caching would mean guessing where one refresh
        // ends, so this leans on what GSAP already assumes of start: a pure function of layout.
        return this.resolveScrollPosition(
          endTrigger,
          prefixSpacedRelativeEnd(start, resolvedEnd),
        );
      },
    };
  }

  // Tears the whole system down: unwinds the nested DOM and restores cover layers' z-order,
  // including layers that never went through GSAP's kill(). Destroying ScrollTrigger itself is
  // the caller's responsibility. Afterwards registration throws and refresh() does nothing.
  destroy(): void {
    if (this.#destroyed) return;

    // As the held last kill would have; the rest still runs if that throws.
    runEach(() => this.#flushPendingDisarmForRevert(), () => this.#tearDown());
  }

  #tearDown(): void {
    if (this.#restTimer !== null) clearTimeout(this.#restTimer);

    this.#restTimer = null;
    this.#destroyed = true;

    const run = this.#deferredRun;

    // Only drops the batch's refreshInit listener now.
    this.#deferredRun = null;
    run?.();

    // Already done by a last kill.
    if (this.#armed) this.#disarm();

    this.#layers.length = 0;
    this.#pinLayers.forEach((layer) => this.#unwrapPinLayer(layer));
    this.#pinLayers.length = 0;
    this.#scrollTriggerClass = null;
  }
}
