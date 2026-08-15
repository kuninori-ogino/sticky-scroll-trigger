# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
