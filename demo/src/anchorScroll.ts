/**
 * Same-page anchor links (e.g. "#link") point at elements inside sticky-scroll-trigger's nested
 * sticky structure, so a plain native fragment jump lands short by exactly the enclosing Scene
 * layers' dwell (the same drift StickyScrollTrigger#createResolvedTrigger corrects for). This
 * routes anchor clicks and an initial #hash on load through StickyScrollTrigger.getScrollTop (the
 * static form, so a click resolves correctly against whichever sticky instance actually owns the
 * target) instead, keeping them in sync with the actual scroll distance.
 */

import StickyScrollTrigger from 'sticky-scroll-trigger';

// Mirrors the native CSSOM View spec: scroll-padding-top (scroller) and scroll-margin-top (target)
// both apply and add together rather than one overriding the other (verified empirically in
// Chromium and WebKit: 56px + 40px lands at 96px, not 56 or 40).
const getScrollOffsetTop = (target: HTMLElement): number => {
  const scroller = document.scrollingElement ?? document.documentElement;
  const scrollPaddingTop = parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
  const scrollMarginTop = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;

  return scrollPaddingTop + scrollMarginTop;
};

// Binds every same-page anchor link under root (default: document) to scroll via
// StickyScrollTrigger.getScrollTop, and corrects an initial #hash the same way once `load` fires
// (after the browser's own fragment-jump attempts have had their chance). Pass every
// StickyScrollTrigger instance on the page; the static getScrollTop picks whichever one actually
// owns the clicked target on its own, so callers don't also need to track containers.
export const bindAnchorScroll = (
  stickies: readonly StickyScrollTrigger[],
  root: ParentNode = document,
): void => {
  const scrollToTarget = (target: HTMLElement, behavior: ScrollBehavior): void => {
    const top = StickyScrollTrigger.getScrollTop(target, stickies) - getScrollOffsetTop(target);

    window.scrollTo({ top, behavior });
  };

  root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((anchor) => {
    const id = anchor.getAttribute('href')?.slice(1);
    const target = id ? document.getElementById(id) : null;

    if (!target) return;

    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      history.pushState(null, '', `#${id}`);
      scrollToTarget(target, 'smooth');
    });
  });

  if (location.hash.length > 1) {
    const target = document.getElementById(location.hash.slice(1));

    if (target) {
      window.addEventListener('load', () => scrollToTarget(target, 'auto'), { once: true });
    }
  }
};
