# Architecture

This document explains the reasoning behind this library's design decisions. For API usage, see `README.md`.

## Why nested sticky instead of pin

GSAP `pin` depends on `pinnedContainer` offsets and accumulated `pin-spacing`, which can drift on resize refreshes when multiple pins share one container.

Pinning each scene directly with `position:sticky` avoids that drift, but only the scene itself freezes, so neighboring content scrolls away and leaves gaps.

This library solves both issues by wrapping the shared container in nested sticky layers and pinning a different layer per scene. The same container can then freeze at multiple scene positions in sequence, with neighboring content frozen together and no visual gaps.

## Nested structure of the Scene and cover layers

### Scene layer (`createStickyTrigger`)

The shared container gets wrapped in as many nested `stickyContainer > { stickyWrapper(sticky), stickyPadding }` layers as there are triggers. Scenes earlier in DOM order end up nested more deeply, and freeze first.

```
container2                         ← layer for the 2nd scene
├ wrapper2 (position:sticky)
│  └ container1                    ← layer for the 1st scene
│     ├ wrapper1 (position:sticky)
│     │  └ .container__inner       ← shared container (the original DOM)
│     └ padding1                   ← spacer equal to the 1st scene's dwell distance
└ padding2                         ← spacer equal to the 2nd scene's dwell distance
```

`padding` defines the dwell distance, and the sticky `wrapper` keeps the container pinned for that duration. GSAP does not pin here; it only advances effects using `start`/`end` values aligned to this freeze window.

### cover layer (`createOverlapScroll`)

Unlike Scene layers, this does not freeze the whole shared container. Inside `trigger`'s parent, only "everything from the start through `trigger`" is moved into a sticky wrapper; `cover` and later siblings stay outside.

```
.container__inner
├ wrapperB (position:sticky)       ← 2nd cover layer
│  ├ wrapperA (position:sticky)    ← 1st cover layer (absorbed into the nesting as-is)
│  │  └ start … trigger1
│  ├ cover1 …
│  └ … trigger2
├ cover2                           ← brought forward via z-index:1
└ …
```

Making only `trigger` sticky would leave a gap as earlier content scrolls away, so this wraps the whole leading range through `trigger`. The rise effect comes from `cover`'s natural scroll, so no GSAP tween or dwell spacer is needed and document height stays constant.

## Two-pass position measurement

`refresh()` (in `README.md`) runs in two passes: first it measures all natural positions with sticky temporarily disabled, then it applies sticky and padding in DOM order. The split is a correctness requirement, not a performance nicety. An ancestor currently pinned by the browser, as opposed to one merely carrying the `position:sticky` CSS, shifts `documentTop` for its descendants by however far the page has scrolled past that ancestor's natural engagement point (verified in `e2e/StickyScrollTrigger.spec.ts`'s "documentTop is corrupted by an actively-stuck sticky ancestor"). `refresh()` can run at any scroll position, including one where an earlier layer is already stuck (a resize-triggered refresh mid-scroll, say), so without the split that layer's offset leaks into every later measurement.

Measurements use `documentTop` (`offsetParent` chain), not `getBoundingClientRect`, so values stay stable across scroll position and across `position:sticky` merely being applied without being stuck. They aren't stable across an ancestor actually being stuck, though, which is exactly why pass 1 resets sticky first.

Viewport height is measured via a temporary `height:100vh` element (`measureViewportHeight`) instead of `window.innerHeight`, which fluctuates on mobile address-bar show/hide. This matches GSAP's own approach (`_refresh100vh`).

### Why a `ResizeObserver`-triggered refresh doesn't loop forever

A common integration pattern (used in `demo/src/main.ts`) watches `document.scrollingElement` with a `ResizeObserver` and calls `refresh()` on change, to catch layout shifts a plain window resize wouldn't. Since `refresh()` itself writes Scene layer dwell padding, which changes the document's own height, this is a feedback loop by construction: writing padding re-triggers the observer.

It settles instead of growing without bound because `refresh()` is idempotent. Once every Scene layer's dwell padding reflects the current (unstickied) layout, recomputing it from that same layout yields the same padding again, so the observer-triggered second `refresh()` changes nothing and no third callback fires. This holds even for a cover layer's `end: 'max'` (verified empirically against `e2e/fixtures/maxEnd.html`, where repeated `refresh()` calls settle immediately), because a cover layer never adds padding itself, so resolving `'max'` after Scene padding has settled doesn't reopen the loop.

## Why resolveScrollPosition corrects for lag

Nested sticky introduces visual lag: during a Scene layer's dwell, screen position appears frozen while real scroll keeps advancing. The lag equals the sum of dwell distances from earlier Scene layers in DOM order.

GSAP string `start`/`end` values (for example `'top 80%'`) do not account for this lag, so plain ScrollTriggers inside the shared container can be off by large distances. `resolveScrollPosition` returns absolute px values with lag correction applied.

Its target element isn't guaranteed to share stuck ancestors with anything else, for the same reason [`createStickyPin`](#why-createstickypin-is-unaffected-by-nested-sticky-lag)'s trigger/endTrigger need the same protection. Once `refresh()` has applied a Scene/Cover wrapper's `position:sticky` CSS, the browser keeps engaging and disengaging it natively as scroll changes, with no further `refresh()` involved. So `resolveScrollPosition` hits an actively-stuck ancestor whenever it runs while scroll sits inside an earlier Scene layer's freeze window, including its documented use as a function-valued `start`/`end` that GSAP re-evaluates during its own refresh. It therefore resets every Scene/Cover wrapper's sticky state before measuring `documentTop` and restores it afterwards, the same way `#refreshPins` does.

## Why scroll-margin-top carries the correction

`resolveScrollPosition` fixes the numbers this module hands to GSAP, but it can't help the browser's own scrolling: fragment navigation, `scrollIntoView`, `:target` and friends all run a one-shot calculation from the current layout, and pinning breaks that calculation the same way it breaks GSAP's own `pin`. `scrollMargin.ts`'s own doc comment derives the fix in full (the `landing = currentScroll + paintedTop − scrollMarginTop` formula, and why the correction needs a scroll-dependent term rather than a single constant). The mid-page case isn't just theoretical: a jump started 800px into an 800px freeze window overshot by exactly 800px when the correction used a plain constant instead of the scroll-dependent term.

The rest of this section covers what that comment doesn't: the browser bugs that shaped the implementation.

### Why the animation rule needs an explicit `@supports` gate

Firefox doesn't support `animation-timeline: scroll()`. The natural assumption is that a browser without that support leaves the declaration inert, but it doesn't (verified against real Firefox via Playwright, not inferred from spec text): `animation-timeline: scroll(...)` is unparseable there, so the whole declaration is dropped and `animation-timeline` stays at its initial value `auto`. Under `auto` the `animation` shorthand this module also writes becomes an ordinary time-based animation with no explicit duration, hence 0s, and a 0-duration animation with fill-mode `both` still runs, instantly: every custom property jumps straight to its keyframe's `to` value, the layer's full dwell, the moment the page loads. The resulting `scroll-margin-top` lands hundreds of pixels from any real target, worse than doing nothing. Wrapping the animation rule in `@supports (animation-timeline: scroll())` (see `scrollMargin.ts`'s `buildStylesheet`) keeps it from running at all on an engine that can't parse it. `e2e/StickyScrollTrigger.spec.ts`'s Firefox-only regression test reproduces the unguarded failure and confirms the gate closes it.

The JS fallback this leaves Firefox with (a `window` `scroll` listener writing the same custom properties) was checked against Chromium's smooth-scroll bug below and doesn't share it: every engine that lacks native scroll-timeline support tolerates a `scroll-margin-top` that keeps changing mid-scroll, which is a Chromium compositor quirk rather than a general consequence of updating the value dynamically.

### Known limitation: Chromium + native smooth scrolling

Chromium's `scroll-behavior: smooth` doesn't run a fragment jump as one continuous animation: per-frame sampling showed it advancing in several distinct steps, each firing its own `scrollend`, with scroll position occasionally moving backwards briefly between them. A `scroll-margin-top` that changes before the last step makes Chromium recompute the landing target mid-flight and under- or overshoot. Driving the value from CSS or from JS fails identically, and deferring the JS write to each intermediate `scrollend` makes it worse, re-triggering the recomputation on every settle rather than just the first. No variant of a dynamically-changing `scroll-margin-top` avoids this while still landing correctly for a jump started mid-dwell, which is why the demo leaves `scroll-behavior: smooth` off `html`. Sites that need animated same-page scrolling in Chromium should drive it themselves via [`getScrollTop`](README.md#stickyscrolltriggergetscrolltopelement-instances) and `scrollTo({ top, behavior: 'smooth' })` to a precomputed, unchanging target.

### Known limitation: Firefox drops scroll-padding-top after a sticky ancestor engages

Putting a fixed header's offset on `scroll-padding-top` (on the scroller), kept separate from this module's own per-target correction on `scroll-margin-top`, runs into a documented, intentional Firefox heuristic (verified via Playwright): once any `position: sticky` element on the page has ever been stuck, Firefox stops applying `scroll-padding-top` on fragment jumps, assuming the stuck sticky ancestor is itself the header. That assumption doesn't hold for this module's nested-sticky structure, where every Scene layer's sticky wrapper becomes an ancestor of everything after it (see "Nested structure of the Scene and cover layers" above) whether or not it has anything to do with a header. Any same-page link past a Scene layer silently loses the header offset, landing short by exactly the header height.

The fix is to keep the header offset off `scroll-padding-top` entirely: fold it into `--sst-scroll-margin-top-offset`, so only `scroll-margin-top` is ever in play for a same-page jump. The demo does this in `style.css`'s `html` rule, and `e2e/StickyScrollTrigger.spec.ts`'s `--sst-scroll-margin-top-offset combines correctly with the dwell correction on a jump started mid-dwell` test guards the pattern.

### Why `getScrollTop` is a static method

A target element for a same-page anchor link isn't guaranteed to belong to the particular `StickyScrollTrigger` instance a piece of code happens to have on hand; a page can have more than one, one per shared container. Applying the wrong instance's dwell to a target it never delayed corrupts the result, the same drift `resolveScrollPosition` above exists to correct. So `getScrollTop` takes every candidate instance and checks each one's shared container itself, rather than making the caller know which one owns the target.

Being `static` (called on the class, not an instance) is what makes that check possible at all: private fields are scoped to the class body, not to a particular `this`, so a static method can read `#rootElement` off any instance passed in as an argument, not just its own.

### Why pin: true is discouraged alongside this

With default `pinType: 'fixed'`, GSAP extrapolates pin position from scroll state at refresh time (internally: `top: bounds.top + (scroll - start)`). Right after page load (`scroll≈0`), extrapolation toward `start` can be offset by dwell-induced lag between those points. In nested sticky, this can make the element jump when pinning starts, even if `start`/`end` are corrected.

`pinType: 'transform'` avoids the jump but shifts pin tracking to JS updates on scroll, which can visibly lag during fast scrolling. In practice, no `pin: true` setup provides both accurate starts and smooth pinning inside nested sticky.

If you just want to pin part of the shared container without going through GSAP, use `createStickyPin` (in `README.md`). It works purely off `position:sticky`, following the same rules regardless of the nested-sticky ancestor structure, so it needs no correction and doesn't run into this `pin: true` issue either.

## Why createStickyPin is unaffected by nested-sticky lag

`resolveScrollPosition` (in `README.md`) and `createStickyTrigger` need lag correction because they hand absolute scroll positions to GSAP.

`createStickyPin` doesn't: it uses only the static `documentTop` distance between `trigger` and `endTrigger` to size its spacer. Before taking that measurement, `#refreshPins` snapshots and resets every Scene/Cover wrapper's sticky state, the same way pass 1 of [Two-pass position measurement](#two-pass-position-measurement) does for Scene/Cover layers' own positions, so neither `documentTop` call is ever taken while an ancestor is actively stuck. That holds regardless of whether `trigger` and `endTrigger` share ancestors or sit outside the shared container entirely (see `createStickyPin`'s options in `README.md`): there's no stuck-ancestor shift left to correct for.

### Why trigger needs to be wrapped

To extend pinning through `endTrigger`, `trigger` needs a containing block that spans that range without pushing later layout down.

`outer` (zero height, `contain: layout`) isolates overflow, while `inner` holds the effective pin range. Horizontal sizing is unchanged; `trigger`'s own `width`/`flex` rules still apply.
