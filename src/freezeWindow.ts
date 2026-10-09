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
 * would move the point it names under GSAP's pins with pinnedContainer set, including layers that
 * come later in `measurements` order; a Scene layer's registered endTrigger later in DOM order (a
 * forward reference) depends on that layer's natural position. When endTriggers depend on each
 * other, planLayers gives the answer GSAP gives when it refreshes the pins in dependency order
 * (see fallbackOrder). Cover layers are planned last, from the settled Scene windows, since
 * nothing depends on a cover's own window.
 *
 * A Scene layer's window is what GSAP gets. The page can't freeze twice at once, so where an
 * absolute start falls inside another window, the page freezes only for the part not already
 * frozen (engagedStart/engagedEnd), and every page position follows that part.
 */

import { resolveAnchorTop, resolveElementFraction } from './position';

// The result of resolving start during refresh()'s first pass.
export type StartSpec
  // The usual case: a position clause resolved relative to trigger's own natural position.
  // elementFraction is the clause's element side as a share of trigger's height (see
  // position.ts's resolveElementFraction).
  = | { mode: 'clause'; anchorOffset: number; elementFraction: number }
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
  // Indices of the layers whose trigger encloses (or is) trigger.
  triggerEnclosedBy: readonly number[];
  wrapperTop: number;
  coverTop: number; // Only meaningful for cover layers (0 for Scene layers).
  end: EndSpec;
  endTriggerIsSelf: boolean;
  endTriggerIndex: number | null; // Index of endTrigger when it's also another layer's trigger.
  endTriggerHeight: number; // Only used for a position-clause end.
  // Indices of the layers whose trigger encloses (or is) an endTrigger inside the container.
  endTriggerEnclosedBy: readonly number[];
  // Indices of the layers whose trigger sits inside an endTrigger in the container, other than
  // the endTrigger's own.
  endTriggerNests: readonly number[];
}

export interface LayerPlan {
  // The window GSAP gets, and so self.start/self.end and the callbacks.
  freezeStart: number;
  freezeEnd: number;
  // Where the page stands still for this layer. Equal to the window unless an absolute start puts
  // it inside another Scene layer's, and always equal for a cover layer.
  engagedStart: number;
  engagedEnd: number;
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
// can't resolve from layers it has already processed this same pass (see gapsBeforeEndAnchor), and
// for every clause start. null before the very first pass.
interface PreviousPass {
  paddings: readonly (number | null)[];
  freezeStarts: readonly (number | null)[];
}

// The refresh order planLayers falls back to when no layout satisfies every Scene layer at once. A
// layer counts only layers before it, and a layer's trigger stops growing once it has been
// refreshed, so a later layer it holds pushes nothing outside it.
interface RefreshOrder {
  isBefore: (a: number, b: number) => boolean;
}

// What a pass reads from the windows the previous pass placed (see placeWindows).
interface PassWorld {
  // Where an absolute start enclosing an end's element would freeze with no dwell before it, as
  // ownIndex's end sees it.
  unpaddedStart: (index: number, ownIndex: number, freezeStart: number) => number;
  // The length an absolute end counts, or null for its written position.
  absoluteEndLength: (index: number) => number | null;
}

// Whether a trigger refreshed earlier holds layer `index` in, keeping its spacer from reaching an
// anchor outside that trigger. anchorElement is the layer whose own trigger the anchor sits on.
const isHeldIn = (
  measurements: readonly LayerMeasurement[],
  index: number,
  enclosedBy: readonly number[],
  anchorElement: number | null,
  order: RefreshOrder,
): boolean => measurements[index].triggerEnclosedBy.some((m) => m !== index
  && measurements[m].kind === 'scene'
  && order.isBefore(m, index)
  && !(enclosedBy.includes(m) && m !== anchorElement));

// The element an end or layout start names a point on: its unpadded top, the clause's share of its
// height (resolveElementFraction), and the layers whose trigger sits inside it in the DOM.
interface AnchorBox {
  top: number;
  fraction: number;
  nests: readonly number[];
}

// The layers whose trigger sits inside layer `index`'s own trigger in the DOM.
const nestedIn = (measurements: readonly LayerMeasurement[], index: number): number[] =>
  measurements.flatMap(({ triggerEnclosedBy }, k) => (
    k !== index && triggerEnclosedBy.includes(index) ? [k] : []
  ));

// The share of layer `index`'s dwell that comes before the point an end or layout start names on
// `box` (reaching the viewport anchor at reachedAt, unpadded). Under GSAP's pins a spacer above the
// element moves the point in full, one inside it grows the element and moves the point by
// box.fraction, and one below moves nothing. Inside is read from the DOM, since a zero-height
// trigger on the element's edge can sit on either side. A Scene layer enclosing the element counts
// in full only if it freezes first, as pinnedContainer would count it, but judged at this point.
// An absolute start is placed as PassWorld's unpaddedStart says.
const anchorShare = (
  measurements: readonly LayerMeasurement[],
  world: PassWorld,
  index: number,
  freezeStart: number,
  box: AnchorBox,
  reachedAt: number,
  enclosedBy: readonly number[],
  anchorElement: number | null,
  order: RefreshOrder | null,
  ownIndex: number,
): number => {
  const measurement = measurements[index];

  if (enclosedBy.includes(index)) {
    const unpaddedFreezeStart = measurement.start.mode === 'absolute'
      ? world.unpaddedStart(index, ownIndex, freezeStart)
      : measurement.triggerTop - measurement.start.anchorOffset;

    return unpaddedFreezeStart < reachedAt - TIE_TOLERANCE_PX ? 1 : 0;
  }

  if (order && isHeldIn(measurements, index, enclosedBy, anchorElement, order)) return 0;

  if (box.nests.includes(index)) return box.fraction;

  return measurement.triggerTop + measurement.triggerHeight <= box.top + TIE_TOLERANCE_PX ? 1 : 0;
};

// Total dwell anchorShare counts, leaving out ownIndex and, under a refresh order, the layers
// after it. Adds each layer with a share to `counted` when given.
const gapsBeforeEndAnchor = (
  measurements: readonly LayerMeasurement[],
  world: PassWorld,
  windows: readonly KnownWindow[],
  box: AnchorBox,
  reachedAt: number,
  enclosedBy: readonly number[],
  ownIndex: number,
  anchorElement: number | null,
  order: RefreshOrder | null,
  counted?: Set<number>,
): number => windows.reduce((total, { index, freezeStart, freezeEnd }) => {
  if (index === ownIndex || (order && order.isBefore(ownIndex, index))) return total;

  const weight = anchorShare(
    measurements, world, index, freezeStart, box, reachedAt, enclosedBy, anchorElement, order,
    ownIndex,
  );

  if (weight === 0) return total;

  counted?.add(index);

  return total + weight * (freezeEnd - freezeStart);
}, 0);

// A Scene layer's window as runPass knows it: this pass's if already handled, else the previous
// pass's (none on the very first).
interface KnownWindow {
  index: number;
  freezeStart: number;
  freezeEnd: number;
}

// Where a clause start freezes: its unpadded reach point plus the dwell of every Scene layer that
// freezes first. Everything inside the container lags by the same dwell, so clause starts freeze
// in reach-point order (DOM order breaks a tie) and an absolute start slots in by its value. A
// freeze beginning just as trigger arrives counts, since the layer waits it out. Ordering by reach
// point rather than by the previous pass's windows keeps two layers from swapping places on
// alternate passes.
const clauseFreezeStart = (
  measurements: readonly LayerMeasurement[],
  index: number,
  paddingOf: (k: number) => number,
): number => {
  const reachOf = (k: number) => {
    const { start, triggerTop } = measurements[k];

    return start.mode === 'clause' ? triggerTop - start.anchorOffset : null;
  };

  const scenes = measurements.flatMap(({ kind }, k) => (kind === 'scene' ? [k] : []));
  const clauses = scenes
    .filter((k) => reachOf(k) !== null)
    .sort((a, b) => {
      const gap = reachOf(a)! - reachOf(b)!;

      return Math.abs(gap) <= TIE_TOLERANCE_PX ? a - b : gap;
    });
  const absolutes = scenes
    .flatMap((k) => {
      const { start } = measurements[k];

      return start.mode === 'absolute' ? [{ k, value: start.value }] : [];
    })
    .sort((a, b) => a.value - b.value);
  let dwell = 0;
  let nextAbsolute = 0;

  for (const k of clauses) {
    const reachedAt = reachOf(k)!;

    while (
      nextAbsolute < absolutes.length
      && absolutes[nextAbsolute].value < reachedAt + dwell + TIE_TOLERANCE_PX
    ) {
      dwell += paddingOf(absolutes[nextAbsolute].k);
      nextAbsolute += 1;
    }

    if (k === index) return reachedAt + dwell;

    dwell += paddingOf(k);
  }

  throw new Error(
    'StickyScrollTrigger: internal error: clauseFreezeStart was given a layer without a clause '
    + 'start.',
  );
};

interface Recount {
  index: number;
  counted: Set<number>;
  runs: ((windows: KnownWindow[]) => void)[];
}

// One full sequential pass over every Scene layer, in DOM order. A cover layer gets a null plan
// here and is planned by planCover once the Scene windows settle. Other layers are read as
// KnownWindow describes, or only from previous with previousOnly. A clause start is the previous
// pass's placement of it (the first pass places it itself). Only the window comes out of a pass:
// planLayers places it and fills in the rest.
const runPass = (
  measurements: readonly LayerMeasurement[],
  { viewportHeight, measureLiveEndTriggerTop }: PlanDeps,
  previous: PreviousPass | null,
  order: RefreshOrder | null,
  world: PassWorld,
  record: ((index: number, counted: ReadonlySet<number>) => void) | null,
  previousOnly = false,
): ({ freezeStart: number; freezeEnd: number } | null)[] => {
  const fresh: ({ freezeStart: number; freezeEnd: number; paddingHeight: number } | null)[] = [];
  const knownWindows = (): KnownWindow[] => measurements.flatMap((measurement, k) => {
    if (measurement.kind !== 'scene') return [];

    const plan = previousOnly ? null : fresh[k];

    if (plan) return [{ index: k, freezeStart: plan.freezeStart, freezeEnd: plan.freezeEnd }];

    const freezeStart = previous?.freezeStarts[k] ?? null;
    const paddingHeight = previous?.paddings[k] ?? null;

    return freezeStart === null || paddingHeight === null
      ? []
      : [{ index: k, freezeStart, freezeEnd: freezeStart + paddingHeight }];
  });
  const paddingOf = (k: number) =>
    (previousOnly ? null : fresh[k]?.paddingHeight) ?? previous?.paddings[k] ?? 0;
  // What each layer counted, taken again once the pass is over: counting against knownWindows
  // mid-pass mixes this pass's windows with the previous one's.
  const recounts: Recount[] = [];
  const plans = measurements.map((measurement, index) => {
    fresh[index] = null;

    if (measurement.kind === 'cover') return null;

    const recount: Recount = { index, counted: new Set(), runs: [] };

    recounts.push(recount);

    // An absolute start is a fixed scroll position, so unlike a clause start, trigger's own
    // natural position plays no part in it.
    const { start } = measurement;
    const freezeStart = start.mode === 'absolute'
      ? start.value
      : (previous?.freezeStarts[index] ?? clauseFreezeStart(measurements, index, paddingOf));
    let freezeEnd: number;

    switch (measurement.end.mode) {
      case 'dwell':
        freezeEnd = freezeStart + measurement.end.distancePx;
        break;

      // A fixed scroll position unrelated to freezeStart, clamped to it the way GSAP itself does
      // (`end = Math.max(start, ...)` in ScrollTrigger.js), or at the length PassWorld gives.
      case 'absolute': {
        const length = world.absoluteEndLength(index);

        freezeEnd = length === null
          ? Math.max(freezeStart, measurement.end.value)
          : freezeStart + length;
        break;
      }

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

        // Nothing inside the container moves during a freeze, so trigger reaches its end anchor the
        // same scroll distance after its start anchor, plus what the spacers of the Scene layers
        // nested inside trigger add to trigger's height between the two anchors. An absolute
        // start has no anchor on trigger, so its end also moves by the spacers GSAP would put
        // above trigger: the dwell of every layer ending above it. Layers around trigger count in
        // neither case.
        if (measurement.endTriggerIsSelf) {
          const nests = nestedIn(measurements, index);
          const weight = resolveElementFraction(measurement.end.clause)
            - (start.mode === 'clause' ? start.elementFraction : 0);
          const dwellInside = measurements.reduce((total, other, k) => {
            if (
              weight === 0
              || other.kind !== 'scene'
              || !nests.includes(k)
              || (order && (order.isBefore(index, k)
                || isHeldIn(measurements, k, measurement.triggerEnclosedBy, index, order)))
            ) return total;

            recount.counted.add(k);

            return total + weight * paddingOf(k);
          }, 0);

          if (start.mode === 'clause') {
            freezeEnd = freezeStart
              + Math.max(0, start.anchorOffset - anchorOffsetEnd + dwellInside);
            break;
          }

          const dwellAbove = measurements.reduce((total, other, k) => {
            if (
              k === index
              || other.kind !== 'scene'
              || nests.includes(k)
              || other.triggerTop + other.triggerHeight > measurement.triggerTop + TIE_TOLERANCE_PX
              || (order && (order.isBefore(index, k)
                || isHeldIn(measurements, k, measurement.triggerEnclosedBy, index, order)))
            ) return total;

            recount.counted.add(k);

            return total + paddingOf(k);
          }, 0);

          freezeEnd = Math.max(
            freezeStart,
            measurement.triggerTop - anchorOffsetEnd + dwellAbove + dwellInside,
          );
          break;
        }

        let endTop: number;

        if (measurement.end.measureLive) {
          endTop = measureLiveEndTriggerTop(index);
        } else {
          // A registered endTrigger is measured unpadded like any other element, rather than
          // taken from that layer's own plan.
          const rawTop = measurement.endTriggerIndex === null
            ? measurement.end.rawTop
            : measurements[measurement.endTriggerIndex].triggerTop;

          if (rawTop === null) {
            endTop = 0;
          } else {
            const box = {
              top: rawTop,
              fraction: resolveElementFraction(measurement.end.clause),
              nests: measurement.endTriggerNests,
            };
            const gaps = (w: readonly KnownWindow[], counted?: Set<number>) => gapsBeforeEndAnchor(
              measurements,
              world,
              w,
              box,
              rawTop - anchorOffsetEnd,
              measurement.endTriggerEnclosedBy,
              index,
              measurement.endTriggerIndex,
              order,
              counted,
            );

            endTop = rawTop + gaps(knownWindows());
            recount.runs.push((w) => gaps(w, recount.counted));
          }
        }

        // The window is as long as GSAP's pins would make it, measured from where they would put
        // the start, and opens at freezeStart. An end that falls before that start (endTrigger
        // sitting above trigger, say) collapses to a zero-length window, the same behavior as
        // GSAP ScrollTrigger.
        let layoutStart: number;

        if (start.mode === 'absolute') {
          layoutStart = start.value;
        } else {
          const gaps = (w: readonly KnownWindow[], counted?: Set<number>) => gapsBeforeEndAnchor(
            measurements,
            world,
            w,
            {
              top: measurement.triggerTop,
              fraction: start.elementFraction,
              nests: nestedIn(measurements, index),
            },
            measurement.triggerTop - start.anchorOffset,
            measurement.triggerEnclosedBy,
            index,
            index,
            order,
            counted,
          );

          layoutStart = measurement.triggerTop - start.anchorOffset + gaps(knownWindows());
          recount.runs.push((w) => gaps(w, recount.counted));
        }

        freezeEnd = freezeStart + Math.max(0, endTop - anchorOffsetEnd - layoutStart);
        break;
      }
    }

    const plan = { freezeStart, freezeEnd, paddingHeight: Math.max(0, freezeEnd - freezeStart) };

    fresh[index] = plan;

    return plan;
  });

  if (record) {
    const windows = knownWindows();

    recounts.forEach(({ index, counted, runs }) => {
      runs.forEach((run) => run(windows));
      record(index, counted);
    });
  }

  return plans;
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
    engagedStart: freezeStart,
    engagedEnd: Math.max(freezeStart, freezeEnd),
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
// earlier tests inside the later ones. The engaged windows planLayers gives never overlap.
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

// Strongly connected components of a dependency graph (i -> k: i depends on k), numbered so that a
// component comes after every component it depends on.
const componentsOf = (edges: readonly (readonly number[])[]): number[] => {
  const visitOrder: number[] = edges.map(() => -1);
  const lowLink: number[] = edges.map(() => 0);
  const component: number[] = edges.map(() => -1);
  const stack: number[] = [];
  let visited = 0;
  let components = 0;

  const visit = (v: number) => {
    visitOrder[v] = visited;
    lowLink[v] = visited;
    visited += 1;
    stack.push(v);

    for (const w of edges[v]) {
      if (visitOrder[w] === -1) {
        visit(w);
        lowLink[v] = Math.min(lowLink[v], lowLink[w]);
      } else if (component[w] === -1) {
        lowLink[v] = Math.min(lowLink[v], visitOrder[w]);
      }
    }

    if (lowLink[v] === visitOrder[v]) {
      let w: number;

      do {
        w = stack.pop()!;
        component[w] = components;
      } while (w !== v);

      components += 1;
    }
  };

  edges.forEach((_, v) => {
    if (visitOrder[v] === -1) visit(v);
  });

  return component;
};

// The refresh order for layers that don't settle with every spacer counted: every layer after the
// ones it counted in any pass and after the Scene layers whose triggers hold it, and DOM order
// within a cycle. Holders first keeps GSAP from growing a trigger by a spacer inside it, which the
// counting can't express.
const fallbackOrder = (
  measurements: readonly LayerMeasurement[],
  counted: readonly ReadonlySet<number>[],
): RefreshOrder => {
  const component = componentsOf(measurements.map(({ triggerEnclosedBy }, i) => [
    ...counted[i],
    ...triggerEnclosedBy.filter((m) => m !== i && measurements[m].kind === 'scene'),
  ]));
  const rank: number[] = [];

  measurements
    .map((_, i) => i)
    .sort((a, b) => component[a] - component[b] || a - b)
    .forEach((layer, position) => {
      rank[layer] = position;
    });

  return { isBefore: (a, b) => rank[a] < rank[b] };
};

// Whether two Scene layers depend on each other, directly or through others.
const hasCycle = (scenes: readonly number[], edges: readonly (readonly number[])[]): boolean => {
  const component = componentsOf(edges);

  return new Set(scenes.map((k) => component[k])).size < scenes.length;
};

// The refresh order GSAP would need to give these lengths: every layer after the layers whose
// length moves its own (see activeEdges). GSAP sizes a pin's spacer when that pin refreshes, so a
// spacer that can reach the point an end names only by growing an enclosing Scene layer's trigger
// has to come before that layer too. A window of zero length moves nothing, so it orders nothing.
const refreshOrderEdges = (
  measurements: readonly LayerMeasurement[],
  lengths: readonly number[],
  edges: readonly (readonly number[])[],
): number[][] => {
  const before: number[][] = measurements.map(() => []);

  edges.forEach((movers, i) => {
    const measurement = measurements[i];
    // A spacer inside a trigger that also encloses the end's element reaches it without leaving
    // that trigger. A registered endTrigger is listed as enclosing itself, but a point on it moves
    // with a spacer inside it only as it grows.
    const enclosingAnchor = (measurement.end.mode === 'clause' && !measurement.endTriggerIsSelf
      ? measurement.endTriggerEnclosedBy
      : measurement.triggerEnclosedBy
    ).filter((m) => m !== measurement.endTriggerIndex);

    movers.forEach((k) => {
      if (lengths[k] <= TIE_TOLERANCE_PX) return;

      before[i].push(k);
      measurements[k].triggerEnclosedBy.forEach((m) => {
        if (m !== k && m !== i && measurements[m].kind === 'scene' && !enclosingAnchor.includes(m)) {
          before[m].push(k);
        }
      });
    });
  });

  return before;
};

type Span = [number, number];

// The Scene windows a set of lengths gives, in the order they open: a clause start once its reach
// point plus the dwell already gone by comes up, an absolute start at its value. At a tie an
// absolute start opens first, then the earlier reach point, then DOM order. A window is reported at
// its start and length, or at its written end where atWrittenEnd says so, and engages only past the
// stretch the page already stands still for, so engaged windows never overlap and only they add to
// the dwell.
const placeWindows = (
  measurements: readonly LayerMeasurement[],
  scenes: readonly number[],
  lengths: readonly number[],
  atWrittenEnd: (index: number) => boolean,
): { reported: Span[]; engaged: Span[] } => {
  const rest = new Set(scenes);
  const reported: Span[] = [];
  const engaged: Span[] = [];
  let consumed = 0;
  let frozenUntil = -Infinity;

  while (rest.size) {
    let next = -1;
    let opensAt = 0;
    let nextIsAbsolute = false;
    let nextReach = 0;

    for (const k of rest) {
      const { start, triggerTop } = measurements[k];
      const isAbsolute = start.mode === 'absolute';
      const reach = start.mode === 'clause' ? triggerTop - start.anchorOffset : 0;
      const at = start.mode === 'absolute' ? start.value : reach + consumed;
      const tied = Math.abs(at - opensAt) <= TIE_TOLERANCE_PX;

      if (
        next === -1
        || at < opensAt - TIE_TOLERANCE_PX
        || (tied && (isAbsolute
          ? !nextIsAbsolute || at < opensAt
          : !nextIsAbsolute && reach < nextReach - TIE_TOLERANCE_PX))
      ) {
        next = k;
        opensAt = at;
        nextIsAbsolute = isAbsolute;
        nextReach = reach;
      }
    }

    const { end } = measurements[next];
    const reportedEnd = end.mode === 'absolute' && atWrittenEnd(next)
      ? Math.max(opensAt, end.value)
      : opensAt + lengths[next];
    const engagedStart = Math.max(opensAt, frozenUntil);
    const engagedEnd = Math.max(engagedStart, reportedEnd);

    rest.delete(next);
    reported[next] = [opensAt, reportedEnd];
    engaged[next] = [engagedStart, engagedEnd];
    consumed += engagedEnd - engagedStart;
    frozenUntil = Math.max(frozenUntil, engagedEnd);
  }

  return { reported, engaged };
};

// How a stage of planLayers reads absolute starts and ends (see PassWorld). With endsAsRefreshed,
// an absolute end counts the length its pin has when refreshed, from its start among the windows
// present then; without it, its written length. With startsAsRefreshed, an enclosing absolute start
// is judged among the windows ownIndex's pin sees when refreshed; without it, the reported ones.
interface Reading {
  endsAsRefreshed: boolean;
  startsAsRefreshed: boolean;
}

// Finalizes every layer's freeze window and style values, from measurements laid out in DOM order.
// A single Scene layer settles in one pass. With more, planLayers runs the whole pass (see runPass)
// until the lengths stop changing, placing the windows each pass gives (see placeWindows) for the
// next pass to read:
//
// - First every spacer counts. A clause with an endTrigger above an earlier layer's trigger can
//   flip a pair between two answers that straddle the one they share, so a pass back at the state
//   before last feeds the two's average. Some answers oscillate slowly before settling, so this
//   gets at least 64 passes. The answer stands only if no two lengths move each other there,
//   directly or through others (see activeEdges): GSAP's pins never count each other's dwell in
//   any creation order, and a pair whose ends count a share of each other would grow toward
//   1 / (1 - share) times their length.
//   Nor does it stand when no refresh order gives it (see refreshOrderEdges).
// - Otherwise, and when that never settles or runs away, the Scene layers are refreshed in
//   fallbackOrder's dependency order, reading absolute starts and ends among the reported
//   windows, as this fallback always has. Where that cycles, a cycle of up to four passes feeds its
//   average and any other pass feeds half its change. Where it still doesn't settle, absolute
//   starts and ends are read as each pin sees them when refreshed in that order, which settles
//   the rest but would move answers the reported reading already gives. Where only the refresh
//   order is missing, the same steps run in DOM order instead, close to the top-to-bottom order
//   GSAP recommends.
//
// planLayers throws if none of these settles.
export const planLayers = (
  measurements: readonly LayerMeasurement[],
  deps: PlanDeps,
): LayerPlan[] => {
  const scenes = measurements.flatMap(({ kind }, k) => (kind === 'scene' ? [k] : []));
  const needsConvergence = scenes.length > 1;
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
  const sameValues = (a: readonly (number | null)[], b: readonly (number | null)[]) =>
    a.every((value, i) => value === b[i]
      || (value !== null && b[i] !== null && Math.abs(value - b[i]!) <= TIE_TOLERANCE_PX));
  const sameState = (a: PreviousPass, b: PreviousPass) =>
    sameValues(a.paddings, b.paddings) && sameValues(a.freezeStarts, b.freezeStarts);
  const lengthsOf = (windows: readonly ({ freezeStart: number; freezeEnd: number } | null)[]) =>
    windows.map((window) => (window ? Math.max(0, window.freezeEnd - window.freezeStart) : 0));
  const stateAt = (lengths: readonly number[], reported: readonly Span[]): PreviousPass => ({
    paddings: measurements.map(({ kind }, k) => (kind === 'scene' ? lengths[k] : null)),
    freezeStarts: measurements.map(({ kind }, k) => (kind === 'scene' ? reported[k][0] : null)),
  });

  const mix = (states: readonly PreviousPass[], weights: readonly number[]): PreviousPass => {
    const of = (pick: (state: PreviousPass) => readonly (number | null)[]) =>
      pick(states[0]).map((value, k) => (value === null
        ? null
        : states.reduce((sum, state, j) => sum + weights[j] * pick(state)[k]!, 0)));

    return {
      paddings: of((state) => state.paddings),
      freezeStarts: of((state) => state.freezeStarts),
    };
  };

  // The windows the last pass placed, which the next pass reads. A stage's first pass reads the
  // last placement of the stage before. refreshTime caches refreshTimeOf.
  let world: {
    lengths: readonly number[];
    order: RefreshOrder | null;
    reported: readonly Span[];
    refreshTime: (readonly Span[] | undefined)[];
  } | null = null;

  const place = (lengths: readonly number[], order: RefreshOrder | null, reading: Reading) => {
    const placed = placeWindows(measurements, scenes, lengths, () => reading.endsAsRefreshed);

    world = { lengths, order, reported: placed.reported, refreshTime: [] };

    return placed;
  };

  // The reported windows ownIndex's pin sees when refreshed in the world's order: its own window
  // and those of the layers refreshed after it have no spacer yet, and an absolute end sits at its
  // written position.
  const refreshTimeOf = (own: number): readonly Span[] | null => {
    if (world === null) return null;

    const { lengths, order, refreshTime } = world;
    const absent = (k: number) => k === own || (order !== null && !order.isBefore(k, own));

    refreshTime[own] ??= placeWindows(
      measurements,
      scenes,
      lengths.map((length, k) => (absent(k) ? 0 : length)),
      (k) => !absent(k),
    ).reported;

    return refreshTime[own];
  };

  const passWorld = (order: RefreshOrder | null, reading: Reading): PassWorld => ({
    // freezeStart less the scroll before it that the page stands still for, among the windows
    // ownIndex's end can see: not its own (GSAP measures a point with its own pin reverted), and
    // under a refresh order, none refreshed after it, which have no spacer yet.
    unpaddedStart: (index, ownIndex, freezeStart) => {
      const windows = (reading.startsAsRefreshed ? refreshTimeOf(ownIndex) : null)
        ?? world?.reported
        ?? [];
      const spans = scenes
        .flatMap((k): Span[] => {
          if (k === index || k === ownIndex || !windows[k]) return [];

          if (order && !order.isBefore(k, ownIndex)) return [];

          const [from, to] = windows[k];

          return Math.min(to, freezeStart) > from ? [[from, Math.min(to, freezeStart)]] : [];
        })
        .sort((a, b) => a[0] - b[0]);
      let frozen = 0;
      let frozenUntil = -Infinity;

      for (const [from, to] of spans) {
        const lo = Math.max(from, frozenUntil);

        if (to > lo) frozen += to - lo;

        frozenUntil = Math.max(frozenUntil, to);
      }

      return freezeStart - frozen;
    },
    absoluteEndLength: (index) => {
      const { end } = measurements[index];

      if (!reading.endsAsRefreshed || end.mode !== 'absolute' || world === null) return null;

      // With every spacer present, a layer's refresh-time start is its reported one: its own
      // window moves nothing placed before it.
      const windows = world.order === null ? world.reported : refreshTimeOf(index)!;

      return Math.max(0, end.value - windows[index][0]);
    },
  });

  // Runs passes in `order` until the lengths stop changing, or returns null after `cap` passes. A
  // pass back at the state fed up to `cycle` passes before feeds that cycle's average; any other
  // pass feeds `damping` of its change.
  const solve = (
    order: RefreshOrder | null,
    reading: Reading,
    cap: number,
    record: ((index: number, counted: ReadonlySet<number>) => void) | null = null,
    cycle = 2,
    damping = 1,
  ) => {
    const reads = passWorld(order, reading);
    const fed: PreviousPass[] = [];
    let previous: PreviousPass | null = null;

    for (let pass = 0; pass < cap; pass += 1) {
      const lengths = lengthsOf(runPass(measurements, passDeps, previous, order, reads, record));
      const placed = place(lengths, order, reading);
      const next = stateAt(lengths, placed.reported);

      if (!needsConvergence || (previous !== null && sameState(next, previous))) {
        return { lengths, ...placed };
      }

      let feed = next;

      if (previous !== null) {
        fed.push(previous);

        let back = -1;

        for (let j = 0; j < cycle - 1 && back === -1; j += 1) {
          if (fed.length > j + 1 && sameState(next, fed[fed.length - j - 2])) back = j;
        }

        if (back !== -1) {
          const states = [...fed.slice(fed.length - back - 1), next];

          feed = mix(states, states.map(() => 1 / states.length));
        } else if (damping < 1) {
          feed = mix([next, previous], [damping, 1 - damping]);
        }
      }

      previous = feed;
    }

    return null;
  };

  // Which lengths each length moves at a solution: nudge one length, place the windows that gives
  // and recompute every length from that state alone.
  const activeEdges = (lengths: readonly number[], reading: Reading): number[][] => {
    const reads = passWorld(null, reading);

    const respond = (from: readonly number[]) => {
      const { reported } = place(from, null, reading);

      return lengthsOf(
        runPass(measurements, passDeps, stateAt(from, reported), null, reads, null, true),
      );
    };

    const base = respond(lengths);
    const edges: number[][] = measurements.map(() => []);

    scenes.forEach((k) => {
      const nudged = lengths.slice();

      // 2 ** -7: no length moves another by more than its own change, so this stays inside
      // TIE_TOLERANCE_PX and can't tip an exact tie; a power of two keeps the response exact.
      nudged[k] += 2 ** -7;
      respond(nudged).forEach((length, i) => {
        if (i !== k && Math.abs(length - base[i]) > 1e-6) edges[i].push(k);
      });
    });

    return edges;
  };

  // A runaway that multiplies the spacers every pass looks settled once floating point stops
  // registering the change, so a window that far out counts as unsettled.
  const unsettled = (solved: ReturnType<typeof solve>) => solved === null
    || solved.reported.some((window) => window.some((point) => !(Math.abs(point) <= 2 ** 48)));
  const counted: Set<number>[] = measurements.map(() => new Set());
  const everySpacer: Reading = { endsAsRefreshed: true, startsAsRefreshed: false };
  let solved = solve(
    null,
    everySpacer,
    Math.max(64, 2 * measurements.length + 2),
    (index, layers) => layers.forEach((k) => counted[index].add(k)),
  );

  // The refresh order to fall back to, or null where the first settle stands.
  const fallback = (): RefreshOrder | null => {
    if (unsettled(solved)) return fallbackOrder(measurements, counted);

    if (!needsConvergence) return null;

    const edges = activeEdges(solved!.lengths, everySpacer);

    if (hasCycle(scenes, edges)) return fallbackOrder(measurements, counted);

    return hasCycle(scenes, refreshOrderEdges(measurements, solved!.lengths, edges))
      ? { isBefore: (a, b) => a < b }
      : null;
  };

  const order = fallback();

  if (order) {
    const asReported: Reading = { endsAsRefreshed: false, startsAsRefreshed: false };

    solved = solve(order, asReported, 2 * measurements.length + 2);

    if (unsettled(solved)) {
      solved = solve(order, asReported, Math.max(64, 2 * measurements.length + 2), null, 4, 0.5);
    }

    if (unsettled(solved)) {
      solved = solve(
        order,
        { endsAsRefreshed: true, startsAsRefreshed: true },
        2 * measurements.length + 2,
      );
    }
  }

  if (unsettled(solved)) {
    throw new Error(
      'StickyScrollTrigger: could not resolve endTrigger positions: some endTrigger '
      + 'references form a circular structural dependency that never settles. Point each '
      + 'endTrigger at an element that doesn\'t depend on it.',
    );
  }

  const { reported, engaged } = solved!;
  // Each Scene wrapper sits inside the wrappers of the Scene layers after it in DOM order. Sticky
  // offsets add up down the nesting, so it engages late by the dwell of every one of them already
  // frozen, and its sticky top subtracts that dwell to engage at engagedStart.
  const scenePlans = measurements.map(({ kind }, index): LayerPlan | null => {
    if (kind !== 'scene') return null;

    const [engagedStart, engagedEnd] = engaged[index];
    const outerDwell = scenes.reduce((total, k) => (
      k > index && engaged[k][1] <= engagedStart + TIE_TOLERANCE_PX
        ? total + (engaged[k][1] - engaged[k][0])
        : total
    ), 0);

    return {
      freezeStart: reported[index][0],
      freezeEnd: reported[index][1],
      engagedStart,
      engagedEnd,
      stickyTop: deps.structureTop - (engagedStart - outerDwell),
      paddingHeight: engagedEnd - engagedStart,
    };
  });
  const windows = scenes.map((k) => ({ freezeStart: engaged[k][0], freezeEnd: engaged[k][1] }));
  const finalPlans = scenePlans.map(
    (plan, index) => plan ?? planCover(measurements, index, windows, passDeps),
  );

  finalPlans.forEach((plan, index) => deps.onPlanned(index, plan));

  return finalPlans;
};
