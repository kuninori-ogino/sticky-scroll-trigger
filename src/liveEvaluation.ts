// End functions evaluated again in GSAP's layout (index.ts's #evaluateLiveEnd), nested or not, and
// the scroll a GSAP refresh started from a start or end function takes.

import { setGsapRefreshReturn } from './dormancy';
import { addGsapListener, removeGsapListener, scrollRecord, syncScrollCache } from './gsap';
import type { ScrollTriggerClass } from './gsap';
import { realScroll, scrollBackTo } from './scrollZero';

// An end function's evaluation (see evaluateLive). suspend puts the page back as refresh()
// left it, unless it already is, and returns the function that sets the evaluation up again.
// resolved: the function measured through resolveScrollPosition, which already gives GSAP's
// value. outer: the evaluation whose function started this one, whose layout is in place too.
// scroll: the scroll on the page refresh() left, before any evaluation's shorter layout cut it.
type LiveEvaluation = {
  suspend: (resolving: boolean) => () => void;
  resolved: boolean;
  ended: boolean;
  outer: LiveEvaluation | null;
  scroll: number;
};

// Suspends an evaluation and every one around it, innermost first, and returns the function that
// sets them up again, outermost first.
const suspendLiveEvaluations = (evaluation: LiveEvaluation, resolving: boolean): (() => void) => {
  const resumes: (() => void)[] = [];

  for (let current: LiveEvaluation | null = evaluation; current; current = current.outer) {
    resumes.unshift(current.suspend(resolving && current === evaluation));
  }

  return () => resumes.forEach((resume) => resume());
};

// The end function evaluation under way, which resolveScrollPosition sets aside to measure.
let liveEvaluation: LiveEvaluation | null = null;
// How many layer handlers (each layer's onRefreshInit) are running, one inside another.
let layerHandlerDepth = 0;

// Runs a layer handler, counted for the hold below and for inLayerHandler.
export const asLayerHandler = <T>(handle: () => T): T => {
  layerHandlerDepth += 1;

  try {
    return handle();
  } finally {
    layerHandlerDepth -= 1;
  }
};

export const inLayerHandler = (): boolean => layerHandlerDepth > 0;

// A GSAP refresh the end function under evaluation starts measures the page refresh() left, with
// no evaluation's layout in, from its first layer handler until its 'refresh'. Only a 'refresh' no
// deeper in layer handlers than that start resumes: one started inside a handler (by a nested
// refresh()'s function, say) ends deeper, or never if it threw. The listener comes off in a
// microtask, since GSAP's dispatch maps over its live listener array. Until the 'refresh' no
// evaluation is under way, so a resolveScrollPosition there isn't the function's.
export const holdLiveEvaluationForGsapRefresh = (cls: ScrollTriggerClass | null): void => {
  const evaluation = liveEvaluation;
  // A GSAP refresh a function starts during a measurement at 0 goes back to the real scroll.
  const real = realScroll();

  if (real !== null && !evaluation) {
    const zeroRecord = scrollRecord(cls, true);

    if (zeroRecord && Math.abs(zeroRecord.read() - real) >= 0.5) {
      zeroRecord.write(real);
      setGsapRefreshReturn(real);
    }
  }

  if (!evaluation) return;

  const resume = suspendLiveEvaluations(evaluation, false);
  // GSAP took the scroll in the function's layout, cut back if that is shorter, and would run
  // every trigger's callbacks there after measuring. A top-level call would have taken it before
  // any listener ahead of this one moved it.
  const record = scrollRecord(cls, true);

  if (record && Math.abs(record.read() - evaluation.scroll) >= 0.5) {
    // Whole pixels, as GSAP's scroll function goes there.
    scrollBackTo(Math.round(evaluation.scroll));
    syncScrollCache(cls);

    // Where the scroll got to, if the page is shorter than that now. A measurement at 0 left GSAP
    // its 0 to take, where a top-level call would have taken the scroll as it was.
    const unclamped = window.scrollY >= Math.round(evaluation.scroll) - 0.5;
    const reached = realScroll() !== null && unclamped ? evaluation.scroll : window.scrollY;

    record.write(reached);
    // The nested-sticky table took the scroll too if its listener came first.
    setGsapRefreshReturn(reached);
  }

  // This handler is one deeper than where the function started the GSAP refresh.
  const depth = layerHandlerDepth - 1;
  let held = true;

  liveEvaluation = null;

  const onRefresh = () => {
    if (!held || layerHandlerDepth > depth) return;

    held = false;
    resume();

    if (!evaluation.ended) liveEvaluation = evaluation;
  };

  addGsapListener(cls, 'refresh', onRefresh);
  queueMicrotask(() => removeGsapListener(cls, 'refresh', onRefresh));
};

// Calls an end function in the layout setUp puts in place, taken down after it and while a
// suspend lasts. null if the function read through resolveOutsideEvaluation.
export const evaluateLive = <T>(
  setUp: () => () => void,
  scroll: number,
  call: () => T,
): T | null => {
  let takeDown = (): void => {};
  let holds = 0;
  const evaluation: LiveEvaluation = {
    resolved: false,
    ended: false,
    outer: liveEvaluation,
    // Inside another evaluation, the scroll read before this one is that layout's.
    scroll: liveEvaluation?.scroll ?? scroll,
    suspend: (resolving) => {
      if (resolving) evaluation.resolved = true;

      holds += 1;

      // Done once: a padding a GSAP refresh in the hold sets to 0 is that refresh's.
      if (holds === 1) {
        takeDown();
        takeDown = () => {};
      }

      // Called once per suspend. A GSAP refresh that threw before its end leaves its hold to
      // the 'refresh' of one under way around the evaluation, which comes after it is over.
      return () => {
        holds -= 1;

        if (holds === 0 && !evaluation.ended) takeDown = setUp();
      };
    },
  };

  try {
    takeDown = setUp();
    liveEvaluation = evaluation;

    const next = call();

    return evaluation.resolved ? null : next;
  } finally {
    evaluation.ended = true;
    liveEvaluation = evaluation.outer;
    takeDown();
  }
};

// Runs resolveScrollPosition's read with every evaluation under way suspended, and marks the
// innermost resolved: the read already gives GSAP's value, so evaluateLive returns null.
export const resolveOutsideEvaluation = <T>(read: () => T): T => {
  const resume = liveEvaluation && suspendLiveEvaluations(liveEvaluation, true);

  try {
    return read();
  } finally {
    resume?.();
  }
};
