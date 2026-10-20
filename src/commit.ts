/**
 * The values refresh() writes: sticky tops, Scene paddings, pin reserves and ranges. Structure,
 * cover lifts, teardown and measurements that undo their own writes go through dom.ts and
 * structure.ts.
 *
 * A value cleared to measure past it is written again by the caller, even when unchanged.
 */

import type { InlinePosition } from './dom';

export const commitSticky = (el: HTMLElement, topPx: number): void => {
  el.style.position = 'sticky';
  el.style.top = `${topPx}px`;
};

// Rolls a clear back after a pass that throws.
export const commitPosition = (el: HTMLElement, saved: InlinePosition): void => {
  el.style.position = saved.position;
  el.style.top = saved.top;
};

export const commitHeight = (el: HTMLElement, height: string): void => {
  el.style.height = height;
};

export const clearStickyForRead = (el: HTMLElement): void => {
  el.style.position = '';
  el.style.top = '';
};

export const clearHeightForRead = (el: HTMLElement): void => {
  el.style.height = '';
};
