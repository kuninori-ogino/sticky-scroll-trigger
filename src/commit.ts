/**
 * The values refresh() writes: sticky tops, Scene paddings, pin reserves and ranges. Structure,
 * cover lifts, the boxes a pin's outer and trigger hold (fitPinBoxes), teardown and
 * measurements that undo their own writes go through dom.ts and structure.ts.
 *
 * A value cleared to measure past it is written again by the caller, even when unchanged.
 */

import {
  adoptLiftedPosition, captureInline, captureLiftedPosition, isLifted, resetStickyPosition,
  restoreInline, restoreInlinePosition, restoreLiftedPosition, setRangeHeight,
} from './dom';
import type { InlinePosition, InlineValue, LiftedPosition, PinOffsets } from './dom';

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

// A pin's range, on its inner.
export const commitRange = (inner: HTMLElement, height: string): void => {
  setRangeHeight(inner, height);
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

const OFFSET_PROPERTIES = ['position', 'top', 'right', 'bottom', 'left'] as const;

// trigger's relative offset on outer, as GSAP's spacer has it, !important so a page rule's offset
// can't move it too. With none, outer is static, as GSAP's spacer isn't: a relative one made it the
// containing block of a static trigger's absolute content, which the page without the pin lays
// out against an ancestor (an endTrigger there released 100px early). Relative all the same where
// a cover's lift raises it, as the lift does any static sibling, so its z-index applies.
export const commitPinOffsets = (outer: HTMLElement, offsets: PinOffsets | null): void => {
  const unlifted = offsets ? 'relative' : 'static';
  const values = {
    position: isLifted(outer) ? 'relative' : unlifted,
    top: offsets ? `${offsets.top}px` : 'auto',
    right: 'auto',
    bottom: 'auto',
    left: offsets ? `${offsets.left}px` : 'auto',
  };

  OFFSET_PROPERTIES.forEach((property) => {
    outer.style.setProperty(property, values[property], 'important');
  });

  // The lift's restore leaves outer as this commit would without it.
  adoptLiftedPosition(outer, { value: unlifted, priority: 'important' });
};

export interface OuterPosition {
  values: InlineValue[];
  lifted: LiftedPosition;
}

// outer's offset, and the lift's record of its position that commitPinOffsets hands over.
export const captureOuterPosition = (outer: HTMLElement): OuterPosition => ({
  values: OFFSET_PROPERTIES.map((property) => captureInline(outer, property)),
  lifted: captureLiftedPosition(outer),
});

// Rolls outer's offset back after a pass that throws, so a lift coming off later leaves it as the
// last successful refresh() would.
export const commitOuterPosition = (outer: HTMLElement, saved: OuterPosition): void => {
  OFFSET_PROPERTIES.forEach((property, i) => restoreInline(outer, property, saved.values[i]));
  restoreLiftedPosition(outer, saved.lifted);
};

// Holds a trigger with no relative offset static for the reads, where it pins (a relative one goes
// through holdRelativeForRead). Not !important, so a page rule's !important position, which sticky
// doesn't get past either, stays.
// The author's top stays too: static ignores it, and its computed value keeps its unit.
export const holdPinForRead = (trigger: HTMLElement): void => {
  trigger.style.position = 'static';
};

// A relative trigger stays one for the reads after the offset is measured, unshifted, as GSAP's pin
// keeps its position with top and left at 0: still the containing block of its absolute content,
// as it is stuck (an endTrigger there released late by trigger's border, or an item's margin).
// left and right too, which a start or end function can read, so outer's offset isn't doubled.
export const holdRelativeForRead = (trigger: HTMLElement): void => {
  resetStickyPosition(trigger);
  trigger.style.setProperty('left', 'auto', 'important');
  trigger.style.setProperty('right', 'auto', 'important');
};

export const clearStickyForRead = (el: HTMLElement): void => {
  el.style.position = '';
  el.style.top = '';
};

export const clearHeightForRead = (el: HTMLElement): void => {
  el.style.height = '';
};

export const clearRangeForRead = (inner: HTMLElement): void => {
  setRangeHeight(inner, 'auto');
};
