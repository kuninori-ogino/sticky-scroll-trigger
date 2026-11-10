/**
 * The values refresh() writes: sticky tops, Scene paddings, pin reserves and ranges. Structure,
 * cover lifts, the boxes a pin's outer and trigger hold (fitPinBoxes), teardown and
 * measurements that undo their own writes go through dom.ts and structure.ts.
 *
 * A value cleared to measure past it is written again by the caller, even when unchanged.
 */

import { restoreInlinePosition } from './dom';
import type { InlinePosition } from './dom';

export const commitSticky = (el: HTMLElement, topPx: number): void => {
  el.style.position = 'sticky';
  el.style.top = `${topPx}px`;
};

// Rolls a clear back after a pass that throws.
export const commitPosition = (el: HTMLElement, saved: InlinePosition): void => {
  restoreInlinePosition(el, saved);
};

export const commitHeight = (el: HTMLElement, height: string): void => {
  el.style.height = height;
};

// Rolls a pin's outer back whole (reserve and item box) after a pass that throws. Through CSSOM,
// which a strict Content Security Policy still applies; it ignores setAttribute('style').
export const commitCssText = (el: HTMLElement, cssText: string): void => {
  el.style.cssText = cssText;
};

// The margin ending the shared container would sit above a padding with dwell and lengthen the
// freeze. margin-top cancels it there and margin-bottom carries it out through the container's
// bottom to collapse with what follows. null clears both: an empty padding lets the margin through.
export const commitCarriedMargin = (padding: HTMLElement, margin: number | null): void => {
  padding.style.marginTop = margin === null ? '' : `${-margin}px`;
  padding.style.marginBottom = margin === null ? '' : `${margin}px`;
};

// Margins of both signs collapse to the largest plus the most negative, so only minus the larger
// part cancels them: the padding carries that one, and its container's margin-bottom the other, so
// both leave the container as they reached the padding.
export const commitContainerMargin = (container: HTMLElement, margin: number | null): void => {
  container.style.marginBottom = margin === null ? '' : `${margin}px`;
};

// A margin-top larger than the positive part of the margins above the padding collapses with them
// to itself plus their negative part, which refresh() reads off.
export const commitMarginProbe = (padding: HTMLElement, probe: number): void => {
  padding.style.marginTop = `${probe}px`;
};

// Holds the margin ending the shared container in the innermost wrapper (flow-root) where carrying
// it out would leave it inside a container, lengthening the freeze, or lets it out (none).
export const commitHeldMargin = (sentinel: HTMLElement, held: boolean): void => {
  sentinel.style.display = held ? 'flow-root' : 'none';
};

// A Scene level a kill leaves in the DOM: no longer sticky, no dwell, and no carried margin.
export const commitInert = (
  wrapper: HTMLElement,
  padding: HTMLElement | null,
  container: HTMLElement | null,
): void => {
  wrapper.style.position = '';
  wrapper.style.top = '';

  if (padding) {
    padding.style.height = '0px';
    commitCarriedMargin(padding, null);
  }

  if (container) commitContainerMargin(container, null);
};

export const clearStickyForRead = (el: HTMLElement): void => {
  el.style.position = '';
  el.style.top = '';
};

export const clearHeightForRead = (el: HTMLElement): void => {
  el.style.height = '';
};
