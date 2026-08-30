/**
 * Declares each Scene layer's dwell to the browser through `scroll-margin-top`, so the platform's
 * own "scroll an element into view" lands where the element really reaches the viewport top. That
 * covers same-page `<a href="#...">` links, `scrollIntoView`, `:target` and anything else routed
 * through that algorithm, with no code on the caller's side.
 *
 * ## Why a correction is needed at all
 *
 * Scrolling an element into view is a single, one-shot calculation:
 *
 *   landing = currentScroll + paintedTop − scrollMarginTop
 *
 * That only holds when `paintedTop + currentScroll` is the same at every scroll position, i.e.
 * when the element moves at exactly scroll speed. Pinning deliberately violates it, so no pinning
 * technique, GSAP's own `pin` included, leaves the native calculation correct by itself.
 * `scroll-margin-top` is the one channel CSS offers for saying "aim this far off from what you
 * measured".
 *
 * ## The value
 *
 * Write `paintedTop(s)` for the element's painted position at scroll `s`, `N` for its
 * `documentTop`, and `h_i(s) = clamp(s − freezeStart_i, 0, dwell_i)` for how much of Scene layer
 * i's dwell has been consumed at `s`. Every Scene layer freezes the whole shared container, so
 *
 *   paintedTop(s) = N − s + Σ h_i(s)
 *
 * The element truly reaches the viewport top at `N + lag`, where `lag` is the total dwell of the
 * Scene layers before it (the same sum `resolveScrollPosition` adds). Substituting both into the
 * landing formula and solving for a landing of `N + lag`:
 *
 *   scrollMarginTop = Σ h_i(currentScroll) − lag
 *
 * `lag` is a constant this module knows after `refresh()`. `Σ h_i` depends on where the jump was
 * started from, which is why the value can't be a plain number: with `−lag` alone, a jump from the
 * top of the page is exact but one started mid-page overshoots by the dwell already consumed.
 *
 * ## How the scroll-dependent half is supplied
 *
 * Each `h_i` is a registered custom property ramped from 0 to its dwell across its own freeze
 * window, driven by a CSS scroll-driven animation (`animation-timeline: scroll(root block)` plus
 * an `animation-range` in absolute px) where the browser supports it. The browser advances the
 * ramps itself, off the main thread, which is what keeps this module's promise of running no code
 * on scroll.
 *
 * That stylesheet is a constructed one the document adopts, so a Content Security Policy needs no
 * `style-src` exception for it.
 *
 * Where `animation-timeline: scroll()` or a constructed stylesheet isn't supported, a `scroll`
 * listener on `window` writes the same `h_i` values instead, and no stylesheet is built at all. A
 * plain `−lag` constant is wrong here for the same reason it's wrong in general (above). This
 * fallback doesn't share Chromium's limitation below, since Chromium always takes the CSS path:
 * every engine that lacks scroll timelines was verified to tolerate a `scroll-margin-top` that
 * keeps changing through an in-flight smooth scroll.
 *
 * The animation, and the `scroll` listener's writes, target the outermost container this module
 * builds, never an element the caller owns, and the custom properties reach the targets by
 * inheritance from there.
 *
 * ## Known limitation: Chromium + native smooth scrolling
 *
 * Chromium's `scroll-behavior: smooth` doesn't run a fragment jump as one continuous animation: it
 * advances in several short steps, each firing its own `scrollend`. A `scroll-margin-top` that
 * changes before the last of those makes Chromium recompute the landing target mid-flight and
 * under- or overshoot, occasionally by enough to reverse direction briefly. It happens whether the
 * value is driven by CSS or by JS, and reacting to the intermediate `scrollend` makes it worse,
 * so no variant of this module avoids it while staying accurate for a jump started
 * mid-dwell. Sites that need animated same-page scrolling in Chromium should drive it themselves
 * (`getScrollTop` plus `scrollTo({ top, behavior: 'smooth' })` to a precomputed, unchanging
 * target).
 *
 * ## Nudging the landing spot on purpose
 *
 * `--sst-scroll-margin-top-offset` is folded into the same calc() as an extra term:
 * `calc(authorPx + --sst-scroll-margin-top-offset + Σh_i − lag)`. A positive value lands short,
 * settling below the viewport's top edge instead of flush with it; negative overshoots. Being an
 * ordinary (unregistered) custom property, it's read live on every scroll-into-view with no
 * refresh() needed, and inherits normally, so it can be set once on the shared container for every
 * target or per-target to override that. It stays separate from the author's own
 * scroll-margin-top (still supported, see above) because the two answer different questions: how
 * far off the caller wants to land, and what the element's own CSS already says.
 */

import { compareDocumentOrder } from './dom';

// Reserved custom property for nudging where a target lands, independent of both the dwell
// correction and the author's own scroll-margin-top. Fixed rather than per-instance because it's
// an authoring knob nothing here ever writes to, unlike the per-layer ramp properties in
// buildStylesheet, so two instances have nothing to collide over.
const OFFSET_PROPERTY = '--sst-scroll-margin-top-offset';

// One Scene layer's contribution, as of the current refresh().
export interface SceneDwell {
  trigger: HTMLElement;
  freezeStart: number;
  freezeEnd: number;
}

// A target element's own inline scroll-margin-top, as it was before this module first wrote to it.
// Restores the element on destroy, and lets a later sync() put a target back to its pre-module
// state before re-reading the author's computed value (see sync's two-pass comment for why that
// re-read happens every time).
interface TargetSnapshot {
  inline: string;
}

let nextInstanceSuffix = 0;
// A fixed browser capability, so this only needs computing once, at load.
const supportsScrollDrivenAnimations = typeof CSS !== 'undefined'
  && typeof CSS.supports === 'function'
  && CSS.supports('animation-timeline', 'scroll()');
// The ramps need a stylesheet to carry them, and only a constructed one stays out of style-src's
// reach: a <style> element would need the policy exception this module promises not to require.
// Where constructed stylesheets aren't available, the JS ramp below stands in, needing no
// stylesheet at all.
const supportsConstructedStyleSheets = typeof CSSStyleSheet === 'function'
  && typeof CSSStyleSheet.prototype.replaceSync === 'function'
  && typeof document !== 'undefined'
  && Array.isArray(document.adoptedStyleSheets);
const usesCssRamp = supportsScrollDrivenAnimations && supportsConstructedStyleSheets;

// Builds the stylesheet that ramps one registered custom property per Scene layer across that
// layer's own freeze window. Written as text (rather than through the Web Animations API) so the
// custom-property animation runs through the same CSS path that was verified in both engines.
//
// Exported for scrollMargin.test.ts alone: jsdom has no adoptedStyleSheets, so a sync() there never
// reaches this, leaving the text it produces checkable only by calling it directly.
export const buildStylesheet = (instanceId: string, scenes: readonly SceneDwell[]): string => {
  const declarations: string[] = [];
  const animations: string[] = [];
  const timelines: string[] = [];
  const ranges: string[] = [];

  scenes.forEach((scene, index) => {
    const property = `--${instanceId}-c${index}`;
    const keyframes = `${instanceId}-k${index}`;

    declarations.push(
      `@property ${property}{syntax:"<length>";inherits:true;initial-value:0px}`,
      `@keyframes ${keyframes}{from{${property}:0px}to{${property}:${scene.freezeEnd - scene.freezeStart}px}}`,
    );
    animations.push(`${keyframes} linear both`);
    // Every layer rides the document scroller's own block axis; this module only supports
    // vertical, window-based scrolling in the first place.
    timelines.push('scroll(root block)');
    // Absolute px along that timeline, i.e. real scroll positions, which is exactly what
    // freezeStart/freezeEnd already are.
    ranges.push(`${scene.freezeStart}px ${scene.freezeEnd}px`);
  });

  // The @supports gate is load-bearing rather than a precaution. A browser that can't parse
  // `animation-timeline: scroll(...)` drops that declaration and leaves animation-timeline at its
  // initial `auto`, which turns the `animation` shorthand above into an ordinary time-based
  // animation with no explicit duration, hence 0s. At 0s with fill-mode `both` it still runs,
  // instantly, jumping every custom property to its keyframe's `to` value on load. Gating the
  // whole rule leaves each var() below with nothing to read, so it falls back to its own 0px
  // default, degrading to the constant '-lag' form by design. See ARCHITECTURE.md's "Why the
  // animation rule needs an explicit @supports gate" for how this was verified in Firefox.
  //
  // animation-timeline and animation-range have to follow the `animation` shorthand, which resets
  // both to their initial values.
  declarations.push(
    `@supports (animation-timeline: scroll()) {`
    + `[data-${instanceId}]{`
    + `animation:${animations.join(',')};`
    + `animation-timeline:${timelines.join(',')};`
    + `animation-range:${ranges.join(',')}}}`,
  );

  return declarations.join('');
};

/**
 * Creates the per-controller state for keeping `scroll-margin-top` in sync. `sync` is called at
 * the end of every `refresh()`, once freeze windows are final; `restore` undoes everything.
 *
 * `targetSelector` is fixed for the instance's lifetime, which is what lets the fallback listener
 * below be decided once here rather than per sync(). A null selector opts out of the whole module.
 */
export const createScrollMarginSync = (
  rootElement: HTMLElement,
  targetSelector: string | null,
) => {
  const instanceId = `sst${nextInstanceSuffix++}`;
  // Whether this instance drives the ramps itself. A null selector means sync() returns before it
  // would ever want them, so the listener is never attached rather than left firing as a no-op
  // until destroy().
  const usesJsRamp = !usesCssRamp && targetSelector !== null;
  const snapshots = new WeakMap<HTMLElement, TargetSnapshot>();
  // Elements currently carrying a value written here, so a target that stops matching the
  // selector (its id removed, say) gets handed back rather than left with a stale correction.
  let written = new Set<HTMLElement>();
  let sheet: CSSStyleSheet | null = null;
  let animationHost: HTMLElement | null = null;
  // Read by applyJsRamp below; kept current by every sync() call. Only meaningful when usesCssRamp
  // is false, since that's the one case nothing else keeps these custom properties current (see
  // the module doc comment's "scroll-dependent half" section).
  let jsRamps: readonly SceneDwell[] = [];
  let jsHost: HTMLElement | null = null;

  const applyJsRamp = () => {
    if (!jsHost) return;

    const scroll = window.scrollY;

    jsRamps.forEach((scene, index) => {
      const consumed = Math.min(
        Math.max(scroll - scene.freezeStart, 0),
        scene.freezeEnd - scene.freezeStart,
      );

      jsHost!.style.setProperty(`--${instanceId}-c${index}`, `${consumed}px`);
    });
  };

  if (usesJsRamp) window.addEventListener('scroll', applyJsRamp, { passive: true });

  const restoreTarget = (target: HTMLElement) => {
    const snapshot = snapshots.get(target);

    target.style.scrollMarginTop = snapshot ? snapshot.inline : '';
  };

  const clearAnimation = () => {
    if (sheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((one) => one !== sheet);
      sheet = null;
    }

    animationHost?.removeAttribute(`data-${instanceId}`);
    animationHost = null;
    jsRamps = [];
    jsHost = null;
  };

  return {
    sync(scenes: readonly SceneDwell[], host: HTMLElement | null): void {
      // A zero-length freeze window contributes nothing, and an animation-range whose start
      // equals its end has no meaningful ramp, so those layers are dropped rather than emitted.
      const ramps = scenes.filter((scene) => scene.freezeEnd > scene.freezeStart);

      if (targetSelector === null || !ramps.length || !host) {
        written.forEach(restoreTarget);
        written = new Set();
        clearAnimation();

        return;
      }

      if (animationHost !== host) {
        animationHost?.removeAttribute(`data-${instanceId}`);
        animationHost = host;
        animationHost.setAttribute(`data-${instanceId}`, '');
      }

      // Applied once immediately so the calc() below is correct right away, without waiting for a
      // scroll event that may never come before the next scroll-into-view. Skipped where the CSS
      // animation already handles it: writing there wouldn't be wrong, since the animation wins
      // the cascade over an inline value either way, just a pointless write on every refresh().
      if (usesJsRamp) {
        jsRamps = ramps;
        jsHost = host;
        applyJsRamp();
      } else {
        if (!sheet) {
          sheet = new CSSStyleSheet();
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }

        sheet.replaceSync(buildStylesheet(instanceId, ramps));
      }

      const targets = Array.from(rootElement.querySelectorAll<HTMLElement>(targetSelector));

      // Pass 1: snapshot each target on first sight, then put every previously-written one back to
      // its pre-module inline value, so pass 2 can read the author's own scroll-margin-top fresh.
      // Without the reset, pass 2 would read back this module's own calc() and mistake it for the
      // author's value, leaving every sync() stuck on whatever that value was the first time (a
      // header height that changes at a breakpoint, or via JS, would never be picked up again).
      targets.forEach((target) => {
        const existing = snapshots.get(target);

        if (!existing) snapshots.set(target, { inline: target.style.scrollMarginTop });
        else if (written.has(target)) target.style.scrollMarginTop = existing.inline;
      });

      const consumed = ramps
        .map((_, index) => `var(--${instanceId}-c${index}, 0px)`)
        .join(' + ');

      // Pass 2: read each target's author value now that it's back to that state, then write the
      // corrected one. Interleaving the two passes would be just as correct, but resetting
      // everything before reading anything avoids forcing a style recalc per target.
      targets.forEach((target) => {
        const authorPx = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        let lag = 0;

        ramps.forEach((scene) => {
          if (compareDocumentOrder(scene.trigger, target) >= 0) return;

          lag += scene.freezeEnd - scene.freezeStart;
        });

        target.style.scrollMarginTop
          = `calc(${authorPx}px + var(${OFFSET_PROPERTY}, 0px) + ${consumed} - ${lag}px)`;
      });

      const next = new Set(targets);

      written.forEach((target) => {
        if (!next.has(target)) restoreTarget(target);
      });
      written = next;
    },

    restore(): void {
      if (usesJsRamp) window.removeEventListener('scroll', applyJsRamp);

      written.forEach(restoreTarget);
      written = new Set();
      clearAnimation();
    },
  };
};
