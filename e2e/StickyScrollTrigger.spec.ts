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
// bounds of the block wrapping it (partialSticky__pinContainerInner, which is height:0+contain
// and stretched by exactly its real height without affecting the following layout). So this
// library needs no correction at all here.
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

// None of the other e2e fixtures ever call destroy(), and all of them give the cover explicit
// position/z-index CSS, so liftAboveStickyWrapper's "only fill in when computed is static/auto"
// branch has never run in a real browser. destroyRestoresLayout.html's cover has no
// such CSS, so this exercises both that branch and destroy()'s restore/unbuild together.
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
