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
 * Scene layer's registered endTrigger later in DOM order (a forward reference) depends on that
 * layer's natural position. Iteration only fails to converge when two or more endTriggers
 * genuinely depend on each other in a cycle. Cover layers are planned last, from the settled
 * Scene windows, since nothing depends on a cover's own window.
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
  // Indices of the layers whose trigger encloses (or is) an endTrigger inside the container.
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
// can't resolve from layers it has already processed this same pass (see gapsBeforeEndAnchor).
// null before the very first pass.
interface PreviousPass {
  paddings: readonly (number | null)[];
}

// Total dwell before the point an endTrigger's end clause names (anchorPosition, which
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

// One full sequential pass over every Scene layer, in DOM order. A cover layer gets a null plan
// here and is planned by planCover once the Scene windows settle.
// precedingGaps accumulates Scene layer dwell only (cover layers never increase document height),
// and only from layers already processed this pass, which is exactly right for a layer's own
// natural position because `measurements` is already DOM-ordered. An endTrigger other than trigger
// itself reaches beyond those layers through gapsBeforeEndAnchor.
const runPass = (
  measurements: readonly LayerMeasurement[],
  { viewportHeight, structureTop, measureLiveEndTriggerTop }: PlanDeps,
  previous: PreviousPass | null,
): (LayerPlan | null)[] => {
  const paddingHeightsSoFar: (number | null)[] = [];
  let precedingGaps = 0;

  return measurements.map((measurement, index) => {
    const naturalAbsoluteTop = measurement.triggerTop + precedingGaps;

    paddingHeightsSoFar[index] = null;

    if (measurement.kind === 'cover') return null;

    // An absolute start is a fixed scroll position, so unlike a clause start, trigger's own
    // natural position and precedingGaps play no part in it.
    const freezeStart = measurement.start.mode === 'absolute'
      ? measurement.start.value
      : naturalAbsoluteTop - measurement.start.anchorOffset;
    let freezeEnd: number;

    switch (measurement.end.mode) {
      case 'dwell':
        freezeEnd = freezeStart + measurement.end.distancePx;
        break;

      // A fixed scroll position unrelated to freezeStart, clamped to it the way GSAP itself does
      // (`end = Math.max(start, ...)` in ScrollTrigger.js).
      case 'absolute':
        freezeEnd = Math.max(freezeStart, measurement.end.value);
        break;

      // measure.ts's resolveEndSpec only lets a cover layer end at 'auto' or 'max'.
      case 'auto':
      case 'max':
        throw new Error(
          `StickyScrollTrigger: internal error: a Scene layer reached '${measurement.end.mode}' `
          + 'end mode, which only a cover layer can have.',
        );

      case 'clause': {
        const anchorOffsetEnd = resolveAnchorTop(
          measurement.end.clause,
          measurement.endTriggerHeight,
          viewportHeight,
        );
        let endTop: number;

        if (measurement.endTriggerIsSelf) {
          endTop = naturalAbsoluteTop;
        } else if (measurement.end.measureLive) {
          endTop = measureLiveEndTriggerTop(index);
        } else {
          // A registered endTrigger is measured unpadded like any other element, rather than
          // taken from that layer's own plan.
          const rawTop = measurement.endTriggerIndex === null
            ? measurement.end.rawTop
            : measurements[measurement.endTriggerIndex].triggerTop;

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

        // An end that falls before the start (endTrigger sitting above trigger, say) collapses to
        // a zero-length window, the same behavior as GSAP ScrollTrigger.
        freezeEnd = Math.max(freezeStart, endTop - anchorOffsetEnd);
        break;
      }
    }

    const paddingHeight = Math.max(0, freezeEnd - freezeStart);

    precedingGaps += paddingHeight;
    paddingHeightsSoFar[index] = paddingHeight;

    return { freezeStart, freezeEnd, stickyTop: structureTop - freezeStart, paddingHeight };
  });
};

// A cover layer's freeze window, from the Scene layers' settled ones. A cover never freezes the
// container, so nothing else depends on it and it needs no iteration. Each point is where the
// element it names reaches its anchor with no dwell (the measurements are taken unpadded), plus
// the dwell of every Scene layer that freezes before it gets there, whatever the DOM order.
//
// start is where the rise begins rather than where trigger arrives, so a freeze starting as
// trigger arrives counts: the rise waits it out. That is what lets a Scene layer ending in a
// zero-height marker hand straight over to the rise (README's "Delaying the rise").
const planCover = (
  measurements: readonly LayerMeasurement[],
  index: number,
  windows: readonly { freezeStart: number; freezeEnd: number }[],
  { viewportHeight, documentMaxScroll, measureLiveEndTriggerTop }: PlanDeps,
): LayerPlan => {
  const measurement = measurements[index];

  // measure.ts's resolveStartSpec rejects an absolute start on a cover layer, since its stickyTop
  // needs a clause's anchorOffset. This guards that invariant; it isn't an expected runtime path.
  if (measurement.start.mode !== 'clause') {
    throw new Error(
      'StickyScrollTrigger: internal error: a cover layer measurement carries an absolute '
      + 'start, which resolveStartSpec should have already rejected.',
    );
  }

  const reached = (reachedAt: number) => reachedAt + dwellBeforeReach(reachedAt, windows);
  const startReachedAt = measurement.triggerTop - measurement.start.anchorOffset;
  const freezeStart = startReachedAt
    + dwellBeforeReach(startReachedAt, windows, { countTies: true });
  let freezeEnd: number;

  switch (measurement.end.mode) {
    // Until cover's top edge reaches the top of the viewport.
    case 'auto':
      freezeEnd = reached(measurement.coverTop);
      break;

    case 'dwell':
      freezeEnd = freezeStart + measurement.end.distancePx;
      break;

    case 'absolute':
      freezeEnd = measurement.end.value;
      break;

    case 'max':
      freezeEnd = documentMaxScroll + measurement.end.offsetPx;
      break;

    case 'clause': {
      const anchorOffsetEnd = resolveAnchorTop(
        measurement.end.clause,
        measurement.endTriggerHeight,
        viewportHeight,
      );

      if (measurement.end.measureLive) {
        // Outside the container, so no dwell holds it back.
        freezeEnd = measureLiveEndTriggerTop(index) - anchorOffsetEnd;
      } else {
        const endTop = measurement.endTriggerIsSelf
          ? measurement.triggerTop
          : measurement.endTriggerIndex === null
            ? (measurement.end.rawTop ?? 0)
            : measurements[measurement.endTriggerIndex].triggerTop;

        freezeEnd = reached(endTop - anchorOffsetEnd);
      }

      break;
    }
  }

  return {
    freezeStart,
    freezeEnd: Math.max(freezeStart, freezeEnd),
    stickyTop: measurement.start.anchorOffset - (measurement.triggerTop - measurement.wrapperTop),
    paddingHeight: null,
  };
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
//
// countTies moves the tolerance to the counted side, for a point that marks when something starts
// moving rather than when it arrives.
export const dwellBeforeReach = (
  reachedAt: number,
  windows: readonly { freezeStart: number; freezeEnd: number }[],
  { countTies = false }: { countTies?: boolean } = {},
): number => {
  const tolerance = countTies ? -TIE_TOLERANCE_PX : TIE_TOLERANCE_PX;
  let earlierDwell = 0;
  let counted = 0;

  [...windows]
    .sort((a, b) => a.freezeStart - b.freezeStart)
    .forEach(({ freezeStart, freezeEnd }) => {
      if (freezeStart < reachedAt + earlierDwell - tolerance) {
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
// Most end modes settle in one pass. One kind of clause end needs more:
//
// - A clause with an endTrigger other than trigger needs gapsBeforeEndAnchor's lookup, whose
//   inputs aren't all known on the first pass (see runPass). That lookup's non-cancelling
//   dependencies run from layer i to a later layer j, which can't close into a cycle, with one
//   exception: an endTrigger above an earlier layer's trigger leaves that layer out even though
//   its dwell moves i's start. With that layer's own end reaching past i's trigger, each pass
//   flips the pair between two answers that straddle the one they share, so a pass that returns
//   to the answer before last feeds the next one their average instead.
//
// Re-running the full pass with the previous pass's results settles a chain within one iteration
// per layer and such a flip within two more; anything still moving after that throws (see
// freezeWindow.test.ts's DOM-order-scrambled stress test and the flip test beside it).
export const planLayers = (
  measurements: readonly LayerMeasurement[],
  deps: PlanDeps,
): LayerPlan[] => {
  const needsConvergence = measurements.some((measurement) => {
    if (measurement.kind !== 'scene') return false;

    if (measurement.end.mode !== 'clause' || measurement.endTriggerIsSelf) return false;

    return measurement.endTriggerIndex !== null || measurement.end.rawTop !== null;
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
  const paddingsOf = (passPlans: readonly (LayerPlan | null)[]) =>
    passPlans.map((plan) => plan?.paddingHeight ?? null);
  const samePaddings = (a: PreviousPass['paddings'], b: PreviousPass['paddings']) =>
    a.every((value, i) => value === b[i]
      || (value !== null && b[i] !== null && Math.abs(value - b[i]!) <= TIE_TOLERANCE_PX));
  let plans = runPass(measurements, passDeps, null);

  if (needsConvergence) {
    const budget = measurements.length + 2;
    let fed = paddingsOf(plans);
    let fedBefore: PreviousPass['paddings'] | null = null;

    for (let pass = 0; pass < budget; pass += 1) {
      plans = runPass(measurements, passDeps, { paddings: fed });

      const out = paddingsOf(plans);

      if (samePaddings(out, fed)) break;

      const flipped = fedBefore !== null && samePaddings(out, fedBefore);

      fedBefore = fed;
      fed = flipped
        ? out.map((value, i) => (value === null ? null : (value + fed[i]!) / 2))
        : out;

      if (pass === budget - 1) {
        throw new Error(
          'StickyScrollTrigger: could not resolve endTrigger positions: some endTrigger '
          + 'references form a circular structural dependency that never settles. Point each '
          + 'endTrigger at an element that doesn\'t depend on it.',
        );
      }
    }
  }

  const windows = plans.filter((plan): plan is LayerPlan => plan !== null);
  const finalPlans = plans.map(
    (plan, index) => plan ?? planCover(measurements, index, windows, passDeps),
  );

  finalPlans.forEach((plan, index) => deps.onPlanned(index, plan));

  return finalPlans;
};
