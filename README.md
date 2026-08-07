# StickyScrollTrigger

A ScrollTrigger helper that uses native `position:sticky` instead of GSAP pinning.

> ScrollTrigger is part of GSAP®, a Webflow product. This project is an independent, unofficial helper and is not affiliated with or endorsed by Webflow.

The only dependency is GSAP's ScrollTrigger types. The implementation is 6 files in `src/`. This package is not published to npm; copy `src/` into your project.

- Pin multiple scenes in sequence, sharing a single container (no gap opens up from adjacent elements scrolling away while one is pinned)
- Pinning is handled 100% by the browser's `position:sticky`; GSAP only tweens the effect's own properties while the freeze window is active
- The "section below rises up and covers the section above" effect (overlap scroll) is achieved without changing document height

See the repository's `demo/index.html` + `demo/src/main.ts` for a live example, and `ARCHITECTURE.md` for why nested sticky was chosen over `pin`, and how it works internally.

## Requirements

| requirement      | description                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GSAP             | 3.x, with the `ScrollTrigger` plugin already registered via `gsap.registerPlugin`                                                              |
| TypeScript       | Type definitions use GSAP's global types (`ScrollTrigger.Vars`). For plain JavaScript, drop the type annotations and rename the files to `.js` |
| Browser          | Must support `position:sticky` (no `overflow:hidden`/`clip` on any ancestor of a pinned element)                                               |
| Scroll direction | Vertical scrolling only (`horizontal` is not supported)                                                                                        |

## Installation

To use this in another project, copy the entire [src/](src/) directory (you can omit `*.test.ts` if you don't need it).

If you'd rather not ship the TypeScript source as-is, `npm run build:lib` produces:

- `dist/StickyScrollTrigger.js`: ESM build, plus a minified `dist/StickyScrollTrigger.min.js`
- `dist/StickyScrollTrigger.d.ts`: single bundled type definition
- `dist/StickyScrollTrigger.global.js`: IIFE build exposing `window.StickyScrollTrigger` for `<script>` tags, plus a minified `dist/StickyScrollTrigger.global.min.js`

Since this isn't published as an npm package, copy the contents of `dist/` into your own project or reference it via a local path.

Consumers should only rely on the exports of `src/index.ts` (or the build output in `dist/`). The other files under `src/` are internal modules and should not be treated as public API.

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

### `new StickyScrollTrigger(root)`

Creates an instance that treats `root` (a selector string or `HTMLElement`) as the shared container, exposing `createStickyTrigger`, `createOverlapScroll`, `createStickyPin`, `createResolvedTrigger`, `resolveScrollPosition`, `refresh`, and `destroy` as instance methods. Throws if the shared container can't be found. The class itself also exposes a static [`getScrollTop`](#stickyscrolltriggergetscrolltopelement-instances) method, for resolving a position across more than one instance.

These are ordinary instance methods, not standalone functions, so always call them on the instance (`sticky.createStickyTrigger(...)`) rather than destructuring them out; a destructured method loses its `this` binding when called.

Like `root`, every `trigger`/`endTrigger`/`cover` option below also accepts a CSS selector string (in addition to an `HTMLElement`), resolved via `document.querySelector`, the same as GSAP ScrollTrigger's own `trigger`/`endTrigger`. Throws an error if the selector matches no elements.

### `createStickyTrigger(options)`

Registers a layer that pins a scene and advances its effect, and returns `ScrollTrigger.Vars`. Pass the return value as a tween's `scrollTrigger`. ScrollTrigger options (`scrub`, `markers`, `onUpdate`, etc.) pass through as-is, except for the exclusions in the table below.

| rejected option                                                                                      | reason                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `trigger` / `start` / `end` / `endTrigger`                                                           | This module derives these itself from the freeze window                              |
| `pin` / `pinSpacing` / `anticipatePin` / `pinnedContainer` / `pinReparent` / `pinSpacer` / `pinType` | Pinning is handled by `position:sticky`, not GSAP pinning, so these have no effect   |
| `horizontal` / `scroller` / `containerAnimation`                                                     | This module assumes vertical, window-based scrolling; setting these shifts positions |

You can specify `onKill`, `invalidateOnRefresh`, and `onRefreshInit`; the module also uses them internally. `invalidateOnRefresh` defaults to `true` (GSAP defaults to `false`) so function-valued tween props are re-measured on refresh. Tracking of the freeze window (`start`/`end`) is independent of this flag, so setting `invalidateOnRefresh: false` will not break it. Explicit values are respected.

| option       | default        | description                                                                                                                                                                                                 |
| ------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`    | (required)     | The scene element to pin and animate. Must be inside the shared container                                                                                                                                   |
| `start`      | `'top top'`    | Where the scene lands in the viewport while pinned (same idea as sticky's CSS `top`). Same default GSAP itself uses for a pinned trigger. See [position syntax](#position-syntax)                           |
| `end`        | `'bottom top'` | End of the freeze window. Auto-detects between a dwell distance and a position clause (see [end syntax](#end-syntax)). Same default GSAP uses too: dwell for the trigger's own height, not a fixed distance |
| `endTrigger` | `trigger`      | Reference element when `end` uses position-clause syntax. Must be inside the shared container (see below)                                                                                                   |

### `createOverlapScroll(options)`

Registers an overlap-scroll effect (`trigger` gets pinned while its siblings from `cover` onward scroll normally and rise up to cover it) and returns `ScrollTrigger.Vars`. No tween or dwell spacer is created. Since the return value only describes the freeze window, the effect works even without passing it to `ScrollTrigger.create()`, unless you need `markers` or callbacks.

| option       | default                      | description                                                                                                                                                                                        |
| ------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`    | (required)                   | The element that gets pinned and covered. Must be a direct child of the shared container                                                                                                           |
| `cover`      | `trigger.nextElementSibling` | The first element of the covering side; this and all following siblings cover together. Must share the same parent as `trigger`                                                                    |
| `start`      | `'bottom bottom'`            | Pinned position of `trigger`. See [position syntax](#position-syntax). Unlike `createStickyTrigger`'s `start`, this doesn't support an absolute scroll position (a bare number): it throws instead |
| `end`        | `null` (auto-computed)       | End of the freeze window. When `null`, computed automatically as "the distance until `cover`'s top edge reaches the top of the viewport"                                                           |
| `endTrigger` | `trigger`                    | Reference element when `end` uses position-clause syntax                                                                                                                                           |

`createOverlapScroll` adjusts `position`/`z-index` on the covering side only when needed, never overrides explicit values, and restores its changes on GSAP `kill()`.

### `createStickyPin(options)`

Pins small elements (badges, labels, etc.) with plain `position:sticky` (pinning handled entirely by CSS, not GSAP). Pinning starts when `trigger` reaches its sticky position and releases when `endTrigger` reaches the `end` clause. This is independent of Scene/Cover layers and works the same inside or outside the shared container.

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

| option       | default     | description                                                                                       |
| ------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| `trigger`    | (required)  | The element to pin and show                                                                       |
| `top`        | `0`         | Distance from the top of the viewport while pinned (this is literally sticky's `top`)             |
| `endTrigger` | (required)  | Reference element for releasing the pin                                                           |
| `end`        | `'top top'` | Which clause of `endTrigger` releases the pin (standard GSAP [position syntax](#position-syntax)) |

Internally, the element wrapping `trigger` renders beyond its own section's bounds, into the visual area of following elements. Make sure the ancestor section containing `trigger` isn't hidden behind a later section in DOM order (e.g. via `position: relative; z-index: ...`).

See the repository's `ARCHITECTURE.md` ("Why `createStickyPin` is unaffected by nested-sticky lag") for why `createStickyPin` is completely unaffected by nested-sticky lag, and why `trigger` needs to be wrapped in two nested divs.

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

| option       | default    | description                                                                                |
| ------------ | ---------- | ------------------------------------------------------------------------------------------ |
| `trigger`    | (required) | Reference element for `start`. Also passed through as-is to GSAP's `scrollTrigger.trigger` |
| `start`      | (required) | [Position syntax](#position-syntax), resolved relative to `trigger`                        |
| `end`        | (required) | [Position syntax](#position-syntax), resolved relative to `endTrigger`                     |
| `endTrigger` | `trigger`  | Reference element for `end` (same idea as GSAP's standard `trigger`/`endTrigger` split)    |

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

For a target that might belong to a _different_ instance than the one at hand (e.g. a same-page anchor link, where you don't know in advance which instance's shared container it lives in), use the static [`getScrollTop`](#stickyscrolltriggergetscrolltopelement-instances) below instead.

### `StickyScrollTrigger.getScrollTop(element, instances)`

A static method, call it on the class itself (`StickyScrollTrigger.getScrollTop(...)`), not on an instance. Returns the absolute scroll position (px) at which `element`'s own top edge reaches the viewport's top edge (`'top top'`), picking whichever of the given `instances` actually has `element` inside its shared container. Applying the wrong instance's dwell to a target it never delayed would corrupt the result, the same way plain [`resolveScrollPosition`](#resolvescrollpositionelement-position) warns against.

```ts
import StickyScrollTrigger from "sticky-scroll-trigger";

const stickyA = new StickyScrollTrigger(".sectionA");
const stickyB = new StickyScrollTrigger(".sectionB");

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

It only cleans up DOM/styles managed by this module. You still need to kill active ScrollTrigger instances yourself. After `destroy()`, `createStickyTrigger`/`createOverlapScroll` throw and `refresh()` is a no-op. Calling `destroy()` twice is safe.

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

### Absolute scroll position

If the entire value is just a number (a plain JS number, or a string that's nothing but digits, with no keyword, second token, or `%`/`px` suffix), GSAP treats it as an absolute scroll position rather than a clause, ignoring the reference element entirely (`ScrollTrigger.js`'s `_parsePosition`: `isNaN(value) || (value = +value)`). This module follows the same rule for `start` and `end`, and for [`createStickyPin`](#createstickypinoptions)'s `end`, [`createResolvedTrigger`](#createresolvedtriggeroptions)'s `start`/`end`, and [`resolveScrollPosition`](#resolvescrollpositionelement-position)'s `position`.

`start: '500'` (or `start: 500`) freezes starting at absolute scroll position 500px, ignoring the trigger's natural position and any preceding dwell. `end: '500'` ends the freeze window at 500px the same way, clamped to `start` if that would put `end` before it, matching GSAP's own `end = Math.max(start, ...)`.

`'500 top'` (two tokens) and `'500px'` (a suffix) don't qualify for this; they resolve via the bare-number _offset_ row in the table above instead, same as GSAP.

> [`createOverlapScroll`](#createoverlapscrolloptions)'s `start` doesn't support absolute scroll positions: a cover layer's sticky position is always computed relative to its own wrapper (see the repository's `ARCHITECTURE.md`), which has no equivalent for one. It throws instead; use a position clause.

## End syntax

`end` auto-detects between an absolute scroll position, dwell distance, GSAP's `'max'` keyword, and a position clause.

A bare number (or numeric string with no sign/`%`/`px`) is an absolute scroll position; see [Absolute scroll position](#absolute-scroll-position) above. `end` follows the same rule `start` uses, matching GSAP.

"Dwell distance": how many px to keep pinning after the freeze starts. Matching GSAP, only a string starting with the literal `'+='` prefix counts (or a `%`-suffixed `'+=...'`, resolved against the viewport height). A leading `-=`/`+`/`-` without `=`, or a `%` without `+=`, is a position clause instead (see below).

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

If `endTrigger` points to another registered layer, its position is resolved using the same computation this module already does for that layer. Forward references (pointing to a layer registered later in DOM order) only work when the referencing layer is `createOverlapScroll`'s cover layer, since it adds no padding and so doesn't depend on its own dwell.

A `createStickyTrigger` Scene layer can't forward-reference a later layer this way: its own dwell padding always precedes and pushes down everything after it, so the reference would depend on its own dwell and never converge. It throws immediately instead of trying.

For an unregistered `endTrigger`, its raw DOM position is measured directly, then adjusted by the dwell of every registered Scene layer structurally positioned before it, including ones registered after this call, if their `trigger` sits between this layer's `trigger` and `endTrigger`.

> Keep `createStickyTrigger`'s `endTrigger` inside the shared container: pointing at an element outside it throws. If you need to reference something outside the container, use a dwell distance (e.g. `'+=500'`) instead.
>
> `createOverlapScroll` isn't subject to this restriction.

"`'max'` keyword": GSAP's own `end: 'max'` notation, the scroller's max scroll position, optionally offset (`'max-=100'`, `'max+=10%'`). Ignores `endTrigger` entirely.

```ts
sticky.createOverlapScroll({
  trigger: ".trigger",
  cover: ".cover",
  end: "max",
}); // pin until the very bottom of the page
```

`'max'` is only supported by [`createOverlapScroll`](#createoverlapscrolloptions) and [`resolveScrollPosition`](#resolvescrollpositionelement-position)/[`createResolvedTrigger`](#createresolvedtriggeroptions). `createStickyTrigger` and `createStickyPin` throw if `end` is `'max'`, because their own dwell padding or pin spacer adds to the document height that `'max'` measures: the freeze window would depend on itself and never settle, growing the page a little more on every `refresh()`. GSAP only defines `'max'` for `end`, not `start`, so this module doesn't support it for `start` either.

## Constraints and caveats

- The structure directly under the shared container changes because of the added wrapper elements. Direct-child selectors like `.container__inner > .scene`, `:nth-child()`, adjacent-sibling selectors (`+`/`~`), and flex/grid layout on the shared container itself may break across the wrapper boundary
- `position:sticky` doesn't work if any ancestor of the pinned target has `overflow:hidden`/`clip`
- `createOverlapScroll`'s `trigger` and `cover` must be siblings sharing the same parent
- ScrollTrigger's `pin`/`pinSpacing`/`anticipatePin` can't be used (pinning is handled by sticky; these are already excluded at the type level)
- A `createStickyTrigger` Scene layer can't point `endTrigger` at a registered layer that comes later in DOM order: it throws immediately, since the Scene layer's own dwell always precedes that later layer's position. `createOverlapScroll`'s cover layer isn't subject to this; it creates no padding, so a forward reference resolves normally
- If a Scene layer's `end` uses a position clause, don't set `endTrigger` to an element that gets pushed down by that same scene's own dwell; the value won't converge
- If several layers' unregistered or cover-layer `endTrigger`s structurally depend on each other's dwell/position in a cycle (each layer's end depends on a layer whose own end depends back on it), `refresh()` throws instead of settling on an incorrect value
- `end: 'max'` throws on `createStickyTrigger` and `createStickyPin` for the same reason (their own padding/spacer would depend on itself); use `createOverlapScroll` instead
- Using the same element as the `trigger` of two different `createStickyTrigger`/`createOverlapScroll`/`createStickyPin` calls throws
- You must call `refresh()` once manually after registration. Window resize/load recomputation is automatically wired to GSAP's own `refreshInit`, but for layout changes that don't involve those (e.g. content height changes), call `ScrollTrigger.refresh()` yourself (see [Calling refresh](#calling-refresh))
- Resizes from mobile browsers showing/hiding their address bar are absorbed automatically (see the repository's `ARCHITECTURE.md`, "Two-pass position measurement"), but other causes like `visualViewport` zoom are not handled
- Don't nest one `StickyScrollTrigger` instance's shared container inside another's: once a target sits inside more than one, [`getScrollTop`](#stickyscrolltriggergetscrolltopelement-instances)'s ownership check picks whichever instance is listed first, and neither instance's own dwell alone is actually correct for it

## License

[MIT](LICENSE)
