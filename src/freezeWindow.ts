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
 * other in a cycle that never settles, planLayers falls back to the answer GSAP gives when it
 * refreshes the pins in dependency order (see fallbackOrder). Cover layers are planned last, from
 * the settled Scene windows, since nothing depends on a cover's own window.
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
  freezeStarts: readonly (number | null)[];
}

// The refresh order planLayers falls back to when no layout satisfies every Scene layer at once. A
// layer counts only layers before it, and a layer's trigger stops growing once it has been
// refreshed, so a later layer it holds pushes nothing outside it.
interface RefreshOrder {
  isBefore: (a: number, b: number) => boolean;
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
const anchorShare = (
  measurements: readonly LayerMeasurement[],
  windows: readonly KnownWindow[],
  index: number,
  freezeStart: number,
  box: AnchorBox,
  reachedAt: number,
  enclosedBy: readonly number[],
  anchorElement: number | null,
  order: RefreshOrder | null,
): number => {
  const measurement = measurements[index];

  if (enclosedBy.includes(index)) {
    const unpaddedFreezeStart = measurement.start.mode === 'absolute'
      ? freezeStart - windows.reduce((earlier, other) => (
        other.index !== index && other.freezeEnd <= freezeStart + TIE_TOLERANCE_PX
          ? earlier + other.freezeEnd - other.freezeStart
          : earlier
      ), 0)
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
    measurements, windows, index, freezeStart, box, reachedAt, enclosedBy, anchorElement, order,
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
// KnownWindow describes. stickyTop is filled in by planLayers once the windows settle.
const runPass = (
  measurements: readonly LayerMeasurement[],
  { viewportHeight, measureLiveEndTriggerTop }: PlanDeps,
  previous: PreviousPass | null,
  order: RefreshOrder | null,
  record: ((index: number, counted: ReadonlySet<number>) => void) | null,
): (LayerPlan | null)[] => {
  const fresh: (LayerPlan | null)[] = [];
  const knownWindows = (): KnownWindow[] => measurements.flatMap((measurement, k) => {
    if (measurement.kind !== 'scene') return [];

    const plan = fresh[k];

    if (plan) return [{ index: k, freezeStart: plan.freezeStart, freezeEnd: plan.freezeEnd }];

    const freezeStart = previous?.freezeStarts[k] ?? null;
    const paddingHeight = previous?.paddings[k] ?? null;

    return freezeStart === null || paddingHeight === null
      ? []
      : [{ index: k, freezeStart, freezeEnd: freezeStart + paddingHeight }];
  });
  const paddingOf = (k: number) => fresh[k]?.paddingHeight ?? previous?.paddings[k] ?? 0;
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
      : clauseFreezeStart(measurements, index, paddingOf);
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

        // Nothing inside the container moves during a freeze, so trigger reaches its end anchor the
        // same scroll distance after its start anchor however much freezes around it. An absolute
        // start has no anchor on trigger, so its end moves only by the spacers GSAP would put above
        // trigger: the dwell of every layer ending above it. Layers nested in or around trigger
        // count in neither case.
        if (measurement.endTriggerIsSelf) {
          if (start.mode === 'clause') {
            freezeEnd = freezeStart + Math.max(0, start.anchorOffset - anchorOffsetEnd);
            break;
          }

          const dwellAbove = measurements.reduce((total, other, k) => {
            if (
              k === index
              || other.kind !== 'scene'
              || other.triggerTop + other.triggerHeight > measurement.triggerTop + TIE_TOLERANCE_PX
              || (order && (order.isBefore(index, k)
                || isHeldIn(measurements, k, measurement.triggerEnclosedBy, index, order)))
            ) return total;

            recount.counted.add(k);

            return total + paddingOf(k);
          }, 0);

          freezeEnd = Math.max(freezeStart, measurement.triggerTop - anchorOffsetEnd + dwellAbove);
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

    const paddingHeight = Math.max(0, freezeEnd - freezeStart);
    const plan = { freezeStart, freezeEnd, stickyTop: 0, paddingHeight };

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
// earlier tests inside the later ones. planLayers can still produce an overlap: an absolute start
// can fall inside another layer's window.
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

// The refresh order for layers that never settle: every layer after the ones it counted and after
// the Scene layers whose triggers hold it, and DOM order within a cycle. Holders first
// keeps GSAP from growing a trigger by a spacer inside it, which the counting can't express.
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

// Finalizes every layer's freeze window and style values, from measurements laid out in DOM order.
// A single Scene layer settles in one pass. With more, a pass reads the previous pass's plan for
// every layer it hasn't reached yet (see runPass):
//
// - A clause start counts the padding of a layer later in DOM order that freezes first.
// - A clause with an endTrigger other than trigger needs gapsBeforeEndAnchor's lookup. An
//   endTrigger above an earlier layer's trigger leaves that layer out even though its dwell moves
//   i's start. With that layer's own end reaching past i's trigger, each pass flips the pair
//   between two answers that straddle the one they share, so a pass that returns to the answer
//   before last feeds the next one their average instead. Two nested layers whose endTriggers
//   each count the other's dwell never settle.
//
// Re-running the full pass with the previous pass's results settles a chain within two iterations
// per layer and such a flip within two more (see freezeWindow.test.ts's DOM-order-scrambled stress
// test and the flip test beside it). Ends that count a share of each other's dwell close the gap
// only by that share per pass, so the first settle gets at least 64 passes. A share near 1 needs
// more (about 90 at 0.9) and gets the fallback below instead, on purpose: its fixed point grows as
// 1 / (1 - share), into windows many times the page's height. Anything still moving after that is
// planned again in fallbackOrder's refresh order, which only an absolute start that flips what an
// end counts can keep from settling; planLayers throws then.
export const planLayers = (
  measurements: readonly LayerMeasurement[],
  deps: PlanDeps,
): LayerPlan[] => {
  const needsConvergence = measurements.filter(({ kind }) => kind === 'scene').length > 1;
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
  const stateOf = (passPlans: readonly (LayerPlan | null)[]): PreviousPass => ({
    paddings: passPlans.map((plan) => plan?.paddingHeight ?? null),
    freezeStarts: passPlans.map((plan) => plan?.freezeStart ?? null),
  });
  const sameValues = (a: readonly (number | null)[], b: readonly (number | null)[]) =>
    a.every((value, i) => value === b[i]
      || (value !== null && b[i] !== null && Math.abs(value - b[i]!) <= TIE_TOLERANCE_PX));
  const sameState = (a: PreviousPass, b: PreviousPass) =>
    sameValues(a.paddings, b.paddings) && sameValues(a.freezeStarts, b.freezeStarts);
  const average = (a: readonly (number | null)[], b: readonly (number | null)[]) =>
    a.map((value, i) => (value === null ? null : (value + b[i]!) / 2));

  // Runs passes until the plans stop changing, or returns null once the budget runs out.
  const settle = (
    order: RefreshOrder | null,
    record: ((index: number, counted: ReadonlySet<number>) => void) | null,
  ): (LayerPlan | null)[] | null => {
    let plans = runPass(measurements, passDeps, null, order, record);

    if (!needsConvergence) return plans;

    const budget = order === null
      ? Math.max(64, 2 * measurements.length + 2)
      : 2 * measurements.length + 2;
    let fed = stateOf(plans);
    let fedBefore: PreviousPass | null = null;

    for (let pass = 0; pass < budget; pass += 1) {
      plans = runPass(measurements, passDeps, fed, order, record);

      const out = stateOf(plans);

      if (sameState(out, fed)) return plans;

      const flipped = fedBefore !== null && sameState(out, fedBefore);

      fedBefore = fed;
      fed = flipped
        ? {
            paddings: average(out.paddings, fed.paddings),
            freezeStarts: average(out.freezeStarts, fed.freezeStarts),
          }
        : out;
    }

    return null;
  };

  const counted: Set<number>[] = measurements.map(() => new Set());
  let settled = settle(null, (index, layers) => layers.forEach((k) => counted[index].add(k)));

  if (settled === null) settled = settle(fallbackOrder(measurements, counted), null);

  if (settled === null) {
    throw new Error(
      'StickyScrollTrigger: could not resolve endTrigger positions: some endTrigger '
      + 'references form a circular structural dependency that never settles. Point each '
      + 'endTrigger at an element that doesn\'t depend on it.',
    );
  }

  const plans = settled;
  // Each Scene wrapper sits inside the wrappers of the Scene layers after it in DOM order. Sticky
  // offsets add up down the nesting, so it engages late by the dwell of every one of them already
  // frozen, and its sticky top subtracts that dwell to engage at freezeStart.
  const withTops = plans.map((plan, index) => {
    if (plan === null) return null;

    const outerDwell = plans.reduce((total, outer, k) => (
      k > index && outer !== null && outer.freezeEnd <= plan.freezeStart + TIE_TOLERANCE_PX
        ? total + outer.paddingHeight!
        : total
    ), 0);

    return { ...plan, stickyTop: deps.structureTop - (plan.freezeStart - outerDwell) };
  });
  const windows = withTops.filter((plan): plan is LayerPlan => plan !== null);
  const finalPlans = withTops.map(
    (plan, index) => plan ?? planCover(measurements, index, windows, passDeps),
  );

  finalPlans.forEach((plan, index) => deps.onPlanned(index, plan));

  return finalPlans;
};
