// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addGsapListener,
  classOf,
  isRefreshing,
  isScrolling,
  isScrollingOrUpdating,
  refreshAll,
  removeGsapListener,
  revertAfterMeasure,
  scrollRecord,
  syncScrollCache,
} from './gsap';
import type { ScrollTriggerClass } from './gsap';

// index.ts and dormancy.ts test what they do with these. Here: a class missing a member or holding
// an unexpected value.

const makeClass = (members: Partial<ScrollTriggerClass> = {}): ScrollTriggerClass =>
  ({ refresh: vi.fn(), ...members }) as ScrollTriggerClass;
const scrollFuncWith = (rec: unknown) => Object.assign(vi.fn(), { rec });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classOf', () => {
  it('reads the class off the instance GSAP passes in', () => {
    class Fake {}

    expect(classOf(new Fake() as unknown as ScrollTrigger)).toBe(Fake);
  });
});

describe('isRefreshing', () => {
  it('is true only while isRefreshing is true', () => {
    expect(isRefreshing(makeClass({ isRefreshing: true }))).toBe(true);
    expect(isRefreshing(makeClass({ isRefreshing: false }))).toBe(false);
    expect(isRefreshing(makeClass())).toBe(false);
    expect(isRefreshing(null)).toBe(false);
  });
});

describe('isScrolling', () => {
  it('reads isScrolling(), and false without one', () => {
    expect(isScrolling(makeClass({ isScrolling: () => true }))).toBe(true);
    expect(isScrolling(makeClass({ isScrolling: () => false }))).toBe(false);
    expect(isScrolling(makeClass())).toBe(false);
    expect(isScrolling(null)).toBe(false);
  });
});

describe('isScrollingOrUpdating', () => {
  it('also counts an update in progress, and only an isUpdating of true', () => {
    expect(isScrollingOrUpdating(makeClass({ isUpdating: true }))).toBe(true);
    expect(isScrollingOrUpdating(makeClass({ isUpdating: 1 }))).toBe(false);
    expect(isScrollingOrUpdating(makeClass({ isScrolling: () => true }))).toBe(true);
    expect(isScrollingOrUpdating(makeClass())).toBe(false);
  });
});

describe('addGsapListener and removeGsapListener', () => {
  it('pass the listener through, and skip a class without the methods', () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const callback = () => {};

    addGsapListener(makeClass({ addEventListener }), 'refreshInit', callback);
    removeGsapListener(makeClass({ removeEventListener }), 'refresh', callback);

    expect(addEventListener).toHaveBeenCalledWith('refreshInit', callback);
    expect(removeEventListener).toHaveBeenCalledWith('refresh', callback);
    expect(() => addGsapListener(makeClass(), 'refresh', callback)).not.toThrow();
    expect(() => removeGsapListener(null, 'refresh', callback)).not.toThrow();
  });
});

describe('refreshAll', () => {
  it('calls ScrollTrigger.refresh(), and skips a class without it', () => {
    const cls = makeClass();

    refreshAll(cls);

    expect(cls.refresh).toHaveBeenCalledTimes(1);
    expect(() => refreshAll({} as ScrollTriggerClass)).not.toThrow();
    expect(() => refreshAll(null)).not.toThrow();
  });
});

describe('scrollRecord', () => {
  it('reads and writes rec on the scroll function itself, each time', () => {
    const scrollFunc = scrollFuncWith(800);
    const cls = makeClass({ isRefreshing: true, getScrollFunc: () => scrollFunc });
    const record = scrollRecord(cls)!;

    expect(record.read()).toBe(800);

    scrollFunc.rec = 900;

    expect(record.read()).toBe(900);

    record.write(1000);

    expect(scrollFunc.rec).toBe(1000);
  });

  it('is null outside a GSAP refresh, at rec 0, for a rec that isn\'t a number, or with no scroll function', () => {
    const withRec = (rec: unknown, refreshing = true) =>
      makeClass({ isRefreshing: refreshing, getScrollFunc: () => scrollFuncWith(rec) });

    expect(scrollRecord(withRec(800, false))).toBeNull();
    expect(scrollRecord(withRec(0))).toBeNull();
    expect(scrollRecord(withRec('800'))).toBeNull();
    expect(scrollRecord(makeClass({ isRefreshing: true }))).toBeNull();
    expect(scrollRecord(null)).toBeNull();
  });
});

describe('syncScrollCache', () => {
  const withCache = (cached: unknown) => {
    const scrollFunc = vi.fn((value?: number) => (value === undefined ? cached : undefined));

    syncScrollCache(makeClass({ getScrollFunc: () => scrollFunc }));

    return scrollFunc;
  };

  it('sets the cache to the scroll only when it is off by half a pixel or more', () => {
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(500);

    expect(withCache(500.4)).not.toHaveBeenCalledWith(500);
    expect(withCache(500.5)).toHaveBeenCalledWith(500);
    expect(withCache(undefined)).toHaveBeenCalledWith(500);
  });

  it('skips a class without a scroll function', () => {
    expect(() => syncScrollCache(makeClass())).not.toThrow();
    expect(() => syncScrollCache(makeClass({ getScrollFunc: () => ({}) }))).not.toThrow();
  });
});

describe('revertAfterMeasure', () => {
  it('renders the caller\'s result first, then restores', () => {
    const calls: string[] = [];
    const result = { render: (time: number) => calls.push(`render ${time}`) };

    revertAfterMeasure(() => calls.push('restore'), result).render(-1);

    expect(calls).toEqual(['render -1', 'restore']);
  });

  it('restores alone for a result with no render', () => {
    const restore = vi.fn();

    revertAfterMeasure(restore, 'not an animation').render(-1);
    revertAfterMeasure(restore).render(-1);

    expect(restore).toHaveBeenCalledTimes(2);
  });
});
