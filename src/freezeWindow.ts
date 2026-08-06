/**
 * Computes each layer's freeze window (freezeStart/freezeEnd) and the style values to apply,
 * from already-measured numbers. This does no DOM measuring or writing itself.
 *
 * There's one ordering dependency it can't resolve on its own: an endTrigger outside the shared
 * container can only be measured correctly after the preceding layers' padding has been applied.
 * That value is received from the caller via the deps callbacks.
 *
 * An unregistered endTrigger inside the shared container is different: its structural position
 * depends on the dwell padding of every Scene layer whose trigger precedes it, including ones
 * that appear later in `measurements` order. Likewise, a registered endTrigger pointing at a
 * layer positioned later in DOM order (a forward reference) depends on that layer's own natural
 * position, not yet known on a single pass. Neither needs a DOM round-trip like the
 * container-external case above; both are resolved in-memory by iterating the whole pass to a
 * fixed point, which only fails to converge when two or more layers' endTriggers genuinely
 * depend on each other in a cycle.
 */

import { resolveAnchorTop } from './position';

// The result of resolving start during refresh()'s first pass.
export type StartSpec
  // Position clause (or function returning one), resolved relative to trigger's own natural
  // position: the usual case.
  = | { mode: 'clause'; anchorOffset: number }
    // A bare number (or a numeric-only string), matching GSAP's own _parsePosition: this is an
    // absolute scroll position, entirely unrelated to trigger's own natural position. See
    // position.ts's isAbsoluteFormat.
    | { mode: 'absolute'; value: number };

// The result of resolving end during refresh()'s first pass.
export type EndSpec
  // end omitted on a cover layer. Auto-computed as "until cover fully covers it".
  = | { mode: 'auto' }
    // Dwell-distance notation ('+=500'). Relative distance (px) from freezeStart.
    | { mode: 'dwell'; distancePx: number }
    // A bare number (or a numeric-only string), matching GSAP's own _parsePosition: an absolute
    // scroll position, entirely unrelated to freezeStart. See position.ts's isAbsoluteFormat.
    | { mode: 'absolute'; value: number }
    // GSAP's 'max' notation. Offset (px) from the document's max scroll position, which is only
    // valid for a cover layer. A Scene layer's own dwell padding would make it self-referential,
    // so index.ts's resolveEndSpec rejects it there instead.
    | { mode: 'max'; offsetPx: number }
    | {
      mode: 'clause';
      clause: string;
      // Position of an unregistered endTrigger inside the shared container, measured in pass 1.
      rawTop: number | null;
      // An endTrigger outside the shared container; re-measured after padding is finalized.
      measureLive: boolean;
    };

// The input for one layer as measured in pass 1. All values measured with sticky disabled.
export interface LayerMeasurement {
  kind: 'scene' | 'cover';
  start: StartSpec;
  triggerTop: number;
  wrapperTop: number;
  coverTop: number; // Only meaningful for cover layers (0 for Scene layers).
  end: EndSpec;
  endTriggerIsSelf: boolean;
  endTriggerIndex: number | null; // Index of endTrigger when it's also another layer's trigger.
  endTriggerHeight: number; // Only used for a position-clause end.
}

export interface LayerPlan {
  freezeStart: number;
  freezeEnd: number;
  stickyTop: number;
  // Height (px) of a Scene layer's dwell spacer; null for cover layers.
  paddingHeight: number | null;
}

export interface PlanDeps {
  viewportHeight: number;
  // Absolute top of the Scene layer nesting's outermost container (0 if none).
  structureTop: number;
  // The document's max scroll position (px), used by a 'max'-mode end. Only meaningful once
  // every Scene layer's dwell padding has been written (see index.ts's refreshScenesAndCovers);
  // an earlier, not-yet-finalized value is harmless for a 'max'-mode end since only cover layers
  // may use it, and a cover layer's freezeEnd doesn't feed into precedingGaps or any other
  // layer's measurement.
  documentMaxScroll: number;
  measureLiveEndTriggerTop: (layerIndex: number) => number;
  onPlanned: (layerIndex: number, plan: LayerPlan) => void;
}

// A previous full pass's results, used as the "best known so far" answer for anything a pass
// can't resolve from layers it has already processed this same pass (see gapsBeforeRawPosition
// and runPass's `known` lookup below). null before the very first pass.
interface PreviousPass {
  paddings: readonly (number | null)[];
  naturalTops: readonly number[];
}

// Sum of paddingHeight for every Scene layer whose (pass-1, unpadded) triggerTop precedes
// rawPosition, i.e. the total dwell that structurally sits before an unregistered endTrigger at
// that raw position, regardless of which index processes before which in `measurements`.
// For a layer already processed earlier in this same pass, `paddingHeightsSoFar` has its
// freshly computed value; for one not yet reached this pass, `previous` (the previous full
// pass's result, or null on the very first pass) is used instead. Mixing a fresh value for
// one and a stale value for the other here would double-count or drop a layer relative to what
// the sequential `precedingGaps` below already folded in, which is what caused this to oscillate
// instead of converging.
const gapsBeforeRawPosition = (
  measurements: readonly LayerMeasurement[],
  paddingHeightsSoFar: readonly (number | null | undefined)[],
  previous: PreviousPass | null,
  rawPosition: number,
  ownIndex: number,
): number => {
  let total = 0;

  measurements.forEach((measurement, i) => {
    if (i === ownIndex || measurement.triggerTop >= rawPosition) return;

    const paddingHeight = paddingHeightsSoFar[i] !== undefined
      ? paddingHeightsSoFar[i]
      : (previous ? previous.paddings[i] : null);

    if (paddingHeight !== null && paddingHeight !== undefined) total += paddingHeight;
  });

  return total;
};

// One full sequential pass over every layer, in DOM order.
// precedingGaps only accumulates from Scene layer dwell (cover layers never increase document
// height), and only from layers already processed in this pass: correct for a layer's own
// natural position, since `measurements` is already DOM-ordered. An unregistered clause's endTop
// uses gapsBeforeRawPosition instead because that dependency isn't limited to already-processed
// layers; a registered clause pointing at a layer positioned later in DOM order (a forward
// reference) similarly falls back to `previous.naturalTops` below.
// Returns naturalTops alongside plans (rather than letting a caller reconstruct
// naturalAbsoluteTop from freezeStart) because that reconstruction assumed
// freezeStart = naturalAbsoluteTop - start.anchorOffset, true for a clause start, but not for an
// absolute start (freezeStart = start.value directly, unrelated to naturalAbsoluteTop).
const runPass = (
  measurements: readonly LayerMeasurement[],
  { viewportHeight, structureTop, documentMaxScroll, measureLiveEndTriggerTop }: PlanDeps,
  previous: PreviousPass | null,
): { plans: LayerPlan[]; naturalTops: number[] } => {
  const naturalTops: number[] = [];
  const paddingHeightsSoFar: (number | null)[] = [];
  let precedingGaps = 0;
  const plans = measurements.map((measurement, index) => {
    const naturalAbsoluteTop = measurement.triggerTop + precedingGaps;
    // An absolute start (a bare number, matching GSAP) is a fixed scroll position, unrelated to
    // trigger's own natural position. Unlike a clause start, precedingGaps plays no part in it.
    const freezeStart = measurement.start.mode === 'absolute'
      ? measurement.start.value
      : naturalAbsoluteTop - measurement.start.anchorOffset;
    let freezeEnd: number;

    switch (measurement.end.mode) {
      case 'auto':
        // Only reachable with a clause start: 'auto' end only ever occurs on a cover layer
        // (createOverlapScroll), and index.ts's resolveStartSpec rejects an absolute start for
        // any cover layer outright (its stickyTop is computed relative to its own wrapper, which
        // needs a clause's anchorOffset; an absolute scroll position has no meaning there). The
        // check below is a defensive fallback for that invariant, not an expected runtime path.
        if (measurement.start.mode !== 'clause') {
          throw new Error(
            'StickyScrollTrigger: internal error: an absolute start reached \'auto\' end mode, '
            + 'which resolveStartSpec should have already rejected.',
          );
        }

        freezeEnd = freezeStart + Math.max(
          0,
          measurement.start.anchorOffset + (measurement.coverTop - measurement.triggerTop),
        );
        break;
      case 'dwell':
        freezeEnd = freezeStart + measurement.end.distancePx;
        break;

      // An absolute end (a bare number, matching GSAP) is a fixed scroll position, unrelated to
      // freezeStart, clamped to freezeStart the same way GSAP itself does
      // (`end = Math.max(start, ...)` in ScrollTrigger.js) when it would otherwise precede start.
      case 'absolute':
        freezeEnd = Math.max(freezeStart, measurement.end.value);
        break;

      case 'max':
        freezeEnd = Math.max(freezeStart, documentMaxScroll + measurement.end.offsetPx);
        break;

      case 'clause': {
        let endTop: number;

        if (measurement.endTriggerIsSelf) {
          endTop = naturalAbsoluteTop;
        } else {
          const known = measurement.endTriggerIndex === null
            ? undefined
            : (naturalTops[measurement.endTriggerIndex] !== undefined
                ? naturalTops[measurement.endTriggerIndex]
                : (previous ? previous.naturalTops[measurement.endTriggerIndex] : undefined));

          if (known !== undefined) endTop = known;
          else if (measurement.end.measureLive) endTop = measureLiveEndTriggerTop(index);
          else {
            endTop = measurement.end.rawTop === null
              ? 0
              : measurement.end.rawTop + gapsBeforeRawPosition(
                measurements,
                paddingHeightsSoFar,
                previous,
                measurement.end.rawTop,
                index,
              );
          }
        }

        // When the end would fall before the start (e.g. endTrigger sits above trigger),
        // clamp it to freezeStart, collapsing to a zero-length window (same behavior as GSAP
        // ScrollTrigger).
        const anchorOffsetEnd = resolveAnchorTop(
          measurement.end.clause,
          measurement.endTriggerHeight,
          viewportHeight,
        );

        freezeEnd = Math.max(freezeStart, endTop - anchorOffsetEnd);
        break;
      }
    }

    let plan: LayerPlan;

    if (measurement.kind === 'cover') {
      // A cover layer's start is always a clause: index.ts's resolveStartSpec rejects an
      // absolute start outright for any cover layer (see the 'auto' case above for why).
      if (measurement.start.mode !== 'clause') {
        throw new Error(
          'StickyScrollTrigger: internal error: a cover layer measurement carries an absolute '
          + 'start, which resolveStartSpec should have already rejected.',
        );
      }

      plan = {
        freezeStart,
        freezeEnd,
        stickyTop: measurement.start.anchorOffset
          - (measurement.triggerTop - measurement.wrapperTop),
        paddingHeight: null,
      };
    } else {
      plan = {
        freezeStart,
        freezeEnd,
        stickyTop: structureTop - freezeStart,
        paddingHeight: Math.max(0, freezeEnd - freezeStart),
      };
    }

    if (plan.paddingHeight !== null) precedingGaps += plan.paddingHeight;

    naturalTops[index] = naturalAbsoluteTop;
    paddingHeightsSoFar[index] = plan.paddingHeight;

    return plan;
  });

  return { plans, naturalTops };
};

// Finalizes every layer's freeze window and style values, from measurements laid out in DOM
// order. Most end modes only need one pass. Two kinds of clause end need more:
//
// - An unregistered clause needs gapsBeforeRawPosition's structural lookup, which depends on
//   other layers' padding heights that aren't all known on the first pass (see runPass). That
//   dependency always resolves: gapsBeforeRawPosition only lets layer i's endTop depend on layer
//   j's paddingHeight without cancelling (see its own comment) when j's array index is >= i's,
//   so every non-cancelling edge of this kind points from a lower-or-equal index to a
//   higher-or-equal one, which can never close into a cycle between two distinct indices.
// - A registered clause pointing at a layer positioned later in DOM order (a forward reference)
//   depends directly on that layer's naturalTop, with no such cancellation, so two layers whose
//   endTriggers point at each other (or a longer cycle through several layers) form a genuine
//   cycle with no fixed point. That's exactly the case the throw below exists for.
//
// Re-running the full pass with the previous pass's results converges on the correct totals for
// every acyclic dependency, bounded to one iteration per layer, enough to settle any chain no
// longer than the number of layers (see the DOM-order-scrambled stress test in
// freezeWindow.test.ts, and the genuine-cycle test next to it).
export const planLayers = (
  measurements: readonly LayerMeasurement[],
  deps: PlanDeps,
): LayerPlan[] => {
  const needsConvergence = measurements.some((measurement, index) => {
    if (measurement.end.mode !== 'clause' || measurement.endTriggerIsSelf) return false;

    return measurement.endTriggerIndex === null
      ? measurement.end.rawTop !== null
      : measurement.endTriggerIndex >= index;
  });
  // Nothing in the shared DOM state changes between internal passes below. onPlanned (the only
  // thing that writes DOM/layer state) only runs once, after the loop, on the final result, so a
  // live remeasurement gives the same answer on every pass. Without this cache, a layer with an
  // endTrigger outside the container would get re-measured (a forced-layout DOM read) once per
  // pass instead of once per planLayers call, for no benefit.
  const liveTopCache = new Map<number, number>();
  const passDeps: PlanDeps = {
    ...deps,
    measureLiveEndTriggerTop: (index) => {
      const cached = liveTopCache.get(index);

      if (cached !== undefined) return cached;

      const value = deps.measureLiveEndTriggerTop(index);

      liveTopCache.set(index, value);

      return value;
    },
  };
  let { plans, naturalTops } = runPass(measurements, passDeps, null);

  if (needsConvergence) {
    for (let pass = 0; pass < measurements.length; pass += 1) {
      const previous: PreviousPass = {
        paddings: plans.map((plan) => plan.paddingHeight),
        naturalTops,
      };
      const next = runPass(measurements, passDeps, previous);
      const stable = next.plans.every((plan, i) => plan.paddingHeight === plans[i].paddingHeight);

      plans = next.plans;
      naturalTops = next.naturalTops;

      if (stable) break;

      if (pass === measurements.length - 1) {
        throw new Error(
          'StickyScrollTrigger: could not resolve endTrigger positions: some Scene layers\' '
          + 'endTrigger references form a circular structural dependency (either two or more '
          + 'triggers reference each other\'s endTrigger, or an unregistered endTrigger\'s '
          + 'dwell depends on a layer whose own end depends back on it). Point each endTrigger '
          + 'at a layer that doesn\'t depend on it.',
        );
      }
    }
  }

  plans.forEach((plan, index) => deps.onPlanned(index, plan));

  return plans;
};
