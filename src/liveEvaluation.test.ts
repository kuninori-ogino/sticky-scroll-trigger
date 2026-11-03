// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScrollTriggerClass } from './gsap';
import {
  asLayerHandler,
  evaluateLive,
  holdLiveEvaluationForGsapRefresh,
  inLayerHandler,
  resolveOutsideEvaluation,
} from './liveEvaluation';
import { enterScrollZero } from './scrollZero';

// index.ts tests what an end function sees when it is called again. Here: the evaluation frame,
// its suspends, and the hold for a GSAP refresh the function starts. Each test ends every frame it
// starts, since the state is the module's.

let scroll = 0;
let log: string[] = [];

beforeEach(() => {
  scroll = 1000;
  log = [];
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
  vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
    scroll = (options as ScrollToOptions).top ?? scroll;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A set-up that logs when it puts its layout in place and takes it down.
const setUpLogged = (name: string) => () => {
  log.push(`${name} up`);

  return () => log.push(`${name} down`);
};

// A class inside GSAP's refresh, with its record, scroll cache and 'refresh' listeners.
const makeClass = (rec: number) => {
  const refreshListeners: (() => unknown)[] = [];
  const scrollFunc = Object.assign((value?: number) => {
    if (value !== undefined) scrollFunc.cached = value;

    return scrollFunc.cached;
  }, { rec, cached: rec });
  const cls = {
    refresh: vi.fn(),
    isRefreshing: true,
    getScrollFunc: () => scrollFunc,
    addEventListener: (type: string, callback: () => unknown) => {
      if (type === 'refresh') refreshListeners.push(callback);
    },
    removeEventListener: vi.fn(),
  } as ScrollTriggerClass;

  return { cls, scrollFunc, dispatchRefresh: () => refreshListeners.forEach((f) => f()) };
};

describe('evaluateLive', () => {
  it('calls the function in the layout set up, and takes it down after, a throw included', () => {
    expect(evaluateLive(setUpLogged('a'), 0, () => {
      log.push('call');

      return 5;
    })).toBe(5);
    expect(log).toEqual(['a up', 'call', 'a down']);

    log = [];

    expect(() => evaluateLive(setUpLogged('a'), 0, () => {
      throw new Error('end');
    })).toThrow('end');
    expect(log).toEqual(['a up', 'a down']);
  });

  it('returns null for a function that read through resolveOutsideEvaluation, with its layout down', () => {
    const result = evaluateLive(setUpLogged('a'), 0, () => resolveOutsideEvaluation(() => {
      log.push('read');

      return 5;
    }));

    expect(result).toBeNull();
    expect(log).toEqual(['a up', 'a down', 'read', 'a up', 'a down']);
  });

  it('suspends every evaluation around one, innermost first, and resolves only the innermost', () => {
    let inner: number | null = 0;
    const outer = evaluateLive(setUpLogged('outer'), 0, () => {
      inner = evaluateLive(setUpLogged('inner'), 0, () => resolveOutsideEvaluation(() => {
        log.push('read');

        return 1;
      }));

      return 2;
    });

    expect(inner).toBeNull();
    expect(outer).toBe(2);
    expect(log).toEqual([
      'outer up', 'inner up',
      'inner down', 'outer down', 'read', 'outer up', 'inner up',
      'inner down', 'outer down',
    ]);
  });
});

describe('resolveOutsideEvaluation', () => {
  it('only reads outside an evaluation', () => {
    expect(resolveOutsideEvaluation(() => 3)).toBe(3);
  });
});

describe('asLayerHandler', () => {
  it('counts the handler running, until it returns or throws', () => {
    expect(inLayerHandler()).toBe(false);
    expect(asLayerHandler(() => inLayerHandler())).toBe(true);
    expect(() => asLayerHandler(() => {
      throw new Error('handler');
    })).toThrow('handler');
    expect(inLayerHandler()).toBe(false);
  });
});

describe('holdLiveEvaluationForGsapRefresh', () => {
  it('sets the evaluation aside until the \'refresh\' of the GSAP refresh it started', () => {
    const { cls, dispatchRefresh } = makeClass(1000);
    let readInside: number | null = 0;
    const result = evaluateLive(setUpLogged('a'), 1000, () => {
      // GSAP's refreshInit dispatch, the function's: a layer handler holds it.
      asLayerHandler(() => holdLiveEvaluationForGsapRefresh(cls));
      log.push('held');
      // Not the function's read: the evaluation is set aside.
      readInside = resolveOutsideEvaluation(() => 4);
      dispatchRefresh();
      log.push('refreshed');

      return 6;
    });

    expect(readInside).toBe(4);
    expect(result).toBe(6);
    expect(log).toEqual(['a up', 'a down', 'held', 'a up', 'refreshed', 'a down']);
  });

  it('leaves the layout down when the function returns before that \'refresh\'', () => {
    const { cls, scrollFunc, dispatchRefresh } = makeClass(1000);

    // A GSAP refresh that threw before its 'refresh', which one under way around it dispatches.
    evaluateLive(setUpLogged('a'), 1000, () => {
      asLayerHandler(() => holdLiveEvaluationForGsapRefresh(cls));
    });
    dispatchRefresh();

    expect(log).toEqual(['a up', 'a down']);

    // Nor is it under way again: the next evaluation's scroll is its own.
    evaluateLive(setUpLogged('b'), 500, () => {
      scroll = 300;
      scrollFunc.rec = 300;
      asLayerHandler(() => holdLiveEvaluationForGsapRefresh(cls));
    });

    expect(scroll).toBe(500);
  });

  it('gives GSAP the scroll on the page refresh() left as its record', () => {
    const { cls, scrollFunc, dispatchRefresh } = makeClass(1000);

    evaluateLive(setUpLogged('a'), 1000, () => {
      // The function's shorter layout cut the scroll, and GSAP took it.
      scroll = 700;
      scrollFunc.rec = 700;
      scrollFunc.cached = 700;
      asLayerHandler(() => holdLiveEvaluationForGsapRefresh(cls));
      dispatchRefresh();
    });

    expect(scroll).toBe(1000);
    expect(scrollFunc.rec).toBe(1000);
    expect(scrollFunc.cached).toBe(1000);
  });

  it('goes back in whole pixels, leaving GSAP the evaluation\'s scroll during a measurement at 0', () => {
    const { cls, scrollFunc, dispatchRefresh } = makeClass(0);

    scroll = 1000.4;

    const back = enterScrollZero(null);

    try {
      evaluateLive(setUpLogged('a'), 1000.4, () => {
        asLayerHandler(() => holdLiveEvaluationForGsapRefresh(cls));

        expect(scroll).toBe(1000);
        expect(scrollFunc.rec).toBe(1000.4);

        dispatchRefresh();
      });
    } finally {
      back();
    }
  });

  it('holds through a \'refresh\' deeper in layer handlers than the GSAP refresh it started', () => {
    const { cls, dispatchRefresh } = makeClass(1000);

    evaluateLive(setUpLogged('a'), 1000, () => {
      asLayerHandler(() => {
        holdLiveEvaluationForGsapRefresh(cls);
        // A GSAP refresh a nested refresh()'s function started inside this handler.
        dispatchRefresh();
        log.push('nested');
      });
      dispatchRefresh();
    });

    expect(log).toEqual(['a up', 'a down', 'nested', 'a up', 'a down']);
  });

  it('gives GSAP the outermost evaluation\'s scroll from a nested one', () => {
    const { cls, scrollFunc, dispatchRefresh } = makeClass(1000);

    evaluateLive(setUpLogged('outer'), 1000, () => {
      scroll = 700;
      evaluateLive(setUpLogged('inner'), 700, () => {
        scroll = 500;
        scrollFunc.rec = 500;
        asLayerHandler(() => holdLiveEvaluationForGsapRefresh(cls));
        dispatchRefresh();
      });
    });

    expect(scrollFunc.rec).toBe(1000);
  });

  it('with no evaluation, gives a GSAP refresh started during a measurement at 0 the real scroll', () => {
    const { cls, scrollFunc } = makeClass(0);
    const back = enterScrollZero(null);

    try {
      holdLiveEvaluationForGsapRefresh(cls);
    } finally {
      back();
    }

    expect(scrollFunc.rec).toBe(1000);
  });
});
