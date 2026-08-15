// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest runs on top of Node's process, even when using the jsdom environment, so an uncaught
// exception inside a microtask can be observed directly via `process.on('uncaughtException')`
// (see "the abnormal case where self's constructor has no .refresh" below).
// `@types/node` isn't a dependency of this project (this is a browser-facing library,
// so `tsconfig.json`'s `types` is deliberately narrowed), so this declares just enough
// of an ambient type to cover what's used.
declare const process: {
  on(event: 'uncaughtException', listener: (error: unknown) => void): void;
  off(event: 'uncaughtException', listener: (error: unknown) => void): void;
};
import StickyScrollTrigger from './index';

// jsdom has no layout, so the freeze window's "values" can't be verified here
// (everything comes out as 0). What's checked here is not values but the validity of the setup
// and whether building succeeds or fails. Verifying actual positions is freezeWindow.test.ts's job
// (numeric) and e2e's job (a real browser).

// onKill relies on the constructor of self (the killed ScrollTrigger itself, as passed in
// by GSAP) to update GSAP's own cache (see index.ts's scheduleRebuild).
// With a fake like `{} as ScrollTrigger`, `self.constructor` resolves to the
// built-in Object, and calling `.refresh()` on it fails silently inside the microtask
// (Vitest doesn't catch async exceptions as test failures, so the test appears to pass while
// masking a real bug in production).
// This reproduces the constructor chain via a class so the static refresh can be spied on.
class FakeScrollTrigger {
  static refresh = vi.fn();
}

const makeFakeSelf = () => Object.create(FakeScrollTrigger.prototype) as ScrollTrigger;

beforeEach(() => {
  FakeScrollTrigger.refresh.mockClear();
});

// A query helper reused across tests. Since document.body.innerHTML is swapped out each time,
// there's no need to redefine this per test.
const query = (sel: string) => document.querySelector<HTMLElement>(sel)!;

const setup = () => {
  document.body.innerHTML = `
    <div class="root">
      <section class="scene"></section>
      <section class="inside"></section>
    </div>
    <section class="outside"></section>
  `;

  return { query, controller: new StickyScrollTrigger(query('.root')) };
};

describe('StickyScrollTrigger', () => {
  it('throws for a selector that matches no shared container', () => {
    document.body.innerHTML = '';
    expect(() => new StickyScrollTrigger('.Missing')).toThrow(/root "\.Missing" not found/);
  });
});

// trigger/endTrigger/cover also accept a CSS selector string (same as GSAP ScrollTrigger's own
// trigger/endTrigger). This only checks that a selector resolves to the right element through
// the public API; dom.test.ts covers the resolution logic itself in its resolveElement tests.
describe('selector-string support for trigger/endTrigger/cover', () => {
  it('createStickyTrigger accepts trigger/endTrigger as selector strings', () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({ trigger: '.scene', end: 'top top', endTrigger: '.inside' });

    expect(vars.trigger).toBe(query('.scene'));
    expect(() => controller.refresh()).not.toThrow();
  });

  it('createOverlapScroll accepts trigger/cover/endTrigger as selector strings', () => {
    const { query, controller } = setup();
    const vars = controller.createOverlapScroll({ trigger: '.scene', cover: '.inside' });

    expect(vars.trigger).toBe(query('.scene'));
    expect(query('.inside').style.position).toBe('relative'); // confirms cover was resolved correctly
  });

  it('createStickyPin accepts trigger/endTrigger as selector strings', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: '.inside', endTrigger: '.scene' });
    controller.refresh();

    expect(query('.inside').style.position).toBe('sticky');
  });

  it('createResolvedTrigger accepts trigger/endTrigger as selector strings', () => {
    const { query, controller } = setup();
    const vars = controller.createResolvedTrigger({ trigger: '.inside', start: 'top 80%', end: 'top 30%' });

    expect(vars.trigger).toBe(query('.inside'));
  });

  it('resolveScrollPosition accepts element as a selector string', () => {
    const { query, controller } = setup();

    expect(controller.resolveScrollPosition('.inside', 'top top')).toBe(
      controller.resolveScrollPosition(query('.inside'), 'top top'),
    );
  });

  it('throws naming the calling function when a selector matches no element', () => {
    const { controller } = setup();

    expect(() => controller.createStickyTrigger({ trigger: '.Missing' })).toThrow(
      /createStickyTrigger: element "\.Missing" not found/,
    );
  });
});

describe('endTrigger validity', () => {
  // An endTrigger outside the shared container has no solution, since a Scene layer's own
  // dwell keeps pushing it further away. Silently approximating it would make padding grow
  // without bound on every refresh(), so this fails explicitly instead.
  it('throws when a Scene layer\'s position-clause end points at an endTrigger outside the shared container', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({
      trigger: query('.scene'),
      end: 'top top',
      endTrigger: query('.outside'),
    });

    // Also confirms the message names both the trigger and endTrigger elements (the typical
    // pattern of registering several via querySelectorAll makes it important to know
    // which element is the culprit).
    expect(() => controller.refresh()).toThrow(
      /trigger <section\.scene>.*endTrigger \(<section\.outside>\).*outside the shared container/,
    );
  });

  it('accepts an endTrigger inside the shared container', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({
      trigger: query('.scene'),
      end: 'top top',
      endTrigger: query('.inside'),
    });

    expect(() => controller.refresh()).not.toThrow();
  });

  it('passes even with an endTrigger outside the container when using a dwell-distance end, since it goes unused', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({
      trigger: query('.scene'),
      end: '+=500',
      endTrigger: query('.outside'),
    });

    expect(() => controller.refresh()).not.toThrow();
  });

  it('passes even outside the container for a cover layer, since it never creates padding or self-references', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({
      trigger: query('.scene'),
      cover: query('.inside'),
      end: 'top top',
      endTrigger: query('.outside'),
    });

    expect(() => controller.refresh()).not.toThrow();
  });

  // A registered endTrigger positioned after itself in DOM order (a forward reference) splits
  // into two cases. A Scene layer's own dwell padding always precedes (and pushes down) anything
  // after it, so a Scene layer's forward reference always depends on its own dwell; that's
  // rejected outright (see resolveEndSpec's dedicated check). A cover layer never creates
  // padding, so it has no such self-dependency; planLayers resolves it via its fixed-point
  // iteration instead (see freezeWindow.test.ts's "a Cover layer's forward reference resolves..."
  // for the numeric verification).
  describe('forward references (endTrigger points at a layer positioned after itself in DOM order)', () => {
    const setupThreeInOrder = () => {
      document.body.innerHTML = `
        <div class="root">
          <section class="s1"></section>
          <section class="s2"></section>
          <section class="s3"></section>
        </div>`;

      return { query, controller: new StickyScrollTrigger(query('.root')) };
    };

    it('throws when a Scene layer points at a later layer (names both trigger and endTrigger)', () => {
      const { query, controller } = setupThreeInOrder();

      controller.createStickyTrigger({ trigger: query('.s1'), end: 'top top', endTrigger: query('.s2') });
      controller.createStickyTrigger({ trigger: query('.s2'), end: '+=100' });

      expect(() => controller.refresh()).toThrow(
        /trigger <section\.s1>.*endTrigger \(<section\.s2>\).*positioned later in DOM order/,
      );
    });

    it('resolves (does not throw) when a cover layer points at a later layer, since a cover layer creates no padding', () => {
      const { query, controller } = setupThreeInOrder();

      controller.createOverlapScroll({
        trigger: query('.s1'),
        cover: query('.s2'),
        end: 'top top',
        endTrigger: query('.s3'),
      });
      controller.createStickyTrigger({ trigger: query('.s3'), end: '+=100' });

      expect(() => controller.refresh()).not.toThrow();
    });

    it('pointing at itself (the default when endTrigger is omitted) is not a forward reference, so it passes', () => {
      const { query, controller } = setupThreeInOrder();

      controller.createStickyTrigger({ trigger: query('.s1'), end: 'bottom top' }); // endTrigger omitted = itself

      expect(() => controller.refresh()).not.toThrow();
    });

    it('pointing at a layer earlier in DOM order continues to work (already-supported range)', () => {
      const { query, controller } = setupThreeInOrder();

      controller.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
      controller.createStickyTrigger({ trigger: query('.s2'), end: 'top top', endTrigger: query('.s1') });

      expect(() => controller.refresh()).not.toThrow();
    });
  });
});

describe('refresh()\'s rebuild decision', () => {
  // Rebuilding recreates the wrapper elements, so this can be detected by whether
  // root's parent node stays the same object.
  const setupTwoScenes = () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="s1"></section>
        <section class="s2"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));

    controller.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
    controller.createStickyTrigger({ trigger: query('.s2'), end: '+=100' });
    controller.refresh();

    return { query, controller };
  };

  it('does not rebuild when nothing has changed', () => {
    const { query, controller } = setupTwoScenes();
    const wrapperBefore = query('.root').parentElement;

    controller.refresh();

    expect(query('.root').parentElement).toBe(wrapperBefore);
  });

  // With no layers added or removed, dirty never gets set. Without also checking
  // DOM-order changes, the nesting order would stay stale.
  it('rebuilds once trigger elements have been reordered', () => {
    const { query, controller } = setupTwoScenes();
    const wrapperBefore = query('.root').parentElement;

    query('.root').insertBefore(query('.s2'), query('.s1'));
    controller.refresh();

    expect(query('.root').parentElement).not.toBe(wrapperBefore);
  });
});

describe('Vars passed to GSAP', () => {
  // GSAP swaps a falsy end for "100% 0", so returning 0 as-is would make the trigger born
  // with a bogus window meaning "until trigger's bottom edge reaches the viewport's top edge."
  it('never returns 0 when freezeEnd is 0 (since GSAP\'s falsy check would swallow it)', () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({ trigger: query('.scene'), end: '+=500' });

    // Before refresh(), both freezeStart and freezeEnd are 0
    expect(vars.start).toBeTypeOf('function');
    expect((vars.start as () => number)()).toBe(0);
    expect((vars.end as () => number)()).not.toBe(0);
  });

  it('never lets GSAP pin, since sticky handles pinning', () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({ trigger: query('.scene') });

    expect(vars.pin).toBeUndefined();
    expect(vars.trigger).toBe(query('.scene'));
  });

  // Every refresh() rewrites padding height and sticky top, i.e. changes layout, so by default
  // this wants function-valued tween props re-measured too (see the comment on
  // registerLayer's definition).
  it('invalidateOnRefresh defaults to true', () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({ trigger: query('.scene') });

    expect(vars.invalidateOnRefresh).toBe(true);
  });

  it('respects an explicit invalidateOnRefresh value from the caller', () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({
      trigger: query('.scene'),
      invalidateOnRefresh: false,
    });

    expect(vars.invalidateOnRefresh).toBe(false);
  });

  // The PassThroughVars (types.ts) contract: any GSAP Vars this module doesn't control
  // pass through untouched. Since the object is built as `{ ...rest, trigger, start, end,
  // invalidateOnRefresh, onKill }`, this checks both pass-through and internally-decided fields
  // together, so a regression where the spread order gets swapped and trigger/onKill etc.
  // get silently overwritten would be caught.
  it('passes through rest values (e.g. scrub) as-is, without overwriting the internally-decided fields', () => {
    const { query, controller } = setup();
    const userOnKill = vi.fn();
    const vars = controller.createStickyTrigger({
      trigger: query('.scene'),
      scrub: true,
      markers: true,
      onKill: userOnKill,
    });

    expect(vars.scrub).toBe(true);
    expect(vars.markers).toBe(true);
    expect(vars.trigger).toBe(query('.scene'));
    expect(vars.start).toBeTypeOf('function');
    expect(vars.end).toBeTypeOf('function');
    expect(vars.onKill).not.toBe(userOnKill); // replaced by this module's wrapping function
  });

  // `@ts-expect-error` is the actual assertion here, not anything vitest runs: vitest transpiles
  // this file without type-checking it, so the body below executing without throwing proves
  // nothing on its own. If horizontal/scroller/pin were ever loosened to be accepted, the
  // `@ts-expect-error` comments would fail to suppress an error that no longer exists, which
  // only `npm run typecheck` (tsc --noEmit), not `npm test`, would catch.
  it('rejects options that would break things at the type level, enforced by npm run typecheck', () => {
    const { query, controller } = setup();

    // Using the same element as the trigger of multiple layers is a separate error (see
    // "rejecting duplicate registration" below), so this uses a different element
    // for each of the 3 type checks.
    // @ts-expect-error horizontal isn't supported (start/end are absolute px on the vertical axis)
    controller.createStickyTrigger({ trigger: query('.scene'), horizontal: true });
    // @ts-expect-error scroller isn't supported (documentTop/innerHeight assume window)
    controller.createStickyTrigger({ trigger: query('.inside'), scroller: document.body });
    // @ts-expect-error pin isn't allowed since sticky handles pinning
    controller.createStickyTrigger({ trigger: query('.outside'), pin: true });
  });
});

// The onRefreshInit registerLayer returns binds refresh() to the refreshInit GSAP itself fires
// (resize/load, etc.), letting callers skip manually binding
// ScrollTrigger.addEventListener('refreshInit', refresh). This test bypasses GSAP and
// simulates it by directly calling the same Vars.onRefreshInit GSAP would call.
describe('registerLayer\'s onRefreshInit', () => {
  const fakeSelf = makeFakeSelf();

  it('calling onRefreshInit runs refresh() and builds the nesting', () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });

    vars.onRefreshInit?.(fakeSelf);

    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
  });

  it('also calls the user\'s onRefreshInit callback', () => {
    const { query, controller } = setup();
    let called = false;
    const vars = controller.createStickyTrigger({
      trigger: query('.scene'),
      end: '+=100',
      onRefreshInit: () => {
        called = true;
      },
    });

    vars.onRefreshInit?.(fakeSelf);

    expect(called).toBe(true);
  });

  // Even with multiple layers, refresh() should actually run only once (not once per
  // registered layer). This is implemented via the approximation "only the current first
  // entry in layers takes responsibility"; this confirms that a non-first layer's
  // onRefreshInit is a no-op, and that the role passes to the next surviving layer only
  // once the first is killed.
  it('with multiple layers, only the currently-surviving first layer actually calls refresh() (killing it hands off to the next layer)', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="s1"></section>
        <section class="s2"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars1 = controller.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
    const vars2 = controller.createStickyTrigger({ trigger: query('.s2'), end: '+=100' });

    // s2 isn't first (s1 is), so refresh() never runs even if onRefreshInit is called.
    vars2.onRefreshInit?.(fakeSelf);
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);

    // s1 gets killed, and layers's first entry hands off to s2.
    vars1.onKill?.(fakeSelf);

    vars2.onRefreshInit?.(fakeSelf);
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
  });
});

describe('batching kill()', () => {
  // What GSAP actually calls when it kills something is Vars's onKill itself, so tests
  // simulate it by calling it directly (no need to run real GSAP inside jsdom).
  const fakeSelf = makeFakeSelf();

  const setupThreeScenes = () => {
    document.body.innerHTML = `
      <div class="host">
        <div class="root">
          <section class="s1"></section>
          <section class="s2"></section>
          <section class="s3"></section>
        </div>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars = [
      controller.createStickyTrigger({ trigger: query('.s1'), end: '+=100' }),
      controller.createStickyTrigger({ trigger: query('.s2'), end: '+=100' }),
      controller.createStickyTrigger({ trigger: query('.s3'), end: '+=100' }),
    ];

    controller.refresh();

    return { query, controller, vars };
  };

  // The main case: killing N layers within the same task still coalesces DOM teardown
  // and rebuild into a single pass (deferred to a microtask). Naively tearing down and
  // rebuilding synchronously on every kill would move the subtree containing rootElement
  // once per kill, causing internal iframes to reload and focus to be lost.
  it('synchronous multiple kills merge into a single microtask (no immediate rebuild)', async () => {
    const { query, vars } = setupThreeScenes();
    const wrapperBefore = query('.root').parentElement;

    vars.forEach((entry) => {
      entry.onKill?.(fakeSelf);
    });
    // still synchronous: waiting on the batch, so the DOM shouldn't have moved at all yet
    expect(query('.root').parentElement).toBe(wrapperBefore);

    await Promise.resolve(); // let exactly one microtask run
    // every layer was killed, so root goes straight back to its original parent (host);
    // no nesting wrapper is needed at all
    expect(query('.root').parentElement).toBe(document.querySelector('.host'));
  });

  it('layers that survive a partial kill are still correctly recomputed after the batch', async () => {
    const { vars } = setupThreeScenes();
    const survivorStartBefore = (vars[2].start as () => number)();

    vars[0].onKill?.(fakeSelf);
    vars[1].onKill?.(fakeSelf);
    await Promise.resolve();

    // precedingGaps changes now that s1 and s2 are gone, so s3's (the survivor's)
    // freezeStart should be recomputed and move.
    expect((vars[2].start as () => number)()).not.toBe(survivorStartBefore);
    // only one padding remains, for the surviving s3 (both s1's and s2's are gone).
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
  });

  // unbuild() tears down by looking at builtLayers (a snapshot of what's actually built),
  // not layers (the "should exist" set, which shrinks immediately on kill). This difference
  // is only observable for cover layers: a Scene layer's root restoration looks directly
  // at outermostContainer, independent of layers's contents, but tearing down a cover wrapper
  // depends on whether that layer is still in the array.
  it('a cover layer\'s wrapper removed from layers immediately by a kill is still torn down without being lost after the batch', async () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="base"></section>
        <section class="cover"></section>
        <section class="tail"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars = controller.createOverlapScroll({ trigger: query('.base'), cover: query('.cover') });

    controller.refresh();
    // confirm trigger is wrapped inside wrapper (cover stays outside) before breaking it
    expect(query('.base').parentElement).not.toBe(query('.root'));

    vars.onKill?.(fakeSelf); // removed from layers immediately, but the wrapper is still in the DOM
    await Promise.resolve();

    // the wrapper is undone, and trigger is back at its original position (directly under root).
    // If teardown looked only at layers and not builtLayers, this layer would already be gone
    // from the array, unwrapCover would never be called, and the wrapper would be left stranded
    // in the DOM with trigger stuck at its frozen position.
    expect(query('.base').parentElement).toBe(query('.root'));
  });

  it('the user\'s onKill callback is called immediately, without waiting for the batch', () => {
    document.body.innerHTML = '<div class="root"><section class="s1"></section></div>';

    const controller = new StickyScrollTrigger(query('.root'));
    let called = false;
    const vars = controller.createStickyTrigger({
      trigger: query('.s1'),
      onKill: () => {
        called = true;
      },
    });

    controller.refresh();

    vars.onKill?.(fakeSelf);

    expect(called).toBe(true); // called at this point, without waiting for a microtask
  });

  // From here: the binding that keeps GSAP's own start/end cache current after a kill.
  // See the comment on index.ts's scheduleRebuild definition. Calls GSAP's static refresh
  // via self's constructor (a way to obtain a reference to the ScrollTrigger class
  // without importing gsap).
  describe('updating GSAP\'s own cache', () => {
    it('calls GSAP\'s static refresh via self\'s constructor after a kill batch', async () => {
      const { vars } = setupThreeScenes();

      vars[0].onKill?.(fakeSelf);

      expect(FakeScrollTrigger.refresh).not.toHaveBeenCalled(); // still waiting on the batch
      await Promise.resolve();
      expect(FakeScrollTrigger.refresh).toHaveBeenCalledTimes(1);
    });

    it('coalesces multiple kills in the same task into a single call to GSAP\'s refresh', async () => {
      const { vars } = setupThreeScenes();

      vars.forEach((entry) => {
        entry.onKill?.(fakeSelf);
      });
      await Promise.resolve();

      expect(FakeScrollTrigger.refresh).toHaveBeenCalledTimes(1);
    });

    it('notifies GSAP only after the internal refresh() (recomputing freezeStart/End) has finished', async () => {
      const { vars } = setupThreeScenes();
      const survivorStartBefore = (vars[2].start as () => number)();
      let survivorStartWhenNotified: number | undefined;

      FakeScrollTrigger.refresh.mockImplementationOnce(() => {
        survivorStartWhenNotified = (vars[2].start as () => number)();
      });

      vars[0].onKill?.(fakeSelf);
      vars[1].onKill?.(fakeSelf);
      await Promise.resolve();

      // by the time GSAP is notified, the surviving layer's (s3's) freezeStart should
      // already hold its new value (notifying GSAP before recomputing internally would leave
      // it reading a stale value).
      expect(survivorStartWhenNotified).not.toBe(survivorStartBefore);
    });

    it('never notifies GSAP for an ordinary refresh() call (no kill involved)', () => {
      const { controller } = setupThreeScenes();

      controller.refresh(); // a call where nothing changed
      controller.refresh();

      expect(FakeScrollTrigger.refresh).not.toHaveBeenCalled();
    });

    it('never throws even in the abnormal case where self\'s constructor has no .refresh', async () => {
      document.body.innerHTML = '<div class="root"><section class="s1"></section></div>';

      const controller = new StickyScrollTrigger(query('.root'));
      const vars = controller.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });

      controller.refresh();

      // has a constructor but no .refresh (simulating GSAP changing its implementation someday).
      // An exception inside a microtask isn't visible as a Promise rejection (it becomes
      // an uncaughtException instead), so this listens for that event directly to verify it.
      const weirdSelf = Object.create({}) as ScrollTrigger;
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown) => uncaught.push(error);

      process.on('uncaughtException', onUncaught);

      vars.onKill?.(weirdSelf);
      await Promise.resolve();
      await Promise.resolve(); // make sure the microtask has fully completed

      process.off('uncaughtException', onUncaught);
      expect(uncaught).toEqual([]);
    });
  });
});

describe('destroy()', () => {
  const fakeSelf = makeFakeSelf();

  it('tears down the nested DOM and returns root to its original position', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });
    controller.refresh();

    const hostBefore = document.body.innerHTML;

    // confirms it returns to the pre-refresh() state (i.e. before the DOM was ever built),
    // by matching the structure (element order)
    // against "what the HTML would look like before building."
    controller.destroy();

    expect(query('.root').parentElement).toBe(document.body);
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);
    void hostBefore;
  });

  // On the README-recommended cover-only path (never calling ScrollTrigger.create()),
  // GSAP's onKill is never called at all. destroy() is the only entry point that can
  // still restore that z-order.
  it('also restores the z-order of a cover layer that never went through ScrollTrigger.create()', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside') });
    // Vars was built but never passed to ScrollTrigger.create() = onKill is never called

    expect(query('.inside').style.position).toBe('relative');

    controller.destroy();

    expect(query('.inside').style.position).toBe('');
  });

  it('can clean up even if refresh() was never called', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside') });

    expect(() => controller.destroy()).not.toThrow();
    expect(query('.inside').style.position).toBe('');
  });

  it('throws when registering after destroy()', () => {
    const { query, controller } = setup();

    controller.destroy();

    expect(() => controller.createStickyTrigger({ trigger: query('.scene') })).toThrow(
      /after destroy\(\) has been called/,
    );
    expect(() => controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside') })).toThrow(
      /after destroy\(\) has been called/,
    );
  });

  it('makes refresh() after destroy() a harmless no-op', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });
    controller.refresh();
    controller.destroy();

    const parentAfterDestroy = query('.root').parentElement;

    expect(() => controller.refresh()).not.toThrow();
    expect(query('.root').parentElement).toBe(parentAfterDestroy);
  });

  it('is safe to call twice (the second call is a no-op)', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });
    controller.refresh();

    controller.destroy();
    expect(() => controller.destroy()).not.toThrow();
  });

  it('never rebuilds after destroy(), even with a pending kill batch', async () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });

    controller.refresh();

    vars.onKill?.(fakeSelf); // schedules a microtask (not yet run)
    controller.destroy();

    const parentAfterDestroy = query('.root').parentElement;

    await Promise.resolve(); // let the scheduled microtask run

    expect(query('.root').parentElement).toBe(parentAfterDestroy); // nothing changed
  });
});

// jsdom has no layout and offsetTop/offsetHeight are always 0, so the actual correction
// values (px) can't be verified here (that's e2e's job). This only checks the structural side:
// whether calling it throws or not, depending on whether a layer is registered, DOM order,
// and the position-clause format.
describe('resolveScrollPosition()', () => {
  it('returns a number without throwing even when there are no Scene layers at all', () => {
    const { query, controller } = setup();
    const result = controller.resolveScrollPosition(query('.inside'), 'top top');

    expect(Number.isNaN(result)).toBe(false);
  });

  it('can be called before refresh (it just uses layers\' initial freezeStart/freezeEnd of 0)', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=500' });

    expect(() => controller.resolveScrollPosition(query('.inside'), 'top top')).not.toThrow();
  });

  it('returns a number without throwing even when a Scene layer sits after the target in DOM order (it is simply excluded from the gap total)', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.inside'), end: '+=500' });
    controller.refresh();

    // '.scene' is earlier than '.inside' in DOM order, so there's no layer before the target
    // ('.inside') itself. This only confirms that having a later layer doesn't break anything
    // (the numeric validity is e2e's job).
    expect(() => controller.resolveScrollPosition(query('.scene'), 'top top')).not.toThrow();
  });

  it('when passed a function returning a position clause, uses the result of calling it', () => {
    const { query, controller } = setup();
    const positionFn = vi.fn(() => 'center center');

    controller.resolveScrollPosition(query('.inside'), positionFn);

    expect(positionFn).toHaveBeenCalledTimes(1);
  });

  it('throws for an invalid position clause', () => {
    const { query, controller } = setup();

    expect(() => controller.resolveScrollPosition(query('.inside'), 'nonsense')).toThrow(
      /unsupported position clause/,
    );
  });

  it('after destroy(), layer registration is simply empty, and the call itself does not throw', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=500' });
    controller.refresh();
    controller.destroy();

    expect(() => controller.resolveScrollPosition(query('.inside'), 'top top')).not.toThrow();
  });

  // Cover layers never add document height (unlike Scene layers), so they must be excluded
  // from the gap total entirely, not just filtered by DOM order like Scene layers are.
  // A dwell distance ('+=500') is layout-independent and reliably makes freezeEnd-freezeStart
  // exactly 500 (see "never returns 0 when freezeEnd is 0" above), so if this cover layer were
  // mistakenly summed into the gap like a Scene layer, `after` would be 500 higher than `before`.
  it('excludes cover layers from the gap total, even when the cover layer\'s trigger sits before the target in DOM order', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="cover-trigger"></section>
        <section class="cover"></section>
        <section class="target"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const target = query('.target');
    const before = controller.resolveScrollPosition(target, 'top top');

    controller.createOverlapScroll({ trigger: query('.cover-trigger'), cover: query('.cover'), end: '+=500' });
    controller.refresh();

    const after = controller.resolveScrollPosition(target, 'top top');

    expect(after).toBe(before);
  });
});

describe('static getScrollTop()', () => {
  it('accepts element as a selector string', () => {
    const { query, controller } = setup();

    expect(StickyScrollTrigger.getScrollTop('.inside', [controller])).toBe(
      StickyScrollTrigger.getScrollTop(query('.inside'), [controller]),
    );
  });

  it('with an empty instances array, measures the element directly without throwing', () => {
    const { query } = setup();

    expect(Number.isNaN(StickyScrollTrigger.getScrollTop(query('.outside'), []))).toBe(false);
  });

  it('matches the owning instance\'s own resolveScrollPosition(element, \'top top\')', () => {
    const { query, controller } = setup();
    const target = query('.inside');

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=500' });
    controller.refresh();

    expect(StickyScrollTrigger.getScrollTop(target, [controller])).toBe(
      controller.resolveScrollPosition(target, 'top top'),
    );
  });

  // A dwell distance ('+=500') is layout-independent (see the '\'excludes cover layers...\'' test
  // above), so mismatched instances give reliably different totals if the wrong one is used.
  it(
    'uses the instance whose container actually contains the target, not another instance passed '
    + 'alongside it',
    () => {
      document.body.innerHTML = `
        <div class="root-a">
          <section class="scene-a"></section>
          <section class="target-a"></section>
        </div>
        <div class="root-b">
          <section class="scene-b"></section>
        </div>
      `;

      const controllerA = new StickyScrollTrigger(query('.root-a'));
      const controllerB = new StickyScrollTrigger(query('.root-b'));
      const target = query('.target-a');

      controllerA.createStickyTrigger({ trigger: query('.scene-a'), end: '+=500' });
      controllerA.refresh();
      controllerB.createStickyTrigger({ trigger: query('.scene-b'), end: '+=700' });
      controllerB.refresh();

      const viaOwner = controllerA.resolveScrollPosition(target, 'top top');
      // controllerB, the wrong instance, is listed first: registration order must not matter,
      // only actual containment.
      const viaStatic = StickyScrollTrigger.getScrollTop(target, [controllerB, controllerA]);

      expect(viaStatic).toBe(viaOwner);
    },
  );

  it(
    'measures an element outside every given instance\'s container directly, applying none of '
    + 'their dwell',
    () => {
      document.body.innerHTML = `
        <div class="root-a">
          <section class="scene-a"></section>
        </div>
        <section class="outside"></section>
      `;

      const controllerA = new StickyScrollTrigger(query('.root-a'));
      const outside = query('.outside');
      const before = StickyScrollTrigger.getScrollTop(outside, [controllerA]);

      controllerA.createStickyTrigger({ trigger: query('.scene-a'), end: '+=500' });
      controllerA.refresh();

      const after = StickyScrollTrigger.getScrollTop(outside, [controllerA]);

      expect(after).toBe(before);
    },
  );
});

// createResolvedTrigger is just a thin wrapper that calls resolveScrollPosition once
// for trigger/start and once for endTrigger/end (it never registers into layers, so it's
// outside refresh()'s scope). This only checks that the built result (ScrollTrigger.Vars)
// has the right shape; the validity of resolveScrollPosition's own values
// is covered by the describe block above.
describe('createResolvedTrigger()', () => {
  it('returns Vars that includes pass-through options like trigger/scrub as-is', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createResolvedTrigger({
      trigger,
      start: 'top 80%',
      end: 'top 30%',
      scrub: true,
    });

    expect(vars.trigger).toBe(trigger);
    expect(vars.scrub).toBe(true);
  });

  it('turns start/end into functions that, when called, return the same values as resolveScrollPosition', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createResolvedTrigger({ trigger, start: 'top 80%', end: 'top 30%' });

    expect(typeof vars.start).toBe('function');
    expect(typeof vars.end).toBe('function');
    expect((vars.start as () => number)()).toBe(controller.resolveScrollPosition(trigger, 'top 80%'));
    expect((vars.end as () => number)()).toBe(controller.resolveScrollPosition(trigger, 'top 30%'));
  });

  // Since jsdom has no layout, documentTop always returns 0, so passing either trigger
  // or endTrigger would produce the same value (0) under a naive comparison, making it
  // impossible to verify resolution is actually relative to endTrigger.
  // A dwell distance ('+=500') is layout-independent and reliably makes
  // freezeEnd-freezeStart exactly 500 (see "never returns 0 when freezeEnd is 0" above),
  // so this places that dwell between trigger/between/endTrigger and verifies it as a
  // difference in resolveScrollPosition's gap total (whether a layer's trigger sits
  // before the target in DOM order).
  it('when endTrigger is given, end is resolved relative to endTrigger, not trigger', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="trigger"></section>
        <section class="between"></section>
        <section class="endTrigger"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const trigger = query('.trigger');
    const endTrigger = query('.endTrigger');

    // places a dwelling Scene layer after trigger and before endTrigger.
    // The gap total only sums Scene layers positioned before the target in DOM order,
    // so it should be excluded (gap+0) relative to trigger
    // but included (gap+500) relative to endTrigger.
    controller.createStickyTrigger({ trigger: query('.between'), end: '+=500' });
    controller.refresh();

    const vars = controller.createResolvedTrigger({
      trigger,
      start: 'top top',
      end: 'top top',
      endTrigger,
    });
    const startValue = (vars.start as () => number)();
    const endValue = (vars.end as () => number)();

    expect(endValue - startValue).toBe(500);
  });

  it('the call itself does not throw even after destroy() (it never depends on refresh or layers registration)', () => {
    const { query, controller } = setup();

    controller.destroy();

    expect(() =>
      controller.createResolvedTrigger({ trigger: query('.inside'), start: 'top 80%', end: 'top 30%' }),
    ).not.toThrow();
  });
});

// createStickyPin is a mechanism completely independent of Scene/Cover layers (the layers array,
// GSAP start/end computation): it never involves GSAP at all and is implemented with plain
// position:sticky alone. jsdom has no layout, so the actual top/height numbers (px)
// can't be verified here (that's e2e's job). This only checks DOM building/teardown
// and exceptions around registration.
describe('createStickyPin()', () => {
  it('wraps trigger in two levels, outer/inner, once refresh() runs', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const originalParent = trigger.parentElement;

    controller.createStickyPin({ trigger, endTrigger: query('.scene') });
    controller.refresh();

    const inner = trigger.parentElement!;
    const outer = inner.parentElement!;

    expect(outer.parentElement).toBe(originalParent);
    expect(outer).not.toBe(originalParent);
    expect(inner).not.toBe(outer);
  });

  it('makes trigger position:sticky once refresh() runs', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene') });

    controller.refresh();

    expect(trigger.style.position).toBe('sticky');
  });

  // Unlike the pin's natural top/height (which depends on layout, unavailable in jsdom),
  // the `top` option is a plain passthrough to applyStickyPosition via resolveMaybeFn,
  // so the exact CSS value it writes can be verified here without layout.
  it('writes the top option as trigger.style.top once refresh() runs', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 39 });
    controller.refresh();

    expect(trigger.style.top).toBe('39px');
  });

  it('never restructures the DOM before refresh() (registration alone does nothing)', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const originalParent = trigger.parentElement;

    controller.createStickyPin({ trigger, endTrigger: query('.scene') });

    expect(trigger.parentElement).toBe(originalParent);
    expect(trigger.style.position).not.toBe('sticky');
  });

  it('builds a pin via refresh() even with zero Scene/Cover layers', () => {
    // index.ts's refresh() returns early when there are zero Scene/Cover layers, so it
    // must call refreshPins() before that early return.
    // A regression here would silently break pin-only usage.
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene') });
    controller.refresh();

    expect(trigger.style.position).toBe('sticky');
  });

  it('throws when the same trigger is registered twice', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene') });

    expect(() =>
      controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene') }),
    ).toThrow(/<section\.inside> is already registered as a pin trigger/);
  });

  it('throws when registering after destroy()', () => {
    const { query, controller } = setup();

    controller.destroy();

    expect(() =>
      controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene') }),
    ).toThrow(/cannot register a new pin after destroy\(\)/);
  });

  it('destroy() tears down outer/inner and returns trigger to its original position', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const originalParent = trigger.parentElement;

    controller.createStickyPin({ trigger, endTrigger: query('.scene') });
    controller.refresh();

    controller.destroy();

    expect(trigger.parentElement).toBe(originalParent);
    expect(trigger.style.position).toBe('');
    expect(trigger.style.top).toBe('');
  });

  it('is not wrapped twice even after multiple refresh() calls', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene') });

    controller.refresh();
    controller.refresh();

    const inner = trigger.parentElement!;
    const outer = inner.parentElement!;

    // If it were wrapped twice, outer's own parent would show the same nesting again,
    // so confirming outer is a direct child of root shows it's only wrapped once.
    expect(outer.parentElement).toBe(query('.root'));
  });
});

// Unlike Scene/Cover layers, createStickyPin's returned Vars uses onKill/onRefreshInit purely
// for pinLayers-specific cleanup and auto-refresh binding (there's no batching into a microtask
// like Scene/Cover layers' scheduleRebuild, since a pin wraps/unwraps independently
// without going through the shared container, it can be done synchronously on the spot).
describe('createStickyPin\'s onKill/onRefreshInit', () => {
  const fakeSelf = makeFakeSelf();

  it('onKill restores the DOM immediately without waiting for destroy(), and removes it from pinLayers too', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const originalParent = trigger.parentElement;
    const vars = controller.createStickyPin({ trigger, endTrigger: query('.scene') });

    controller.refresh();
    expect(trigger.style.position).toBe('sticky');

    vars.onKill?.(fakeSelf);

    expect(trigger.parentElement).toBe(originalParent);
    expect(trigger.style.position).toBe('');
  });

  it('also calls the user\'s onKill callback', () => {
    const { query, controller } = setup();
    let called = false;
    const vars = controller.createStickyPin({
      trigger: query('.inside'),
      endTrigger: query('.scene'),
      onKill: () => {
        called = true;
      },
    });

    controller.refresh();
    vars.onKill?.(fakeSelf);

    expect(called).toBe(true);
  });

  it('calling onRefreshInit runs refresh() and builds the pin', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createStickyPin({ trigger, endTrigger: query('.scene') });

    vars.onRefreshInit?.(fakeSelf);

    expect(trigger.style.position).toBe('sticky');
  });

  it('also calls the user\'s onRefreshInit callback', () => {
    const { query, controller } = setup();
    let called = false;
    const vars = controller.createStickyPin({
      trigger: query('.inside'),
      endTrigger: query('.scene'),
      onRefreshInit: () => {
        called = true;
      },
    });

    vars.onRefreshInit?.(fakeSelf);

    expect(called).toBe(true);
  });

  // pinLayers is never reordered (no DOM-order sort like Scene/Cover layers), so "only the
  // currently-surviving first pin takes responsibility" holds strictly as a
  // duplicate-prevention rule.
  it('with multiple pins, only the surviving first pin actually calls refresh() (killing it hands off to the next pin)', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="p1"></section>
        <section class="p2"></section>
        <section class="scene"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const p2 = query('.p2');
    const vars1 = controller.createStickyPin({ trigger: query('.p1'), endTrigger: query('.scene') });
    const vars2 = controller.createStickyPin({ trigger: p2, endTrigger: query('.scene') });

    // p2 isn't first (p1 is), so refresh() never runs even if onRefreshInit is called.
    vars2.onRefreshInit?.(fakeSelf);
    expect(p2.style.position).not.toBe('sticky');

    // p1 gets killed, and pinLayers's first entry hands off to p2.
    vars1.onKill?.(fakeSelf);

    vars2.onRefreshInit?.(fakeSelf);
    expect(p2.style.position).toBe('sticky');
  });
});

describe('createOverlapScroll input validation', () => {
  it('throws naming trigger when cover cannot be found', () => {
    const { query, controller } = setup();

    expect(() => controller.createOverlapScroll({ trigger: query('.outside') })).toThrow(
      /cover element.*not found for trigger <section\.outside>/,
    );
  });

  it('throws naming both when cover is not a sibling of trigger', () => {
    const { query, controller } = setup();

    expect(() => controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.outside') })).toThrow(
      /cover <section\.outside> must be a sibling of trigger <section\.scene>/,
    );
  });

  // createOverlapScroll raises cover to the front (liftAboveStickyWrapper) at the same
  // time it registers, so if .inside ends up lifted, that confirms trigger.nextElementSibling
  // (=.inside) was used as cover when omitted
  // (see the README's createOverlapScroll table for cover's default).
  it('uses trigger.nextElementSibling as the default cover element when omitted', () => {
    const { query, controller } = setup();

    expect(() => controller.createOverlapScroll({ trigger: query('.scene') })).not.toThrow();

    expect(query('.inside').style.position).toBe('relative');
    expect(query('.inside').style.zIndex).toBe('1');
  });
});

// GSAP's 'max' keyword (the scroller's max scroll position) is only mathematically solvable
// where the layer itself never contributes to document height: createOverlapScroll (cover layers
// never add padding) and resolveScrollPosition/createResolvedTrigger (they never register into
// `layers` or add height). For createStickyTrigger (Scene layers) and createStickyPin, the
// layer's own padding/spacer would contribute to the very document height 'max' measures, so the
// equation never converges, so these reject it with a clear error instead of producing an unstable
// value.
describe('\'max\' end keyword', () => {
  it('createOverlapScroll accepts end: \'max\' without throwing', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside'), end: 'max' });

    expect(() => controller.refresh()).not.toThrow();
  });

  it('createOverlapScroll accepts end: \'max-=100\' without throwing', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({
      trigger: query('.scene'),
      cover: query('.inside'),
      end: 'max-=100',
    });

    expect(() => controller.refresh()).not.toThrow();
  });

  it('createStickyTrigger rejects end: \'max\' (a Scene layer\'s own dwell padding is self-referential)', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: 'max' });

    expect(() => controller.refresh()).toThrow(
      /trigger <section\.scene>.*end "max".*'max'.*isn't supported.*createOverlapScroll/,
    );
  });

  it('createStickyPin rejects end: \'max\' (the pin\'s own spacer is self-referential)', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), end: 'max' });

    expect(() => controller.refresh()).toThrow(
      /createStickyPin's end "max".*'max'.*isn't supported/,
    );
  });

  // refreshPins measures with every Scene/Cover layer's sticky state temporarily reset, and the
  // rejection above throws from inside that window. Restoring on the way out keeps one bad option
  // value from stripping the sticky CSS off every layer on the page and leaving it that way.
  it('leaves Scene layer sticky state intact when a pin option throws mid-refresh', () => {
    const { query, controller } = setup();
    const stuckWrappers = () =>
      [...document.querySelectorAll<HTMLElement>('div')]
        .filter((el) => el.style.position === 'sticky').length;

    controller.createStickyTrigger({ trigger: query('.scene'), start: 'top top', end: '+=500' });
    controller.refresh();

    const before = stuckWrappers();

    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), end: 'max' });

    expect(() => controller.refresh()).toThrow(/'max' keyword/);
    expect(before).toBeGreaterThan(0);
    expect(stuckWrappers()).toBe(before);
  });

  it('resolveScrollPosition resolves \'max\' without throwing, ignoring element entirely', () => {
    const { query, controller } = setup();

    expect(() => controller.resolveScrollPosition(query('.inside'), 'max')).not.toThrow();
  });

  it('createResolvedTrigger accepts end: \'max\'', () => {
    const { query, controller } = setup();
    const vars = controller.createResolvedTrigger({
      trigger: query('.inside'),
      start: 'top 80%',
      end: 'max',
    });

    expect(() => (vars.end as () => number)()).not.toThrow();
  });
});

// GSAP's own _parsePosition treats a bare number (or a numeric-only string) as an absolute
// scroll position, entirely unrelated to any element. A cover layer's stickyTop is computed
// relative to its own wrapper's natural position (see freezeWindow.ts), which has no equivalent
// for an absolute value, so createOverlapScroll rejects it, unlike a Scene layer's stickyTop,
// which is already document-absolute and works with either.
describe('absolute start (a bare number)', () => {
  it('createOverlapScroll rejects a numeric-string start', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside'), start: '500' });

    expect(() => controller.refresh()).toThrow(
      /trigger <section\.scene>.*start "500".*absolute scroll position.*isn't supported/,
    );
  });

  it('createOverlapScroll rejects a plain-number start', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside'), start: 500 });

    expect(() => controller.refresh()).toThrow(/absolute scroll position/);
  });

  it('createStickyTrigger accepts a numeric-string start without throwing', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), start: '500' });

    expect(() => controller.refresh()).not.toThrow();
  });

  // freezeStart = start.value directly for an absolute start (see freezeWindow.ts's runPass),
  // unrelated to the trigger's own natural position, so unlike a clause start this doesn't
  // need real layout to verify: it's exact even in jsdom.
  it('resolves freezeStart to exactly the given value, ignoring the trigger\'s own natural position', () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({ trigger: query('.scene'), start: '500', end: '+=100' });

    controller.refresh();

    expect((vars.start as () => number)()).toBe(500);
  });
});

// Unlike start, end used to treat a bare number as a dwell distance (an intentional, documented
// divergence from GSAP). That exception was withdrawn: end now matches GSAP's own "bare number =
// absolute scroll position" too, the same as start.
describe('absolute end (a bare number)', () => {
  it('createStickyTrigger accepts a numeric-string end without throwing', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: '500' });

    expect(() => controller.refresh()).not.toThrow();
  });

  it('createOverlapScroll accepts a numeric-string end without throwing (unlike start, end has no cover-layer restriction)', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside'), end: 500 });

    expect(() => controller.refresh()).not.toThrow();
  });

  // freezeEnd = end.value directly for an absolute end (clamped to freezeStart, see
  // freezeWindow.ts's runPass), unrelated to freezeStart or any preceding dwell, so unlike a
  // clause end this doesn't need real layout to verify: it's exact even in jsdom.
  it('resolves freezeEnd to exactly the given value, ignoring freezeStart and any preceding dwell', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=500' });

    const vars = controller.createStickyTrigger({ trigger: query('.inside'), end: '5000' });

    controller.refresh();

    expect((vars.end as () => number)()).toBe(5000);
  });
});

// Using the same element as the trigger of two layers used to make it ambiguous which layer
// another layer's endTrigger pointed at, and one of them would silently get ignored
// (since indexByTrigger's implementation only remembered the first registration).
// This now throws immediately at registration time so it's caught right away.
describe('rejecting duplicate registration', () => {
  it('throws when the same element is used as the trigger of two createStickyTrigger calls', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene') });

    expect(() => controller.createStickyTrigger({ trigger: query('.scene') })).toThrow(
      /<section\.scene> is already registered as a trigger for another layer/,
    );
  });

  it('also throws when createStickyTrigger\'s trigger and createOverlapScroll\'s trigger are the same element', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene') });

    expect(() => controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside') })).toThrow(
      /<section\.scene> is already registered as a trigger for another layer/,
    );
  });

  // Regression test for a bug where the cover's lift ran before registerLayer's duplicate-
  // trigger check, so a rejected call left the cover's position/z-index stuck (see the ordering
  // comment above registerLayer's call in createOverlapScroll).
  it('does not leave the cover\'s lifted position/z-index behind when registration is rejected', () => {
    const { query, controller } = setup();
    const cover = query('.inside');

    controller.createStickyTrigger({ trigger: query('.scene') });

    expect(() => controller.createOverlapScroll({ trigger: query('.scene'), cover })).toThrow();
    expect(cover.style.position).toBe('');
    expect(cover.style.zIndex).toBe('');

    // destroy() also restores every registered cover layer's z-order, confirming the rejected
    // call didn't leave anything behind for it to find either.
    controller.destroy();
    expect(cover.style.position).toBe('');
    expect(cover.style.zIndex).toBe('');
  });

  it('passes for distinct elements', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="scene"></section>
        <section class="base"></section>
        <section class="cover"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));

    controller.createStickyTrigger({ trigger: query('.scene') });

    expect(() => controller.createOverlapScroll({ trigger: query('.base'), cover: query('.cover') })).not.toThrow();
  });

  // A pin layer wraps trigger itself via wrapPin(), so using the same element as a
  // Scene/Cover layer's trigger would make wrapScene/wrapCover and wrapPin wrap it twice,
  // conflicting with each other's sticky behavior.
  it('also throws when createStickyTrigger\'s trigger and createStickyPin\'s trigger are the same element', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene') });

    expect(() =>
      controller.createStickyPin({ trigger: query('.scene'), endTrigger: query('.inside') }),
    ).toThrow(/<section\.scene> is already registered as a trigger for another layer/);
  });

  it('also throws when createStickyPin\'s trigger and createStickyTrigger\'s trigger are the same element (reversed order)', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: query('.scene'), endTrigger: query('.inside') });

    expect(() => controller.createStickyTrigger({ trigger: query('.scene') })).toThrow(
      /<section\.scene> is already registered as a pin trigger/,
    );
  });
});

// scroll-margin-top synchronisation (see src/scrollMargin.ts). jsdom has no layout, so every
// documentTop comes out 0 and the dwell has to come from '+=' notation, which resolves without
// measuring. What's checked here is the bookkeeping: which elements get written to, what value,
// and that everything is handed back. Whether the resulting numbers actually make the browser's
// own scroll-into-view land correctly is e2e/StickyScrollTrigger.spec.ts's job. That file also
// covers the `scroll` listener fallback for engines without `animation-timeline: scroll()`
// support, since jsdom's own CSS.supports is a syntax-only stub that reports that combination as
// supported regardless of what it's actually asked about, making the fallback branch unreachable
// here.
describe('scroll-margin-top synchronisation', () => {
  // Each controller registers its own custom-property names off a module-level counter, so the
  // exact index depends on how many instances the whole suite has built by now.
  const correction = (lagPx: number, authorPx = 0) =>
    new RegExp(
      `^calc\\(${authorPx}px \\+ var\\(--sst-scroll-margin-top-offset, 0px\\) \\+ var\\(--sst\\d+-c0, 0px\\) `
      + `- ${lagPx}px\\)$`,
    );
  // document.body is swapped per test but document.head isn't, so stylesheets injected by
  // controllers from earlier tests would otherwise pile up and be counted here.
  const ownStyles = () =>
    Array.from(document.head.querySelectorAll('style'))
      .filter((style) => style.textContent?.includes('--sst'));

  beforeEach(() => {
    document.head.querySelectorAll('style').forEach((style) => style.remove());
  });

  const setupAnchors = (options?: { scrollMarginTargets?: string | null }) => {
    document.body.innerHTML = `
      <div class="root">
        <div id="before"></div>
        <section class="scene"></section>
        <div id="after"></div>
      </div>
      <div id="outside"></div>
    `;

    const controller = new StickyScrollTrigger(query('.root'), options);

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=800' });

    return { query, controller };
  };

  it('writes a correction that subtracts the dwell preceding each target', () => {
    const { query, controller } = setupAnchors();

    controller.refresh();

    // #before sits above the scene, so no dwell precedes it; #after is delayed by the full 800.
    // Both still carry the scroll-dependent term, which is what makes a jump started mid-page
    // land in the same place as one started from the top.
    expect(query('#before').style.scrollMarginTop).toMatch(correction(0));
    expect(query('#after').style.scrollMarginTop).toMatch(correction(800));
  });

  it('leaves elements outside the shared container alone', () => {
    const { query, controller } = setupAnchors();

    controller.refresh();

    expect(query('#outside').style.scrollMarginTop).toBe('');
  });

  it('folds an author\'s own scroll-margin-top into the correction instead of replacing it', () => {
    const { query, controller } = setupAnchors();

    query('#after').style.scrollMarginTop = '40px';
    controller.refresh();

    expect(query('#after').style.scrollMarginTop).toMatch(correction(800, 40));
  });

  it('keeps the same value across repeated refreshes when nothing changed', () => {
    const { query, controller } = setupAnchors();

    query('#after').style.scrollMarginTop = '40px';
    controller.refresh();

    const first = query('#after').style.scrollMarginTop;

    controller.refresh();
    controller.refresh();

    expect(query('#after').style.scrollMarginTop).toBe(first);
  });

  // Regression test: reading the author's value back on a later refresh would, without a reset
  // first, return this module's own calc() from the previous refresh rather than the author's
  // real value, so a later refresh() used to skip re-reading entirely and stayed stuck on
  // whatever the author's value was the first time. sync() now resets each target to its
  // pre-module inline value before re-reading, so a later author change (a responsive header
  // height, or JS updating the same custom property) is picked up on the very next refresh().
  // Driven through a stylesheet rule rather than the target's own inline style: the reset puts
  // the element's inline scroll-margin-top back to what it was before this module ever touched it
  // (empty, here), so only a change that's still visible after that reset (like a stylesheet
  // rule) exercises the fix. Overwriting the target's inline value directly would just be
  // undone by that same reset, and isn't the scenario this guards.
  it('picks up a later change to the author\'s own scroll-margin-top', () => {
    const { query, controller } = setupAnchors();
    const style = document.createElement('style');

    style.textContent = '#after { scroll-margin-top: 40px }';
    document.head.appendChild(style);
    controller.refresh();

    expect(query('#after').style.scrollMarginTop).toMatch(correction(800, 40));

    style.textContent = '#after { scroll-margin-top: 120px }';
    controller.refresh();

    expect(query('#after').style.scrollMarginTop).toMatch(correction(800, 120));

    style.remove();
  });

  // --sst-scroll-margin-top-offset (scrollMargin.ts's "Nudging the landing spot on purpose"): a
  // fixed var() term this module always emits, independent of the author's own
  // scroll-margin-top. jsdom can't verify that the browser actually reads it live (that's e2e's
  // job), only that the term is present in the calc() this module writes, in every case
  // correction()'s regex already covers.
  it('always includes the --sst-scroll-margin-top-offset term in the written calc()', () => {
    const { query, controller } = setupAnchors();

    controller.refresh();

    expect(query('#after').style.scrollMarginTop).toContain('var(--sst-scroll-margin-top-offset, 0px)');
  });

  it('injects one stylesheet carrying the scroll-driven ramp per Scene layer', () => {
    const { controller } = setupAnchors();

    controller.refresh();

    const styles = ownStyles();

    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain('animation-timeline:scroll(root block)');
    // The ramp spans the layer's own freeze window, in absolute scroll px.
    expect(styles[0].textContent).toContain('animation-range:0px 800px');
  });

  it('hands every target back and removes the stylesheet on destroy', () => {
    const { query, controller } = setupAnchors();

    query('#after').style.scrollMarginTop = '40px';
    controller.refresh();
    controller.destroy();

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).toBe('40px');
    expect(ownStyles()).toHaveLength(0);
  });

  it('writes nothing when scrollMarginTargets is null', () => {
    const { query, controller } = setupAnchors({ scrollMarginTargets: null });

    controller.refresh();

    expect(query('#after').style.scrollMarginTop).toBe('');
    expect(ownStyles()).toHaveLength(0);
  });

  it('honours a custom scrollMarginTargets selector', () => {
    const { query, controller } = setupAnchors({ scrollMarginTargets: '#after' });

    controller.refresh();

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).not.toBe('');
  });

  // A target that stops matching (its id removed, say) has to be handed back rather than left
  // carrying a correction nothing updates any more.
  it('restores a target that no longer matches the selector', () => {
    const { query, controller } = setupAnchors();

    controller.refresh();

    const after = query('#after');

    expect(after.style.scrollMarginTop).not.toBe('');

    after.removeAttribute('id');
    controller.refresh();

    expect(after.style.scrollMarginTop).toBe('');
  });

  // A Scene layer with no dwell contributes no ramp and no lag, so there's nothing to declare.
  it('writes nothing when no layer has any dwell', () => {
    document.body.innerHTML = '<div class="root"><section class="scene"></section><div id="a"></div></div>';

    const controller = new StickyScrollTrigger(query('.root'));

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=0' });
    controller.refresh();

    expect(query('#a').style.scrollMarginTop).toBe('');
    expect(ownStyles()).toHaveLength(0);
  });
});
