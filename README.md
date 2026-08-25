# StickyScrollTrigger

A ScrollTrigger helper that uses native `position:sticky` instead of GSAP pinning.

> ScrollTrigger is part of GSAP®, a Webflow product. This project is an independent, unofficial helper and is not affiliated with or endorsed by Webflow.

The only dependency is GSAP's ScrollTrigger types.

- Pin multiple scenes in sequence, sharing a single container (no gap opens up from adjacent elements scrolling away while one is pinned)
- Pinning is handled 100% by the browser's `position:sticky`; GSAP only tweens the effect's own properties while the freeze window is active
- The "section below rises up and covers the section above" effect (overlap scroll) is achieved without changing document height
- Same-page anchor links, `scrollIntoView` and `:target` land where they should, with no code on your side (see [Same-page links](#same-page-links))

See the repository's `demo/index.html` + `demo/src/main.ts` for a live example, and `ARCHITECTURE.md` for why nested sticky was chosen over `pin`, and how it works internally.

## Requirements

| requirement      | description                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GSAP             | `^3.15.0`, with the `ScrollTrigger` plugin already registered via `gsap.registerPlugin`                                                                     |
| TypeScript       | Optional. The published `.d.ts` uses GSAP's global types (`ScrollTrigger.Vars`); plain JavaScript projects can `import` the same `dist/` build without them |
| Browser          | Must support `position:sticky` (no `overflow:hidden`/`clip` on any ancestor of a pinned element)                                                            |
| Scroll direction | Vertical scrolling only (`horizontal` is not supported)                                                                                                     |
| Module system    | ESM only (`import`) or a `<script>` tag via the global build; CommonJS (`require`) is not supported                                                         |

This module is tested against 3.15.0, and the notes below on what raw GSAP itself does were measured there. A later 3.x satisfies the peer range but is untested.

## Installation

```bash
npm install gsap sticky-scroll-trigger
```

`gsap` (with its `ScrollTrigger` plugin) is a peer dependency; register the plugin yourself (see [Usage](#usage) below).

For plain `<script>` usage without a bundler, an IIFE build is also published, exposing `window.StickyScrollTrigger`:

```html
<script src="https://cdn.jsdelivr.net/npm/sticky-scroll-trigger/dist/StickyScrollTrigger.global.min.js"></script>
```

Consumers should only rely on the exports of `sticky-scroll-trigger` (or `window.StickyScrollTrigger` for the global build). The internal modules under `src/` are not part of the public API.

## Usage

Pick a single "shared container" that wraps all the scenes you want to pin, and create a `StickyScrollTrigger` instance for its selector.

```html
<div class="container">
  <div class="container__inner">
    <section class="scene">...</section>
    <section class="filler">...</section>
    <section class="overlapScroll__trigger">...</section>
    <section class="overlapScroll__cover">...</section>
  </div>
</div>
```

```ts
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import StickyScrollTrigger from "sticky-scroll-trigger";

gsap.registerPlugin(ScrollTrigger);

const sticky = new StickyScrollTrigger(".container__inner");

// Scene effect. This just builds and returns the Vars passed to
// scrollTrigger, so writing the tween itself is just ordinary GSAP.
gsap.fromTo(
  scene,
  { opacity: 0 },
  {
    opacity: 1,
    scrollTrigger: sticky.createStickyTrigger({
      trigger: scene,
      start: "center center",
      end: "+=100%",
      scrub: true,
    }),
  },
);

// Overlap scroll effect. No tween involved, so pass it straight to ScrollTrigger.create().
ScrollTrigger.create(
  sticky.createOverlapScroll({ trigger: ".trigger", cover: ".cover" }),
);

// Call once, after all registrations are done.
sticky.refresh();
```

Registration order doesn't matter. `refresh()` sorts trigger elements by DOM order internally and builds the nesting from that, so you're free to register different effect types in separate loops.

### Calling refresh

`createStickyTrigger`/`createOverlapScroll` do not call `refresh()` automatically. Call it once after registration. Resize/load are already covered via GSAP's `refreshInit`, so manual calls are mainly for non-resize layout changes (for example, content height changes).

`debounce` isn't provided by this library or GSAP. Bring your own (e.g. lodash's `debounce`) or use a minimal version like this:

```ts
const debounce = <Args extends unknown[]>(
  fn: (...args: Args) => void,
  wait: number,
) => {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

const debouncedRefresh = debounce(() => {
  ScrollTrigger.refresh(); // runs refresh() first, via refreshInit
}, 100);

if (document.scrollingElement) {
  new ResizeObserver(() => debouncedRefresh()).observe(
    document.scrollingElement,
  );
}
```

Order matters: `refresh()` must run before `ScrollTrigger.refresh()`, or GSAP may read stale freeze-window values.

This binding is automatic as soon as you register at least one `createStickyTrigger`/`createOverlapScroll`/`createStickyPin` result with ScrollTrigger.

If you only use `createResolvedTrigger`/`resolveScrollPosition`, auto-binding has nothing to attach to, so bind manually:

```ts
ScrollTrigger.addEventListener("refreshInit", () => sticky.refresh());
```

Avoid debounce logic that assumes it runs before GSAP's 200ms delay. Use `refreshInit` binding.

## API

### `new StickyScrollTrigger(root, options?)`

Creates an instance that treats `root` (a selector string or `HTMLElement`) as the shared container. Everything documented below is an instance method on it, apart from the static [`getScrollTop`](#stickyscrolltriggergetscrolltopelement-instances), which resolves a position across more than one instance. Throws if the shared container can't be found.

| option                | default  | description                                                                                                                                                  |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scrollMarginTargets` | `'[id]'` | Which elements inside the shared container get their `scroll-margin-top` kept in sync (see [Same-page links](#same-page-links)). `null` disables it entirely |

Call them on the instance (`sticky.createStickyTrigger(...)`) rather than destructuring them out: a destructured method loses its `this` binding.

Like `root`, every `trigger`/`endTrigger`/`cover` option below also accepts a CSS selector string (in addition to an `HTMLElement`), resolved via `document.querySelector`, the same as GSAP ScrollTrigger's own `trigger`/`endTrigger`. Throws an error if the selector matches no elements.

### `createStickyTrigger(options)`

Registers a layer that pins a scene and advances its effect, and returns `ScrollTrigger.Vars`. Pass the return value as a tween's `scrollTrigger`. ScrollTrigger options (`scrub`, `markers`, `onUpdate`, etc.) pass through as-is, except for the exclusions in the table below.

| rejected option                                                                                      | reason                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `trigger` / `start` / `end` / `endTrigger`                                                           | This module derives these itself from the freeze window                              |
| `pin` / `pinSpacing` / `anticipatePin` / `pinnedContainer` / `pinReparent` / `pinSpacer` / `pinType` | Pinning is handled by `position:sticky`, not GSAP pinning, so these have no effect   |
| `horizontal` / `scroller` / `containerAnimation`                                                     | This module assumes vertical, window-based scrolling; setting these shifts positions |

You can specify `onKill`, `invalidateOnRefresh`, and `onRefreshInit`; the module also uses them internally. `invalidateOnRefresh` defaults to `true` (GSAP defaults to `false`) so function-valued tween props are re-measured on refresh, and an explicit value is respected. Freeze-window tracking is independent of the flag, so `invalidateOnRefresh: false` won't break it.

| option       | default        | description                                                                                                                                                                                                 |
| ------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`    | (required)     | The scene element to pin and animate. Must be inside the shared container; throws otherwise                                                                                                                 |
| `start`      | `'top top'`    | Where the scene lands in the viewport while pinned (same idea as sticky's CSS `top`). Same default GSAP itself uses for a pinned trigger. See [position syntax](#position-syntax)                           |
| `end`        | `'bottom top'` | End of the freeze window. Auto-detects between a dwell distance and a position clause (see [end syntax](#end-syntax)). Same default GSAP uses too: dwell for the trigger's own height, not a fixed distance |
| `endTrigger` | `trigger`      | Reference element when `end` uses position-clause syntax. Must be inside the shared container (see below)                                                                                                   |

### `createOverlapScroll(options)`

Registers an overlap-scroll effect (`trigger` gets pinned while its siblings from `cover` onward scroll normally and rise up to cover it) and returns `ScrollTrigger.Vars`. No tween or dwell spacer is created. Since the return value only describes the freeze window, the effect works even without passing it to `ScrollTrigger.create()`, unless you need `markers` or callbacks.

| option       | default                      | description                                                                                                                                                                                                 |
| ------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`    | (required)                   | The element that gets pinned and covered. Must be inside the shared container; throws otherwise. Its own parent, which doesn't have to be the container itself, bounds how far the rise can run (see below) |
| `cover`      | `trigger.nextElementSibling` | The first element of the covering side; this and all following siblings cover together. Must share the same parent as `trigger`                                                                             |
| `start`      | `'bottom bottom'`            | Pinned position of `trigger`. See [position syntax](#position-syntax). Unlike `createStickyTrigger`'s `start`, this doesn't support an absolute scroll position (a bare number): it throws instead          |
| `end`        | `null` (auto-computed)       | End of the freeze window. When `null`, computed automatically as "the distance until `cover`'s top edge reaches the top of the viewport"                                                                    |
| `endTrigger` | `trigger`                    | Reference element when `end` uses position-clause syntax                                                                                                                                                    |

`createOverlapScroll` adjusts `position`/`z-index` on the covering side only when needed, never overrides explicit values, and restores its changes on GSAP `kill()`. The restore clears a property only while it still holds the value the lift wrote, so a different value you set on the covering side afterwards (a `gsap.set()`, say) survives.

Every [`refresh()`](#refresh) runs that check again over the covering side as it stands: it raises an element added since, and hands back a property your own CSS has turned on in the meantime. Where the covering side holds a `createStickyPin` `trigger`, the pin's own wrapper rises in its place and the pinned element is left alone.

#### Room for the rise

Pinning here is plain `position:sticky`, and the browser keeps a sticky element stuck only until its containing block's bottom edge catches up with it. That containing block is `trigger`'s own parent, not the shared container:

```
trigger's parent's bottom edge - trigger's bottom edge  >=  end - start
```

With the auto `end`, that distance is where `cover`'s top edge sits when the freeze starts: `start`'s pinned offset, plus `trigger`'s own height, plus any gap between the two. Under the defaults (`start: 'bottom bottom'`, `cover` directly after `trigger`) it comes to one viewport height; a `trigger` taller than the viewport, pinned near the top, needs more.

With less room than that, the browser releases the wrapper mid-rise: `trigger` scrolls away before `cover` has covered it, at a point that moves with the window size, since the requirement scales with the viewport while the room doesn't. Content after `trigger`'s parent never counts, however long the page is. Add the missing height below `trigger` (a taller `cover`, or a spacer after it), or keep the sections that follow inside the same parent rather than wrapping `trigger` and `cover` in a box of their own.

#### Delaying the rise

`cover` starts rising as soon as the freeze window opens, so a scrubbed effect on `trigger` plays out underneath it. To let the effect finish first, put a Scene layer in front of the cover layer: freezing one freezes the whole shared container, `cover` included, and the scene's dwell doubles as the hold. Since the two layers can't share a trigger element, the cover layer gets a zero-height marker between the scene and `cover`:

```html
<div class="container__inner">
  <section class="scene">...</section>
  <div class="hold" style="height: 0"></div>
  <section class="cover">...</section>
</div>
```

```ts
gsap.fromTo(
  ".scene",
  { opacity: 0 },
  {
    opacity: 1,
    scrollTrigger: sticky.createStickyTrigger({
      trigger: ".scene",
      start: "bottom bottom",
      end: "+=800",
      scrub: true,
    }),
  },
);

ScrollTrigger.create(
  sticky.createOverlapScroll({
    trigger: ".hold",
    cover: ".cover",
    start: "bottom bottom",
  }),
);
```

The rise picks up where the scrub ends, with no arithmetic on your side, because `refresh()` adds a Scene layer's dwell to the freeze window of every layer whose trigger comes later in DOM order. That is also why the marker goes after the scene rather than inside it.

The marker sits on the scene's bottom edge, so one `'bottom bottom'` describes both layers and nothing moves at the handover. The scene pins with that edge on the viewport's bottom, and `cover`, which begins there, stays just off screen for the whole hold. Pin the scene anywhere else and you have to reconcile the two clauses by hand, since a zero-height marker resolves any clause to a plain viewport position. Its `start` has to name wherever the scene's bottom edge sits while pinned, or `trigger` jumps.

The marker is the cover layer's `trigger`, so [the room](#room-for-the-rise) the rise needs is measured below it, not below the scene.

### `createStickyPin(options)`

Pins small elements (badges, labels, etc.) with plain `position:sticky` (pinning handled entirely by CSS, not GSAP). Pinning starts when `trigger` reaches its sticky position and releases when `endTrigger` reaches the `end` clause. This is independent of Scene/Cover layers and works the same inside or outside the shared container. The only `trigger` it rejects is one that encloses the container (see [Constraints and caveats](#constraints-and-caveats)).

Because pinning is handled by CSS, the returned `ScrollTrigger.Vars` does not define GSAP `start`/`end`; it exists for hooks such as `onKill`/`onRefreshInit`. Pass it to `ScrollTrigger.create()` if you want automatic cleanup and auto refresh-binding.

```ts
const sticky = new StickyScrollTrigger(".container__inner");

// badge can be inside the shared container. Stays pinned until sectionEnd is reached.
// getHeaderHeight() is your own function (not part of this library) that returns the
// current header height in px.
ScrollTrigger.create(
  sticky.createStickyPin({
    trigger: ".badge",
    top: () => getHeaderHeight() + 20,
    endTrigger: ".sectionEnd",
    end: "top top",
  }),
);

sticky.refresh();
```

| option       | default        | description                                                                                                                                                                                      |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trigger`    | (required)     | The element to pin and show                                                                                                                                                                      |
| `start`      | `'top top'`    | Where `trigger` lands in the viewport while pinned, in [position syntax](#position-syntax), so the element's own side counts too (`'bottom bottom'` rests it against the viewport's bottom edge) |
| `top`        | `0`            | A px distance from the viewport's top edge, as a plain number. `top: 20` is `start: 'top 20px'`                                                                                                  |
| `endTrigger` | `trigger`      | Reference element for releasing the pin                                                                                                                                                          |
| `end`        | `'bottom top'` | Which clause of `endTrigger` releases the pin (standard GSAP [position syntax](#position-syntax))                                                                                                |

Here `start` means only where the element sits while pinned, not when pinning begins, as it does for the other methods. Pinning begins the moment `trigger` reaches that position naturally, which is CSS's decision rather than a separate number to set, so a pin's position and the scroll position it engages at are one setting.

That's why `start` throws on an [absolute scroll position](#absolute-scroll-position) (`start: 20`, which GSAP reads as scroll position 20) instead of silently treating it as a px distance. `top` is its own option for the same reason: with the bare-number slot reserved for GSAP's meaning, `'top 20px'` would otherwise be a pin's only way to say "20px below the top of the viewport". `end` does take an absolute scroll position (`end: 3000` releases at scroll 3000), since a release point is a real thing to ask for on the scroll axis.

Clauses resolve exactly as they do elsewhere, including the one-token forms that name the element's own side: `'top 20px'` puts the element's top 20px below the viewport's top edge, while `'20px'` puts it 20px above.

`endTrigger` and `end` both default to GSAP's own values. `'bottom top'` releases the pin once `endTrigger`'s bottom edge reaches the viewport's top edge, so naming an `endTrigger` and leaving `end` alone holds the pin for that element's own height past its top. Omit both and `trigger` pins against itself, held for its own height, the duration GSAP's `pin: true` gives.

`trigger` keeps its own space in the page: every [`refresh()`](#refresh) sizes its wrapper to `trigger`'s margin box, so registering a pin doesn't shorten the document or move what follows. The wrapping does change margin collapsing, though. `trigger`'s vertical margins stop at that wrapper instead of collapsing with its siblings', and no sizing can give that back, since the collapsing partner sits outside it. A `margin-bottom: 30px` above a `trigger` with `margin-top: 20px` occupies 30px unpinned and 50px pinned.

Internally, the element wrapping `trigger` renders beyond its own section's bounds, into the visual area of following elements. Make sure the ancestor section containing `trigger` isn't hidden behind a later section in DOM order (e.g. via `position: relative; z-index: ...`).

See the repository's `ARCHITECTURE.md` ("Why `createStickyPin` is unaffected by nested-sticky lag") for why the lag never applies here, and why `trigger` needs two nested wrapper divs.

### `createResolvedTrigger(options)`

A thin wrapper that calls [`resolveScrollPosition`](#resolvescrollpositionelement-position) for `trigger`/`start`/`end` together and assembles the result into `ScrollTrigger.Vars`. If you just want to place a plain ScrollTrigger on an element inside the shared container, start here.

```ts
const sticky = new StickyScrollTrigger(".container__inner");

gsap.to(plainBox, {
  autoAlpha: 1,
  scrollTrigger: sticky.createResolvedTrigger({
    trigger: plainBox,
    start: "top 80%",
    end: "top 30%",
    scrub: true,
  }),
});
```

| option       | default        | description                                                                                |
| ------------ | -------------- | ------------------------------------------------------------------------------------------ |
| `trigger`    | (required)     | Reference element for `start`. Also passed through as-is to GSAP's `scrollTrigger.trigger` |
| `start`      | `'top bottom'` | [Position syntax](#position-syntax), resolved relative to `trigger`                        |
| `end`        | `'bottom top'` | [Position syntax](#position-syntax), resolved relative to `endTrigger`                     |
| `endTrigger` | `trigger`      | Reference element for `end` (same idea as GSAP's standard `trigger`/`endTrigger` split)    |

Omit `start` and `end` and the range runs from `trigger`'s top edge entering the viewport at the bottom to `endTrigger`'s bottom edge leaving it at the top, GSAP's own defaults for a trigger that doesn't pin.

This does not register a layer, so `refresh()` does not manage it. It shares the same rejected-option table as [`createStickyTrigger`](#createstickytriggeroptions) (no pin-family options, no `horizontal`/`scroller`/`containerAnimation`).

If you need different reference elements or custom progress logic, use `resolveScrollPosition` directly.

### `resolveScrollPosition(element, position)`

For any element inside the shared container (registered or not), returns the absolute scroll position (px) for GSAP position syntax (`element` + `position`). As with `trigger`/`endTrigger`/`cover` above, `element` also accepts a CSS selector string in addition to an `HTMLElement`. Use this to keep plain ScrollTriggers inside nested sticky in sync with real scroll distance. If `start` and `end` use the same element, [`createResolvedTrigger`](#createresolvedtriggeroptions) is usually simpler.

```ts
const sticky = new StickyScrollTrigger(".container__inner");

// An element inside the shared container that isn't registered with
// createStickyTrigger/createOverlapScroll
ScrollTrigger.create({
  trigger: ".plainBox",
  start: () => sticky.resolveScrollPosition(".plainBox", "top 80%"),
  end: () => sticky.resolveScrollPosition(".plainBox", "top 30%"),
  scrub: true,
});
```

Call this after `refresh()`. If passed as a function to `start`/`end`, it is re-evaluated on each GSAP refresh.

`position` also accepts GSAP's [`'max'` keyword](#end-syntax) (e.g. `resolveScrollPosition(".plainBox", "max")`), which ignores `element` entirely and returns the scroller's max scroll position.

Using it with `pin: true` is discouraged because the element can jump when pinning starts. If you only need pinning, use [`createStickyPin`](#createstickypinoptions). See the repository's `ARCHITECTURE.md` ("Why `resolveScrollPosition` corrects for lag") for details.

Only the dwell of Scene layers registered via `createStickyTrigger` is accumulated here (`createOverlapScroll` never changes the document height, so it doesn't contribute to the lag).

When the target might belong to some other instance than the one at hand, use the static [`getScrollTop`](#stickyscrolltriggergetscrolltopelement-instances) below instead.

### `StickyScrollTrigger.getScrollTop(element, instances)`

A static method, call it on the class itself (`StickyScrollTrigger.getScrollTop(...)`), not on an instance. Returns the absolute scroll position (px) at which `element`'s own top edge reaches the viewport's top edge (`'top top'`), picking whichever of the given `instances` actually has `element` inside its shared container. Applying the wrong instance's dwell to a target it never delayed would corrupt the result, the same way plain [`resolveScrollPosition`](#resolvescrollpositionelement-position) warns against.

Same-page links don't need this: [`scrollMarginTargets`](#same-page-links) already makes them land correctly on their own. Reach for it when you want to drive the scroll yourself (custom easing, a scroll library, a target that isn't a fragment link). If you do, pass `scrollMarginTargets: null` so the correction isn't applied twice.

```ts
import StickyScrollTrigger from "sticky-scroll-trigger";

const stickyA = new StickyScrollTrigger(".sectionA", {
  scrollMarginTargets: null,
});
const stickyB = new StickyScrollTrigger(".sectionB", {
  scrollMarginTargets: null,
});

document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener("click", (event) => {
    const target = document.getElementById(anchor.hash.slice(1));

    if (!target) return;

    event.preventDefault();
    window.scrollTo({
      top: StickyScrollTrigger.getScrollTop(target, [stickyA, stickyB]),
      behavior: "smooth",
    });
  });
});
```

An `element` outside every given instance's shared container is measured directly (no dwell to correct for), so passing every `StickyScrollTrigger` instance on the page is always safe, whether or not the target actually belongs to any of them.

### `refresh()`

Recomputes each layer's sticky `top`, dwell spacer height, and freeze window (`start`/`end`). It also rebuilds nested DOM when triggers are added, removed, or reordered. If nothing has changed, it does not rebuild.

Kill-driven teardown/rebuild is deferred to a microtask and coalesced per task. This DOM move can reload `<iframe>` elements or drop focus for focused inputs inside the managed container. This behavior runs on every kill or relevant layout change and cannot be disabled, so be careful when placing iframes or focus-sensitive inputs under the controller.

If surviving layers' freeze windows change after kill, GSAP's cached `start`/`end` values are synced internally.

### `destroy()`

Tears down the controller, restores the original DOM layout, and reverts z-order changes from `createOverlapScroll`. This is also the only entry point that can clean up cover layers that were never passed to `ScrollTrigger.create()`.

It only cleans up DOM/styles managed by this module. You still need to kill active ScrollTrigger instances yourself. After `destroy()`, `createStickyTrigger`, `createOverlapScroll` and `createStickyPin` throw and `refresh()` is a no-op. Calling `destroy()` twice is safe.

## Same-page links

Pinning decouples an element's position in the document from the scroll position at which it actually reaches the top of the viewport. The browser's own "scroll an element into view" is a single calculation made from the current layout, so on its own it lands short by every preceding scene's dwell. This is true of any pinning technique, GSAP's own `pin` included.

`refresh()` declares that difference to the browser by keeping `scroll-margin-top` in sync on every element inside the shared container that matches `scrollMarginTargets` (`'[id]'` by default). Nothing else is needed: plain `<a href="#target">` links, `scrollIntoView()`, `:target` and a `#hash` on load all land correctly as written.

```html
<!-- Lands correctly with no click handler and no scroll math. -->
<a href="#chapter3">Chapter 3</a>
```

- Your own `scroll-margin-top` still applies. The correction is added to whatever value the element already computes to, never written over it, re-read on every `refresh()` (so a later change, e.g. a responsive breakpoint, is picked up too), and `destroy()` puts the original inline value back
- A fixed header's offset is a different case, applying to every scroll rather than only those inside the shared container. CSSOM View says `scroll-padding-top` (on the scroller) and `scroll-margin-top` (on the target) add together, so in principle the header offset could live there, independently of this module's correction. In practice, don't: Firefox drops `scroll-padding-top` from a fragment jump once any `position:sticky` element on the page has engaged, landing short by exactly the header height (see ARCHITECTURE.md's "Firefox drops scroll-padding-top" for how this was verified). Fold it into `--sst-scroll-margin-top-offset` instead (below), as the repository's demo does in `style.css`'s `html` rule
- To land deliberately short of or past a target, set the `--sst-scroll-margin-top-offset` custom property (a length) on it, or on any ancestor to cover several targets at once (it inherits like any other custom property). A positive value lands short, settling below the viewport's top edge instead of flush with it; negative overshoots. Being a plain `var()`, the browser reads it live at scroll-into-view time, so unlike the author-`scroll-margin-top` case above, no `refresh()` call is needed for a change to take effect

  ```css
  /* A fixed header's height, folded in here rather than into scroll-padding-top (see above). */
  html {
    --sst-scroll-margin-top-offset: 56px;
  }
  ```

- The part of the correction that depends on where the jump was started from rides a CSS scroll-driven animation where [supported](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_scroll-driven_animations), so nothing runs on scroll there. Where it isn't (Firefox, as of this writing), a `scroll` listener supplies the same value instead, so the correction is exact from any starting position on every engine either way
- Known limitation: Chromium's own `scroll-behavior: smooth` doesn't run a native fragment jump as one continuous animation, and can under- or overshoot if `scroll-margin-top` changes at any point before it settles (which a jump started mid-dwell does, on purpose). This isn't specific to how the value is driven (CSS or JS) and has no known workaround; if you need animated same-page scrolling in Chromium, drive it yourself with [`getScrollTop`](#stickyscrolltriggergetscrolltopelement-instances) and `scrollTo({ top, behavior: 'smooth' })` to a precomputed target instead
- The default `'[id]'` covers everything a fragment link or `:target` can reach. Find-in-page and keyboard focus can scroll to arbitrary elements, which this doesn't cover; widen the selector if that matters to you
- To take this over yourself, pass `scrollMarginTargets: null` and compute positions with [`getScrollTop`](#stickyscrolltriggergetscrolltopelement-instances) instead. Don't do both: a handler that reads `scroll-margin-top` and also applies `getScrollTop` would count the correction twice

## Position syntax

`start` (and `end`'s position-clause form) accepts GSAP's standard `"element-side viewport-side"` syntax. With only one clause, the viewport side defaults to `top` (`"center"` is equivalent to `"center top"`, not `"center center"`). You can also pass a function that returns a string, or for the absolute scroll position case below, a number. It's re-evaluated on every `refresh()`, which is handy for reflecting variable values like header height.

| token       | example                     | meaning                                                       |
| ----------- | --------------------------- | ------------------------------------------------------------- |
| keyword     | `top` / `center` / `bottom` | 0% / 50% / 100%                                               |
| bare number | `80` / `80px`               | 80px from the reference point (matches GSAP: only `%` scales) |
| percentage  | `80%`                       | 80% of the target's height                                    |
| px offset   | `center+=50` / `top-=20`    | ± px from the reference point                                 |
| % offset    | `top+=10%`                  | ± (relative to the target's height)                           |

```ts
// Center the scene within the visible area, excluding a 56px header.
// getHeaderHeight() is your own function (not part of this library).
start: () => `center center+=${getHeaderHeight() / 2}`,
```

A px/% offset needs the `=` when it follows a keyword or number (`top+=50`, `80-=10%`), because GSAP uses the `=` itself to split the base from the offset. `top+50` isn't recognized syntax: GSAP silently resolves it to 0, treating the whole string as unparseable, while this module throws instead. Without a base, the `=` is optional (`+=500` and `+500` are equivalent), since there's nothing to split it from.

A trailing `px` (`top 100px`, `center+=50px`) is accepted and ignored, the same idea as GSAP's own `_offsetToPx`, which only special-cases `%` and otherwise passes the value through `parseFloat`. This module isn't as lenient as GSAP toward other unrecognized suffixes, though: an actually-unsupported unit like `top 100vh` still throws, rather than silently behaving like `top 100`.

The table above is the whole accepted grammar. GSAP's `clamp()` wrapper (`start: 'clamp(top center)'`, which holds the resolved position inside the scroller's own range) is not part of it and throws. Nothing clamps the freeze window either, so a clause that resolves past the top of the document keeps its negative value: a Scene layer sitting at the very start of the container with `start: 'top bottom'` begins one viewport height before scroll 0. `end` is the exception, already clamped to `start`.

GSAP passes the `ScrollTrigger` instance to its own function-valued `start`/`end` (`start: (self) => ...`), and this module doesn't, so a function declaring that parameter is a TypeScript error. There is nothing to pass: this module's `refresh()` resolves these functions, and it runs whether or not the returned `ScrollTrigger.Vars` was ever handed to `ScrollTrigger.create()`. `self.start`/`self.end` would be circular anyway, since the freeze window they report is what `refresh()` is in the middle of computing.

### Absolute scroll position

If the entire value is just a number (a plain JS number, or a string that's nothing but digits, with no keyword, second token, or `%`/`px` suffix), GSAP treats it as an absolute scroll position rather than a clause, and ignores the reference element entirely (`ScrollTrigger.js`'s `_parsePosition`: `isNaN(value) || (value = +value)`). This module follows the same rule for `start` and `end`, and for [`createStickyPin`](#createstickypinoptions)'s `end`, [`createResolvedTrigger`](#createresolvedtriggeroptions)'s `start`/`end`, and [`resolveScrollPosition`](#resolvescrollpositionelement-position)'s `position`.

`start: '500'` (or `start: 500`) freezes starting at absolute scroll position 500px, ignoring the trigger's natural position and any preceding dwell. `end: '500'` ends the freeze window at 500px the same way, clamped to `start` if that would put `end` before it, matching GSAP's own `end = Math.max(start, ...)`.

`'500 top'` (two tokens) and `'500px'` (a suffix) don't qualify; they resolve as offsets via the bare-number row in the table above, same as GSAP.

> [`createOverlapScroll`](#createoverlapscrolloptions)'s `start` doesn't support absolute scroll positions: a cover layer's sticky position is always computed relative to its own wrapper (see the repository's `ARCHITECTURE.md`), which has no equivalent for one. It throws instead; use a position clause.

> [`createStickyPin`](#createstickypinoptions)'s `start` throws on one too, for a different reason than the cover layer above. The scroll position a pin engages at follows from where it sits, so honoring an absolute value would mean inverting it back into a viewport position the caller never chose. A trigger 2000px down the document, asked to engage at scroll 500, would sit 1500px below the viewport's top edge, off-screen. Its `end` does take one.

## End syntax

`end` auto-detects between an absolute scroll position, dwell distance, GSAP's `'max'` keyword, and a position clause.

A bare number (or numeric string with no sign/`%`/`px`) is an absolute scroll position; see [Absolute scroll position](#absolute-scroll-position) above. `end` follows the same rule `start` uses, matching GSAP.

"Dwell distance": how many px to keep pinning after the freeze starts. Matching GSAP, only a string starting with the literal `'+='` prefix counts (or a `%`-suffixed `'+=...'`, resolved against the viewport height). A leading `-=`/`+`/`-` without `=`, or a `%` without `+=`, is a position clause instead (see below). A dwell `end` never consults `endTrigger`, again matching GSAP: the distance runs from wherever the freeze starts.

| example                          | meaning                               |
| -------------------------------- | ------------------------------------- |
| `500` / `'500'`                  | End at absolute scroll position 500px |
| `'+=500'` / `'+=500px'`          | Pin for 500px                         |
| `'+=100%'`                       | Pin for one viewport height           |
| `() => window.innerHeight * 1.5` | Functions are also accepted           |

"Position clause": ends the freeze window at the absolute scroll position where the given clause of `endTrigger` (defaults to `trigger` itself) reaches the given clause of the viewport, the same idea as GSAP's own `end`. This also covers offset-only notation with no keyword before it, resolved against `endTrigger`'s own dimensions instead of the viewport's: `'-=500'` means 500px before `endTrigger`'s top, and `'+100%'`/`'50%'` mean a fraction of `endTrigger`'s own height, not a dwell distance.

```ts
sticky.createStickyTrigger({
  trigger: ".scene",
  end: "bottom top",
  endTrigger: ".nextSection",
});
```

If `endTrigger` points to another registered layer, its position is resolved using the same computation this module already does for that layer. A forward reference (pointing to a layer later in DOM order) only works from `createOverlapScroll`'s cover layer, which adds no padding and so doesn't depend on its own dwell. A `createStickyTrigger` Scene layer throws immediately instead: its own dwell padding pushes down everything after it, so the reference would depend on that dwell and never converge.

For an unregistered `endTrigger`, its raw DOM position is measured directly, then adjusted by the dwell of every registered Scene layer structurally positioned before it, including ones registered after this call, if their `trigger` sits between this layer's `trigger` and `endTrigger`.

> Keep `createStickyTrigger`'s `endTrigger` inside the shared container: pointing at an element outside it throws. If you need to reference something outside the container, use a dwell distance (e.g. `'+=500'`) instead.
>
> `createOverlapScroll` isn't subject to this restriction.

"`'max'` keyword": the scroller's max scroll position, optionally offset (`'max-=100'`, `'max+=10%'`). Ignores `endTrigger` entirely.

Bare `'max'` matches GSAP's own `end: 'max'` notation exactly. The offset forms are this module's own extension, not a GSAP reproduction: raw GSAP 3.15.0 silently drops both the offset and the `'max'` itself for `end: 'max-=100'`/`'max+=10%'`, collapsing `end` down to `start`'s position.

```ts
sticky.createOverlapScroll({
  trigger: ".trigger",
  cover: ".cover",
  end: "max",
}); // pin until the very bottom of the page
```

`'max'` is only supported by [`createOverlapScroll`](#createoverlapscrolloptions) and [`resolveScrollPosition`](#resolvescrollpositionelement-position)/[`createResolvedTrigger`](#createresolvedtriggeroptions). `createStickyTrigger` and `createStickyPin` throw on it, because their own dwell padding or pin spacer adds to the document height `'max'` measures: the freeze window would depend on itself, growing the page a little more on every `refresh()`. GSAP defines `'max'` for `end`, not `start`. In raw GSAP 3.15.0, `start: 'max'` silently resolves to `0` rather than the scroller's max, so this module rejects it for `start` instead of reproducing that.

## Constraints and caveats

- The structure directly under the shared container changes because of the added wrapper elements. Direct-child selectors like `.container__inner > .scene`, `:nth-child()`, adjacent-sibling selectors (`+`/`~`), and flex/grid layout on the shared container itself may break across the wrapper boundary
- `position:sticky` doesn't work if any ancestor of the pinned target has `overflow:hidden`/`clip`
- `createOverlapScroll`'s `trigger` and `cover` must be siblings sharing the same parent
- That shared parent also caps how far `cover` can rise: it needs `end - start` worth of content below `trigger`, or the browser releases the wrapper mid-rise, at a point that shifts with the window size (see [Room for the rise](#room-for-the-rise))
- `createStickyTrigger` and `createOverlapScroll` throw if `trigger` isn't inside the shared container. Both build their structure inside it, so a `trigger` elsewhere would wrap, move and style elements the instance doesn't own
- `createStickyPin` works on either side of the container, and throws only for a `trigger` that encloses it (the container itself, or an ancestor). A pin makes `trigger` itself `position:sticky` inside a box holding the pin range, which would pin the container and the layers' dwell padding along with it
- Selector strings for `trigger`/`endTrigger`/`cover`/`element` resolve against the whole document, as GSAP's own `trigger` does, rather than within the shared container; only the `trigger` rules above restrict where a match may land. Validate or scope these values yourself if they come from content you don't control
- ScrollTrigger's `pin`/`pinSpacing`/`anticipatePin` can't be used (pinning is handled by sticky; these are already excluded at the type level)
- GSAP's `clamp()` position wrapper isn't accepted, and a function-valued `start`/`end` is called with no arguments rather than with the `ScrollTrigger` instance GSAP passes (see [Position syntax](#position-syntax))
- A `createStickyTrigger` Scene layer can't point `endTrigger` at a registered layer later in DOM order; `createOverlapScroll`'s cover layer can, since it adds no padding (see [End syntax](#end-syntax))
- If a Scene layer's `end` uses a position clause, don't set `endTrigger` to an element that gets pushed down by that same scene's own dwell; the value won't converge
- If several layers' unregistered or cover-layer `endTrigger`s form a dependency cycle, `refresh()` throws instead of settling on a wrong value
- `end: 'max'` throws on `createStickyTrigger` and `createStickyPin` for the same reason (their own padding/spacer would depend on itself); use `createOverlapScroll` instead
- Using the same element as the `trigger` of two different `createStickyTrigger`/`createOverlapScroll`/`createStickyPin` calls throws
- You must call `refresh()` once manually after registration. Window resize/load recomputation is automatically wired to GSAP's own `refreshInit`, but for layout changes that don't involve those (e.g. content height changes), call `ScrollTrigger.refresh()` yourself (see [Calling refresh](#calling-refresh))
- Resizes from mobile browsers showing/hiding their address bar are absorbed automatically (see the repository's `ARCHITECTURE.md`, "Two-pass position measurement"), but other causes like `visualViewport` zoom are not handled
- `refresh()` writes an inline `scroll-margin-top` on every element matching `scrollMarginTargets` inside the shared container, and, on engines that drive the correction's ramps in CSS, adopts one stylesheet of its own per instance. That sheet is a constructed one, so a Content Security Policy needs no `style-src` exception for it. Both are undone by `destroy()`. Pass `scrollMarginTargets: null` to opt out (see [Same-page links](#same-page-links))
- Don't nest one `StickyScrollTrigger` instance's shared container inside another's: once a target sits inside more than one, [`getScrollTop`](#stickyscrolltriggergetscrolltopelement-instances)'s ownership check picks whichever instance is listed first, and neither instance's own dwell alone is actually correct for it

## License

[MIT](LICENSE)
