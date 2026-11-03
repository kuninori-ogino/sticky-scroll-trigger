// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScrollTriggerClass } from './gsap';
import {
  enterScrollZero,
  gsapScrollToZero,
  isGsapAtZero,
  isPageScrolling,
  isUserScrolling,
  mayBeStuckAround,
  moveScrollZeroReturn,
  realScroll,
  scrollZeroReturnTop,
  withAfterFunction,
} from './scrollZero';

// What dormancy moved past its freeze, for mayBeStuckAround.
const moved = vi.hoisted(() => new Set<HTMLElement>());

vi.mock('./dormancy', async (importOriginal) => ({
  ...await importOriginal<typeof import('./dormancy')>(),
  movedPastFreeze: () => moved,
}));

// index.ts tests where refresh() and the reads go to 0. Here: the trips themselves, the way back
// and the own-trip rule. Each test ends every trip it starts, since the state is the module's.

let scroll = 0;
let scrolls: number[] = [];
// Each test starts past any own trip an earlier one left counted.
let clock = 1e12;

beforeEach(() => {
  clock += 1e6;
  scroll = 800;
  scrolls = [];
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
  vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
    scroll = (options as ScrollToOptions).top ?? scroll;
    scrolls.push(scroll);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.removeAttribute('style');
  moved.clear();
});

// A class inside GSAP's refresh with the record `rec`, or outside one.
const makeClass = (
  { rec, scrolling = false, updating = false, refreshing = rec !== undefined }:
  { rec?: number; scrolling?: boolean; updating?: boolean; refreshing?: boolean } = {},
) => {
  const scrollFunc = Object.assign(() => scroll, { rec });

  return {
    refresh: vi.fn(),
    isRefreshing: refreshing,
    isUpdating: updating,
    isScrolling: () => scrolling,
    getScrollFunc: () => scrollFunc,
    scrollFunc,
  } as ScrollTriggerClass & { scrollFunc: { rec?: number } };
};

describe('enterScrollZero', () => {
  it('goes to 0 and back, holding the way back meanwhile', () => {
    const back = enterScrollZero(null);

    expect(scrolls).toEqual([0]);
    expect(scrollZeroReturnTop()).toBe(800);
    expect(realScroll()).toBe(800);

    back();

    expect(scrolls).toEqual([0, 800]);
    expect(scrollZeroReturnTop()).toBeNull();
    expect(realScroll()).toBeNull();
  });

  it('inside another, goes back to 0 and leaves the outer way back', () => {
    const back = enterScrollZero(null);

    // A function's GSAP refresh went back to the real scroll.
    scroll = 500;

    const inner = enterScrollZero(null);

    expect(scrolls).toEqual([0, 0]);

    inner();

    expect(scrolls).toEqual([0, 0]);

    back();

    expect(scrolls).toEqual([0, 0, 800]);
  });

  it('brings GSAP\'s scroll cache up to the scroll it went back to', () => {
    let cached = 0;
    const scrollFunc = vi.fn((value?: number) => {
      if (value !== undefined) cached = value;

      return cached;
    });

    enterScrollZero({ refresh: vi.fn(), getScrollFunc: () => scrollFunc } as ScrollTriggerClass)();

    expect(cached).toBe(800);
  });

  it('goes back where a kill\'s catch-up moved the way back', () => {
    const back = enterScrollZero(null);

    moveScrollZeroReturn(650);
    back();

    expect(scrolls).toEqual([0, 650]);
  });
});

describe('gsapScrollToZero', () => {
  it('goes to 0 and back to GSAP\'s record as it reads on the way back', () => {
    const cls = makeClass({ rec: 800 });
    const back = gsapScrollToZero(cls);

    expect(scrolls).toEqual([0]);
    expect(isGsapAtZero()).toBe(true);
    expect(realScroll()).toBe(800);

    cls.scrollFunc.rec = 950;
    back();

    expect(scrolls).toEqual([0, 950]);
    expect(isGsapAtZero()).toBe(false);
    expect(realScroll()).toBeNull();
  });

  it('does nothing with a record of 0 or outside GSAP\'s refresh', () => {
    gsapScrollToZero(makeClass({ rec: 0 }))();
    gsapScrollToZero(makeClass())();

    expect(scrolls).toEqual([]);
    expect(isGsapAtZero()).toBe(false);
  });

  it('inside another, away from 0, goes there and back, leaving the outer way back', () => {
    const cls = makeClass({ rec: 800 });
    const back = gsapScrollToZero(cls);

    scroll = 300;

    const inner = gsapScrollToZero(cls);

    inner();

    expect(scrolls).toEqual([0, 0, 300]);
    expect(isGsapAtZero()).toBe(true);

    back();

    expect(scrolls).toEqual([0, 0, 300, 800]);
  });

  it('inside another, at 0 already, does nothing', () => {
    const back = gsapScrollToZero(makeClass({ rec: 800 }));

    gsapScrollToZero(makeClass({ rec: 800 }))();

    expect(scrolls).toEqual([0]);

    back();
  });

  it('inside another, counts its way back as the library\'s own trip', () => {
    const cls = makeClass({ rec: 800 });
    const back = gsapScrollToZero(cls);

    scroll = 300;
    gsapScrollToZero(cls)();
    (cls as { isScrolling: () => boolean }).isScrolling = () => true;

    expect(isUserScrolling(cls)).toBe(false);

    back();
  });
});

describe.each([
  ['enterScrollZero', enterScrollZero],
  ['gsapScrollToZero', gsapScrollToZero],
])('isPageScrolling and isUserScrolling after %s', (_, trip) => {
  // A trip begun with GSAP reporting `scrolling`, after which GSAP reports a scroll.
  const tripThenScrolling = (scrolling: boolean) => {
    const cls = makeClass({ rec: 800, scrolling });

    trip(cls)();
    (cls as { isScrolling: () => boolean }).isScrolling = () => true;

    return cls;
  };

  it('count the library\'s own trip from rest as none, while the page stays where it came back to', () => {
    const cls = tripThenScrolling(false);

    expect(isPageScrolling(cls)).toBe(false);
    expect(isUserScrolling(cls)).toBe(false);

    scroll += 1;

    expect(isPageScrolling(cls)).toBe(true);
    expect(isUserScrolling(cls)).toBe(true);
  });

  it('leave GSAP\'s word once 500 ms have gone since the trip', () => {
    const cls = tripThenScrolling(false);

    clock += 499;

    expect(isUserScrolling(cls)).toBe(false);

    clock += 1;

    expect(isUserScrolling(cls)).toBe(true);
  });

  it('leave GSAP\'s word after a trip begun mid-scroll', () => {
    expect(isUserScrolling(tripThenScrolling(true))).toBe(true);
  });
});

describe('isPageScrolling', () => {
  it('counts GSAP\'s update as a scroll outside GSAP\'s refresh, unlike isUserScrolling', () => {
    expect(isPageScrolling(makeClass({ updating: true }))).toBe(true);
    expect(isPageScrolling(makeClass({ updating: true, refreshing: true }))).toBe(false);
    expect(isUserScrolling(makeClass({ updating: true }))).toBe(false);
  });
});

describe('withAfterFunction', () => {
  it('passes a value through and calls a function as it is outside a measurement at 0', () => {
    const fn = vi.fn(() => 7);

    expect(withAfterFunction(5)).toBe(5);
    expect((withAfterFunction(fn) as () => number)()).toBe(7);
    expect(scrolls).toEqual([]);
  });

  it('goes back to 0 after a function, one that throws included, inside a measurement at 0', () => {
    const back = enterScrollZero(null);
    // The function's GSAP refresh went back to the real scroll.
    const returns = withAfterFunction(() => {
      scroll = 400;

      return 7;
    }) as () => number;
    const throws = withAfterFunction(() => {
      scroll = 400;
      throw new Error('end');
    }) as () => number;

    expect(returns()).toBe(7);
    expect(scroll).toBe(0);
    expect(throws).toThrow('end');
    expect(scroll).toBe(0);

    back();

    expect(scroll).toBe(800);
  });

  it('goes back to 0 after a function inside a layer handler\'s measurement in GSAP\'s refresh', () => {
    const back = gsapScrollToZero(makeClass({ rec: 800 }));
    const fn = withAfterFunction(() => {
      scroll = 800;
    }) as () => void;

    fn();

    expect(scroll).toBe(0);

    back();

    expect(scroll).toBe(800);
  });
});

describe('mayBeStuckAround', () => {
  it('finds a sticky ancestor besides the instance\'s own, up to the body', () => {
    document.body.innerHTML = `
      <div class="page" style="position: sticky">
        <div class="own" style="position: sticky"><p></p></div>
      </div>
    `;

    const p = document.querySelector<HTMLElement>('p')!;
    const own = new Set([document.querySelector<HTMLElement>('.own')!]);
    const page = document.querySelector<HTMLElement>('.page')!;

    expect(mayBeStuckAround([p], own)).toBe(true);

    page.style.position = 'relative';

    expect(mayBeStuckAround([p], own)).toBe(false);
    expect(mayBeStuckAround([p], new Set())).toBe(true);

    document.body.style.position = 'sticky';

    expect(mayBeStuckAround([p], own)).toBe(false);
  });

  it('finds an ancestor dormancy moved past its freeze', () => {
    document.body.innerHTML = '<div class="wrapper"><p></p></div>';
    moved.add(document.querySelector<HTMLElement>('.wrapper')!);

    expect(mayBeStuckAround([document.querySelector<HTMLElement>('p')!], new Set())).toBe(true);
  });
});
