/**
 * Computes each layer's freeze window (freezeStart/freezeEnd) and the style values to apply,
 * from already-measured numbers. This does no DOM measuring or writing itself.
 *
 * One ordering dependency needs the caller's help: an endTrigger outside the shared container can
 * only be measured once the preceding layers' padding has been applied, so its position arrives
 * through the deps callbacks.
 *
 * Two others are resolved in memory instead, by iterating the whole pass to a fixed point. An
 * unregistered endTrigger inside the container depends on the dwell of every Scene layer that
 * would delay it under GSAP's pins, including layers that come later in `measurements` order; a
 * registered endTrigger pointing at a layer later in DOM order (a forward reference) depends on
 * that layer's natural position. Iteration only fails to converge when two or more endTriggers
 * genuinely depend on each other in a cycle.
 */

import { resolveAnchorTop, resolveElementAnchor } from './position';

// The result of resolving start during refresh()'s first pass.
export type StartSpec
  // The usual case: a position clause resolved relative to trigger's own natural position.
  = | { mode: 'clause'; anchorOffset: number }
    // A bare number, which GSAP reads as an absolute scroll position unrelated to trigger's own
    // natural position. See position.ts's isAbsoluteFormat.
    | { mode: 'absolute'; value: number };

// The result of resolving end during refresh()'s first pass.
export type EndSpec
  // end omitted on a cover layer. Auto-computed as "until cover fully covers it".
  = | { mode: 'auto' }
    // Dwell-distance notation ('+=500'). Relative distance (px) from freezeStart.
    | { mode: 'dwell'; distancePx: number }
    // A bare number, unrelated to freezeStart (same rule as StartSpec's absolute mode above).
    | { mode: 'absolute'; value: number }
    // GSAP's 'max' notation: an offset (px) from the document's max scroll position. Cover layers
    // only, since a Scene layer's own dwell padding would make it self-referential (measure.ts's
    // resolveEndSpec rejects that).
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
  triggerHeight: number;
  wrapperTop: number;
  coverTop: number; // Only meaningful for cover layers (0 for Scene layers).
  end: EndSpec;
  endTriggerIsSelf: boolean;
  endTriggerIndex: number | null; // Index of endTrigger when it's also another layer's trigger.
  endTriggerHeight: number; // Only used for a position-clause end.
  // Indices of the layers whose trigger encloses an unregistered endTrigger inside the container.
  endTriggerEnclosedBy: readonly number[];
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
  // The document's max scroll position (px), for a 'max'-mode end. Only meaningful once every
  // Scene layer's dwell padding has been written (see index.ts's #planLayerPositions), but an
  // earlier value is harmless: only cover layers may use 'max', and a cover layer's freezeEnd
  // feeds into no other layer's measurement.
  documentMaxScroll: number;
  measureLiveEndTriggerTop: (layerIndex: number) => number;
  onPlanned: (layerIndex: number, plan: LayerPlan) => void;
}

// A previous full pass's results, used as the "best known so far" answer for anything a pass
// can't resolve from layers it has already processed this same pass (see gapsBeforeEndAnchor
// and runPass's `known` lookup below). null before the very first pass.
interface PreviousPass {
  paddings: readonly (number | null)[];
  naturalTops: readonly number[];
}

// Total dwell before the point an unregistered endTrigger's end clause names (anchorPosition, which
// reaches the viewport's anchor at reachedAt, both unpadded), counted the way GSAP's pins would
// delay it. A Scene layer whose trigger encloses the endTrigger counts only if it freezes first,
// since a pin holds its contents only while engaged; any other counts if its trigger ends above
// that point, since its spacer pushes the point down. `measurements` order doesn't matter. A layer
// already handled this pass contributes its fresh value from `paddingHeightsSoFar`; one not yet
// reached contributes the previous pass's (null on the very first). Reading a fresh value where a
// stale one belongs, or the reverse, double-counts or drops a layer relative to the sequential
// `precedingGaps` below, which makes the iteration oscillate instead of converge.
const gapsBeforeEndAnchor = (
  measurements: readonly LayerMeasurement[],
  paddingHeightsSoFar: readonly (number | null | undefined)[],
  previous: PreviousPass | null,
  anchorPosition: number,
  reachedAt: number,
  enclosedBy: readonly number[],
  ownIndex: number,
): number => {
  let total = 0;
  // Dwell before each layer in DOM order, to put an absolute start in unpadded terms.
  let precedingGaps = 0;

  measurements.forEach((measurement, i) => {
    const paddingHeight = paddingHeightsSoFar[i] !== undefined
      ? paddingHeightsSoFar[i]
      : (previous ? previous.paddings[i] : null);
    const triggerBottom = measurement.triggerTop + measurement.triggerHeight;
    const unpaddedFreezeStart = measurement.start.mode === 'absolute'
      ? measurement.start.value - precedingGaps
      : measurement.triggerTop - measurement.start.anchorOffset;
    const counts = enclosedBy.includes(i)
      ? unpaddedFreezeStart < reachedAt - TIE_TOLERANCE_PX
      : triggerBottom <= anchorPosition + TIE_TOLERANCE_PX;

    if (paddingHeight !== null && paddingHeight !== undefined) {
      if (i !== ownIndex && counts) total += paddingHeight;

      precedingGaps += paddingHeight;
    }
  });

  return total;
};

// One full sequential pass over every layer, in DOM order.
// precedingGaps accumulates Scene layer dwell only (cover layers never increase document height),
// and only from layers already processed this pass, which is exactly right for a layer's own
// natural position because `measurements` is already DOM-ordered. The two clause cases that reach
// beyond those layers look elsewhere: an unregistered endTrigger through gapsBeforeEndAnchor, a
// forward reference through `previous.naturalTops`.
// naturalTops is returned alongside plans because a caller can't reconstruct it from freezeStart:
// freezeStart = naturalAbsoluteTop - start.anchorOffset only holds for a clause start, not an
// absolute one, where freezeStart is start.value directly.
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
    // An absolute start is a fixed scroll position, so unlike a clause start, trigger's own
    // natural position and precedingGaps play no part in it.
    const freezeStart = measurement.start.mode === 'absolute'
      ? measurement.start.value
      : naturalAbsoluteTop - measurement.start.anchorOffset;
    let freezeEnd: number;

    switch (measurement.end.mode) {
      case 'auto':
        // 'auto' only occurs on a cover layer, and measure.ts's resolveStartSpec rejects an
        // absolute start there, since a cover layer's stickyTop needs a clause's anchorOffset. The
        // check below guards that invariant; it isn't an expected runtime path.
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

      // A fixed scroll position unrelated to freezeStart, clamped to it the way GSAP itself does
      // (`end = Math.max(start, ...)` in ScrollTrigger.js).
      case 'absolute':
        freezeEnd = Math.max(freezeStart, measurement.end.value);
        break;

      case 'max':
        freezeEnd = Math.max(freezeStart, documentMaxScroll + measurement.end.offsetPx);
        break;

      case 'clause': {
        const anchorOffsetEnd = resolveAnchorTop(
          measurement.end.clause,
          measurement.endTriggerHeight,
          viewportHeight,
        );
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
            const { rawTop } = measurement.end;

            endTop = rawTop === null
              ? 0
              : rawTop + gapsBeforeEndAnchor(
                measurements,
                paddingHeightsSoFar,
                previous,
                rawTop + resolveElementAnchor(measurement.end.clause, measurement.endTriggerHeight),
                rawTop - anchorOffsetEnd,
                measurement.endTriggerEnclosedBy,
                index,
              );
          }
        }

        // An end that falls before the start (endTrigger sitting above trigger, say) collapses to
        // a zero-length window, the same behavior as GSAP ScrollTrigger.

        freezeEnd = Math.max(freezeStart, endTop - anchorOffsetEnd);
        break;
      }
    }

    let plan: LayerPlan;

    if (measurement.kind === 'cover') {
      // The same invariant the 'auto' case above guards: a cover layer's start is always a clause.
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

// How far past a freeze's start an element has to arrive before that freeze counts as starting
// first. An element exactly at the start waits out none of it, but the sums that land it there
// reach it in different orders and differ in the last bit. scrollMargin.ts's CSS step uses the
// same margin, so both paths draw the line in one place.
export const TIE_TOLERANCE_PX = 0.05;

// The total Scene layer dwell an element inside the shared container waits out before it reaches
// a viewport anchor. reachedAt is where it would reach that anchor with no dwell at all: its
// natural top less the anchor offset. Every Scene layer freezes the whole container and nothing in
// it moves during a freeze, so a layer counts in full if its freeze starts first, and not at all
// otherwise, whatever the DOM order.
//
// With windows that don't overlap, which "nothing moves" already assumes, the layers that count
// are always the earliest ones. So each layer's test can assume every earlier one counted, making
// it a comparison against a constant, which scrollMargin.ts can write as CSS without repeating the
// earlier tests inside the later ones. planLayers can still produce an overlap: a scene with start
// 'top bottom' can open its window before a short scene above it closes its own.
//
// A Scene trigger resolving its own start lands exactly on its freezeStart, which the tolerance
// keeps on the not-counted side.
export const dwellBeforeReach = (
  reachedAt: number,
  windows: readonly { freezeStart: number; freezeEnd: number }[],
): number => {
  let earlierDwell = 0;
  let counted = 0;

  [...windows]
    .sort((a, b) => a.freezeStart - b.freezeStart)
    .forEach(({ freezeStart, freezeEnd }) => {
      if (freezeStart < reachedAt + earlierDwell - TIE_TOLERANCE_PX) {
        counted += freezeEnd - freezeStart;
      }

      earlierDwell += freezeEnd - freezeStart;
    });

  return counted;
};

// How much Scene layer dwell has gone by at a given scroll position: the distance the shared
// container has stood still for, and so how far anything inside it lags behind the document.
export const dwellConsumedAt = (
  scroll: number,
  windows: readonly { freezeStart: number; freezeEnd: number }[],
): number => windows.reduce(
  (consumed, { freezeStart, freezeEnd }) =>
    consumed + Math.min(Math.max(scroll - freezeStart, 0), freezeEnd - freezeStart),
  0,
);

// Finalizes every layer's freeze window and style values, from measurements laid out in DOM order.
// Most end modes settle in one pass. Two kinds of clause end need more:
//
// - An unregistered clause needs gapsBeforeEndAnchor's structural lookup, whose inputs aren't
//   all known on the first pass (see runPass). That lookup's non-cancelling dependencies run from
//   layer i to a later layer j, which can't close into a cycle, with one exception: an endTrigger
//   above an earlier layer's trigger leaves that layer out even though its dwell moves i's start.
//   With that layer's own end reaching past i's trigger, the pair can oscillate into the throw
//   below. The DOM-order rule before this one had it too.
// - A forward reference depends directly on the referenced layer's naturalTop, with no such
//   cancellation, so endTriggers pointing at each other (or a longer cycle through several
//   layers) have no fixed point. That's the case the throw below exists for.
//
// Re-running the full pass with the previous pass's results converges for every acyclic
// dependency, within one iteration per layer, enough for any chain no longer than the layer count
// (see freezeWindow.test.ts's DOM-order-scrambled stress test and the genuine-cycle test beside
// it).
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
  // onPlanned, the only thing that writes DOM or layer state, runs once after the loop, so no
  // shared state changes between passes and a live remeasurement gives the same answer every time.
  // Without this cache, an endTrigger outside the container costs one forced-layout read per pass
  // instead of one per planLayers call.
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
          'StickyScrollTrigger: could not resolve endTrigger positions: some endTrigger '
          + 'references form a circular structural dependency, each layer\'s end depending on a '
          + 'layer whose own end depends back on it. Point each endTrigger at a layer that '
          + 'doesn\'t depend on it.',
        );
      }
    }
  }

  plans.forEach((plan, index) => deps.onPlanned(index, plan));

  return plans;
};
