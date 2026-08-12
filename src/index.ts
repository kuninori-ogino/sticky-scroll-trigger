/**
 * An extension helper that pins multiple ScrollTrigger effects using native position:sticky
 * instead of GSAP pinning. It works by wrapping the shared container in nested sticky layers.
 * This file is the only public entry point;
 * position.ts/dom.ts/structure.ts/freezeWindow.ts/types.ts are internal modules.
 */

import {
  applyStickyPosition,
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

// Converts a resolved end value into an EndSpec. Only for a position-clause end does this decide
// how to find endTrigger's position: for a registered layer, pass 2 (planLayers) resolves it,
// including a cover layer's forward reference to a layer positioned later in DOM order. Cover
// layers create no padding, so that reference always converges via fixed-point iteration. A
// Scene layer's forward reference is rejected outright instead: its own dwell always precedes
// anything after it, making the reference self-referential no matter how it's computed. For an
// unregistered endTrigger inside the shared container, pass 1 can measure it directly and pass 2
// adds precedingGaps. Outside the container, the measurement is itself affected by padding, so
// it's re-measured in pass 2 after padding is applied (measureLive).
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

  // GSAP's 'max' keyword (the document's max scroll position). A Scene layer's own dwell padding
  // contributes to that same max scroll position, so its freeze window would depend on itself.
  // The equation never converges: each refresh grows the page a little more instead of settling.
  // Cover layers never create padding, so they don't have this problem.
  if (isMaxFormat(endResolved)) {
    if (layer.kind !== 'cover') {
      throw new Error(
        `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)} `
        + `has end "${endResolved}", which uses GSAP's 'max' keyword. This isn't supported here `
        + '(a Scene layer\'s own dwell padding contributes to the document\'s max scroll '
        + 'position, so the freeze window would depend on itself and never converge). Use '
        + 'createOverlapScroll instead (cover layers never add padding), or a dwell distance '
        + 'such as \'+=500\'.',
      );
    }

    return { mode: 'max', offsetPx: resolveMaxOffset(endResolved as string, viewportHeight) };
  }

  // A Scene layer's own dwell padding always precedes (and pushes down) everything positioned
  // after it in DOM order, regardless of what its own endTrigger points at. So a Scene layer
  // forward-referencing a later layer's position always depends on its own dwell: the same
  // self-reference problem as the 'max' keyword above, just reached through a registered-layer
  // reference instead of directly. Unlike 'max', this can't be fixed by iterating: there's no
  // fixed point, since the layer's own paddingHeight cancels out of its own defining equation,
  // leaving either a contradiction or an arbitrary value. Cover layers never create padding, so
  // they don't have this problem; planLayers resolves a cover layer's forward reference normally.
  if (layer.kind !== 'cover' && endTriggerIndex !== null && endTriggerIndex > ownIndex) {
    throw new Error(
      `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)}'s `
      + `endTrigger (${describeElement(layer.endTrigger)}) refers to a layer positioned later `
      + 'in DOM order. This isn\'t supported (the layer\'s own dwell padding always precedes and '
      + 'pushes down that later layer\'s position, so the freeze window would depend on its own '
      + 'dwell and never converge). Point endTrigger at a layer registered earlier in '
      + 'DOM order, or use a dwell distance such as \'+=500\' instead.',
    );
  }

  const unregistered = endTriggerIndex === null;
  const insideRoot = rootElement.contains(layer.endTrigger);

  // A Scene layer stretches the document by its own dwell, so an endTrigger outside the shared
  // container would keep retreating downward by that same amount, leaving the equation with no
  // solution (cover layers are safe here since they never create padding).
  if (unregistered && !insideRoot && layer.kind !== 'cover') {
    throw new Error(
      `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)} `
      + `has an endTrigger (${describeElement(layer.endTrigger)}) outside the shared `
      + 'container (the layer\'s own dwell would push it away, so the freeze window never '
      + 'converges). Point endTrigger at an element inside the container, or use a dwell '
      + 'distance such as \'+=500\'.',
    );
  }

  return {
    mode: 'clause',
    clause: endResolved as string,
    rawTop: unregistered && insideRoot ? documentTop(layer.endTrigger) : null,
    measureLive: unregistered && !insideRoot,
  };
};

// Converts a resolved start value into a StartSpec. GSAP's own _parsePosition treats a position
// value as an absolute scroll position whenever the entire value (a number, or a string
// containing nothing but a number) coerces cleanly via unary '+' (`isNaN(value) || (value =
// +value)` at ScrollTrigger.js:750), with no element lookup at all. See position.ts's
// isAbsoluteFormat for the exact check; a two-token clause like '500 top', or a suffixed value
// like '500px', doesn't qualify and still resolves as a position clause as before.
// A cover layer's stickyTop is computed relative to its own wrapper's natural position (see
// freezeWindow.ts's stickyTop formula for cover layers), which requires start to be a clause.
// An absolute scroll position has no meaning in that local coordinate space, unlike a Scene
// layer's stickyTop, which is already document-absolute and works with either. So this rejects
// it outright rather than silently producing a number that looks plausible but isn't.
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
      + `start "${startResolved}", an absolute scroll position (GSAP treats any bare-number `
      + 'start this way). This isn\'t supported here: a cover layer\'s sticky position is always '
      + 'computed relative to its own wrapper, which needs start to be a position clause (e.g. '
      + '\'bottom bottom\'), not an absolute scroll position.',
    );
  }

  return { mode: 'absolute', value: resolveAbsolute(startResolved) };
};

// Measures one layer's natural absolute position and end-resolution result together in pass 1
// (called from refreshScenesAndCovers's pass 1).
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

// Both layers and pinLayers share the constraint "the same trigger element can't be registered
// twice," so this check is factored out as common logic for both.
const hasDuplicateTrigger = (
  list: readonly { trigger: HTMLElement }[],
  trigger: HTMLElement,
): boolean => list.some((existing) => existing.trigger === trigger);

export default class StickyScrollTrigger {
  #rootElement: HTMLElement;
  // The set of layers that "should" exist. Changes immediately on register, kill, and reorder.
  #layers: Layer[] = [];
  // A snapshot of the layers that are "actually built into the DOM."
  // A layer removed from `#layers` by a kill can still remain here as long as it's still built,
  // so it isn't lost mid-batch during teardown.
  #builtLayers: Layer[] = [];
  // Restore callbacks for cover layers' z-order. Kept in a WeakMap so destroy() can call them
  // even without going through GSAP's onKill.
  #coverRestoreByLayer = new WeakMap<CoverLayer, () => void>();
  #built = false;
  #dirty = false; // Set true when a trigger is added/removed; rebuilt on the next refresh().
  #outermostContainer: HTMLDivElement | null = null;
  #destroyed = false;
  #rebuildScheduled = false;
  // Reference to the ScrollTrigger class, obtained from the self that GSAP's kill passes in.
  // Acquired at runtime without importing gsap (see #scheduleRebuild for details). Stays null
  // until a kill ever happens.
  #scrollTriggerClass: { refresh(safe?: boolean): void } | null = null;
  // Pin layers: a mechanism independent of Scene/Cover layers, implemented entirely with
  // plain position:sticky.
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

  // Even when multiple kills happen synchronously in a row, teardown and rebuild are coalesced
  // into one pass (doing it on every single kill would be O(n^2), and moving the shared
  // container's subtree each time breaks iframes and focus). This defers the work to a microtask
  // so multiple kills within the same task merge into a single refresh().
  //
  // GSAP doesn't re-read function-valued start/end until `ScrollTrigger.refresh()` is called, so
  // updating freezeStart/freezeEnd in refresh() leaves GSAP's own cache stale.
  // This grabs the ScrollTrigger class at runtime via `self.constructor` from the self that
  // onKill passes in (the killed ScrollTrigger itself),
  // and calls its refresh() right after the internal one to keep the cache in sync.
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

  // Obtains a reference to the ScrollTrigger class from the self that onKill/onRefreshInit pass in,
  // without ever importing gsap (see the comment on #scheduleRebuild's definition). Factored out
  // here since both #registerLayer's and createStickyPin's onKill/onRefreshInit call it.
  #captureScrollTriggerClass(self: ScrollTrigger) {
    this.#scrollTriggerClass = self.constructor as unknown as {
      refresh(safe?: boolean): void;
    };
  }

  // Builds an onRefreshInit handler that binds refresh() to the refreshInit GSAP itself fires
  // (resize/load, etc.), guaranteeing ordering without manually binding
  // ScrollTrigger.addEventListener('refreshInit', refresh). To avoid calling refresh() once per
  // layer/pin, only the current first entry of `list` takes responsibility (once it's killed,
  // the role passes to the next surviving entry). Note that for list=#layers,
  // refresh() itself reorders layers via layers.sort() into DOM order, so if DOM order and
  // creation order diverge within the same dispatch, it can rarely fire more than once
  // (list=#pinLayers has no such reordering, so a single call is guaranteed there).
  // refresh() itself is idempotent no matter how many times it's called,
  // so this causes no real harm.
  #createAutoRefreshHandler<T>(
    list: readonly T[],
    entry: T,
    userOnRefreshInit: ScrollTrigger.Vars['onRefreshInit'],
  ): ScrollTrigger.Vars['onRefreshInit'] {
    return (self) => {
      this.#captureScrollTriggerClass(self);

      if (list[0] === entry) this.refresh();

      userOnRefreshInit?.(self);
    };
  }

  // Wraps any not-yet-built pin layer via wrapPin(). Must run before #refreshScenesAndCovers
  // measures Scene/Cover positions: wrapping removes trigger from the document flow (into
  // outer{height:0}), so on the first refresh() it would still occupy its natural height during
  // that measurement, then collapse right after, throwing off every Scene layer below it by
  // trigger's own height, just once.
  #wrapUnwrappedPins() {
    this.#pinLayers.forEach((layer) => {
      if (layer.outer) return;

      const wrapped = wrapPin(layer.trigger);

      layer.outer = wrapped.outer;
      layer.inner = wrapped.inner;
    });
  }

  // Recomputes pin layers' sticky top and spacer height. Since this is implemented with plain
  // position:sticky alone, it never computes an absolute scroll position to hand to GSAP the way
  // Scene/Cover layers do.
  //
  // The spacer height is the distance from "the natural position where pinning begins"
  // to "the absolute position where endTrigger's clause reaches the viewport's clause,"
  // with the sticky top and trigger's own height added back (a sticky element unpins once
  // it catches up to the bottom of its containing block).
  // A Scene/Cover wrapper that's currently stuck (the page happens to be scrolled into its
  // freeze window when this runs) shifts documentTop for anything nested inside it, by however
  // far scroll has advanced past that wrapper's engagement point (see ARCHITECTURE.md's
  // "Two-pass position measurement"). A Scene layer's own dwell computation is a difference of
  // two documentTop calls sharing the same stuck ancestors, so that shift cancels out there, but
  // callers measuring arbitrary elements (a pin's trigger/endTrigger, or resolveScrollPosition's
  // element) aren't guaranteed to share stuck ancestors with anything, so it doesn't cancel out
  // automatically for them. Snapshot and reset every Scene/Cover wrapper's sticky state, returning
  // a function that restores it; callers must call that before returning.
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

  #refreshPins(viewportHeight: number) {
    if (!this.#pinLayers.length) return;

    // #refreshScenesAndCovers already finished applying its own (possibly-stuck) sticky state by
    // the time this runs, so trigger/endTrigger measurement below needs its own reset. This is a
    // separate pass 1/pass 2 split from the one below, which only concerns pins' own previous
    // sticky/spacer state.
    const restoreSceneCoverStickyState = this.#resetSceneCoverStickyState();

    // Pass 1: reset everything first so the previous sticky/spacer height doesn't affect
    // the reading, then measure the natural position.
    this.#pinLayers.forEach((layer) => {
      resetStickyPosition(layer.trigger);

      if (layer.inner) layer.inner.style.height = '';
    });

    this.#pinLayers.forEach((layer) => {
      if (!layer.inner) return;

      const resolvedEnd = resolveMaybeFn(layer.end);

      // GSAP's 'max' keyword isn't supported here: the pin's own spacer (layer.inner) height
      // contributes to the document's max scroll position, so the height would depend on itself
      // and never converge (same reasoning as resolveEndSpec's rejection for Scene layers).
      if (isMaxFormat(resolvedEnd)) {
        throw new Error(
          `StickyScrollTrigger: createStickyPin's end "${resolvedEnd}" uses GSAP's 'max' keyword, `
          + 'which isn\'t supported here (the pin\'s own spacer height contributes to the '
          + 'document\'s max scroll position, so the spacer height would depend on itself and '
          + 'never converge). Use a plain position clause such as \'top top\' against endTrigger '
          + 'instead.',
        );
      }

      const topPx = resolveMaybeFn(layer.top);
      const triggerTop = documentTop(layer.trigger);
      const triggerHeight = layer.trigger.offsetHeight;
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

    restoreSceneCoverStickyState();
  }

  // Recomputes each layer's sticky top, padding height, and start/end. This disables sticky
  // on every wrapper and measures every layer's natural position together (pass 1),
  // then applies sticky/padding while accumulating precedingGaps in DOM order
  // (pass 2 = planLayers).
  // Mixing pass 1 and pass 2 would let an earlier layer's applied sticky throw off a later
  // layer's measurement, so keeping them separate is essential.
  // A position-clause endTrigger pointing at a registered layer positioned later in DOM order
  // (a forward reference) is resolved by planLayers' fixed-point iteration, not by this pass
  // ordering. See freezeWindow.ts's planLayers.
  // An endTrigger outside the shared container isn't at the right position
  // until padding is finalized, so pass 2 runs a second time only in that case. This only
  // applies to cover layers; Scene layers are rejected in resolveEndSpec because their own
  // dwell pushes the measurement target away and never converges.
  // The arithmetic itself lives in freezeWindow.ts's planLayers (DOM-independent);
  // this function's job is just to "measure" and "write."
  #refreshScenesAndCovers(viewportHeight: number) {
    if (!this.#layers.length) return;

    const active: Layer[] = [];

    this.#layers.forEach((layer) => {
      if (!layer.wrapper) return;

      resetStickyPosition(layer.wrapper);
      active.push(layer);
    });

    if (!active.length) return;

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
    // documentMaxScroll starts at 0 (pass 1 hasn't written any Scene layer's padding yet, so the
    // true value isn't known). This is harmless as a placeholder: only cover layers may use
    // 'max' (resolveEndSpec rejects it for Scene layers), and a cover layer's freezeEnd doesn't
    // feed into precedingGaps or any other layer's measurement, so a wrong first-pass value here
    // has no side effects and is corrected below before anything reads it a second time.
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

    // window.innerHeight isn't used because it fluctuates with a mobile browser's address bar
    // showing/hiding (see measureViewportHeight).
    // This measures once here so both Scene/Cover layers and pin layers share the same single
    // reading (a setup using both used to force two layout reflows here).
    // Skipped entirely if nothing is registered.
    const viewportHeight
      = this.#layers.length || this.#pinLayers.length ? measureViewportHeight() : 0;

    this.#refreshScenesAndCovers(viewportHeight);
    // A pin layer's spacer height spans the Scene layer dwell padding between trigger
    // and endTrigger, so it's measured only after #refreshScenesAndCovers has finalized padding.
    this.#refreshPins(viewportHeight);
    // Last: the values written here are derived from the freeze windows the passes above settle,
    // and nothing measures layout afterwards, so writing style here can't disturb anything.
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

  // Throws `message` if any entry in `list` already uses `trigger`. Shared by #registerLayer and
  // createStickyPin, which each check both #layers and #pinLayers in mirrored, opposite directions
  // (see their own comments for why), using a message specific to each call site.
  #assertTriggerAvailable(
    list: readonly { trigger: HTMLElement }[],
    trigger: HTMLElement,
    message: string,
  ): void {
    if (hasDuplicateTrigger(list, trigger)) throw new Error(message);
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
      + 'trigger for another layer. Each element can only be used once across '
      + 'createStickyTrigger/createOverlapScroll calls in the same controller instance (reusing it makes '
      + 'endTrigger resolution ambiguous).',
    );

    // A pin layer, independent of Scene/Cover layers, wraps trigger itself via wrapPin()
    // and applies position:sticky directly. Using the same element as a Scene/Cover layer's
    // trigger too would wrap it a second time via wrapScene/wrapCover, and the two sticky
    // behaviors would conflict.
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
      // GSAP swaps a falsy end for "100% 0". freezeEnd is 0 right after registration,
      // and GSAP refreshes synchronously inside its constructor, so this nudges a 0 value to
      // a tiny non-zero one, just to avoid the trigger being born with a bogus window
      // before refresh() ever runs.
      end: () => layer.freezeEnd || 0.001,
      // Every refresh rewrites padding height and sticky top, i.e. changes layout, so
      // this defaults to true (so function-valued tween props get re-measured too).
      // A value the caller specifies explicitly is respected.
      invalidateOnRefresh: rest.invalidateOnRefresh ?? true,
      // Removes the layer when GSAP kills it (e.g. a matchMedia switch).
      // The actual teardown/rebuild is deferred to a microtask via #scheduleRebuild()
      // and coalesced there. This removes it from `#layers` immediately, but since the real
      // DOM teardown looks at #builtLayers, this wrapper is never lost even during that deferral.
      onKill: (self) => {
        this.#captureScrollTriggerClass(self);

        const index = this.#layers.indexOf(layer);

        if (index !== -1) this.#layers.splice(index, 1);

        this.#dirty = true;
        this.#scheduleRebuild();
        onKill?.(self);
      },
      onRefreshInit: this.#createAutoRefreshHandler(this.#layers, layer, rest.onRefreshInit),
    };
  }

  // Builds the ScrollTrigger config for an effect that sticky-pins a Scene.
  // Registration order doesn't matter (refresh() builds it in DOM order).
  // start/end's defaults match GSAP's own defaults for a pinned trigger:
  // - start (ScrollTrigger.js:1339, `vars.start || (... pin ? "0 0" : "0 100%")`): trigger's own
  //   top reaching the viewport's top.
  // - end (ScrollTrigger.js:1401, `parsedEnd || (parsedEndTrigger ? "100% 0" : max)`;
  //   parsedEndTrigger defaults to trigger itself, so it's always truthy in practice, meaning
  //   "100% 0" is GSAP's actual default regardless of pin usage): endTrigger's own bottom edge
  //   reaching the viewport's top edge. That's dwell for endTrigger's own height, not a fixed
  //   distance.
  // A caller who wants this module's previous defaults ('center center' start, one-viewport-height
  // dwell) now has to say so explicitly (`start: 'center center', end: '+=100%'`).
  createStickyTrigger({
    trigger: triggerInput,
    start = '0 0',
    end = '100% 0',
    endTrigger: endTriggerInput,
    onKill,
    ...rest
  }: CreateStickyTriggerOptions): ScrollTrigger.Vars {
    const trigger = resolveElement(triggerInput, 'createStickyTrigger');
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

  // Registers an overlap-scroll effect (the elements from right after trigger onward cover
  // trigger).
  // Creates no tween and no dwell padding. The returned Vars merely describes
  // the freeze window; the caller must pass it to ScrollTrigger.create().
  createOverlapScroll({
    trigger: triggerInput,
    cover,
    start = 'bottom bottom',
    end = null,
    endTrigger: endTriggerInput,
    onKill,
    ...rest
  }: CreateOverlapScrollOptions): ScrollTrigger.Vars {
    const trigger = resolveElement(triggerInput, 'createOverlapScroll');
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
    // liftAboveStickyWrapper only runs once #registerLayer has succeeded. #registerLayer throws on
    // a duplicate trigger, and a layer that never reaches `#layers` has nothing to restore it
    // later: neither onKill nor destroy() can find it.
    const vars = this.#registerLayer(
      layer,
      (self) => {
        restoreCoverStyles();
        onKill?.(self);
      },
      rest,
    );
    const restoreCoverStyles = liftAboveStickyWrapper(coverElement);

    // Usage that skips ScrollTrigger.create() never calls GSAP's onKill, leaving nothing to trigger
    // the restore, so this keeps one per layer that destroy() can call directly.
    this.#coverRestoreByLayer.set(layer, restoreCoverStyles);

    return vars;
  }

  // Pins a small element using plain position:sticky alone, with pinning handled entirely
  // by CSS, not GSAP: "start pinning once trigger naturally arrives at that position, release
  // once endTrigger's end clause reaches the viewport." Unlike Scene/Cover layers, this only
  // wraps trigger by itself in outer{ inner{ trigger } }, so it works free of nested-sticky
  // lag whether it sits inside or outside the shared container. Registration order and DOM
  // order don't matter either.
  //
  // Since pinning itself never uses GSAP pinning, the returned Vars does nothing
  // on the ScrollTrigger side (it just keeps start/end at their defaults).
  // Vars is still returned so the caller passes it to ScrollTrigger.create(), purely to attach
  // the onKill/onRefreshInit hooks. onKill lets it clean up after an individual kill
  // (removing it from pinLayers and undoing outer), and onRefreshInit binds refresh()
  // to the refreshInit GSAP itself fires (resize/load, etc.), so callers get that wiring
  // without manually writing ScrollTrigger.addEventListener('refreshInit', refresh)
  // (a setup with zero pins registered still needs another layer to bind it).
  createStickyPin({
    trigger: triggerInput,
    top = 0,
    endTrigger: endTriggerInput,
    end = 'top top',
    onKill,
    ...rest
  }: CreateStickyPinOptions): ScrollTrigger.Vars {
    if (this.#destroyed) {
      throw new Error(
        'StickyScrollTrigger: cannot register a new pin after destroy() has been called.',
      );
    }

    const trigger = resolveElement(triggerInput, 'createStickyPin');
    const endTrigger = resolveElement(endTriggerInput, 'createStickyPin');

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

    const layer: PinLayer = { trigger, outer: null, inner: null, top, endTrigger, end };

    this.#pinLayers.push(layer);

    return {
      ...rest,
      trigger,
      onKill: (self) => {
        this.#captureScrollTriggerClass(self);

        const index = this.#pinLayers.indexOf(layer);

        if (index !== -1) this.#pinLayers.splice(index, 1);

        if (layer.outer) {
          unwrapPin(layer.outer, layer.trigger);
          layer.outer = null;
          layer.inner = null;
        }

        onKill?.(self);
      },
      onRefreshInit: this.#createAutoRefreshHandler(this.#pinLayers, layer, rest.onRefreshInit),
    };
  }

  // Returns the absolute scroll position (px) a GSAP-standard position clause points to,
  // for any element inside the shared container (one that isn't registered as a layer).
  // Nested sticky delays an inner element's on-screen movement by exactly the enclosing Scene
  // layers' dwell, so using plain GSAP ScrollTrigger directly would throw it off.
  // This corrects for that by adding the total dwell (freezeEnd - freezeStart) of every Scene
  // layer earlier than the target element back onto documentTop (a static absolute position);
  // cover layers are excluded since they never change document height.
  // Call this only after refresh() has run.
  resolveScrollPosition(
    elementInput: string | HTMLElement,
    position: PositionInput,
  ): number {
    const element = resolveElement(elementInput, 'resolveScrollPosition');
    const resolved = resolveMaybeFn(position);
    const viewportHeight = measureViewportHeight();

    // 'max' isn't relative to element at all (GSAP's own scrollerMax, optionally offset), and
    // this function doesn't register into `#layers` or add document height itself. Unlike
    // Scene/Cover layers and createStickyPin, it can just be measured directly with no
    // circularity or two-pass concerns (refresh() has already finalized every Scene layer's
    // dwell padding by the time a caller invokes this, per this function's own contract).
    if (isMaxFormat(resolved)) {
      return measureDocumentMaxScroll(viewportHeight)
        + resolveMaxOffset(resolved as string, viewportHeight);
    }

    // An absolute position (a bare number, matching GSAP) is a fixed scroll position, independent
    // of `element` entirely. Same idea as an absolute start for Scene/Cover layers (see
    // resolveStartSpec above).
    if (isAbsoluteFormat(resolved)) return resolveAbsolute(resolved);

    let gap = 0;

    this.#layers.forEach((layer) => {
      if (layer.kind !== 'scene') return;

      if (compareDocumentOrder(layer.trigger, element) >= 0) return;

      gap += layer.freezeEnd - layer.freezeStart;
    });

    const anchorOffset = resolveAnchorTop(resolved as string, element.offsetHeight, viewportHeight);
    // element can be anywhere inside the shared container, not guaranteed to share stuck
    // ancestors with anything else, so (like createStickyPin's trigger/endTrigger) its
    // documentTop needs its own reset rather than relying on cancellation. Once refresh() has
    // applied a Scene/Cover wrapper's position:sticky CSS, the browser keeps engaging and
    // disengaging it natively as scroll changes, no matter when this function is called
    // (including the documented pattern of a function-valued start/end, which GSAP re-evaluates
    // during its own refresh). So a stuck ancestor here is a real possibility, not just a
    // theoretical one.
    const restoreSceneCoverStickyState = this.#resetSceneCoverStickyState();
    const result = documentTop(element) + gap - anchorOffset;

    restoreSceneCoverStickyState();

    return result;
  }

  // Returns the absolute scroll position (px) at which element's own top edge reaches the
  // viewport's top edge ('top top'), for an element that might belong to any one of several
  // StickyScrollTrigger instances on the same page (e.g. a same-page anchor link, where the
  // caller doesn't know in advance which instance's shared container the target lives in). Finds
  // whichever instance's shared container actually contains element and delegates to that
  // instance's own resolveScrollPosition; picking the wrong one would apply its dwell to a target
  // it never delayed, corrupting the result the same way resolveScrollPosition's own docs warn
  // against. This reaches into #rootElement on any instance passed in, not just its own, since
  // private fields are scoped to the class body, not to `this`. An element outside every given
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

  // A thin wrapper that calls resolveScrollPosition for trigger/start and endTrigger/end
  // together, building Vars for plain GSAP ScrollTrigger. Doesn't register into the layers array
  // (it has no freeze window and is outside refresh()'s scope).
  createResolvedTrigger({
    trigger: triggerInput,
    start,
    end,
    endTrigger: endTriggerInput,
    ...rest
  }: CreateResolvedTriggerOptions): ScrollTrigger.Vars {
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
  // including layers that never went through GSAP's kill(). Destroying ScrollTrigger
  // itself is the caller's responsibility. After this, neither registration
  // nor refresh() is accepted (registration throws; refresh() is harmlessly ignored).
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
    this.#pinLayers.forEach((layer) => {
      if (layer.outer) unwrapPin(layer.outer, layer.trigger);
    });
    this.#pinLayers.length = 0;
  }
}
