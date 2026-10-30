// Every run-time access to GSAP's ScrollTrigger. gsap is never imported: the class comes off the
// `self` GSAP passes to callbacks. Much of this is undocumented, so each access skips what is
// absent.

// The part of the class the nested-sticky table listens to.
export interface ScrollTriggerClassLike {
  isRefreshing?: boolean;
  getScrollFunc?(element: Window): unknown;
  addEventListener?(type: 'refresh' | 'refreshInit', callback: () => unknown): void;
  removeEventListener?(type: 'refresh' | 'refreshInit', callback: () => unknown): void;
}

export type ScrollTriggerClass = {
  refresh(safe?: boolean): void;
  isScrolling?(): boolean;
  isUpdating?: unknown;
} & ScrollTriggerClassLike;

type ClassArg = ScrollTriggerClassLike | null | undefined;
type GsapEvent = 'refresh' | 'refreshInit';

// self.constructor is an undocumented GSAP implementation detail.
export const classOf = (self: ScrollTrigger): ScrollTriggerClass =>
  self.constructor as unknown as ScrollTriggerClass;

// GSAP assigns it only true or false (ScrollTrigger.js:1178, 1250), undefined before its first
// refresh.
export const isRefreshing = (cls: ClassArg): boolean => cls?.isRefreshing === true;

export const isScrolling = (cls: ScrollTriggerClass | null | undefined): boolean =>
  Boolean(cls?.isScrolling?.());

// A kill from a trigger callback runs inside GSAP's update, where the first scroll after a pause
// still reads as not scrolling. isUpdating is undocumented, so a missing one reads as false.
export const isScrollingOrUpdating = (cls: ScrollTriggerClass | null | undefined): boolean =>
  Boolean(cls?.isScrolling?.() || cls?.isUpdating === true);

export const addGsapListener = (
  cls: ClassArg,
  type: GsapEvent,
  callback: () => unknown,
): void => {
  cls?.addEventListener?.(type, callback);
};

export const removeGsapListener = (
  cls: ClassArg,
  type: GsapEvent,
  callback: () => unknown,
): void => {
  cls?.removeEventListener?.(type, callback);
};

// ScrollTrigger.refresh(); skipped if the class has none.
export const refreshAll = (cls: ScrollTriggerClass | null | undefined): void => {
  if (typeof cls?.refresh === 'function') cls.refresh();
};

type ScrollRecord = { read(): number; write(value: number): void };

// GSAP's record of the scroll it returns to after measuring, while one of its refreshes runs.
// Each read and write goes to the record itself, since GSAP may move it in between. GSAP took it
// before its refreshInit (ScrollTrigger.js:1179) and doesn't go back to a record of 0 (1233),
// which counts as none unless `zero`.
export const scrollRecord = (
  cls: ClassArg,
  zero = false,
): ScrollRecord | null => {
  if (!cls || !isRefreshing(cls)) return null;

  const scrollFunc = cls.getScrollFunc?.(window) as { rec?: unknown } | undefined;

  if (!(scrollFunc && typeof scrollFunc.rec === 'number' && (zero || scrollFunc.rec))) return null;

  const record = scrollFunc as { rec: number };

  return {
    read: () => record.rec,
    write: (value) => {
      record.rec = value;
    },
  };
};

// GSAP caches the scroll until the scroll event, and a trigger created before then scrolls back
// to the cached number once it has measured (ScrollTrigger.js:1265, 1565). GSAP's scroll function
// updates the cache but also scrolls, so it runs only when the cache is off.
export const syncScrollCache = (cls: ScrollTriggerClass | null | undefined): void => {
  const scrollFunc = cls?.getScrollFunc?.(window) as ((value?: number) => unknown) | undefined;

  if (typeof scrollFunc !== 'function') return;

  const cached = scrollFunc();

  if (typeof cached !== 'number' || Math.abs(cached - window.scrollY) >= 0.5) {
    scrollFunc(window.scrollY);
  }
};

// What a refreshInit listener returns: GSAP calls render(-1) on it once every trigger is measured
// (ScrollTrigger.js's `refreshInits.forEach(...render(-1))`), which reverts an animation a
// caller's onRefreshInit returned. restore runs after the caller's render.
export const revertAfterMeasure = (
  restore: () => void,
  result?: unknown,
): { render: (time: number) => void } => ({
  render: (time: number) => {
    (result as { render?: (time: number) => unknown } | undefined)?.render?.(time);
    restore();
  },
});
