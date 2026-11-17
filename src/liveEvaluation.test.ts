// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asLayerHandler,
  asStartEndFunction,
  assertOutsideStartEndFunction,
  evaluateLive,
  inLayerHandler,
  inStartEndFunction,
  noteStartEndFunctionCall,
  resolveOutsideEvaluation,
} from './liveEvaluation';
import { enterScrollZero } from './scrollZero';

// index.ts tests what a function sees and what refresh() does with its calls. Here: the function
// frame and the calls it notes, and the evaluation frame and its suspends. Each test ends every
// frame it starts, since the state is the module's.

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

const call = <T>(fn: T | (() => T)): T => (fn as () => T)();

describe('asStartEndFunction', () => {
  it('passes a value through and calls a function, counted until it returns or throws', () => {
    expect(asStartEndFunction(5)).toBe(5);
    expect(call(asStartEndFunction(() => inStartEndFunction()))).toBe(true);
    expect(() => call(asStartEndFunction(() => {
      throw new Error('end');
    }))).toThrow('end');
    expect(inStartEndFunction()).toBe(false);
    expect(noteStartEndFunctionCall('kill()')).toBe(false);
  });

  it('throws for a call the function made once it returns, and only for that one', () => {
    const fn = asStartEndFunction(() => {
      noteStartEndFunctionCall('ScrollTrigger.refresh()');
      noteStartEndFunctionCall('kill()');

      return 5;
    });

    expect(() => call(fn)).toThrow(
      'StickyScrollTrigger: ScrollTrigger.refresh() was called from a start or end function',
    );
    expect(call(asStartEndFunction(() => 6))).toBe(6);
  });

  it('throws at a call that has done nothing yet, and again once a function catching it returns', () => {
    const fn = asStartEndFunction(() => {
      expect(() => assertOutsideStartEndFunction('destroy()')).toThrow('destroy() was called');

      return 5;
    });

    expect(() => assertOutsideStartEndFunction('destroy()')).not.toThrow();
    expect(() => call(fn)).toThrow('destroy() was called');
  });

  it('lets the function\'s own throw win and leaves nothing for the next one', () => {
    const fn = asStartEndFunction(() => {
      noteStartEndFunctionCall('kill()');
      throw new Error('end');
    });

    expect(() => call(fn)).toThrow('end');
    expect(call(asStartEndFunction(() => 6))).toBe(6);
  });

  it('goes back to 0 after a function, one that throws included, inside a measurement at 0', () => {
    const back = enterScrollZero(null);

    expect(call(asStartEndFunction(() => {
      scroll = 400;

      return 7;
    }))).toBe(7);
    expect(scroll).toBe(0);
    expect(() => call(asStartEndFunction(() => {
      scroll = 400;
      throw new Error('end');
    }))).toThrow('end');
    expect(scroll).toBe(0);

    back();

    expect(scroll).toBe(1000);
  });
});

describe('evaluateLive', () => {
  it('calls the function in the layout set up, and takes it down after, a throw included', () => {
    expect(evaluateLive(setUpLogged('a'), () => {
      log.push('call');

      return 5;
    })).toBe(5);
    expect(log).toEqual(['a up', 'call', 'a down']);

    log = [];

    expect(() => evaluateLive(setUpLogged('a'), () => {
      throw new Error('end');
    })).toThrow('end');
    expect(log).toEqual(['a up', 'a down']);
  });

  it('returns null for a function that read through resolveOutsideEvaluation, with its layout down', () => {
    const result = evaluateLive(setUpLogged('a'), () => resolveOutsideEvaluation(() => {
      log.push('read');

      return 5;
    }));

    expect(result).toBeNull();
    expect(log).toEqual(['a up', 'a down', 'read', 'a up', 'a down']);
  });

  it('keeps the layout down through a read inside a read', () => {
    evaluateLive(setUpLogged('a'), () => resolveOutsideEvaluation(() => {
      resolveOutsideEvaluation(() => log.push('inner read'));
      log.push('outer read');
    }));

    expect(log).toEqual(['a up', 'a down', 'inner read', 'outer read', 'a up', 'a down']);
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
