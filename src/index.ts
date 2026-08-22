/**
 * Pins multiple ScrollTrigger effects with native position:sticky instead of GSAP pinning, by
 * wrapping the shared container in nested sticky layers. This is the only public entry point;
 * every other module under src/ is internal.
 */

import {
  applyStickyPosition,
  captureInlinePosition,
  compareDocumentOrder,
  describeElement,
  documentTop,
  liftAboveStickyWrapper,
  measureDocumentMaxScroll,
  measureViewportHeight,
  resetStickyPosition,
  resolveElement,
  resolveEndTrigger,
  resolveRoot,
  restoreInlinePosition,
  unwrapPin,
  wrapPin,
} from './dom';
import { createScrollMarginSync } from './scrollMargin';
import { buildStructure, isDomOrderStale, unbuildStructure } from './structure';
import { planLayers } from './freezeWindow';
import type { EndSpec, LayerMeasurement, StartSpec } from './freezeWindow';
import {
  isAbsoluteFormat,
  isDwellFormat,
  isMaxFormat,
  resolveAbsolute,
  resolveAnchorTop,
  resolveDwell,
  resolveMaxOffset,
  resolveMaybeFn,
} from './position';
import type { EndValue, PositionInput, PositionValue } from './position';
import { EXCLUDED_VAR_KEYS } from './vars';
import type {
  CoverLayer,
  CreateOverlapScrollOptions,
  CreateResolvedTriggerOptions,
  CreateStickyPinOptions,
  CreateStickyTriggerOptions,
  Layer,
  PinLayer,
  SceneLayer,
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

// Converts a resolved end value into an EndSpec. Only a position-clause end needs a decision
// here: where endTrigger's position comes from.
// - a registered layer: pass 2 (planLayers) resolves it, including a cover layer's forward
//   reference, which converges because cover layers add no padding. A Scene layer's forward
//   reference is rejected outright, since its own dwell precedes anything after it.
// - unregistered, inside the shared container: pass 1 measures it, pass 2 adds precedingGaps.
// - unregistered, outside it: padding shifts the measurement, so pass 2 re-measures (measureLive).
const resolveEndSpec = (
  rootElement: HTMLElement,
  viewportHeight: number,
  layer: Layer,
  endResolved: EndValue | null,
  ownIndex: number,
  endTriggerIndex: number | null,
): EndSpec => {
  if (endResolved === null) return { mode: 'auto' };

  if (isDwellFormat(endResolved)) {
    return {
      mode: 'dwell',
      distancePx: Math.max(0, resolveDwell(endResolved, viewportHeight)),
    };
  }

  if (isAbsoluteFormat(endResolved)) {
    return { mode: 'absolute', value: resolveAbsolute(endResolved) };
  }

  // A Scene layer's own dwell padding adds to the document's max scroll position, so a 'max' end
  // would depend on itself, growing the page a little more on every refresh instead of settling.
  // Cover layers add no padding.
  if (isMaxFormat(endResolved)) {
    if (layer.kind !== 'cover') {
      throw new Error(
        `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)} `
        + `has end "${endResolved}". GSAP's 'max' keyword isn't supported here: the layer's own `
        + 'dwell padding adds to the document\'s max scroll position, so the freeze window would '
        + 'depend on itself. Use createOverlapScroll, which adds no padding, or a dwell distance '
        + 'such as \'+=500\'.',
      );
    }

    return { mode: 'max', offsetPx: resolveMaxOffset(endResolved as string, viewportHeight) };
  }

  // The same self-reference as the 'max' case above, reached through a registered layer instead:
  // a Scene layer's dwell padding pushes down everything after it in DOM order, so referencing a
  // later layer's position means depending on its own dwell. Iteration can't fix this one, since
  // the layer's own paddingHeight cancels out of its defining equation, leaving a contradiction
  // or an arbitrary value. Cover layers add no padding, so planLayers resolves their forward
  // references normally.
  if (layer.kind !== 'cover' && endTriggerIndex !== null && endTriggerIndex > ownIndex) {
    throw new Error(
      `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)}'s `
      + `endTrigger (${describeElement(layer.endTrigger)}) refers to a layer positioned later `
      + 'in DOM order, which isn\'t supported: this layer\'s own dwell padding pushes that one '
      + 'down, so the freeze window would depend on its own dwell. Point endTrigger at a layer '
      + 'earlier in DOM order, or use a dwell distance such as \'+=500\'.',
    );
  }

  const unregistered = endTriggerIndex === null;
  const insideRoot = rootElement.contains(layer.endTrigger);

  // A Scene layer stretches the document by its own dwell, pushing an endTrigger outside the
  // shared container down by that same amount, so the equation has no solution. Cover layers add
  // no padding, so they're safe.
  if (unregistered && !insideRoot && layer.kind !== 'cover') {
    throw new Error(
      `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)} `
      + `has an endTrigger (${describeElement(layer.endTrigger)}) outside the shared `
      + 'container: the layer\'s own dwell keeps pushing it away, so the freeze window never '
      + 'settles. Point endTrigger at an element inside the container, or use a dwell distance '
      + 'such as \'+=500\'.',
    );
  }

  return {
    mode: 'clause',
    clause: endResolved as string,
    rawTop: unregistered && insideRoot ? documentTop(layer.endTrigger) : null,
    measureLive: unregistered && !insideRoot,
  };
};

// Converts a resolved start value into a StartSpec. position.ts's isAbsoluteFormat defines which
// values GSAP reads as an absolute scroll position rather than a clause.
// A cover layer's stickyTop is computed relative to its own wrapper's natural position (see
// freezeWindow.ts), so it needs a clause. An absolute scroll position means nothing in that
// local coordinate space, so this throws instead of turning it into a plausible-looking number.
// A Scene layer's stickyTop is already document-absolute and works with either.
const resolveStartSpec = (
  layer: Layer,
  startResolved: PositionValue,
  elementHeight: number,
  viewportHeight: number,
): StartSpec => {
  if (!isAbsoluteFormat(startResolved)) {
    return {
      mode: 'clause',
      anchorOffset: resolveAnchorTop(startResolved as string, elementHeight, viewportHeight),
    };
  }

  if (layer.kind === 'cover') {
    throw new Error(
      `StickyScrollTrigger: createOverlapScroll's trigger ${describeElement(layer.trigger)} has `
      + `start "${startResolved}", an absolute scroll position (GSAP reads any bare number this `
      + 'way). That isn\'t supported here: a cover layer\'s sticky position is computed relative '
      + 'to its own wrapper, so start must be a position clause such as \'bottom bottom\'.',
    );
  }

  return { mode: 'absolute', value: resolveAbsolute(startResolved) };
};

// Measures one layer's natural absolute position and resolves its start/end, in
// #planLayerPositions' pass 1.
const measureLayer = (
  rootElement: HTMLElement,
  viewportHeight: number,
  layer: Layer,
  ownIndex: number,
  indexByTrigger: ReadonlyMap<HTMLElement, number>,
): LayerMeasurement => {
  const startResolved = resolveMaybeFn(layer.start);
  const endResolved = layer.end === null ? null : resolveMaybeFn(layer.end);
  const elementHeight = layer.trigger.offsetHeight;
  const endTriggerIsSelf = layer.endTrigger === layer.trigger;
  const endTriggerIndex = indexByTrigger.get(layer.endTrigger) ?? null;
  const end = resolveEndSpec(
    rootElement,
    viewportHeight,
    layer,
    endResolved,
    ownIndex,
    endTriggerIndex,
  );
  const start = resolveStartSpec(layer, startResolved, elementHeight, viewportHeight);

  return {
    kind: layer.kind,
    start,
    triggerTop: documentTop(layer.trigger),
    wrapperTop: layer.wrapper ? documentTop(layer.wrapper) : 0,
    coverTop: layer.kind === 'cover' ? documentTop(layer.cover) : 0,
    end,
    endTriggerIsSelf,
    endTriggerIndex,
    endTriggerHeight: end.mode === 'clause' ? layer.endTrigger.offsetHeight : 0,
  };
};

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

// Shared by the layer and pin registration paths, which both reject an already-registered trigger.
const hasDuplicateTrigger = (
  list: readonly { trigger: HTMLElement }[],
  trigger: HTMLElement,
): boolean => list.some((existing) => existing.trigger === trigger);

export default class StickyScrollTrigger {
  #rootElement: HTMLElement;
  // The set of layers that "should" exist. Changes immediately on register, kill, and reorder.
  #layers: Layer[] = [];
  // The layers actually built into the DOM. A layer that a kill removed from `#layers` stays here
  // as long as it's still built, so teardown never loses it mid-batch.
  #builtLayers: Layer[] = [];
  // Restore callbacks for cover layers' z-order. Kept in a WeakMap so destroy() can call them
  // even without going through GSAP's onKill.
  #coverRestoreByLayer = new WeakMap<CoverLayer, () => void>();
  #built = false;
  #dirty = false; // Set true when a trigger is added/removed; rebuilt on the next refresh().
  #outermostContainer: HTMLDivElement | null = null;
  #destroyed = false;
  #rebuildScheduled = false;
  // The ScrollTrigger class, read at runtime off the `self` GSAP passes to its callbacks, so gsap
  // is never imported (see #scheduleRebuild). Null until the first onKill/onRefreshInit.
  #scrollTriggerClass: { refresh(safe?: boolean): void } | null = null;
  // Independent of Scene/Cover layers, implemented with plain position:sticky alone.
  #pinLayers: PinLayer[] = [];
  // Keeps scroll-margin-top on same-page-link targets in step with the current freeze windows,
  // so the browser's own scroll-into-view accounts for Scene layer dwell (see scrollMargin.ts).
  #scrollMarginSync: ReturnType<typeof createScrollMarginSync>;
  #scrollMarginTargets: string | null;

  constructor(root: string | HTMLElement, options: StickyScrollTriggerOptions = {}) {
    this.#rootElement = resolveRoot(root);
    this.#scrollMarginSync = createScrollMarginSync(this.#rootElement);
    this.#scrollMarginTargets = options.scrollMarginTargets === undefined
      ? '[id]'
      : options.scrollMarginTargets;

    // Validated here rather than inside refresh(): refresh() runs from GSAP's own dispatch, so
    // an uncaught SyntaxError from querySelectorAll on an invalid selector would abort every
    // other ScrollTrigger's refresh on the page.
    if (this.#scrollMarginTargets !== null) {
      try {
        this.#rootElement.querySelectorAll(this.#scrollMarginTargets);
      } catch {
        throw new Error(
          `StickyScrollTrigger: scrollMarginTargets "${this.#scrollMarginTargets}" is not a `
          + 'valid CSS selector.',
        );
      }
    }
  }

  #unbuild() {
    if (!this.#built) return;

    unbuildStructure(this.#rootElement, this.#builtLayers, this.#outermostContainer);
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

  // Defers teardown and rebuild to a microtask, so kills within the same task coalesce into one
  // refresh(). Rebuilding per kill would be O(n^2), and moving the shared container's subtree
  // each time breaks iframes and focus.
  //
  // GSAP doesn't re-read function-valued start/end until ScrollTrigger.refresh() is called, so
  // refresh() alone would leave GSAP's cache holding stale freezeStart/freezeEnd. Calling
  // ScrollTrigger.refresh() right after keeps the two in sync.
  #scheduleRebuild() {
    if (this.#rebuildScheduled || this.#destroyed) return;

    this.#rebuildScheduled = true;
    queueMicrotask(() => {
      this.#rebuildScheduled = false;

      if (this.#destroyed) return;

      this.refresh();

      // self.constructor is an undocumented GSAP implementation detail, so this skips silently
      // in case it ever changes.
      if (typeof this.#scrollTriggerClass?.refresh === 'function') this.#scrollTriggerClass.refresh();
    });
  }

  // Reads the ScrollTrigger class off the `self` that onKill/onRefreshInit pass in, so gsap is
  // never imported (see #scheduleRebuild). Shared by #registerLayer's and createStickyPin's
  // handlers.
  #captureScrollTriggerClass(self: ScrollTrigger) {
    this.#scrollTriggerClass = self.constructor as unknown as {
      refresh(safe?: boolean): void;
    };
  }

  // Binds refresh() to the refreshInit GSAP itself fires (resize/load), so callers get the right
  // ordering without writing ScrollTrigger.addEventListener('refreshInit', refresh) themselves.
  // Every layer refreshes: GSAP runs all refreshInit listeners before it measures anything, so a
  // layer that skipped refresh() would leave its callback's layout changes out of the freeze
  // window. That costs one refresh() per layer, on the resize and load refreshes GSAP fires.
  #createAutoRefreshHandler(
    userOnRefreshInit: ScrollTrigger.Vars['onRefreshInit'],
  ): ScrollTrigger.Vars['onRefreshInit'] {
    return (self) => {
      this.#captureScrollTriggerClass(self);

      // GSAP dispatches refreshInit before any measurement, so a callback that puts something in
      // place to be measured expects to run before refresh() too.
      const result = userOnRefreshInit?.(self);

      this.refresh();

      // GSAP reverts an animation a refreshInit listener returns, once the refresh is done
      // (ScrollTrigger.js's `refreshInits.forEach(...render(-1))`).
      return result;
    };
  }

  // Wraps any not-yet-built pin layer. Must run before #refreshScenesAndCovers measures Scene and
  // Cover positions: wrapping takes trigger out of the flow (into outer{height:0}), so measuring
  // first would count trigger's own height on the first refresh() only, throwing off every Scene
  // layer below it.
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

  // #wrapUnwrappedPins's counterpart. Nulling outer keeps it idempotent: destroy() and a kill
  // both run over the same layer, and a second unwrap would put savedPosition back over whatever
  // inline position/top the caller has set on trigger since the first.
  #unwrapPinLayer(layer: PinLayer): boolean {
    if (!layer.outer) return false;

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
  // throwing path (see the catch there for why).
  #resetSceneCoverStickyState(): () => void {
    const wrapperSnapshots = this.#layers
      .map((layer) => layer.wrapper)
      .filter((wrapper): wrapper is HTMLDivElement => wrapper !== null)
      .map((wrapper) => ({
        wrapper,
        position: wrapper.style.position,
        top: wrapper.style.top,
      }));

    wrapperSnapshots.forEach(({ wrapper }) => resetStickyPosition(wrapper));

    return () => {
      wrapperSnapshots.forEach(({ wrapper, position, top }) => {
        wrapper.style.position = position;
        wrapper.style.top = top;
      });
    };
  }

  // Pass 1 of the pin refresh: snapshots and strips every pin's own sticky top and spacer height,
  // returning a function that puts them back. #refreshPinLayers then measures a natural position
  // rather than the previous refresh's result.
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
      this.#refreshPinLayers(viewportHeight);
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
  // spans from the natural position where pinning begins to the absolute position where
  // endTrigger's clause reaches the viewport's, plus the sticky top and trigger's own height (a
  // sticky element unpins once it catches up to the bottom of its containing block).
  #refreshPinLayers(viewportHeight: number) {
    this.#pinLayers.forEach((layer) => {
      if (!layer.inner) return;

      const resolvedEnd = resolveMaybeFn(layer.end);

      // The same self-reference resolveEndSpec rejects for Scene layers: the pin's own spacer
      // (layer.inner) adds to the document's max scroll position.
      if (isMaxFormat(resolvedEnd)) {
        throw new Error(
          `StickyScrollTrigger: createStickyPin's end "${resolvedEnd}" uses GSAP's 'max' keyword, `
          + 'which isn\'t supported here: the pin\'s own spacer height adds to the document\'s '
          + 'max scroll position, so it would depend on itself. Use a position clause against '
          + 'endTrigger, such as \'top top\'.',
        );
      }

      const resolvedStart = resolveMaybeFn(layer.start);
      const triggerTop = documentTop(layer.trigger);
      const triggerHeight = layer.trigger.offsetHeight;

      // A bare number keeps GSAP's meaning, an absolute scroll position, which a pin can't act on.
      // A Scene layer honors one because its freeze window is a scroll range to begin with and its
      // sticky top follows from that range (freezeWindow.ts's `structureTop - freezeStart`). A pin
      // runs the other way: topPx below is the only value it has, and the scroll position it
      // engages at (triggerTop - topPx) follows from that. Inverting it would mean already knowing
      // triggerTop, and anyone who does would write the px distance directly, which is what `top`
      // is for.
      if (isAbsoluteFormat(resolvedStart)) {
        throw new Error(
          `StickyScrollTrigger: createStickyPin's start "${resolvedStart}" is an absolute scroll `
          + 'position (GSAP reads any bare number this way). A pin can\'t act on one: it '
          + 'engages when position:sticky engages, so start says where trigger sits in the '
          + `viewport while pinned. Use the top option (top: ${resolvedStart}) for a px distance `
          + `from the viewport's top edge, or a position clause such as 'top top'.`,
        );
      }

      const topPx = resolveAnchorTop(resolvedStart as string, triggerHeight, viewportHeight);
      // An absolute end (a bare number, matching GSAP) releases the pin at that fixed scroll
      // position directly, independent of endTrigger entirely. Same idea as an absolute start
      // for Scene/Cover layers (see resolveStartSpec above).
      const releaseTop = isAbsoluteFormat(resolvedEnd)
        ? resolveAbsolute(resolvedEnd)
        : documentTop(layer.endTrigger) - resolveAnchorTop(
          resolvedEnd as string,
          layer.endTrigger.offsetHeight,
          viewportHeight,
        );
      const height = releaseTop - triggerTop + topPx + triggerHeight;

      applyStickyPosition(layer.trigger, topPx);
      layer.inner.style.height = `${Math.max(0, height)}px`;
    });
  }

  // Recomputes each layer's sticky top, padding height, and start/end. This disables sticky on
  // every wrapper before the two passes below run, and puts it back if either one throws.
  #refreshScenesAndCovers(viewportHeight: number) {
    if (!this.#layers.length) return;

    const active = this.#layers.filter((layer) => layer.wrapper !== null);

    if (!active.length) return;

    const restoreStickyState = this.#resetSceneCoverStickyState();

    try {
      this.#planLayerPositions(viewportHeight, active);
    } catch (error) {
      // The same window and reasoning as #refreshPins' `finally`. The one difference is `catch`
      // rather than `finally`: pass 2 writes the new sticky state itself, so after a successful
      // pass the snapshot holds what that pass replaced, and restoring it would undo the lot.
      restoreStickyState();

      throw error;
    }
  }

  // Pass 1 measures every layer's natural position, then pass 2 (planLayers) applies sticky and
  // padding while accumulating precedingGaps in DOM order. Keeping them separate is what stops an
  // earlier layer's applied sticky from throwing off a later layer's measurement.
  // Forward references are resolved by planLayers' fixed-point iteration rather than by this pass
  // ordering. An endTrigger outside the shared container isn't at the right position until padding
  // is finalized, so pass 2 runs a second time in that case alone (cover layers only;
  // resolveEndSpec rejects it for Scene layers).
  // The arithmetic lives in freezeWindow.ts's planLayers, which touches no DOM; this function only
  // measures and writes.
  #planLayerPositions(viewportHeight: number, active: readonly Layer[]) {
    // Scene layers' wrappers line up at the start of the nested container, so every layer's
    // natural position aligns here.
    const structureTop = this.#outermostContainer ? documentTop(this.#outermostContainer) : 0;
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

          if (!layer.wrapper) return;

          applyStickyPosition(layer.wrapper, plan.stickyTop);

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
  }

  // Public entry point. Rebuilds the nesting if triggers were added/removed, and recomputes
  // both the Scene/Cover layers and the pin layers.
  refresh(): void {
    if (this.#destroyed) return;

    // Checks DOM-order changes as well as dirty (layer count changes),
    // since a reorder with no additions/removals never sets dirty.
    if (this.#dirty || !this.#built || isDomOrderStale(this.#layers)) {
      this.#unbuild();
      this.#build();
    }

    // Must happen before #refreshScenesAndCovers measures Scene/Cover positions (see
    // #wrapUnwrappedPins's own comment for why).
    this.#wrapUnwrappedPins();

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

  // Hands the current Scene layer freeze windows to the scroll-margin bookkeeping, along with the
  // outermost container as the host for the scroll-driven ramps. That container is built by this
  // module and is an ancestor of every target, which is what lets the ramps reach them by
  // inheritance without ever styling an element the caller owns.
  #syncScrollMargins(): void {
    this.#scrollMarginSync.sync(
      this.#layers
        .filter((layer): layer is SceneLayer => layer.kind === 'scene')
        .map(({ trigger, freezeStart, freezeEnd }) => ({ trigger, freezeStart, freezeEnd })),
      this.#outermostContainer,
      this.#scrollMarginTargets,
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
      `${context}: trigger ${describeElement(trigger)} ${relation}. A pin wraps trigger in a `
      + 'height:0, contain:layout box, which would pull the container and every layer\'s dwell '
      + 'padding out of the flow. Pin an element that doesn\'t contain the container.',
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
      // immediately, while the DOM teardown #scheduleRebuild defers works from #builtLayers, so
      // the wrapper survives that deferral.
      onKill: (self) => {
        this.#captureScrollTriggerClass(self);

        const index = this.#layers.indexOf(layer);

        if (index !== -1) this.#layers.splice(index, 1);

        this.#dirty = true;
        this.#scheduleRebuild();
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
  //   own bottom edge reaching the viewport's top edge, so dwell for endTrigger's own height rather
  //   than a fixed distance. parsedEndTrigger defaults to trigger itself and so is always truthy,
  //   which makes "100% 0" GSAP's real default whether or not pinning is used.
  createStickyTrigger({
    trigger: triggerInput,
    start = '0 0',
    end = '100% 0',
    endTrigger: endTriggerInput,
    onKill,
    ...rest
  }: CreateStickyTriggerOptions): ScrollTrigger.Vars {
    this.#assertNoExcludedVars(rest, 'createStickyTrigger');

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
    };
    // liftAboveStickyWrapper runs only after #registerLayer succeeds: a layer rejected as a
    // duplicate never reaches `#layers`, so neither onKill nor destroy() could find it to restore.
    const vars = this.#registerLayer(
      layer,
      (self) => {
        restoreCoverStyles();
        onKill?.(self);
      },
      rest,
    );
    const restoreCoverStyles = liftAboveStickyWrapper(coverElement);

    // Usage that skips ScrollTrigger.create() never fires GSAP's onKill, so destroy() needs its
    // own handle on the restore.
    this.#coverRestoreByLayer.set(layer, restoreCoverStyles);

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
  createStickyPin({
    trigger: triggerInput,
    start,
    top,
    endTrigger: endTriggerInput,
    end = 'top top',
    onKill,
    ...rest
  }: CreateStickyPinOptions): ScrollTrigger.Vars {
    this.#assertNoExcludedVars(rest, 'createStickyPin');

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
    const endTrigger = resolveElement(endTriggerInput, 'createStickyPin');

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

    this.#pinLayers.push(layer);

    return {
      ...rest,
      trigger,
      onKill: (self) => {
        this.#captureScrollTriggerClass(self);

        const index = this.#pinLayers.indexOf(layer);

        if (index !== -1) this.#pinLayers.splice(index, 1);

        // outer is height:0, so unwrapping puts trigger's own height back into the flow and
        // moves everything below it down by that much. That invalidates every later Scene
        // layer's freeze window. A pin that was never wrapped moved nothing.
        if (this.#unwrapPinLayer(layer)) this.#scheduleRebuild();

        onKill?.(self);
      },
      onRefreshInit: this.#createAutoRefreshHandler(rest.onRefreshInit),
    };
  }

  // Returns the absolute scroll position (px) a GSAP-standard position clause points to, for any
  // element inside the shared container, registered as a layer or not. Nested sticky delays an
  // inner element's on-screen movement by exactly the enclosing Scene layers' dwell, which plain
  // GSAP ScrollTrigger knows nothing about, so this adds that dwell (freezeEnd - freezeStart, over
  // every Scene layer earlier than the element) back onto the static documentTop. Cover layers are
  // excluded, never having changed the document height. Call this only after refresh() has run.
  resolveScrollPosition(
    elementInput: string | HTMLElement,
    position: PositionInput,
  ): number {
    const element = resolveElement(elementInput, 'resolveScrollPosition');
    const resolved = resolveMaybeFn(position);
    const viewportHeight = measureViewportHeight();

    // 'max' isn't relative to element at all: it's GSAP's scrollerMax, optionally offset. This
    // function registers no layer and adds no document height, so unlike Scene/Cover layers and
    // createStickyPin it can measure directly, with no circularity. Per this function's contract,
    // refresh() has already finalized every Scene layer's dwell padding by now.
    if (isMaxFormat(resolved)) {
      return measureDocumentMaxScroll(viewportHeight)
        + resolveMaxOffset(resolved as string, viewportHeight);
    }

    // A fixed scroll position, independent of `element` entirely (see resolveStartSpec above).
    if (isAbsoluteFormat(resolved)) return resolveAbsolute(resolved);

    let gap = 0;

    this.#layers.forEach((layer) => {
      if (layer.kind !== 'scene') return;

      if (compareDocumentOrder(layer.trigger, element) >= 0) return;

      gap += layer.freezeEnd - layer.freezeStart;
    });

    const anchorOffset = resolveAnchorTop(resolved as string, element.offsetHeight, viewportHeight);
    // element can sit anywhere in the shared container and isn't guaranteed to share stuck
    // ancestors with anything, so (like createStickyPin's trigger/endTrigger) its documentTop
    // needs its own reset rather than the cancellation a Scene layer's own dwell relies on. A
    // stuck ancestor here is a real possibility: once refresh() has applied a wrapper's
    // position:sticky, the browser engages and disengages it natively as scroll changes, including
    // during the documented function-valued start/end pattern GSAP re-evaluates on its own refresh.
    const restoreSceneCoverStickyState = this.#resetSceneCoverStickyState();
    const result = documentTop(element) + gap - anchorOffset;

    restoreSceneCoverStickyState();

    return result;
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

    return documentTop(element);
  }

  // A thin wrapper that calls resolveScrollPosition for trigger/start and endTrigger/end together,
  // building Vars for plain GSAP ScrollTrigger. Registers no layer: it has no freeze window and
  // sits outside refresh()'s scope.
  createResolvedTrigger({
    trigger: triggerInput,
    start,
    end,
    endTrigger: endTriggerInput,
    ...rest
  }: CreateResolvedTriggerOptions): ScrollTrigger.Vars {
    this.#assertNoExcludedVars(rest, 'createResolvedTrigger');

    const trigger = resolveElement(triggerInput, 'createResolvedTrigger');
    const endTrigger = resolveEndTrigger(trigger, endTriggerInput, 'createResolvedTrigger');

    return {
      ...rest,
      trigger,
      start: () => this.resolveScrollPosition(trigger, start),
      end: () => this.resolveScrollPosition(endTrigger, end),
    };
  }

  // Tears the whole system down: unwinds the nested DOM and restores cover layers' z-order,
  // including layers that never went through GSAP's kill(). Destroying ScrollTrigger itself is
  // the caller's responsibility. Afterwards registration throws and refresh() does nothing.
  destroy(): void {
    if (this.#destroyed) return;

    this.#destroyed = true;
    // Before #unbuild removes the outermost container, which hosts the scroll-driven ramps.
    this.#scrollMarginSync.restore();
    this.#layers.forEach((layer) => {
      if (layer.kind === 'cover') this.#coverRestoreByLayer.get(layer)?.();
    });
    this.#unbuild();
    this.#layers.length = 0;
    this.#builtLayers = [];
    this.#pinLayers.forEach((layer) => this.#unwrapPinLayer(layer));
    this.#pinLayers.length = 0;
  }
}
