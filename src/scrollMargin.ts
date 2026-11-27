/**
 * Declares each Scene layer's dwell, and how far a cover's wrapper has carried what it holds, to
 * the browser through `scroll-margin-top`, so the platform's own "scroll an element into view"
 * lands where the element really reaches the viewport top. That covers same-page `<a href="#...">`
 * links, `scrollIntoView`, `:target` and anything else routed through that algorithm, with no code
 * on the caller's side.
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
 * A jump aims to leave the element `m` below the viewport top, where `m` is the author's own
 * `scroll-margin-top` plus the offset property below. It truly sits there at `N − m + lag`, where
 * `lag` is the dwell of every Scene layer that freezes before it gets there (freezeWindow.ts's
 * `dwellBeforeReach`, the same rule `resolveScrollPosition` applies). Substituting both into the
 * landing formula and solving for a landing of `N − m + lag`:
 *
 *   scrollMarginTop = m + Σ h_i(currentScroll) − lag
 *
 * `Σ h_i` depends on where the jump was started from, which is why the value can't be a plain
 * number: with `−lag` alone, a jump from the top of the page is exact but one started mid-page
 * overshoots by the dwell already consumed.
 *
 * A cover's wrapper stays stuck until its parent's content box ends, carrying what it holds down
 * the page by `c_k(s) = clamp(s − Σ h_i(s) − u_k − Σ c_j(s), 0, room_k)`, where `u_k` is where the
 * content stands when the wrapper sticks and the `c_j` are the wrappers around it. A target inside
 * has `paintedTop(s) = N − s + Σ h_i(s) + Σ c_k(s)`, so the same substitution adds
 * `Σ (c_k(currentScroll) − c_k(0))` to the value. Leaving out the carry at scroll 0 (which a
 * wrapper stuck from the top of the page has) keeps a jump from the top where it lands unwritten.
 * Each wrapper's property holds its own term, so a target that leaves the wrapper reads 0 there.
 * With no Scene layer dwell, only those targets are written.
 *
 * `lag` depends on `m`, which moves the point the element has to reach, and the offset property
 * in `m` can change without a `refresh()`. So each layer's all-or-nothing decision is written as
 * CSS too: `clamp(0px, x * 1000000, dwell)` is 0 for any `x` at or below 0 and the full dwell for
 * anything past a few thousandths of a pixel, a step in all but name. Each layer's `x` compares
 * against a constant (see `dwellBeforeReach` for why), so the text grows by one term per layer.
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
 * Each `c_k` rides a ramp on its own wrapper, across the scroll window where it can change (see
 * planCarryRamps), and only for a wrapper holding a target: a changing inherited property restyles
 * everything below it on every frame.
 *
 * The animations, and the `scroll` listener's writes, target the outermost container and the
 * cover wrappers this module builds, never an element the caller owns, and the custom properties
 * reach the targets by inheritance from there.
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
 * `calc(authorPx + --sst-scroll-margin-top-offset + Σh_i + Σ(c_k − c_k(0)) − lag)`. A positive
 * value lands short, settling below the viewport's top edge instead of flush with it; negative
 * overshoots. Being an ordinary (unregistered) custom property, it's read live on every
 * scroll-into-view with no refresh() needed, and inherits normally, so it can be set once on the
 * shared container for every target or per-target to override that. It stays separate from the
 * author's own scroll-margin-top (still supported, see above) because the two answer different
 * questions: how far off the caller wants to land, and what the element's own CSS already says.
 */

import { captureInline, compareDocumentOrder, restoreIfWritten, writeInline } from './dom';
import type { InlineValue } from './dom';
import { dwellConsumedAt, TIE_TOLERANCE_PX } from './freezeWindow';

// Reserved custom property for nudging where a target lands, independent of both the dwell
// correction and the author's own scroll-margin-top. Fixed rather than per-instance because it's
// an authoring knob nothing here ever writes to, unlike the per-layer ramp properties in
// buildStylesheet, so two instances have nothing to collide over.
const OFFSET_PROPERTY = '--sst-scroll-margin-top-offset';
// The correction already includes the author's computed value, so it's written !important: a page
// stylesheet's !important beats a plain inline value, but not an inline !important one.
const PRIORITY = 'important';

// One Scene layer's contribution, as of the current refresh().
export interface SceneDwell {
  freezeStart: number;
  freezeEnd: number;
}

// One cover layer's wrapper. Once it sticks, it carries what it holds down the page by how far the
// content has moved since (scroll less the Scene dwell consumed), up to room. start is where the
// content stands when it sticks.
export interface CoverCarry {
  wrapper: HTMLElement;
  start: number;
  room: number;
}

// A cover wrapper's carry as CSS: value is its expression over the scroll, which only changes
// between from and to.
export interface CarryRamp {
  value: string;
  from: number;
  to: number;
}

// A cover carry in sync()'s order (outermost first), with the indices of the ones around it and
// how much it carries at scroll 0 (a wrapper stuck from the top of the page).
export interface PlannedCarry {
  carry: CoverCarry;
  outer: number[];
  atTop: number;
}

// c_k(s) in the module doc: what a cover's wrapper carries at scroll s, given the Scene dwell
// consumed by then and what the wrappers around it carry.
const carriedAt = (scroll: number, consumed: number, held: number, { start, room }: CoverCarry) =>
  Math.min(Math.max(scroll - consumed - held - start, 0), room);

// A target's own inline scroll-margin-top from before the library's last write over it, that write
// as the browser keeps it, and the instance that made it. Shared by every instance, so a target
// moved into another instance's container still reads as a library write, and only the instance
// that wrote last hands it back.
interface TargetSnapshot {
  authored: InlineValue;
  written: string;
  owner: string;
}

const snapshots = new WeakMap<HTMLElement, TargetSnapshot>();
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
// layer's own freeze window, and one per cover wrapper in carries across its own window. Written
// as text (rather than through the Web Animations API) so the custom-property animation runs
// through the same CSS path that was verified in both engines.
//
// Exported for scrollMargin.test.ts alone: jsdom has no adoptedStyleSheets, so a sync() there never
// reaches this, leaving the text it produces checkable only by calling it directly.
export const buildStylesheet = (
  instanceId: string,
  scenes: readonly SceneDwell[],
  carries: readonly CarryRamp[] = [],
): string => {
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

  const rules: string[] = [];

  if (animations.length) {
    rules.push(
      `[data-${instanceId}]{`
      + `animation:${animations.join(',')};`
      + `animation-timeline:${timelines.join(',')};`
      + `animation-range:${ranges.join(',')}}`,
    );
  }

  // Each cover wrapper reads the scroll across its own window alone, into a property it keeps to
  // itself, so a frame outside every window restyles nothing and one inside restyles only what
  // that wrapper holds.
  carries.forEach(({ value, from, to }, index) => {
    const scroll = `--${instanceId}-s${index}`;
    const carried = `--${instanceId}-w${index}`;
    const keyframes = `${instanceId}-ks${index}`;

    declarations.push(
      `@property ${scroll}{syntax:"<length>";inherits:false;initial-value:0px}`,
      `@property ${carried}{syntax:"<length>";inherits:true;initial-value:0px}`,
      `@keyframes ${keyframes}{from{${scroll}:${from}px}to{${scroll}:${to}px}}`,
    );
    rules.push(
      `[data-${instanceId}-w="${index}"]{`
      + `animation:${keyframes} linear both;animation-timeline:scroll(root block);`
      + `animation-range:${from}px ${to}px;${carried}:${value}}`,
    );
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
  declarations.push(`@supports (animation-timeline: scroll()) {${rules.join('')}}`);

  return declarations.join('');
};

// Each carry as the CSS path writes it: the scroll less where the wrapper sticks, the Scene dwell
// consumed and the carries around it, clamped to its room. The ramp starts at start: one starting
// later would read a scroll above the real one before it, and carry while a dwell before it is
// still to be consumed. It ends where the carry is full for certain: the
// content moved room past start with every carry around it full and every dwell begun by then
// consumed. Past that end the ramp holds still, so a dwell that begins later isn't subtracted: it
// would take the carry back down.
//
// Exported for scrollMargin.test.ts alone, for the reason buildStylesheet is.
export const planCarryRamps = (
  instanceId: string,
  ramps: readonly SceneDwell[],
  carries: readonly PlannedCarry[],
): CarryRamp[] => carries.map(({ carry, outer, atTop }, index) => {
  // A wrapper stuck from the top of the page carries from scroll 0, where the range starts.
  const from = Math.max(carry.start, 0);
  let to = carry.start + carry.room + outer.reduce((sum, k) => sum + carries[k].carry.room, 0);
  const begun: string[] = [];

  ramps.forEach(({ freezeStart, freezeEnd }, i) => {
    if (freezeStart >= to) return;

    to += freezeEnd - freezeStart;
    begun.push(`var(--${instanceId}-c${i}, 0px)`);
  });

  // Each property around it leaves out that wrapper's carry at scroll 0, which goes back in here.
  const offset = outer.reduce((sum, k) => sum + carries[k].atTop, carry.start);
  const held = [...begun, ...outer.map((k) => `var(--${instanceId}-w${k}, 0px)`)];
  const full = `clamp(0px, var(--${instanceId}-s${index}) - ${offset}px`
    + `${held.map((v) => ` - ${v}`).join('')}, ${carry.room}px)`;

  // Less its own carry at scroll 0, on the wrapper rather than in each target's value: a killed
  // cover unwraps at once, and what it held then reads 0 until the kill's refresh rewrites it.
  return {
    value: atTop ? `calc(${full} - ${atTop}px)` : full,
    from,
    to: Math.max(to, from + 1),
  };
});

/**
 * Creates the per-controller state for keeping `scroll-margin-top` in sync. `sync` is called at
 * the end of every `refresh()`, once freeze windows are final, and `applyRamps` after it; `restore`
 * undoes everything.
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
  // Elements currently carrying a value written here, so a target that stops matching the
  // selector (its id removed, say) gets handed back rather than left with a stale correction.
  let written = new Set<HTMLElement>();
  let sheet: CSSStyleSheet | null = null;
  let sheetText: string | null = null;
  let animationHost: HTMLElement | null = null;
  // Read by applyJsRamp below; kept current by every sync() call. Only meaningful when usesCssRamp
  // is false, since that's the one case nothing else keeps these custom properties current (see
  // the module doc comment's "scroll-dependent half" section).
  let jsRamps: readonly SceneDwell[] = [];
  let jsHost: HTMLElement | null = null;
  // Cover wrappers carrying a ramp of their own, outermost first, and which earlier ones hold each.
  let carryHosts: HTMLElement[] = [];
  let jsCarries: readonly PlannedCarry[] = [];

  const applyJsRamp = (scroll = window.scrollY) => {
    let consumedAll = 0;

    jsRamps.forEach((scene, index) => {
      const consumed = Math.min(
        Math.max(scroll - scene.freezeStart, 0),
        scene.freezeEnd - scene.freezeStart,
      );

      consumedAll += consumed;
      jsHost?.style.setProperty(`--${instanceId}-c${index}`, `${consumed}px`);
    });

    const carried: number[] = [];

    jsCarries.forEach(({ carry, outer, atTop }, index) => {
      const held = outer.reduce((sum, k) => sum + carried[k], 0);

      carried[index] = carriedAt(scroll, consumedAll, held, carry);
      carry.wrapper.style.setProperty(`--${instanceId}-w${index}`, `${carried[index] - atTop}px`);
    });
  };

  const onScroll = () => applyJsRamp();

  if (usesJsRamp) window.addEventListener('scroll', onScroll, { passive: true });

  const restoreTarget = (target: HTMLElement) => {
    const snapshot = snapshots.get(target);

    if (snapshot?.owner === instanceId) {
      restoreIfWritten(
        target,
        'scroll-margin-top',
        snapshot.authored,
        snapshot.written,
        PRIORITY,
      );
    }
  };

  const dropCarry = (wrapper: HTMLElement, index: number) => {
    wrapper.removeAttribute(`data-${instanceId}-w`);
    wrapper.style.removeProperty(`--${instanceId}-w${index}`);
  };

  const stopRamps = () => {
    if (sheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((one) => one !== sheet);
      sheet = null;
    }

    animationHost?.removeAttribute(`data-${instanceId}`);
    animationHost = null;
    carryHosts.forEach(dropCarry);
    carryHosts = [];
    jsRamps = [];
    jsHost = null;
    jsCarries = [];
  };

  // Points the Scene ramps at host and each carry at its wrapper, and starts them: the CSS
  // animation where it runs, else the scroll listener's values, which applyRamps() writes once
  // the caller is done with layout. Where the animation runs, those writes would only lose to it
  // in the cascade, so they're skipped.
  const startRamps = (
    ramps: readonly SceneDwell[],
    host: HTMLElement | null,
    carries: readonly PlannedCarry[],
  ) => {
    if (animationHost !== host) {
      animationHost?.removeAttribute(`data-${instanceId}`);
      animationHost = host;
      animationHost?.setAttribute(`data-${instanceId}`, '');
    }

    const wrappers = carries.map(({ carry }) => carry.wrapper);

    carryHosts.forEach((wrapper, index) => {
      if (wrappers[index] !== wrapper) dropCarry(wrapper, index);
    });
    wrappers.forEach((wrapper, index) => {
      if (wrapper.getAttribute(`data-${instanceId}-w`) !== `${index}`) {
        wrapper.setAttribute(`data-${instanceId}-w`, `${index}`);
      }
    });
    carryHosts = wrappers;

    if (usesJsRamp) {
      jsRamps = ramps;
      jsHost = host;
      jsCarries = carries;

      return;
    }

    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheetText = null;
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }

    // Replacing the text restyles the whole page, so skip it when no freeze window or carry
    // (where a wrapper sticks, its room) moved.
    const text = buildStylesheet(instanceId, ramps, planCarryRamps(instanceId, ramps, carries));

    if (text !== sheetText) {
      sheet.replaceSync(text);
      sheetText = text;
    }
  };

  const matching = (within?: readonly HTMLElement[]) => {
    const all = Array.from(rootElement.querySelectorAll<HTMLElement>(targetSelector!));

    return within
      ? all.filter((target) => within.some((wrapper) => wrapper.contains(target)))
      : all;
  };

  const release = () => {
    written.forEach(restoreTarget);
    written = new Set();
    stopRamps();
  };

  return {
    // The elements sync() would write now, so the caller can measure them first: all of them, or
    // with no Scene layer dwell, those inside one of the cover wrappers in `within`.
    targets: (within?: readonly HTMLElement[]): HTMLElement[] => (targetSelector === null
      ? []
      : matching(within)),

    // measureNaturalTops returns each target's documentTop with no wrapper stuck, which only the
    // caller can arrange.
    sync(
      scenes: readonly SceneDwell[],
      host: HTMLElement | null,
      measureNaturalTops: (targets: readonly HTMLElement[]) => number[],
      covers: readonly CoverCarry[] = [],
    ): void {
      // A zero-length freeze window contributes nothing, and an animation-range whose start
      // equals its end has no meaningful ramp, so those layers are dropped rather than emitted.
      // Sorted because each layer's lag decision assumes every earlier one counted.
      const ramps = scenes
        .filter((scene) => scene.freezeEnd > scene.freezeStart)
        .sort((a, b) => a.freezeStart - b.freezeStart);

      if (targetSelector === null) {
        release();

        return;
      }

      const sceneHost = ramps.length ? host : null;
      const sceneRamps = sceneHost ? ramps : [];
      const matched = matching();
      // Only a wrapper holding a target needs its carry, which restyles everything it holds on
      // every frame it changes. In document order, so a wrapper comes before the ones inside it,
      // which it carries in its own frame.
      const holds = (wrapper: HTMLElement) => matched.some((target) => wrapper.contains(target));
      const sorted = covers
        .filter(({ wrapper, room }) => room > 0 && holds(wrapper))
        .sort((a, b) => compareDocumentOrder(a.wrapper, b.wrapper));
      const carries: PlannedCarry[] = [];
      // The dwell a Scene window opening before scroll 0 has consumed there, which every carry
      // subtracts from the scroll.
      const consumedAtTop = dwellConsumedAt(0, sceneRamps);

      sorted.forEach((carry, index) => {
        const outer = sorted.flatMap((other, k) => (
          k < index && other.wrapper.contains(carry.wrapper) ? [k] : []));
        const held = outer.reduce((sum, k) => sum + carries[k].atTop, 0);
        const atTop = carriedAt(0, consumedAtTop, held, carry);

        carries.push({ carry, outer, atTop });
      });

      if (!sceneHost && !carries.length) {
        release();

        return;
      }

      startRamps(sceneRamps, sceneHost, carries);

      const targets = sceneHost
        ? matched
        : matched.filter((target) => carries.some(({ carry }) => carry.wrapper.contains(target)));
      // Measured before anything here writes to a target. Nothing below changes layout, so this
      // only keeps the caller's sticky resets ahead of every write of this module's own.
      const naturalTops = measureNaturalTops(targets);

      // Pass 1: put every target still holding a library write back to the author's inline value,
      // so pass 2 reads the author's scroll-margin-top instead of our calc() (a header height
      // changed at a breakpoint would go unnoticed). Any other inline value, one set by JS since
      // the last sync included, is the author's and becomes the snapshot.
      targets.forEach((target) => {
        const existing = snapshots.get(target);

        if (existing
          && restoreIfWritten(
            target,
            'scroll-margin-top',
            existing.authored,
            existing.written,
            PRIORITY,
          )) {
          return;
        }

        snapshots.set(target, {
          authored: captureInline(target, 'scroll-margin-top'),
          written: '',
          owner: instanceId,
        });
      });

      const consumedTerms = sceneRamps.map((_, index) => `var(--${instanceId}-c${index}, 0px)`);

      // Pass 2: read each target's author value now that it's back to that state, then write the
      // corrected one. Interleaving the two passes would be just as correct, but resetting
      // everything before reading anything avoids forcing a style recalc per target.
      targets.forEach((target, targetIndex) => {
        const authorPx = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        let earlierDwell = 0;
        // dwellBeforeReach's test, with everything but the offset folded into one number.
        const lag = sceneRamps.map(({ freezeStart, freezeEnd }) => {
          const margin = naturalTops[targetIndex] - authorPx + earlierDwell - freezeStart
            - TIE_TOLERANCE_PX;

          earlierDwell += freezeEnd - freezeStart;

          return `clamp(0px, (${margin}px - var(${OFFSET_PROPERTY}, 0px)) * 1000000,`
            + ` ${freezeEnd - freezeStart}px)`;
        }).join(' + ');
        const snapshot = snapshots.get(target)!;
        // Each cover wrapper around target adds what it has carried since scroll 0.
        const carried = carries.flatMap(({ carry }, index) => (carry.wrapper.contains(target)
          ? [`var(--${instanceId}-w${index}, 0px)`]
          : []));
        const added = [...consumedTerms, ...carried].map((v) => ` + ${v}`).join('');

        snapshot.written = writeInline(
          target,
          'scroll-margin-top',
          `calc(${authorPx}px + var(${OFFSET_PROPERTY}, 0px)${added}${lag ? ` - (${lag})` : ''})`,
          PRIORITY,
        );
        snapshot.owner = instanceId;
      });

      const next = new Set(targets);

      written.forEach((target) => {
        if (!next.has(target)) restoreTarget(target);
      });
      written = next;
    },

    // Writes the JS ramp's values for the current scroll, so the targets' calc() holds even if no
    // scroll event comes before the next scroll-into-view. Separate from sync() because reading the
    // scroll forces a layout, which refresh() puts off until dormancy has demoted the far layers.
    // `scroll` is the one a measurement at 0 goes back to.
    applyRamps(scroll?: number): void {
      applyJsRamp(scroll);
    },

    restore(): void {
      if (usesJsRamp) window.removeEventListener('scroll', onScroll);

      release();
    },
  };
};
