// The start and end functions refresh() calls, what they may call back, and end functions
// evaluated again in GSAP's layout (index.ts's #evaluateLiveEnd).

import { backToZeroAfterFunction } from './scrollZero';

// How many start or end functions refresh() is calling, and the first call one made that a
// refresh() can't take mid-measurement, thrown once the function returns.
let functionDepth = 0;
let misuse: string | null = null;

export const inStartEndFunction = (): boolean => functionDepth > 0;

const misuseMessage = (call: string): string => `StickyScrollTrigger: ${call} was called from a `
  + 'start or end function while refresh() evaluates it. Call it outside the function, after '
  + 'refresh() returns.';

// For a call GSAP has already carried out (a ScrollTrigger.refresh(), a kill()) whose part here is
// skipped or put off: the refresh() calling the function throws once it returns. Returns whether
// a function is running.
export const noteStartEndFunctionCall = (call: string): boolean => {
  if (functionDepth === 0) return false;

  misuse ??= misuseMessage(call);

  return true;
};

// For a call that hasn't done anything yet (destroy(), create*): throws inside a function, and
// the refresh() calling it throws too, should the function catch this.
export const assertOutsideStartEndFunction = (call: string): void => {
  if (noteStartEndFunctionCall(call)) throw new Error(misuseMessage(call));
};

// A layer's or pin's start or end function, which refresh() calls in its measurement. A function
// handed to resolveScrollPosition needs none of this, nor does createResolvedTrigger's, which
// GSAP calls.
export const asStartEndFunction = <T>(value: T | (() => T)): T | (() => T) => {
  if (typeof value !== 'function') return value;

  return () => {
    functionDepth += 1;

    let result: T;
    let found: string | null = null;

    try {
      result = (value as () => T)();
    } finally {
      functionDepth -= 1;

      // The function's own throw wins over a call it made.
      if (functionDepth === 0) {
        found = misuse;
        misuse = null;
      }

      backToZeroAfterFunction();
    }

    if (found !== null) throw new Error(found);

    return result;
  };
};

// An end function's evaluation (see evaluateLive). suspend puts the page back as refresh() left
// it, unless it already is, and returns the function that sets the evaluation up again.
// resolved: the function measured through resolveScrollPosition, which already gives GSAP's value.
type LiveEvaluation = {
  suspend: () => () => void;
  resolved: boolean;
};

// The end function evaluation under way, which resolveScrollPosition sets aside to measure.
let liveEvaluation: LiveEvaluation | null = null;
// How many layer handlers (each layer's onRefreshInit) are running, one inside another.
let layerHandlerDepth = 0;

// Runs a layer handler, counted for inLayerHandler.
export const asLayerHandler = <T>(handle: () => T): T => {
  layerHandlerDepth += 1;

  try {
    return handle();
  } finally {
    layerHandlerDepth -= 1;
  }
};

export const inLayerHandler = (): boolean => layerHandlerDepth > 0;

// Calls an end function in the layout setUp puts in place, taken down after it and while a
// suspend lasts. null if the function read through resolveOutsideEvaluation.
export const evaluateLive = <T>(setUp: () => () => void, call: () => T): T | null => {
  let takeDown = (): void => {};
  // Nested suspends: a position function that resolveScrollPosition calls can call it again.
  let holds = 0;
  const evaluation: LiveEvaluation = {
    resolved: false,
    suspend: () => {
      holds += 1;

      if (holds === 1) {
        takeDown();
        takeDown = () => {};
      }

      return () => {
        holds -= 1;

        if (holds === 0) takeDown = setUp();
      };
    },
  };

  try {
    takeDown = setUp();
    liveEvaluation = evaluation;

    const next = call();

    return evaluation.resolved ? null : next;
  } finally {
    liveEvaluation = null;
    takeDown();
  }
};

// Runs resolveScrollPosition's read with the evaluation under way suspended, and marks it
// resolved: the read already gives GSAP's value, so evaluateLive returns null.
export const resolveOutsideEvaluation = <T>(read: () => T): T => {
  const evaluation = liveEvaluation;

  if (!evaluation) return read();

  evaluation.resolved = true;

  const resume = evaluation.suspend();

  try {
    return read();
  } finally {
    resume();
  }
};
