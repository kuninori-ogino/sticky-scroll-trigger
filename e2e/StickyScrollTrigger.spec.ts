import { test, expect, type Locator } from '@playwright/test';

// Reads the scene element's --progress CSS custom property (0-1).
// main.ts drives this value via createStickyTrigger's scrub, and it should only move
// while sticky-pinned. gsap.fromTo's initial state sets --progress before any test can observe
// the element, so a missing/unparseable value here means the property name drifted from what
// main.ts actually sets (or the tween never ran). Throwing surfaces that immediately, instead of
// `|| 0` silently reading it as a legitimate "at rest" value indistinguishable from the real one.
const readProgress = (locator: Locator) =>
  locator.evaluate((el) => {
    const raw = getComputedStyle(el).getPropertyValue('--progress');
    const value = parseFloat(raw);

    if (Number.isNaN(value)) {
      throw new Error(`--progress is missing or unparseable (raw value: "${raw}")`);
    }

    return value;
  });
// Whether any ancestor of the target element (up to document.body) has position:sticky applied.
// createStickyTrigger generates an anonymous wrapper div each time, so this walks computedStyle
// rather than checking class names.
const hasStickyAncestor = (locator: Locator) =>
  locator.evaluate((el) => {
    let node = el.parentElement;

    while (node) {
      if (getComputedStyle(node).position === 'sticky') return true;

      node = node.parentElement;
    }

    return false;
  });

// documentTop depends on offsetTop/offsetParent/clientTop,
// so it can't be verified in jsdom's layout-free environment (it would always return 0
// and pass through trivially).
// This only makes sense in a real browser, so it lives here.
test('documentTop returns the absolute position including ancestors\' borders', async ({ page }) => {
  await page.goto('/fixtures/documentTop.html');

  const measure = () =>
    page.evaluate(() => {
      const el = document.getElementById('target') as HTMLElement;
      const documentTop = (window as unknown as { __documentTop: (el: HTMLElement) => number })
        .__documentTop;

      return {
        measured: documentTop(el),
        truth: el.getBoundingClientRect().top + window.scrollY,
        // Sum of ancestors' border-top. Without the clientTop correction, the measurement would
        // fall short by exactly this much.
        borders: Array.from(document.querySelectorAll<HTMLElement>('.Frame, .Inner')).reduce(
          (sum, node) => sum + node.clientTop,
          0,
        ),
      };
    });
  const atTop = await measure();

  expect(atTop.borders).toBeGreaterThan(0);
  // atTop.measured (documentTop, an offsetTop chain) is always integer-valued, but
  // atTop.truth (getBoundingClientRect) can be fractional under subpixel layout. This fixture's
  // all-integer dimensions happen to make them agree exactly today, but that's incidental, so
  // this only asserts agreement to within offsetTop's own rounding (±0.5px).
  expect(atTop.measured).toBeCloseTo(atTop.truth, 0);

  // Being an absolute position, the value should stay the same even while scrolled
  // (this is why getBoundingClientRect isn't used)
  await page.evaluate(() => window.scrollTo(0, 400));

  const scrolled = await measure();

  // Both sides are documentTop's own (integer) output, so exact equality is appropriate here.
  expect(scrolled.measured).toBe(atTop.measured);
  expect(scrolled.measured).toBeCloseTo(scrolled.truth, 0);
});

// The above only proves stability against scroll position for position:relative ancestors; it
// doesn't touch position:sticky at all. This is the case ARCHITECTURE.md's "Two-pass position
// measurement" section is actually about: an ancestor that's *actively stuck* (not just carrying
// the sticky CSS, but currently pinned by the browser) does shift documentTop for its
// descendants. That's the real, correctness reason refresh() resets sticky before measuring
// (not just a performance nicety), since refresh() can run while the page is scrolled into an
// already-stuck earlier layer (e.g. a resize-triggered refresh mid-scroll).
test('documentTop is corrupted by an actively-stuck sticky ancestor (why pass 1 resets sticky before measuring)', async ({ page }) => {
  await page.goto('/fixtures/documentTop.html');

  const result = await page.evaluate(() => {
    const documentTop = (window as unknown as { __documentTop: (el: HTMLElement) => number })
      .__documentTop;

    // Mirrors this library's own Scene-layer shape: container > wrapper > (spacer, target),
    // with room after the wrapper for it to actually engage while scrolling.
    document.body.innerHTML = `
      <div style="height:1000px"></div>
      <div>
        <div id="wrapper">
          <div style="height:50px"></div>
          <div id="target" style="height:80px"></div>
        </div>
        <div style="height:2000px"></div>
      </div>
      <div style="height:1500px"></div>
    `;

    const target = document.getElementById('target') as HTMLElement;
    const wrapper = document.getElementById('wrapper') as HTMLElement;

    window.scrollTo(0, 0);

    const beforeSticky = documentTop(target);

    wrapper.style.position = 'sticky';
    wrapper.style.top = '0px';

    const stickyNotYetStuck = documentTop(target);

    window.scrollTo(0, 1400); // well past wrapper's natural position (1000px), so it's engaged

    return {
      beforeSticky,
      stickyNotYetStuck,
      stuck: documentTop(target),
      isActuallyStuck: target.getBoundingClientRect().top < 100,
    };
  });

  expect(result.isActuallyStuck).toBe(true); // sanity check the scenario actually engaged sticky
  // Merely carrying position:sticky (while not stuck) doesn't shift anything.
  expect(result.stickyNotYetStuck).toBe(result.beforeSticky);
  // But once genuinely stuck, the measurement shifts by the scrolled-past-engagement distance.
  expect(result.stuck).toBe(result.beforeSticky + 400);
});

// The corruption above cancels out for a Scene layer's own dwell computation (it's a difference
// of two documentTop calls sharing the same stuck ancestors), but createStickyPin's trigger and
// endTrigger aren't guaranteed to: both are allowed outside the shared container entirely. This
// exercises that gap through the real controller (not the low-level documentTop primitive):
// pinTrigger is nested inside a Scene layer, pinEndTrigger is outside it, so if refresh() runs
// while that Scene layer is stuck, an unfixed refreshPins would compute a wrong spacer height.
test('createStickyPin computes the same spacer height whether refresh() runs at scroll 0 or while an ancestor Scene layer is already stuck', async ({ page }) => {
  await page.goto('/fixtures/pinRefreshWhileStuck.html');

  type FixtureWindow = Window & {
    __refresh: () => void;
    __pinSpacerHeight: () => number;
    __sceneFreezeWindow: () => { start: number; end: number };
  };

  const evalRefresh = () => page.evaluate(() => (window as unknown as FixtureWindow).__refresh());
  const evalSpacerHeight = () =>
    page.evaluate(() => (window as unknown as FixtureWindow).__pinSpacerHeight());

  await evalRefresh();

  const baseline = await evalSpacerHeight();

  expect(baseline).toBeGreaterThan(0); // sanity check the pin actually computed some dwell

  // Scroll to the middle of the scene's own freeze window, guaranteed stuck, using the exact
  // same numbers this module hands GSAP, rather than guessing from rendered layout.
  const freezeWindow = await page.evaluate(() =>
    (window as unknown as FixtureWindow).__sceneFreezeWindow());

  expect(freezeWindow.end).toBeGreaterThan(freezeWindow.start); // sanity check the scene has dwell

  await page.evaluate(
    (mid) => window.scrollTo(0, mid),
    (freezeWindow.start + freezeWindow.end) / 2,
  );

  await evalRefresh();

  const whileStuck = await evalSpacerHeight();

  expect(whileStuck).toBe(baseline);
});

// resolveScrollPosition is meant to return a fixed absolute scroll position for a given
// element/clause, independent of when it's called. Once refresh() has applied a Scene
// wrapper's position:sticky CSS, the browser keeps engaging and disengaging it natively as
// scroll changes, with no further refresh() call involved (this test doesn't issue a second
// one). So calling resolveScrollPosition while an earlier Scene layer is actively stuck is a
// real scenario, not just a theoretical one. target is nested inside the scene's sticky
// wrapper (see "Two-pass position measurement"), so an unprotected documentTop(target) call
// would drift by however far scroll has advanced past the scene's engagement point.
test('resolveScrollPosition returns the same absolute position whether called at scroll 0 or while an ancestor Scene layer is already stuck', async ({ page }) => {
  await page.goto('/fixtures/resolveScrollPositionWhileStuck.html');

  type FixtureWindow = Window & {
    __resolveScrollPosition: (position: string) => number;
    __sceneFreezeWindow: () => { start: number; end: number };
  };

  const evalResolve = () =>
    page.evaluate(() => (window as unknown as FixtureWindow).__resolveScrollPosition('top top'));
  const baseline = await evalResolve();
  const freezeWindow = await page.evaluate(() =>
    (window as unknown as FixtureWindow).__sceneFreezeWindow());

  expect(freezeWindow.end).toBeGreaterThan(freezeWindow.start); // sanity check the scene has dwell

  // Scroll to the middle of the scene's own freeze window, guaranteed stuck, using the exact
  // same numbers this module hands GSAP, rather than guessing from rendered layout.
  await page.evaluate(
    (mid) => window.scrollTo(0, mid),
    (freezeWindow.start + freezeWindow.end) / 2,
  );

  const whileStuck = await evalResolve();

  expect(whileStuck).toBe(baseline);
});

// measureViewportHeight follows the same technique GSAP itself uses to dodge resizes caused
// by a mobile browser's address bar showing/hiding:
// "append a height:100vh div to body and read its offsetHeight."
// Headless Chromium can't reproduce a mobile browser's dynamic URL-bar resizing itself,
// so all that can be confirmed here is "the implementation isn't broken": it returns a value
// close to window.innerHeight under a normal viewport, and it leaves no measuring div behind.
test('measureViewportHeight returns a sane value in a real browser and leaves no measuring div behind', async ({ page }) => {
  await page.goto('/fixtures/documentTop.html');

  const result = await page.evaluate(() => {
    const measureViewportHeight = (window as unknown as { __measureViewportHeight: () => number })
      .__measureViewportHeight;
    const bodyChildrenBefore = document.body.children.length;
    const height = measureViewportHeight();

    return {
      height,
      innerHeight: window.innerHeight,
      bodyChildrenAfter: document.body.children.length,
      bodyChildrenBefore,
    };
  });

  // Both sides are already integers (offsetHeight/innerHeight are spec'd as such), but under
  // fractional device pixel ratios the two can independently round a fractional 100vh by ±1px,
  // so this allows that instead of requiring bit-for-bit equality.
  expect(Math.abs(result.height - result.innerHeight)).toBeLessThanOrEqual(1);
  expect(result.bodyChildrenAfter).toBe(result.bodyChildrenBefore); // no leftover measuring div
});

// measureDocumentMaxScroll backs the 'max' end keyword. document.documentElement.scrollHeight
// is always 0 in jsdom, same as documentTop/measureViewportHeight above, so only a real browser
// can confirm it actually matches "document height minus viewport height."
test('measureDocumentMaxScroll matches the real scroller\'s max scroll position', async ({ page }) => {
  await page.goto('/fixtures/documentTop.html');

  const result = await page.evaluate(() => {
    const measureDocumentMaxScroll = (
      window as unknown as { __measureDocumentMaxScroll: (viewportHeight: number) => number }
    ).__measureDocumentMaxScroll;
    const viewportHeight = window.innerHeight;

    return {
      measured: measureDocumentMaxScroll(viewportHeight),
      truth: document.documentElement.scrollHeight - viewportHeight,
    };
  });

  expect(result.measured).toBe(result.truth);
  expect(result.truth).toBeGreaterThan(0); // sanity check that the fixture actually scrolls
});

// createOverlapScroll's cover layer never creates its own dwell padding, but a preceding Scene
// layer's does. The document's true max scroll position is only known once that padding has
// actually been written to the DOM. This confirms refreshScenesAndCovers's two-pass
// documentMaxScroll re-measurement actually lands on the right number in a real browser: a bug
// here (e.g. forgetting the re-measure and only ever using the pass-1 placeholder of 0) would
// leave freezeEnd close to 0 instead of matching the real scroller max.
test('createOverlapScroll\'s end: \'max\' resolves to the real document max scroll position, accounting for a preceding Scene layer\'s dwell', async ({ page }) => {
  await page.goto('/fixtures/maxEnd.html');

  const result = await page.evaluate(() => {
    const coverFreezeEnd = (
      window as unknown as { __coverFreezeEnd: () => number }
    ).__coverFreezeEnd;
    const viewportHeight = window.innerHeight;

    return {
      freezeEnd: coverFreezeEnd(),
      truth: document.documentElement.scrollHeight - viewportHeight,
    };
  });

  expect(result.freezeEnd).toBe(result.truth);
});

test('resolveScrollPosition(el, \'max\') matches the document\'s real max scroll position', async ({ page }) => {
  await page.goto('/fixtures/maxEnd.html');

  const result = await page.evaluate(() => {
    const resolveScrollPosition = (
      window as unknown as {
        __resolveScrollPosition: (el: HTMLElement, position: string) => number;
      }
    ).__resolveScrollPosition;
    const cover = document.querySelector('.overlapScroll__cover') as HTMLElement;
    const viewportHeight = window.innerHeight;

    return {
      resolved: resolveScrollPosition(cover, 'max'),
      truth: document.documentElement.scrollHeight - viewportHeight,
    };
  });

  expect(result.resolved).toBe(result.truth);
});

// '+100%' (no '=') used to be treated as dwell (= one viewport height), but GSAP itself only
// treats a string starting with the literal '+=' as relative-to-start; anything else is a
// position clause resolved against endTrigger (here, trigger itself, since endTrigger defaults
// to it). All 3 scenes share the same (deliberately viewport-height-unequal) trigger height,
// so if '+100%' were still being treated as dwell, its window would match the '+=100%' scene's
// instead of its own trigger's height, and createStickyTrigger's own end/start defaults
// ('100% 0' / '0 0', matching GSAP's defaults for a pinned trigger) should produce that same
// trigger-height dwell without either being specified at all.
test('end: \'+100%\' (and createStickyTrigger\'s own end/start defaults) resolve against the trigger\'s own height, not the viewport', async ({ page }) => {
  await page.goto('/fixtures/endFormat.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as {
      __clauseWindow: () => { start: number; end: number };
      __dwellWindow: () => { start: number; end: number };
      __defaultWindow: () => { start: number; end: number };
      __viewportHeight: () => number;
    };
    const clause = win.__clauseWindow();
    const dwell = win.__dwellWindow();
    const defaultWindow = win.__defaultWindow();

    return {
      clauseDwell: clause.end - clause.start,
      dwellDwell: dwell.end - dwell.start,
      defaultDwell: defaultWindow.end - defaultWindow.start,
      triggerHeight: document.querySelector('.clauseScene')!.getBoundingClientRect().height,
      viewportHeight: win.__viewportHeight(),
    };
  });

  // sanity check they're distinguishable
  expect(result.triggerHeight).not.toBe(result.viewportHeight);
  expect(result.clauseDwell).toBeCloseTo(result.triggerHeight, 0);
  expect(result.dwellDwell).toBe(result.viewportHeight);
  // createStickyTrigger's own defaults ('100% 0' end, '0 0' start) match GSAP's own defaults for
  // a pinned trigger with end/start omitted, so this should behave the same as clauseVars (dwell
  // for the trigger's own height). A regression here wouldn't be caught by any test that always
  // passes end/start explicitly.
  expect(result.defaultDwell).toBeCloseTo(result.triggerHeight, 0);
});

// createStickyTrigger's default end ('100% 0') must resolve against an explicit, non-self
// endTrigger's own height, not the trigger's own height, matching GSAP's
// `parsedEndTrigger = vars.endTrigger || trigger`. .customEndTriggerScene (111px) sits directly
// before .customEndTrigger (555px) in DOM order, with no other scene between them, so the
// expected dwell reduces to a hand-checkable value: .customEndTriggerScene's own raw height
// (111px, the untouched gap between the two elements) plus .customEndTrigger's own height
// (555px) that the default end clause resolves against, 666px total, regardless of any dwell
// padding contributed by the other scenes earlier in the fixture.
test('createStickyTrigger\'s default end resolves against an explicit endTrigger\'s own height, not the trigger\'s own', async ({ page }) => {
  await page.goto('/fixtures/endFormat.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as {
      __customEndTriggerWindow: () => { start: number; end: number };
    };
    const customEndTrigger = win.__customEndTriggerWindow();

    return {
      customEndTriggerDwell: customEndTrigger.end - customEndTrigger.start,
      triggerHeight:
        document.querySelector('.customEndTriggerScene')!.getBoundingClientRect().height,
      endTriggerHeight:
        document.querySelector('.customEndTrigger')!.getBoundingClientRect().height,
    };
  });

  // sanity check they're distinguishable
  expect(result.triggerHeight).not.toBe(result.endTriggerHeight);
  expect(result.customEndTriggerDwell)
    .toBeCloseTo(result.triggerHeight + result.endTriggerHeight, 0);
});

// GSAP splits the two '+=' end forms at ScrollTrigger.js:1389: one holding a space is a position
// clause against endTrigger, which GSAP resolves after prefixing the start clause's element token
// onto it ('bottom' + '+=100 bottom'). The prefix is only visible in a real browser, since the
// whole difference it makes is that token's fraction of endTrigger's own height. With start
// 'bottom bottom' against a 444px endTrigger, both element sides resolve against that height and
// .spacedScene's own 222px cancels out of the dwell, leaving 444 + 100.
test('a spaced \'+=\' end resolves against endTrigger with the start clause\'s element token prefixed', async ({ page }) => {
  await page.goto('/fixtures/endFormat.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as {
      __spacedWindow: () => { start: number; end: number };
    };
    const spaced = win.__spacedWindow();

    return {
      spacedDwell: spaced.end - spaced.start,
      triggerHeight: document.querySelector('.spacedScene')!.getBoundingClientRect().height,
      endTriggerHeight:
        document.querySelector('.spacedEndTrigger')!.getBoundingClientRect().height,
    };
  });

  // sanity check they're distinguishable
  expect(result.triggerHeight).not.toBe(result.endTriggerHeight);
  expect(result.spacedDwell).toBeCloseTo(result.endTriggerHeight + 100, 0);
  // Without its element token, this end resolves to the bare 100px offset.
  expect(result.spacedDwell).not.toBeCloseTo(100, 0);
});

// createOverlapScroll's 'bottom bottom' is the one start default in this module whose element
// token isn't 'top'/'0', so it's the case that moves for a caller who never passed start.
test('createOverlapScroll\'s default start feeds a spaced \'+=\' end its own element token', async ({
  page,
}) => {
  await page.goto('/fixtures/spacedRelativeEndCover.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as {
      __spacedCoverWindows: () => {
        spaced: { start: number; end: number };
        explicit: { start: number; end: number };
      };
    };
    const windows = win.__spacedCoverWindows();

    return {
      spacedDwell: windows.spaced.end - windows.spaced.start,
      explicitDwell: windows.explicit.end - windows.explicit.start,
      viewportHeight: window.innerHeight,
      endTriggerHeight:
        document.querySelector('.endTrigger--spaced')!.getBoundingClientRect().height,
    };
  });

  // trigger's own 200px cancels out of the dwell, leaving the cover's own viewport height plus the
  // end clause's 444 + 100 against endTrigger.
  expect(result.spacedDwell)
    .toBeCloseTo(result.viewportHeight + result.endTriggerHeight + 100, 0);
  expect(result.spacedDwell).toBeCloseTo(result.explicitDwell, 0);
  // Strip the base and endTrigger's height drops out of the dwell entirely.
  expect(result.spacedDwell).not.toBeCloseTo(result.viewportHeight + 100, 0);
});

// createResolvedTrigger is the third path to the same prefix, and the one GSAP can't cover for
// itself: it hands GSAP a resolved number, so the end never reaches GSAP as a string.
test('createResolvedTrigger\'s spaced \'+=\' end lands where the clause it composes into does', async ({
  page,
}) => {
  await page.goto('/fixtures/endFormat.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as {
      __spacedResolvedEnds: () => { spaced: number; explicit: number; baseless: number };
    };

    return {
      ...win.__spacedResolvedEnds(),
      endTriggerHeight:
        document.querySelector('.spacedEndTrigger')!.getBoundingClientRect().height,
    };
  });

  expect(result.spaced).toBeCloseTo(result.explicit, 0);
  // The gap between the two forms is exactly the base: one full endTrigger height.
  expect(result.spaced - result.baseless).toBeCloseTo(result.endTriggerHeight, 0);
});

// The pin resolves its own end through resolvePinReleaseTop rather than resolveEndSpec, so this
// covers the same prefix on a separate path from the clause one above.
test('createStickyPin\'s spaced \'+=\' end takes the start clause\'s element token too', async ({
  page,
}) => {
  await page.goto('/fixtures/spacedRelativeEndPin.html');

  const layout = await page.evaluate(() => {
    const win = window as unknown as {
      __pinInnerHeight: () => number;
      __pinNaturalTop: () => number;
      __endTriggerTop: () => number;
    };

    return {
      innerHeight: win.__pinInnerHeight(),
      naturalTop: win.__pinNaturalTop(),
      endTriggerTop: win.__endTriggerTop(),
      viewportHeight: window.innerHeight,
      pinHeight: document.querySelector('.pin')!.getBoundingClientRect().height,
      endTriggerHeight: document.querySelector('.endTrigger')!.getBoundingClientRect().height,
    };
  });
  // top = viewportHeight/2 - pinHeight/2 from start 'center center'; the release point is where
  // endTrigger's own center, pushed 100px further, reaches the viewport's bottom edge. Then
  // height = releaseTop - naturalTop + top + pinHeight, as in the start-clause test above.
  const releaseTop
    = layout.endTriggerTop - layout.viewportHeight + layout.endTriggerHeight / 2 + 100;
  const expected
    = releaseTop - layout.naturalTop + layout.viewportHeight / 2 + layout.pinHeight / 2;

  expect(layout.innerHeight).toBeCloseTo(expected, 0);
  // A release point without endTrigger's half-height would make the pin range 200px shorter.
  expect(layout.innerHeight).not.toBeCloseTo(expected - layout.endTriggerHeight / 2, 0);
});

// GSAP's own _parsePosition treats a value as an absolute scroll position whenever it coerces
// cleanly to a number (a plain number, or a numeric-only string), matching that for `start` too
// (previously only `end` had an equivalent, intentionally different, dwell-distance exception).
test('createStickyTrigger\'s absolute start (a bare number) ignores the trigger\'s own natural position and any preceding dwell', async ({ page }) => {
  await page.goto('/fixtures/absolutePosition.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as {
      __gapWindow: () => { start: number; end: number };
      __absoluteStartWindow: () => { start: number; end: number };
    };

    return { gap: win.__gapWindow(), absolute: win.__absoluteStartWindow() };
  });

  // sanity check gapScene actually contributes real dwell padding ahead of it
  expect(result.gap.end - result.gap.start).toBe(500);
  expect(result.absolute.start).toBe(2500);
  expect(result.absolute.end - result.absolute.start).toBe(100); // '+=100' dwell, unaffected
});

// end used to treat a bare number as a dwell distance instead; it now matches GSAP's own
// "bare number = absolute scroll position" for end too, the same as start.
test('createStickyTrigger\'s absolute end (a bare number) ignores freezeStart and any preceding dwell', async ({ page }) => {
  await page.goto('/fixtures/absolutePosition.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as {
      __gapWindow: () => { start: number; end: number };
      __absoluteEndWindow: () => { start: number; end: number };
    };

    return { gap: win.__gapWindow(), absoluteEnd: win.__absoluteEndWindow() };
  });

  // sanity check gapScene actually contributes real dwell padding ahead of it
  expect(result.gap.end - result.gap.start).toBe(500);
  expect(result.absoluteEnd.end).toBe(5000);
});

test('createStickyPin\'s absolute end (a plain number) sizes the spacer from the trigger alone, ignoring endTrigger entirely', async ({ page }) => {
  await page.goto('/fixtures/absolutePosition.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as { __pinInnerHeight: () => number };
    const rect = document.querySelector('.pinTrigger')!.getBoundingClientRect();

    return {
      pinInnerHeight: win.__pinInnerHeight(),
      triggerTop: rect.top + window.scrollY,
      triggerHeight: rect.height,
    };
  });
  // height = end(3000) - triggerTop + top(0) + triggerHeight
  const expectedHeight = 3000 - result.triggerTop + result.triggerHeight;

  expect(result.pinInnerHeight).toBeCloseTo(expectedHeight, 0);
});

// Without the height outer reserves, the page would shorten by trigger's own height and
// everything below it would move up. jsdom reports every height as 0, so none of this can be
// checked in the unit tests.
test('registering a pin leaves the page the height and the layout it had without one', async ({
  page,
}) => {
  await page.goto('/fixtures/pinReservesSpace.html');

  type Snapshot = { afterTop: number; endTriggerTop: number; documentHeight: number };

  const measured = await page.evaluate(() => {
    const win = window as unknown as {
      __unregistered: () => Snapshot;
      __registered: () => Snapshot;
    };

    return { unregistered: win.__unregistered(), registered: win.__registered() };
  });

  // sanity check the fixture laid out as written: 400 lead + 20.25 + 200.5 pin + 20.25
  expect(measured.unregistered.afterTop).toBeCloseTo(641, 4);
  // Exact rather than approximate, since the reserved height has to carry the fractional part of
  // the margin box too: a rounded offsetHeight would put .after half a pixel lower. The pin range
  // inner holds also runs far past the document's end, so this covers contain:layout keeping that
  // overflow off the scrollable area.
  expect(measured.registered).toEqual(measured.unregistered);
});

// Omitting both leaves trigger resolving 'bottom top' against itself, which holds it for its own
// height, the duration GSAP's pin: true gives. A pinned element's rest position moves by exactly
// the distance it was held, so the two numbers below are the same measurement.
test('createStickyPin with no endTrigger and no end holds trigger for its own height', async ({
  page,
}) => {
  await page.goto('/fixtures/pinDefaults.html');

  const measured = await page.evaluate(() => {
    const win = window as unknown as {
      __documentTopAt: (selector: string, y: number) => number;
      __height: (selector: string) => number;
    };

    return {
      atRest: win.__documentTopAt('.selfPin', 0),
      // Past the release point (600) but short of the second pin's own engagement (1200).
      afterRelease: win.__documentTopAt('.selfPin', 900),
      height: win.__height('.selfPin'),
    };
  });

  expect(measured.atRest).toBeCloseTo(400, 0); // sanity check: the fixture's own lead
  expect(measured.height).toBeCloseTo(200, 0);
  expect(measured.afterRelease - measured.atRest).toBeCloseTo(measured.height, 0);
});

// The end default resolves against endTrigger's bottom edge, not its top, so naming an endTrigger
// and leaving end alone holds the pin for endTrigger's own height longer than 'top top' would.
test('createStickyPin\'s end default releases at endTrigger\'s bottom edge', async ({ page }) => {
  await page.goto('/fixtures/pinDefaults.html');

  const measured = await page.evaluate(() => {
    const win = window as unknown as {
      __documentTopAt: (selector: string, y: number) => number;
      __height: (selector: string) => number;
    };

    return {
      released: win.__documentTopAt('.refPin', 2400),
      endTriggerTop: win.__documentTopAt('.refEnd', 0),
      endTriggerHeight: win.__height('.refEnd'),
    };
  });

  expect(measured.endTriggerTop).toBeCloseTo(1800, 0); // sanity check: 400 + 200 + 600 + 100 + 500
  // 'top top' would have released it at 1800, the endTrigger's own top edge.
  expect(measured.released).toBeCloseTo(measured.endTriggerTop + measured.endTriggerHeight, 0);
});

// jsdom reports every position as 0, so the unit tests can check the distance but not that the
// named endTrigger (1500 in this fixture) was passed over, which is how GSAP reads a dwell too.
test('createStickyPin\'s dwell end holds for its distance and ignores endTrigger', async ({
  page,
}) => {
  await page.goto('/fixtures/pinDwellEnd.html');

  const measured = await page.evaluate(() => {
    const win = window as unknown as {
      __documentTopAt: (selector: string, y: number) => number;
    };

    return {
      atRest: win.__documentTopAt('.pin', 0),
      endTriggerTop: win.__documentTopAt('.endTrigger', 0),
      // Well past both the dwell's release point and the endTrigger a clause end would have used.
      afterRelease: win.__documentTopAt('.pin', 2200),
    };
  });

  expect(measured.atRest).toBeCloseTo(400, 0); // sanity check: the fixture's own lead
  expect(measured.endTriggerTop).toBeCloseTo(1500, 0); // 400 + 200 + 900
  // A pinned element's rest position moves by exactly the distance it was held, so this is the
  // '+=500' itself. Resolved against the endTrigger it would have been 1100.
  expect(measured.afterRelease - measured.atRest).toBeCloseTo(500, 0);
});

// The unit tests see only the spacer height this writes, not how long the browser then holds. The
// top offset moves where the pin engages without lengthening that hold.
test('createStickyPin\'s dwell end holds for its distance under a top offset', async ({ page }) => {
  await page.goto('/fixtures/pinDwellEnd.html');

  const measured = await page.evaluate(() => {
    const win = window as unknown as {
      __documentTopAt: (selector: string, y: number) => number;
      __viewportTopAt: (selector: string, y: number) => number;
    };

    return {
      atRest: win.__documentTopAt('.offsetPin', 0),
      // Between the engagement point (1510 - 30) and the release (that plus 400).
      heldTop: win.__viewportTopAt('.offsetPin', 1700),
      afterRelease: win.__documentTopAt('.offsetPin', 2200),
    };
  });

  expect(measured.atRest).toBeCloseTo(1510, 0); // 400 + 200 + 900 + 10
  expect(measured.heldTop).toBeCloseTo(30, 0); // the top option really applied
  // 400 rather than 430: the offset moved where the pin engaged, not how long it held.
  expect(measured.afterRelease - measured.atRest).toBeCloseTo(400, 0);
});

// The reserved height doesn't cover trigger's own margin. That has to collapse through inner and
// stop at outer, or the pin would rest 20px below the position its start clause names.
test('a pinned trigger with vertical margins rests at exactly the top its start names', async ({
  page,
}) => {
  await page.goto('/fixtures/pinReservesSpace.html');

  const heldTop = await page.evaluate(() =>
    (window as unknown as { __pinTopAt: (y: number) => number }).__pinTopAt(600),
  );

  expect(heldTop).toBeCloseTo(0, 0);
});

// The element side of createStickyPin's start clause resolves against trigger's own height:
// 'bottom bottom' has to become a sticky top of viewportHeight - 60, a number the clause never
// states. jsdom reports every height as 0, so that term only shows up in a real browser.
test('createStickyPin\'s start clause pins trigger by its own bottom edge, and releases at endTrigger', async ({
  page,
}) => {
  await page.goto('/fixtures/pinStartClause.html');

  const layout = await page.evaluate(() => {
    const win = window as unknown as {
      __pinInnerHeight: () => number;
      __pinNaturalTop: () => number;
      __endTriggerTop: () => number;
    };

    return {
      innerHeight: win.__pinInnerHeight(),
      naturalTop: win.__pinNaturalTop(),
      releaseTop: win.__endTriggerTop(),
      viewportHeight: window.innerHeight,
      pinHeight: document.querySelector('.pin')!.getBoundingClientRect().height,
    };
  });

  // height = releaseTop - triggerTop + top + triggerHeight, with top = viewportHeight - 60.
  expect(layout.pinHeight).toBeCloseTo(60, 0);
  expect(layout.innerHeight).toBeCloseTo(
    layout.releaseTop - layout.naturalTop + layout.viewportHeight,
    0,
  );

  const heldBottom = await page.evaluate((y) => {
    window.scrollTo(0, y);

    return document.querySelector('.pin')!.getBoundingClientRect().bottom;
  }, layout.releaseTop - 300);

  // Pinned by its bottom edge: it rests against the viewport's bottom, not its top.
  expect(heldBottom).toBeCloseTo(layout.viewportHeight, 0);

  const releasedBottom = await page.evaluate((y) => {
    window.scrollTo(0, y);

    return document.querySelector('.pin')!.getBoundingClientRect().bottom;
  }, layout.releaseTop + 200);

  // Past the release point it scrolls away with the page, 1:1 with the extra 200px.
  expect(releasedBottom).toBeCloseTo(layout.viewportHeight - 200, 0);
});

test('resolveScrollPosition returns an absolute value (string or number) as-is, regardless of element', async ({ page }) => {
  await page.goto('/fixtures/absolutePosition.html');

  const result = await page.evaluate(() => {
    const win = window as unknown as {
      __resolveScrollPosition: (el: HTMLElement, position: string | number) => number;
    };
    const el = document.querySelector('.absoluteStartScene') as HTMLElement;

    return {
      fromString: win.__resolveScrollPosition(el, '1234'),
      fromNumber: win.__resolveScrollPosition(el, 1234),
    };
  });

  expect(result.fromString).toBe(1234);
  expect(result.fromNumber).toBe(1234);
});

// The return shape of batchKill.html's run(), exposed as window.__runBatchKillAll/
// __runBatchKillPartial. survivorAfter is null for the all-killed case (s3 is killed too, so
// there's no survivor to snapshot); the partial-kill tests below rely on it being present.
interface BatchKillResult {
  rootMoveCount: number;
  killedCount: number;
  survivorBefore: { module: number[]; gsap: number[] };
  survivorAfter: { module: number[]; gsap: number[] } | null;
}

// Reproduces a scenario where N triggers get killed synchronously within the same task
// (e.g. gsap.matchMedia() teardown).
// Moving the subtree containing rootElement causes iframes to reload and focus to be lost,
// so this is coalesced into a single microtask.
// This confirms that root movement remains a single operation with a real browser and real GSAP.
test('killing every trigger within the same task still moves rootElement only once', async ({ page }) => {
  await page.goto('/fixtures/batchKill.html');

  const result = await page.evaluate(() =>
    (window as unknown as { __runBatchKillAll: () => Promise<BatchKillResult> })
      .__runBatchKillAll(),
  );

  expect(result.killedCount).toBe(3);
  expect(result.rootMoveCount).toBe(1);
});

// Since s3 survives, build() has to re-wrap the root that unbuild() returned to host
// in s3's wrapper again, meaning "a single rebuild cycle" itself takes 2 root moves
// (out to host, then wrapped again).
// So if batching is working, however many kills happen,
// this should cap out at those same 2 moves (a naive implementation would move root once
// per kill's own cycle of 2, so 2 kills would move root 4 times).
test('killing only some triggers within the same task still caps root movement at "one cycle\'s worth"', async ({
  page,
}) => {
  await page.goto('/fixtures/batchKill.html');

  const result = await page.evaluate(() =>
    (window as unknown as { __runBatchKillPartial: () => Promise<BatchKillResult> })
      .__runBatchKillPartial(),
  );

  expect(result.killedCount).toBe(2);
  expect(result.rootMoveCount).toBe(2);
});

// Killing s1 and s2 shrinks the survivor s3's freeze window (since precedingGaps decreases).
// Only once both the internal freezeStart/freezeEnd and GSAP's own cached start/end agree
// does the scroll position stay in sync with animation progress after a kill.
// This confirms the wiring that calls GSAP's static refresh via self.constructor
// (see index.ts's scheduleRebuild) also works with real GSAP.
test('the surviving layer\'s freeze window, shifted by a kill, is tracked by GSAP\'s own cache too', async ({ page }) => {
  await page.goto('/fixtures/batchKill.html');

  const result = await page.evaluate(() =>
    (window as unknown as { __runBatchKillPartial: () => Promise<BatchKillResult> })
      .__runBatchKillPartial(),
  );

  // the surviving layer's freeze window itself should have changed after the kill (otherwise
  // this test is meaningless)
  expect(result.survivorAfter!.module).not.toEqual(result.survivorBefore.module);
  // GSAP's side matches the module's internal value too (not stuck on a stale cache)
  expect(result.survivorAfter!.gsap).toEqual(result.survivorAfter!.module);
});

test('scene1 gets pinned by native sticky while scrolling, and --progress advances from 0 to 1', async ({
  page,
}) => {
  await page.goto('/fixtures/scenario.html');

  const scene = page.locator('.scene--1');

  await expect(scene).toHaveCount(1);
  await expect.poll(() => readProgress(scene)).toBeCloseTo(0, 2);

  await scene.scrollIntoViewIfNeeded();

  let progress = 0;
  let sawSticky = false;

  for (let i = 0; i < 80 && progress < 0.99; i += 1) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(20);
    progress = await readProgress(scene);

    if (!sawSticky && progress > 0.05 && progress < 0.95) {
      sawSticky = await hasStickyAncestor(scene);
    }
  }

  expect(progress).toBeGreaterThan(0.9);
  expect(sawSticky).toBe(true);
});

test('overlapScroll__trigger and overlapScroll__cover overlap via the overlap-scroll effect', async ({ page }) => {
  await page.goto('/fixtures/scenario.html');

  const trigger = page.locator('.overlapScroll__trigger').first();
  const cover = page.locator('.overlapScroll__cover').first();

  await trigger.scrollIntoViewIfNeeded();

  let overlapped = false;

  for (let i = 0; i < 80 && !overlapped; i += 1) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(20);

    const [triggerBox, coverBox] = await Promise.all([trigger.boundingBox(), cover.boundingBox()]);

    if (triggerBox && coverBox) {
      overlapped = coverBox.y < triggerBox.y + triggerBox.height;
    }
  }

  expect(overlapped).toBe(true);
});

// .plainSection--fade is a plain GSAP ScrollTrigger effect that uses neither createStickyTrigger
// nor createOverlapScroll.
// Since it sits inside the sticky nesting (within .container__inner),
// its on-screen movement lags behind actual scroll distance by exactly the combined dwell
// of the Scene layers above it.
// main.ts uses start/end corrected for that lag via resolveScrollPosition();
// without the correction, the fade's trigger position would be off by hundreds to thousands
// of px, making the element jump instantly.

test('.plainSection--fade\'s fade stays in sync with the element becoming visible', async ({ page }) => {
  await page.goto('/fixtures/scenario.html');

  const box = page.locator('.plainSection--fade .plainSection__box');
  const viewportHeight = page.viewportSize()?.height ?? 720;
  // scrollIntoViewIfNeeded lands unpredictably when the element's height exceeds the viewport,
  // so this steps directly through scrollTo() across a range guaranteed
  // to cross the trigger position, anchored to the static position at scroll=0.
  const staticTop = await page.evaluate(() => {
    window.scrollTo(0, 0);

    return document.querySelector('.plainSection--fade .plainSection__box')!.getBoundingClientRect()
      .top;
  });
  let topWhenHalfVisible: number | null = null;
  const start = Math.max(0, Math.round(staticTop) - 200);

  for (let y = start; y <= start + 2500 && topWhenHalfVisible === null; y += 60) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(20);

    const opacity = await box.evaluate((el) => parseFloat(getComputedStyle(el).opacity));

    if (opacity > 0.5) {
      topWhenHalfVisible = (await box.boundingBox())?.y ?? null;
    }
  }

  expect(topWhenHalfVisible).not.toBeNull();
  // Without the correction, opacity would reach 1 while the element is still off-screen
  // (top > viewportHeight), so the fade would already look finished by the time it enters view.
  expect(topWhenHalfVisible as number).toBeLessThan(viewportHeight);
});

// .partialSticky__pin is plain position:sticky, using neither JS nor GSAP.
// It sits inside the sticky nesting (within .container__inner), but plain sticky's own rule
// still applies unmodified regardless of the ancestor nesting structure: it pins only within the
// bounds of the block wrapping it (the pin's inner, stretched to the pin range inside a
// contain:layout outer that keeps the flow at the pin's own margin box). So this library needs no
// correction at all here.
// It keeps pinning across not just partialSticky__content
// but the following 2 sections too (filler and block--outro).
test('.partialSticky__pin stays sticky across multiple sections and later releases', async ({ page }) => {
  await page.goto('/fixtures/scenario.html');

  // Since it sits inside the sticky nesting, this element's "static" position and the position
  // actually reached by scrolling don't match (they differ by the ancestors' dwell).
  // This converges on the correct scroll position by measuring iteratively.
  let y = await page.evaluate(() => {
    window.scrollTo(0, 0);

    return document.querySelector('.partialSticky')!.getBoundingClientRect().top;
  });

  for (let i = 0; i < 60; i += 1) {
    const top = await page.evaluate((yy) => {
      window.scrollTo(0, yy);

      return document.querySelector('.partialSticky')!.getBoundingClientRect().top;
    }, y);

    if (Math.abs(top) < 5) break;

    y += top;
  }

  const label = page.locator('.partialSticky__pin');
  let previousTop: number | null = null;
  let maxJump = 0;
  let sawHeld = false;
  let sawReleasedAfterHeld = false;
  const start = Math.max(0, Math.round(y) - 200);

  for (let yy = start; yy <= start + 3500 && !sawReleasedAfterHeld; yy += 40) {
    await page.evaluate((v) => window.scrollTo(0, v), yy);
    await page.waitForTimeout(15);

    const box = await label.boundingBox();

    if (!box) continue;

    if (previousTop !== null) {
      const delta = Math.abs(box.y - previousTop);

      maxJump = Math.max(maxJump, delta);

      if (delta < 3) sawHeld = true;

      if (sawHeld && delta > 20) sawReleasedAfterHeld = true;
    }

    previousTop = box.y;
  }

  expect(sawHeld).toBe(true);
  expect(sawReleasedAfterHeld).toBe(true);
  // Since scrolling advances 40px at a time,
  // the delta outside the held/released sections should stay close to that too.
  expect(maxJump).toBeLessThan(80);
});

// .spanScenePin__pin is placed with scene 3 (a layer that stretches the document
// via createStickyTrigger's dwell) sitting between trigger and endTrigger,
// a regression test for using a scene layer between a pin's trigger and endTrigger.
// index.ts calls refreshPins() after refreshScenesAndCovers inside refresh()
// for exactly this reason.
// This confirms the label's pin never releases before scene 3's --progress reaches 1.
test('.spanScenePin__pin stays pinned until scene 3\'s dwell is fully consumed', async ({ page }) => {
  await page.goto('/fixtures/scenario.html');

  let y = await page.evaluate(() => {
    window.scrollTo(0, 0);

    return document.querySelector('.spanScenePin')!.getBoundingClientRect().top;
  });

  for (let i = 0; i < 60; i += 1) {
    const top = await page.evaluate((yy) => {
      window.scrollTo(0, yy);

      return document.querySelector('.spanScenePin')!.getBoundingClientRect().top;
    }, y);

    if (Math.abs(top) < 5) break;

    y += top;
  }

  const label = page.locator('.spanScenePin__pin');
  const scene3 = page.locator('.scene--3');
  let previousTop: number | null = null;
  let sawHeld = false;
  let sawReleasedAfterHeld = false;
  let releasedWhileScene3Mid = false;
  const start = Math.max(0, Math.round(y) - 200);

  for (let yy = start; yy <= start + 4000 && !sawReleasedAfterHeld; yy += 40) {
    await page.evaluate((v) => window.scrollTo(0, v), yy);
    await page.waitForTimeout(15);

    const box = await label.boundingBox();

    if (!box) continue;

    if (previousTop !== null) {
      const delta = Math.abs(box.y - previousTop);

      if (delta < 3) sawHeld = true;

      if (sawHeld && delta > 20) {
        sawReleasedAfterHeld = true;

        if ((await readProgress(scene3)) < 0.95) releasedWhileScene3Mid = true;
      }
    }

    previousTop = box.y;
  }

  expect(sawHeld).toBe(true);
  expect(sawReleasedAfterHeld).toBe(true);
  expect(releasedWhileScene3Mid).toBe(false);
});

// refresh() is meant to be idempotent no matter how many times it runs (see index.ts's
// createAutoRefreshHandler). This fixture registers a pin right before a Scene layer in DOM
// order and calls refresh() exactly once, unlike scenario.html/demo which call it repeatedly
// during setup and so would never expose a bug confined to the very first call.
test('a Scene layer after a not-yet-wrapped pin gets a stable freeze window on the first refresh()', async ({
  page,
}) => {
  await page.goto('/fixtures/pinBeforeScene.html');

  const readSceneFreezeWindow = () =>
    page.evaluate(() =>
      (window as unknown as { __sceneFreezeWindow: () => { start: number; end: number } })
        .__sceneFreezeWindow(),
    );
  const afterFirstRefresh = await readSceneFreezeWindow();

  await page.evaluate(() => (window as unknown as { __refreshAgain: () => void }).__refreshAgain());

  const afterSecondRefresh = await readSceneFreezeWindow();

  expect(afterFirstRefresh).toEqual(afterSecondRefresh);
});

// A pin's kill restores the margin collapsing its wrappers blocked, moving the layers below it,
// and jsdom has no layout to move, so the unit tests can only check that the re-measure is
// scheduled. This checks the 40px.
test('killing a pin moves the freeze window of the Scene layer below it, in the module and in GSAP', async ({
  page,
}) => {
  await page.goto('/fixtures/pinKillRemeasure.html');

  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __runPinKill: () => Promise<{
          before: { module: number; gsap: number };
          after: { module: number; gsap: number };
        }>;
      }
    ).__runPinKill(),
  );

  // 100 lead + 60 margin + 40 margin + 300 pin, with the two margins kept apart by the wrappers
  expect(result.before.module).toBe(500);
  // unwrapped they collapse into one 60px gap, so .scene starts 40px earlier
  expect(result.after.module).toBe(460);
  // GSAP's cached start tracks it, rather than staying on the pre-kill measurement
  expect(result.after.gsap).toBe(result.after.module);
});

// scenario.html no longer manually binds refreshInit (see the earlier commit removing it), relying
// solely on this module's own onRefreshInit auto-binding (createAutoRefreshHandler). That binding
// has to run before GSAP recomputes each trigger's start/end during a resize-triggered refresh;
// otherwise the freeze window would be computed from the filler's old height. This confirms the
// ordering holds for a real window resize, not just the explicit refresh() call at setup.
test('a real window resize re-runs refresh() before GSAP recomputes trigger positions', async ({ page }) => {
  await page.goto('/fixtures/resizeRefreshOrdering.html');

  const readStart = () =>
    page.evaluate(() => (window as unknown as { __sceneStart: () => number }).__sceneStart());
  const before = await readStart();

  expect(before).toBe(10); // sanity check: matches the filler's starting height

  await page.evaluate(() => (window as unknown as { __growFiller: () => void }).__growFiller());

  const viewport = page.viewportSize()!;

  await page.setViewportSize({ width: viewport.width, height: viewport.height - 10 });
  await page.waitForTimeout(500); // GSAP debounces its own resize handling by 0.2s

  const after = await readStart();

  expect(after - before).toBe(490); // filler grew from 10px to 500px
});

// The scenario-style fixtures all give the cover explicit position/z-index CSS and never call
// destroy(), so liftAboveStickyWrapper's "only fill in what the author left static/auto" branch
// runs in a real browser only here and in strictCsp.html below. destroyRestoresLayout.html's cover
// has no such CSS, so this exercises both that branch and destroy()'s restore/unbuild together.
test('destroy() restores the cover\'s lifted position/z-index and unwinds the DOM', async ({ page }) => {
  await page.goto('/fixtures/destroyRestoresLayout.html');

  const readCoverStyle = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          __coverComputedStyle: () => { position: string; zIndex: string };
        }
      ).__coverComputedStyle(),
    );
  const triggerIsDirectRootChild = () =>
    page.evaluate(() =>
      (window as unknown as { __triggerIsDirectRootChild: () => boolean })
        .__triggerIsDirectRootChild(),
    );
  const styleWhileBuilt = await readCoverStyle();

  expect(styleWhileBuilt.position).toBe('relative');
  expect(styleWhileBuilt.zIndex).toBe('1');
  expect(await triggerIsDirectRootChild()).toBe(false);

  await page.evaluate(() => (window as unknown as { __destroy: () => void }).__destroy());

  const styleAfterDestroy = await readCoverStyle();

  expect(styleAfterDestroy.position).toBe('static');
  expect(styleAfterDestroy.zIndex).toBe('auto');
  expect(await triggerIsDirectRootChild()).toBe(true);
});

// Everything this module adds to a page goes in through CSSOM: inline writes for the cover lift,
// a constructed stylesheet for the scroll-margin ramps. A Content Security Policy's style-src
// governs neither, so a page with a strict policy needs no exception. The fixture carries a <style>
// element of its own as the control: it stays inert under this policy, so the module's own results
// are evidence about CSSOM rather than about the policy.
interface CspReport {
  cover: { position: string; zIndex: string };
  probePosition: string;
  moduleSheetCount: number;
  rampProperty: string;
  scrollMarginTop: string;
}

test('both halves still work under a style-src policy without \'unsafe-inline\'', async ({ page }) => {
  await page.goto('/fixtures/strictCsp.html');

  const read = () =>
    page.evaluate(() => (window as unknown as { __report: () => CspReport }).__report());
  const report = await read();
  const usesCssRamp = await page.evaluate(() =>
    (window as never as { __scrollDrivenAnimationsSupported: () => boolean })
      .__scrollDrivenAnimationsSupported());

  expect(report.probePosition).toBe('static');
  expect(report.cover).toEqual({ position: 'relative', zIndex: '1' });
  expect(report.scrollMarginTop).not.toBe('');
  // No scroll timelines, no stylesheet: the ramps come from the scroll listener instead.
  expect(report.moduleSheetCount).toBe(usesCssRamp ? 1 : 0);
  expect(report.rampProperty.trim()).toBe('0px');

  // Scrolling into the scene's freeze window (0..800, the scene being at the top of the document)
  // advances the ramp. On the CSS path nothing else could have moved it: that path registers no
  // scroll listener, so a value here is the adopted stylesheet's animation actually running.
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const midDwell = await read();

  expect(parseFloat(midDwell.rampProperty)).toBeCloseTo(400, 0);

  await page.evaluate(() => window.scrollTo(0, 0));

  await page.evaluate(() => (window as unknown as { __destroy: () => void }).__destroy());

  const afterDestroy = await read();

  expect(afterDestroy.cover).toEqual({ position: 'static', zIndex: 'auto' });
  expect(afterDestroy.moduleSheetCount).toBe(0);
  expect(afterDestroy.scrollMarginTop).toBe('');
});

// scroll-margin-top synchronization (see src/scrollMargin.ts). Nested sticky decouples an
// element's document position from the scroll position at which it reaches the viewport top, so
// the browser's own one-shot scroll-into-view calculation lands short. refresh() declares that
// difference through scroll-margin-top instead of asking the caller to intercept anything. None
// of this can be checked without layout, so it lives here rather than in index.test.ts.

// Scans for the scroll position at which an element's top edge first reaches the viewport top.
// Sticky makes the painted position a non-linear function of scroll, so this is walked rather
// than derived.
const findArrivalScroll = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((elementId) => {
    const el = document.getElementById(elementId) as HTMLElement;
    const max = document.documentElement.scrollHeight - window.innerHeight;

    for (let scroll = 0; scroll <= max; scroll += 1) {
      window.scrollTo(0, scroll);

      if (el.getBoundingClientRect().top <= 0) return scroll;
    }

    return null;
  }, id);

// Performs one native jump and reports where it landed. `how` covers both routes into the same
// CSSOM View algorithm: a real fragment navigation, and a direct scrollIntoView call.
// The scroll-driven ramps that carry the scroll-dependent half of the correction are advanced by
// the browser, not by this module, so a frame has to pass after moving the scroll position before
// the jump reads them; otherwise it would aim using the previous position's value.
const jumpTo = async (
  page: import('@playwright/test').Page,
  id: string,
  from: number,
  how: 'anchorClick' | 'scrollIntoView',
) => {
  const nextFrame = () =>
    page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  await page.evaluate(() => {
    history.replaceState(null, '', location.pathname + location.search);
  });
  await page.evaluate((scroll) => window.scrollTo(0, scroll), from);
  await nextFrame();

  if (how === 'anchorClick') await page.click(`#link-${id}`);
  else await page.evaluate((elementId) => document.getElementById(elementId)?.scrollIntoView(), id);

  await nextFrame();

  return page.evaluate((elementId) => ({
    scroll: Math.round(window.scrollY),
    rectTop: Math.round(
      (document.getElementById(elementId) as HTMLElement).getBoundingClientRect().top,
    ),
  }), id);
};

test('a native same-page anchor lands exactly on target, from any starting scroll position', async ({
  page,
}) => {
  // Runs on every engine unconditionally: the scroll-dependent half of the correction rides a CSS
  // scroll-driven animation where supported, and an equivalent `scroll` listener where it isn't
  // (Firefox, as of this writing); see scrollMargin.ts's module doc comment. Both are expected
  // to be exact from any starting position, not just from above the freeze windows.
  await page.goto('/fixtures/scrollMargin.html');

  for (const id of ['beforeScene1', 'afterScene1', 'afterScene2']) {
    const arrival = await findArrivalScroll(page, id);

    for (const how of ['anchorClick', 'scrollIntoView'] as const) {
      for (const from of [0, 700, 1400, 2600, 3500]) {
        const landed = await jumpTo(page, id, from, how);

        expect(
          landed,
          `#${id} via ${how} from ${from}`,
        ).toEqual({ scroll: arrival, rectTop: 0 });
      }
    }
  }
});

// Without the correction the same jumps land short by every preceding layer's dwell, which is
// what makes the numbers above meaningful rather than trivially true.
test('the same anchors land short of their target when the correction is opted out of', async ({
  page,
}) => {
  await page.goto('/fixtures/scrollMargin.html?scrollMarginTargets=none');

  expect(
    await page.evaluate(() =>
      (window as never as { __inlineScrollMarginTop: (id: string) => string })
        .__inlineScrollMarginTop('afterScene1'),
    ),
  ).toBe('');

  const arrival = await findArrivalScroll(page, 'afterScene1');
  const landed = await jumpTo(page, 'afterScene1', 0, 'anchorClick');

  // Exactly one preceding layer's dwell short, leaving the target still below the viewport top.
  expect(landed.scroll).toBe((arrival ?? 0) - 800);
  expect(landed.rectTop).toBeGreaterThan(0);
});

// An author's own scroll-margin-top (a fixed-header offset, typically) has to keep applying: the
// correction is added to it, not written over it.
test('an author\'s own scroll-margin-top still applies on top of the correction', async ({
  page,
}) => {
  await page.goto('/fixtures/scrollMargin.html');

  const arrival = await findArrivalScroll(page, 'withAuthorMargin');
  const landed = await jumpTo(page, 'withAuthorMargin', 0, 'anchorClick');

  // 40px of author margin means stopping 40px earlier, leaving the element 40px below the top.
  expect(landed.scroll).toBe((arrival ?? 0) - 40);
  expect(landed.rectTop).toBe(40);
});

// The emitted rules themselves, checked against the same freeze window the fixture reports. jsdom
// never reaches this path, reporting no scroll-timeline support, so it never sees a stylesheet to
// check.
test('the adopted stylesheet ramps one custom property across each layer\'s own freeze window', async ({
  page,
}) => {
  await page.goto('/fixtures/scrollMargin.html');

  const usesCssRamp = await page.evaluate(() =>
    (window as never as { __scrollDrivenAnimationsSupported: () => boolean })
      .__scrollDrivenAnimationsSupported());

  test.skip(!usesCssRamp, 'only meaningful where the ramps are driven by CSS');

  const scene1 = await page.evaluate(() =>
    (window as never as { __scene1FreezeWindow: () => { start: number; end: number } })
      .__scene1FreezeWindow());
  const css = await page.evaluate(() =>
    (window as never as { __moduleSheetText: () => string }).__moduleSheetText());

  // Read back through the CSSOM, so these are the engine's own serializations rather than the
  // strings the module wrote: the block axis is dropped as the default, and the `animation`
  // shorthand comes back as longhands.
  expect(css).toMatch(/animation-timeline:\s*scroll\(root/);
  expect(css).toContain(`${scene1.start}px ${scene1.end}px`); // scene1's slice of animation-range
  // Two Scene layers, so two ramped properties, each with its own registration and keyframes.
  expect(css).toContain('@property --sst0-c0');
  expect(css).toContain('@property --sst0-c1');
  expect(css).toMatch(new RegExp(`--sst0-c0:\\s*${scene1.end - scene1.start}px`));
});

test('destroy() hands scroll-margin-top back and removes the injected stylesheet', async ({
  page,
}) => {
  await page.goto('/fixtures/scrollMargin.html');

  expect(
    await page.evaluate(() =>
      (window as never as { __inlineScrollMarginTop: (id: string) => string })
        .__inlineScrollMarginTop('afterScene1'),
    ),
  ).not.toBe('');

  const sheetsBefore = await page.evaluate(() =>
    (window as never as { __moduleSheetCount: () => number }).__moduleSheetCount());
  const usesCssRamp = await page.evaluate(() =>
    (window as never as { __scrollDrivenAnimationsSupported: () => boolean })
      .__scrollDrivenAnimationsSupported());

  // Without scroll timelines the ramps are driven by the scroll listener instead, and no
  // stylesheet is built at all.
  expect(sheetsBefore).toBe(usesCssRamp ? 1 : 0);

  await page.evaluate(() => (window as never as { __destroy: () => void }).__destroy());

  expect(
    await page.evaluate(() =>
      (window as never as { __inlineScrollMarginTop: (id: string) => string })
        .__inlineScrollMarginTop('afterScene1'),
    ),
  ).toBe('');
  // The author's own value survives the round trip untouched.
  expect(
    await page.evaluate(() =>
      (window as never as { __computedScrollMarginTop: (id: string) => string })
        .__computedScrollMarginTop('withAuthorMargin'),
    ),
  ).toBe('40px');
  expect(
    await page.evaluate(() =>
      (window as never as { __moduleSheetCount: () => number }).__moduleSheetCount()),
  ).toBe(0);
});

// Regression test for a real bug in this module's stylesheet: on a browser that doesn't
// support `animation-timeline: scroll(...)` (Firefox, as of this writing), that whole
// declaration is dropped as invalid, leaving `animation-timeline` at its initial value `auto`.
// Under `auto`, the `animation` shorthand this module also writes is an ordinary time-based
// animation with no explicit duration, i.e. 0s, and a 0-duration animation with fill-mode
// `both` still runs, instantly: every custom property jumped straight to its keyframe's `to`
// value (the layer's full dwell) the moment the page loaded, rather than staying at 0px the way
// an unset var() should. scrollMargin.ts now gates the whole animation rule behind
// `@supports (animation-timeline: scroll())`, so an unsupporting browser never runs it at all:
// every var() genuinely falls back to 0px, and a `scroll` listener (verified elsewhere by the
// "lands exactly" test above, which now runs unconditionally) supplies the same values instead.
// This only reproduces on an engine that lacks the feature, so it's meaningless to run on
// Chromium/WebKit (where it would pass either way).
test('an engine without animation-timeline: scroll() never runs the animation shorthand at all', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'firefox', 'only meaningful without animation-timeline: scroll() support');

  await page.goto('/fixtures/scrollMargin.html');

  expect(
    await page.evaluate(() =>
      (window as never as { __scrollDrivenAnimationsSupported: () => boolean })
        .__scrollDrivenAnimationsSupported(),
    ),
  ).toBe(false);

  // What keeps the bug this test is named for out of reach: an engine that can't parse the
  // declaration never receives the stylesheet at all, so the animation it would have mangled is
  // never emitted. buildStylesheet's @supports gate still wraps the rule, as a second line for a
  // CSS.supports() that disagrees with the parser, but nothing here depends on it.
  expect(
    await page.evaluate(() =>
      (window as never as { __moduleSheetCount: () => number }).__moduleSheetCount()),
  ).toBe(0);

  // At load, before any 'scroll' event has fired, every consumed-dwell custom property must
  // already read back as 0px (the correct value at scroll 0, and what the named bug got wrong by
  // jumping straight to the layer's full dwell).
  const ramps = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('afterScene1') as HTMLElement);

    return [0, 1].map((i) => cs.getPropertyValue(`--sst0-c${i}`).trim());
  });

  expect(ramps.every((value) => value === '' || value === '0px')).toBe(true);
});

// Firefox never runs the CSS animation (see the test above), so the only thing keeping its
// consumed-dwell custom properties current is the `scroll` listener scrollMarginTop.ts installs
// in that case. This checks that listener actually tracks a scroll position mid-freeze-window,
// not just the load-time (scroll 0) case every test above happens to also cover.
test('the scroll listener fallback tracks a mid-freeze-window scroll position, not just scroll 0', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'firefox', 'only meaningful without animation-timeline: scroll() support');

  await page.goto('/fixtures/scrollMargin.html');

  // The fixture hands over scene1's own freeze window (real, absolute scroll positions), which is
  // the reliable way to pick a scroll position inside it, rather than guessing from the fixture's
  // layout (lead/block/scene heights) and risking landing outside it.
  const scene1 = await page.evaluate(() =>
    (window as never as { __scene1FreezeWindow: () => { start: number; end: number } })
      .__scene1FreezeWindow());
  const dwell = scene1.end - scene1.start;
  const midDwell = Math.round((scene1.start + scene1.end) / 2);

  await page.evaluate((scroll) => window.scrollTo(0, scroll), midDwell);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const consumed = await page.evaluate(() => parseFloat(
    getComputedStyle(document.getElementById('afterScene1') as HTMLElement)
      .getPropertyValue('--sst0-c0'),
  ));

  expect(consumed).toBeGreaterThan(0);
  expect(consumed).toBeLessThan(dwell);
});

// Regression test for a real bug: the author's scroll-margin-top used to be read only once, the
// first time this module saw a target, and then never again: reading it back on a later sync
// would have returned this module's own calc(), not the author's value, so re-reading on every
// pass was skipped rather than distinguishing the two. That meant a responsive header height (or
// any other author change to the same property) got silently stuck at whatever value was in
// effect the moment the target was first synced. scrollMargin.ts's sync() now resets each target
// to its pre-module inline value before re-reading, mirroring the reset-then-measure two-pass
// pattern refreshScenesAndCovers already uses for the same reason.
test('a change to the author\'s scroll-margin-top is picked up on a later refresh()', async ({
  page,
}) => {
  await page.goto('/fixtures/scrollMargin.html');

  const before = await jumpTo(page, 'withAuthorMargin', 0, 'anchorClick');

  expect(before.rectTop).toBe(40); // sanity check: the original 40px author margin is in effect

  await page.evaluate(() =>
    (window as never as { __setHeaderHeightAndRefresh: (px: number) => void })
      .__setHeaderHeightAndRefresh(120));

  const arrival = await findArrivalScroll(page, 'withAuthorMargin');
  const after = await jumpTo(page, 'withAuthorMargin', 0, 'anchorClick');

  expect(after.scroll).toBe((arrival ?? 0) - 120);
  expect(after.rectTop).toBe(120);

  // And a later refresh() with no further change is stable, rather than drifting from
  // repeatedly folding the same author value back in.
  await page.evaluate(() =>
    (window as never as { __setHeaderHeightAndRefresh: (px: number) => void })
      .__setHeaderHeightAndRefresh(120));

  const stable = await jumpTo(page, 'withAuthorMargin', 0, 'anchorClick');

  expect(stable).toEqual(after);
});

// --sst-scroll-margin-top-offset (see scrollMargin.ts's own "Nudging the landing spot on
// purpose" comment): a reserved custom property for deliberately landing short of or past a
// target, independent of both the dwell correction and the author's own scroll-margin-top.
// Being an ordinary var(), the browser reads it live at scroll-into-view time, so unlike the
// author-value correction this needs no refresh() call to take effect.
test('--sst-scroll-margin-top-offset nudges the landing spot without a refresh() call, in either direction', async ({
  page,
}) => {
  await page.goto('/fixtures/scrollMargin.html');

  const arrival = await findArrivalScroll(page, 'afterScene1');

  const jump = async (offsetPx: number | null) => {
    await page.evaluate((px) => {
      const el = document.getElementById('afterScene1') as HTMLElement;

      if (px === null) el.style.removeProperty('--sst-scroll-margin-top-offset');
      else el.style.setProperty('--sst-scroll-margin-top-offset', `${px}px`);
      // Deliberately no refresh() call here: the whole point is that this applies live.
    }, offsetPx);

    return jumpTo(page, 'afterScene1', 0, 'anchorClick');
  };

  expect(await jump(null)).toEqual({ scroll: arrival, rectTop: 0 });
  // Positive: lands short, leaving the target further down the viewport.
  expect(await jump(30)).toEqual({ scroll: (arrival ?? 0) - 30, rectTop: 30 });
  // Negative: overshoots, leaving the target above the viewport top.
  expect(await jump(-30)).toEqual({ scroll: (arrival ?? 0) + 30, rectTop: -30 });
});

// --sst-scroll-margin-top-offset inherits like any other custom property, so setting it once on
// the shared container applies it to every target inside, without repeating it per element.
test('--sst-scroll-margin-top-offset applies to every target when set once on an ancestor', async ({
  page,
}) => {
  await page.goto('/fixtures/scrollMargin.html');

  await page.evaluate(() => {
    document.querySelector('.container__inner')?.setAttribute(
      'style',
      '--sst-scroll-margin-top-offset: 20px',
    );
  });

  for (const id of ['beforeScene1', 'afterScene1', 'afterScene2']) {
    const arrival = await findArrivalScroll(page, id);
    const landed = await jumpTo(page, id, 0, 'anchorClick');

    expect(landed, `#${id}`).toEqual({ scroll: (arrival ?? 0) - 20, rectTop: 20 });
  }
});

// Regression coverage for the pattern demo/src/style.css actually uses for its fixed header: a
// site-wide offset folded into --sst-scroll-margin-top-offset has to keep working from a jump
// started mid-dwell, not just from page top (the two tests above only jump from 0). This is also
// what sidesteps a documented Firefox behavior (verified via Playwright, reproduced even with a
// completely static scroll-margin-top with this module's own code destroyed, so it's not
// something this library's correction causes or can fix directly) where scroll-padding-top on
// the scroller gets silently dropped from a fragment jump once any position:sticky element on
// the page has been engaged, landing short by exactly the scroll-padding-top amount. Folding the
// same offset into --sst-scroll-margin-top-offset instead means only scroll-margin-top is ever in
// play, which this test confirms lands correctly even from mid-dwell.
test('--sst-scroll-margin-top-offset combines correctly with the dwell correction on a jump started mid-dwell', async ({
  page,
}) => {
  await page.goto('/fixtures/scrollMargin.html');

  await page.evaluate(() => {
    document.documentElement.style.setProperty('--sst-scroll-margin-top-offset', '20px');
  });

  const scene1 = await page.evaluate(() =>
    (window as never as { __scene1FreezeWindow: () => { start: number; end: number } })
      .__scene1FreezeWindow());
  const midDwell = Math.round((scene1.start + scene1.end) / 2);
  const arrival = await findArrivalScroll(page, 'afterScene1');
  const landed = await jumpTo(page, 'afterScene1', midDwell, 'anchorClick');

  expect(landed).toEqual({ scroll: (arrival ?? 0) - 20, rectTop: 20 });
});
