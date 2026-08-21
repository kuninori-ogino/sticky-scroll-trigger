# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Documented the room `cover` needs to rise: `trigger`'s own parent bounds the cover layer's sticky wrapper, not the shared container, so that parent needs `end - start` worth of content below `trigger`, or the browser releases the wrapper mid-rise, at a point that shifts with the window size. Behavior is unchanged; only the README was missing it (see [Room for the rise](README.md#room-for-the-rise))
- Corrected `createOverlapScroll`'s `trigger` description: it said a `trigger` that isn't a direct child of the shared container throws, when only a `trigger` outside the container does
- Documented how to hold `cover` off screen until a scrubbed effect on `trigger` finishes, using a `createStickyTrigger` dwell and a zero-height marker (see [Delaying the rise](README.md#delaying-the-rise))
- `createStickyPin` now puts `trigger`'s own inline `position`/`top` back on kill and `destroy()`, rather than clearing both to `''`. An element that arrived with, say, `position: relative; top: 8px` used to lose them for good, though [`destroy()`](README.md#destroy) documents a full restore

## [0.5.0] - 2026-08-17

- A rejected option value on a Scene/Cover layer (an `end` of `'max'`, an unparseable position clause) no longer leaves every layer's sticky CSS stripped until the next successful `refresh()`; the layout keeps the previous refresh's values instead. That matters when a function-valued option begins returning one long after setup, on a refresh GSAP itself triggers. The error is unchanged
- Improved the position-clause regular expressions (`start`/`end`/`top`) to parse more efficiently on long input. What's accepted or rejected is unchanged
- `createStickyTrigger` and `createOverlapScroll` now throw when `trigger` is outside the shared container, or is the container itself. The README always required this, but such a `trigger` used to be accepted, and the layer's wrapping, DOM moves and `position:sticky` styling landed on elements the instance doesn't own
- `createStickyPin` still works on either side of the shared container, and now throws only for a `trigger` that encloses it (the container itself, or an ancestor). Such a `trigger` used to nest the container and the layers' dwell padding in the pin's own `height:0` box
- An invalid `scrollMarginTargets` selector now throws when the instance is constructed, instead of inside `refresh()`, where it used to abort every other `ScrollTrigger`'s refresh on the page
- `pin`, `scroller`, `horizontal`, and the rest of the pin/axis vars this module handles itself now throw at runtime, not just at the TypeScript type level. A plain JS or JSON caller could pass them straight through to GSAP before, silently breaking pinning or the scroll axis

## [0.4.0] - 2026-08-15

- `createStickyPin` now takes `start` in the same [position syntax](README.md#position-syntax) as the other methods (e.g. `start: 'bottom bottom'`, `'top 20%'`), including clauses measured against `trigger`'s own height. The existing `top` option is unchanged and still the way to give a plain px distance (`top: 20` is `start: 'top 20px'`); passing both throws. A pin's `start` throws on an absolute scroll position (a bare number, GSAP's meaning everywhere else in this module), since a pin engages when `position:sticky` engages and has nothing to set on the scroll axis. `end` is unaffected
- A `'max'` end on `createStickyPin` no longer leaves every Scene/Cover layer's sticky CSS stripped until the next successful `refresh()`. The error it throws is unchanged

## [0.3.0] - 2026-08-12

- Added automatic `scroll-margin-top` correction, so same-page links land correctly without any code on the caller's side; opt elements in or out via `new StickyScrollTrigger(root, { scrollMarginTargets })`, and fine-tune the landing position with the `--sst-scroll-margin-top-offset` custom property (see [Same-page links](README.md#same-page-links))

## [0.2.0] - 2026-08-07

- `StickyScrollTrigger.getScrollTop` (static): resolves an element's scroll-top position across multiple instances, picking whichever one's shared container actually contains it

## [0.1.0] - 2026-08-06

- `new StickyScrollTrigger(root)`: create one instance per container, then call the methods below on it
- `createStickyTrigger`: pin multiple scenes in sequence, sharing a single container, using nested `position:sticky` layers instead of GSAP's own pin
- `createOverlapScroll`: the effect where a lower section rises up and covers the section above it, without changing document height
- `createStickyPin`: pin badges and similar elements via plain `position:sticky`, entirely independent of GSAP's own pinning
- `createResolvedTrigger` / `resolveScrollPosition`: position-resolution APIs for using a plain ScrollTrigger effect inside the nested sticky structure
