// Measurements at scroll 0, where GSAP measures, and the scroll they go back to: page state every
// instance shares. Also tells the library's own trip from the page scrolling.

import { dormancyAfterScrollZero, dormancyAtScrollZero, movedPastFreeze } from './dormancy';
import {
  isRefreshing,
  isScrolling,
  isScrollingOrUpdating,
  scrollRecord,
  syncScrollCache,
} from './gsap';
import type { ScrollTriggerClass } from './gsap';

// The scroll a measurement at scroll 0 goes back to, while one is under way outside GSAP's refresh
// (see enterScrollZero). A kill's catch-up during one keeps the content in place by moving it.
let scrollZeroReturn: number | null = null;

export const scrollZeroReturnTop = (): number | null => scrollZeroReturn;

export const moveScrollZeroReturn = (top: number): void => {
  scrollZeroReturn = top;
};

// Where the last trip to 0 came back to and when, until the page is seen anywhere else. A trip
// begun mid-scroll leaves none: the page it comes back to is still scrolling.
let ownScrollTop: number | null = null;
let ownScrollAt = -Infinity;

const markOwnScroll = (fromRest: boolean): void => {
  ownScrollTop = fromRest ? window.scrollY : null;
  ownScrollAt = performance.now();
};

// GSAP's word, less the library's own trip. GSAP counts the scroll event a trip fires as the page
// scrolling (ScrollTrigger.js:388), until a check it makes every 250 ms finds 200 ms gone since
// (2124, 596). Within that time, with the page still where the trip came back to, the trip is the
// only scroll there was, under a pointer held still too; past it, GSAP's word stands. Inside GSAP's
// update, the first scroll after a pause reads as none yet (383-388), as a kill finds too; the
// update that ends GSAP's refresh comes at rest (315-316).
const isOwnTripOnly = (): boolean => {
  if (ownScrollTop !== null && (Math.abs(window.scrollY - ownScrollTop) >= 0.5
    || performance.now() - ownScrollAt >= 500)) ownScrollTop = null;

  return ownScrollTop !== null;
};

export const isPageScrolling = (cls: ScrollTriggerClass | null): boolean =>
  (isRefreshing(cls) ? isScrolling(cls) : isScrollingOrUpdating(cls)) && !isOwnTripOnly();
// What a kill holds its catch-up for: GSAP's word outside its update, less the library's own trip.
export const isUserScrolling = (cls: ScrollTriggerClass | null): boolean =>
  isScrolling(cls) && !isOwnTripOnly();

export const scrollBackTo = (top: number): void => {
  if (Math.abs(window.scrollY - top) >= 0.5) window.scrollTo({ top, behavior: 'instant' });
};

// Measures at 0 as GSAP's refresh does, returning the way back: to where it was, or where a kill's
// catch-up moved scrollZeroReturn to keep the content. Nothing is painted in between. Dormancy's
// table goes to its state for 0 too, without making anything sticky. Inside another one (whose
// function's GSAP refresh went back to the real scroll), back to 0, leaving the way back to it.
export const enterScrollZero = (cls: ScrollTriggerClass | null): (() => void) => {
  if (scrollZeroReturn !== null) {
    scrollBackTo(0);
    dormancyAtScrollZero();

    return () => {};
  }

  const fromRest = !isUserScrolling(cls);

  scrollZeroReturn = window.scrollY;
  dormancyAtScrollZero();
  window.scrollTo({ top: 0, behavior: 'instant' });

  return () => {
    const back = scrollZeroReturn ?? 0;

    scrollZeroReturn = null;
    window.scrollTo({ top: back, behavior: 'instant' });
    markOwnScroll(fromRest);
    syncScrollCache(cls);
    // Where it got to: short of `back` if the page is shorter now.
    dormancyAfterScrollZero(window.scrollY);
  };
};

// Inside GSAP's refresh, a layer handler measures at 0, where GSAP measures after its refreshInit
// dispatch, and goes back to GSAP's record, so the listeners after it see GSAP's scroll. The
// record needs no layout read, and GSAP goes back to it too, wherever a kill's catch-up moved it.
// Away from 0 again inside one (a function's GSAP refresh went back to its record), it goes there
// and back, leaving the outer way back alone. Nothing to undo when GSAP has no record.
let gsapAtZero = false;
let gsapZeroReturn = 0;

export const gsapScrollToZero = (cls: ScrollTriggerClass | null): (() => void) => {
  if (gsapAtZero) {
    const back = window.scrollY;

    if (back === 0) return () => {};

    const fromRest = !isUserScrolling(cls);

    window.scrollTo({ top: 0, behavior: 'instant' });

    return () => {
      window.scrollTo({ top: back, behavior: 'instant' });
      markOwnScroll(fromRest);
    };
  }

  const record = scrollRecord(cls, true);

  if (!record || record.read() === 0) return () => {};

  const fromRest = !isUserScrolling(cls);

  gsapZeroReturn = record.read();
  // The table's own GSAP phase, which puts it back afterwards, may not have begun yet (its listener
  // after this one).
  dormancyAtScrollZero();
  window.scrollTo({ top: 0, behavior: 'instant' });
  gsapAtZero = true;

  return () => {
    gsapAtZero = false;
    // GSAP's scroll cache stays as GSAP left it: GSAP sets the scroll again once it has measured.
    window.scrollTo({ top: record.read(), behavior: 'instant' });
    markOwnScroll(fromRest);
  };
};

export const isGsapAtZero = (): boolean => gsapAtZero;

// The scroll a measurement at 0 goes back to, or null outside one: a GSAP refresh a function
// starts there takes it as its record, as it would have at the top level.
export const realScroll = (): number | null =>
  scrollZeroReturn ?? (gsapAtZero ? gsapZeroReturn : null);

// Whether something besides `own` around an element in `from` can sit off its place at scroll 0:
// a sticky element (stuck at its inset, or carried to its container's end), or a wrapper dormancy
// moved past its freeze. Read only; a false yes costs a scroll to 0 and back.
export const mayBeStuckAround = (
  from: readonly HTMLElement[],
  own: ReadonlySet<HTMLElement>,
): boolean => {
  const seen = new Set<HTMLElement>();
  const moved = movedPastFreeze();

  return from.some((el) => {
    for (let current: HTMLElement | null = el; current && !seen.has(current)
      && current !== document.body && current !== document.documentElement;
      current = current.parentElement) {
      seen.add(current);

      if (own.has(current)) continue;

      if (moved.has(current) || getComputedStyle(current).position === 'sticky') return true;
    }

    return false;
  });
};

// A GSAP refresh a function started went back to its record: the rest of the measurement reads
// at 0.
const afterFunction = (): void => {
  if (gsapAtZero || scrollZeroReturn !== null) scrollBackTo(0);

  if (scrollZeroReturn !== null) dormancyAtScrollZero();
};

// A layer's or pin's start or end function, which refresh() calls in its measurement, running
// afterFunction once it returns or throws. A function handed to resolveScrollPosition needs none,
// since its read goes back to 0 itself, nor does createResolvedTrigger's, which GSAP calls.
export const withAfterFunction = <T>(value: T | (() => T)): T | (() => T) => {
  if (typeof value !== 'function') return value;

  return () => {
    try {
      return (value as () => T)();
    } finally {
      afterFunction();
    }
  };
};
