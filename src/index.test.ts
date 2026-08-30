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
  // Cleared alongside the body each setup() swaps out, so a stylesheet one test installs can't
  // reach the next one.
  document.head.innerHTML = '';
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

// A Scene/Cover trigger has to live inside the shared container, so the wrapping and styling that
// follow can't reach elements the instance doesn't own. The endTrigger rule below is separate.
describe('trigger containment', () => {
  it('throws when a Scene layer\'s trigger is outside the shared container', () => {
    const { query, controller } = setup();

    expect(() => controller.createStickyTrigger({ trigger: query('.outside') })).toThrow(
      /createStickyTrigger: trigger <section\.outside> is outside the shared container/,
    );
  });

  it('throws when a Cover layer\'s trigger is outside the shared container', () => {
    const { query, controller } = setup();

    expect(() => controller.createOverlapScroll({
      trigger: query('.outside'),
      cover: query('.inside'),
    })).toThrow(/createOverlapScroll: trigger <section\.outside> is outside the shared container/);
  });

  it('throws when trigger is the shared container itself', () => {
    const { query, controller } = setup();

    expect(() => controller.createStickyTrigger({ trigger: query('.root') })).toThrow(
      /trigger <div\.root> is the shared container itself/,
    );
  });

  // A selector string resolves against the whole document; only this check confines it.
  it('throws for a selector string that resolves outside the shared container', () => {
    const { controller } = setup();

    expect(() => controller.createOverlapScroll({ trigger: '.outside' })).toThrow(
      /outside the shared container/,
    );
  });

  // A rejected registration must not wrap, move or style anything.
  it('leaves the rejected trigger and its surroundings untouched', () => {
    const { query, controller } = setup();
    const outside = query('.outside');

    expect(() => controller.createOverlapScroll({ trigger: outside })).toThrow();
    controller.refresh();

    expect(outside.parentElement).toBe(document.body);
    expect(outside.style.position).toBe('');
    expect(outside.style.zIndex).toBe('');
  });

  it('accepts a trigger nested deeper inside the shared container', () => {
    document.body.innerHTML = `
      <div class="root">
        <div class="group">
          <section class="scene"></section>
        </div>
      </div>
    `;

    const controller = new StickyScrollTrigger(query('.root'));

    expect(() => controller.createStickyTrigger({ trigger: query('.scene'), end: '+=500' }))
      .not.toThrow();
    expect(() => controller.refresh()).not.toThrow();
  });

  // A pin stays free to sit on either side of the container (see "createStickyPin()" below). The
  // exception: a pin makes trigger itself position:sticky, so a trigger enclosing the container
  // would pin every layer inside it as one block.
  describe('a pin trigger that encloses the shared container', () => {
    it('throws when the pin trigger is the shared container itself', () => {
      const { query, controller } = setup();

      expect(() => controller.createStickyPin({
        trigger: query('.root'),
        endTrigger: query('.inside'),
      })).toThrow(/createStickyPin: trigger <div\.root> is the shared container itself/);
    });

    it('throws when the pin trigger is an ancestor of the shared container', () => {
      document.body.innerHTML = `
        <div class="outerWrap">
          <div class="root">
            <section class="scene"></section>
            <section class="inside"></section>
          </div>
        </div>
      `;

      const controller = new StickyScrollTrigger(query('.root'));

      expect(() => controller.createStickyPin({
        trigger: query('.outerWrap'),
        endTrigger: query('.inside'),
      })).toThrow(/createStickyPin: trigger <div\.outerWrap> is an ancestor of the shared container/);
    });

    // Without the check, the refresh below would wrap the container and make it sticky, carrying
    // the layer and its 500px of dwell padding along with it.
    it('leaves the container unpinned after the rejected pin', () => {
      const { query, controller } = setup();

      controller.createStickyTrigger({ trigger: query('.scene'), end: '+=500' });
      expect(() => controller.createStickyPin({
        trigger: query('.root'),
        endTrigger: query('.inside'),
      })).toThrow();
      controller.refresh();

      expect(query('.root').style.position).not.toBe('sticky');

      // The wrapping too, not just the sticky: outer is two levels up from a wrapped trigger, so
      // this walks the chain rather than naming a level.
      for (let node = query('.root').parentElement; node; node = node.parentElement) {
        expect(node.style.contain).toBe('');
      }
    });
  });
});

// measure.ts raises the rejections below, and measure.test.ts asserts their messages in full.
// What these add is that refresh() still reaches each one from the public API, so they match only
// enough of the message to tell the rejections apart. Same split at 'max' end keyword and
// absolute start further down.
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

    expect(() => controller.refresh()).toThrow(/endTrigger .*outside the shared container/);
  });

  // The plain "this endTrigger is accepted" cases live in measure.test.ts, which asserts the
  // EndSpec each resolves to rather than only that nothing threw. This one stays because refresh()
  // does more with it: an endTrigger outside the container is the sole case that makes
  // #planLayerPositions run pass 2 a second time, to re-measure after padding.
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
  // rejected outright (see measure.ts's resolveEndSpec). A cover layer never creates
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

    it('throws when a Scene layer points at a later layer', () => {
      const { query, controller } = setupThreeInOrder();

      controller.createStickyTrigger({ trigger: query('.s1'), end: 'top top', endTrigger: query('.s2') });
      controller.createStickyTrigger({ trigger: query('.s2'), end: '+=100' });

      expect(() => controller.refresh()).toThrow(/positioned later in DOM order/);
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

  // `@ts-expect-error` guards the type level: if horizontal/scroller/pin were ever loosened to
  // be accepted, the comment would fail to suppress an error that no longer exists, which only
  // `npm run typecheck` (tsc --noEmit), not `npm test`, would catch. The `toThrow` calls guard
  // runtime too (#assertNoExcludedVars), since a plain JS/JSON caller bypasses the type check
  // entirely.
  it('rejects options that would break things, at both the type level and runtime', () => {
    const { query, controller } = setup();
    // Using the same element as the trigger of multiple layers is a separate error (see
    // "rejecting duplicate registration" below), so this uses a different element
    // for each of the 3 checks. The third is appended rather than taken from setup()'s markup,
    // since a trigger has to be inside the shared container (see "trigger containment").
    const third = query('.root').appendChild(document.createElement('section'));

    expect(() => controller.createStickyTrigger({
      trigger: query('.scene'),
      // @ts-expect-error horizontal isn't supported (start/end are px on the vertical axis)
      horizontal: true,
    })).toThrow('createStickyTrigger: horizontal is not supported here');

    expect(() => controller.createStickyTrigger({
      trigger: query('.inside'),
      // @ts-expect-error scroller isn't supported (documentTop/innerHeight assume window)
      scroller: document.body,
    })).toThrow('createStickyTrigger: scroller is not supported here');

    expect(() => controller.createStickyTrigger({
      trigger: third,
      // @ts-expect-error pin isn't allowed since sticky handles pinning
      pin: true,
    })).toThrow('createStickyTrigger: pin is not supported here');
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

  // The fake stands in for an animation: GSAP only reverts a returned value that has render().
  it('hands the user callback\'s return value back to GSAP', () => {
    const { query, controller } = setup();
    const animation = { render: () => {} };
    const vars = controller.createStickyTrigger({
      trigger: query('.scene'),
      end: '+=100',
      onRefreshInit: () => animation,
    });

    expect(vars.onRefreshInit?.(fakeSelf)).toBe(animation);
  });

  it('runs the user callback before refresh()', () => {
    const { query, controller } = setup();
    const order: string[] = [];
    const vars = controller.createStickyTrigger({
      trigger: query('.scene'),
      end: '+=100',
      onRefreshInit: () => {
        // refresh() builds the nesting, so its absence means this call came first.
        order.push(document.querySelector('div[aria-hidden="true"]') ? 'after' : 'before');
      },
    });

    vars.onRefreshInit?.(fakeSelf);

    expect(order).toEqual(['before']);
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
  });

  // The user's callback runs outside the guard, so its error still reaches GSAP's dispatch.
  it('lets an error from the user callback through', () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({
      trigger: query('.scene'),
      end: '+=100',
      onRefreshInit: () => {
        throw new Error('from the user callback');
      },
    });

    expect(() => vars.onRefreshInit?.(fakeSelf)).toThrow('from the user callback');
  });

  // jsdom measures everything as 0, so a callback can't check the DOM to see whether its own
  // layer was measured yet. It records how many refreshes ran before it instead. Each layer
  // should see only the refreshes of the layers dispatched earlier, hence [0, 1, 2]. If one
  // layer took over the refresh for all of them, the last two would both see 1.
  it('every layer\'s callback precedes a refresh() of its own', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="s1"></section>
        <section class="s2"></section>
        <section class="s3"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const refresh = vi.spyOn(controller, 'refresh');
    const refreshesBefore: number[] = [];

    const track = () => () => {
      refreshesBefore.push(refresh.mock.calls.length);
    };

    const vars = ['.s1', '.s2', '.s3'].map((selector) => controller.createStickyTrigger({
      trigger: query(selector),
      end: '+=100',
      onRefreshInit: track(),
    }));

    vars.forEach(({ onRefreshInit }) => onRefreshInit?.(fakeSelf));

    expect(refreshesBefore).toEqual([0, 1, 2]);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

// The guard in #createAutoRefreshHandler keeps a throw out of GSAP's unguarded refreshInit
// dispatch. The end here only turns bad after setup, which pre-validation can't catch.
describe('a refresh() that throws from GSAP\'s refreshInit dispatch', () => {
  const setupBreakingPin = () => {
    document.body.innerHTML = `
      <div class="root"><section class="scene"></section></div>
      <section class="pin"></section>
    `;

    const controller = new StickyScrollTrigger(query('.root'));
    let broken = false;
    const vars = controller.createStickyPin({
      trigger: query('.pin'),
      endTrigger: query('.scene'),
      end: () => (broken ? 'max' : '+=100'),
    });

    controller.refresh();
    broken = true;

    return vars;
  };

  // Collects the deliberate uncaught exception each dispatch leaves behind, which Vitest would
  // otherwise report against whichever test was running. The finally keeps a failing dispatch
  // from leaking the listener into every later test.
  const runDispatch = async (dispatch: () => void) => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    process.on('uncaughtException', onUncaught);

    try {
      dispatch();
      await Promise.resolve();
      await Promise.resolve(); // make sure the microtask has fully completed
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    return uncaught;
  };

  it('lets the listeners dispatched after it still run', async () => {
    const vars = setupBreakingPin();
    let laterListenerRan = false;

    // Stands in for another controller's listener, or a plain ScrollTrigger's.
    const laterListener = () => {
      laterListenerRan = true;
    };

    await runDispatch(() => {
      [() => vars.onRefreshInit?.(makeFakeSelf()), laterListener].map((f) => f());
    });

    expect(laterListenerRan).toBe(true);
  });

  it('rethrows the error off the stack, so a broken setup still reports itself', async () => {
    const vars = setupBreakingPin();
    const uncaught = await runDispatch(() => {
      vars.onRefreshInit?.(makeFakeSelf());
    });

    expect(uncaught).toHaveLength(1);
    expect((uncaught[0] as Error).message).toMatch(/uses GSAP's 'max' keyword/);
  });

  // The public method is the caller's own call, where a synchronous throw is the whole point.
  it('leaves an explicit refresh() call throwing synchronously', () => {
    document.body.innerHTML = `
      <div class="root"><section class="scene"></section></div>
      <section class="pin"></section>
    `;

    const controller = new StickyScrollTrigger(query('.root'));

    controller.createStickyPin({
      trigger: query('.pin'),
      endTrigger: query('.scene'),
      end: 'max',
    });

    expect(() => controller.refresh()).toThrow(/uses GSAP's 'max' keyword/);
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

    // The layer's trigger ('.inside') sits after the target ('.scene') in DOM order, so it adds
    // nothing to the gap total. This only confirms that having a later layer doesn't break
    // anything (the numeric validity is e2e's job).
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

  it('rejects pin/scroller/horizontal at runtime, not just the type level', () => {
    const { query, controller } = setup();

    expect(() => controller.createResolvedTrigger({
      trigger: query('.inside'),
      start: 'top 80%',
      end: 'top 30%',
      // @ts-expect-error scroller isn't supported (documentTop/innerHeight assume window)
      scroller: document.body,
    })).toThrow('createResolvedTrigger: scroller is not supported here');
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

  // GSAP's own defaults for a trigger that doesn't pin, which is every trigger here.
  it('defaults start to \'top bottom\' and end to \'bottom top\'', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createResolvedTrigger({ trigger });

    expect((vars.start as () => number)()).toBe(controller.resolveScrollPosition(trigger, 'top bottom'));
    expect((vars.end as () => number)()).toBe(controller.resolveScrollPosition(trigger, 'bottom top'));
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

  // The default end belongs to endTrigger too, so it picks up the same dwell the test above
  // measures.
  it('resolves the default end relative to endTrigger', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="trigger"></section>
        <section class="between"></section>
        <section class="endTrigger"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const trigger = query('.trigger');
    const endTrigger = query('.endTrigger');

    controller.createStickyTrigger({ trigger: query('.between'), end: '+=500' });
    controller.refresh();

    const vars = controller.createResolvedTrigger({ trigger, endTrigger });

    expect((vars.end as () => number)()).toBe(500);
    expect(controller.resolveScrollPosition(trigger, 'bottom top')).toBe(0);
  });

  // A dwell end counts from the resolved start and ignores endTrigger, matching GSAP and the
  // pin path. resolveScrollPosition has no dwell branch, so this used to resolve against
  // endTrigger, landing at its top edge plus the offset.
  it('resolves a dwell end as that distance past start, ignoring endTrigger', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="trigger"></section>
        <section class="between"></section>
        <section class="endTrigger"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const trigger = query('.trigger');
    const endTrigger = query('.endTrigger');

    // A dwelling Scene layer between trigger and endTrigger moves a position-clause end
    // resolved against endTrigger by 500 (see the tests above); a dwell end must not shift.
    controller.createStickyTrigger({ trigger: query('.between'), end: '+=500' });
    controller.refresh();

    const vars = controller.createResolvedTrigger({
      trigger,
      start: 'top top',
      end: '+=300',
      endTrigger,
    });

    expect((vars.end as () => number)() - (vars.start as () => number)()).toBe(300);
  });

  // A '%' dwell scales against the viewport, not endTrigger's own height, which jsdom reports as
  // 0. resolveScrollPosition's position-clause path would have used that height instead.
  it('scales a percent dwell end against the viewport', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createResolvedTrigger({ trigger, start: 'top top', end: '+=100%' });

    expect((vars.end as () => number)() - (vars.start as () => number)()).toBe(window.innerHeight);
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
  it('rejects pin/scroller/horizontal at runtime, not just the type level', () => {
    const { query, controller } = setup();

    expect(() => controller.createStickyPin({
      trigger: query('.inside'),
      endTrigger: query('.scene'),
      // @ts-expect-error pin isn't allowed since sticky handles pinning
      pin: true,
    })).toThrow('createStickyPin: pin is not supported here');
  });

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

  // The reserved height is outer's own natural height, which jsdom has no layout to produce. A
  // stylesheet rule on outer stands in for one, leaving the plumbing as what these two can check:
  // that the measured height reaches outer's inline style intact, fractional part and all, and
  // that it's taken again on each refresh().
  const styleOuter = (height: string) => {
    // The pin's outer is the only div directly inside .root: .scene and .inside are sections, and
    // .inside has moved inside the wrappers by the time this matters.
    document.head.innerHTML = `<style>.root > div { height: ${height} }</style>`;
  };

  it('writes the height it measures on outer, keeping the fractional part', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    styleOuter('112.5px');
    controller.createStickyPin({ trigger, endTrigger: query('.scene') });
    controller.refresh();

    expect(trigger.parentElement!.parentElement!.style.height).toBe('112.5px');
  });

  it('re-measures the reserved space on every refresh()', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    styleOuter('20px');
    controller.createStickyPin({ trigger, endTrigger: query('.scene') });
    controller.refresh();

    const outer = trigger.parentElement!.parentElement!;

    expect(outer.style.height).toBe('20px');

    styleOuter('60px');
    controller.refresh();

    expect(outer.style.height).toBe('60px');
  });

  // trigger's own top margin collapses through inner and stops at outer, which contain:layout
  // makes a formatting context, so a pinned trigger rests at exactly the top its start clause
  // names. An overflow or contain on inner would make it a formatting context too, and the margin
  // would push trigger down inside the reserved box instead.
  it('leaves inner without a formatting context of its own', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene') });
    controller.refresh();

    const inner = trigger.parentElement!;

    expect(inner.style.overflow).toBe('');
    expect(inner.style.contain).toBe('');
  });

  // A dwell end is the one pin arithmetic jsdom can check in full: the distance comes from the
  // value and the viewport, never from an element's height or position, all of which it reports
  // as 0. The spacer is that distance plus trigger's own height (0 here).
  describe('a dwell end', () => {
    it('resolves \'+=100%\' against the viewport, not the endTrigger', () => {
      const { query, controller } = setup();
      const trigger = query('.inside');

      controller.createStickyPin({ trigger, endTrigger: query('.scene'), end: '+=100%' });
      controller.refresh();

      // Read as a position clause instead, the '%' would resolve against the endTrigger's own
      // height, which is 0 here, collapsing the spacer.
      expect(trigger.parentElement!.style.height).toBe(`${window.innerHeight}px`);
    });

    it('resolves \'+=400\' as a plain px distance', () => {
      const { query, controller } = setup();
      const trigger = query('.inside');

      controller.createStickyPin({ trigger, endTrigger: query('.scene'), end: '+=400' });
      controller.refresh();

      expect(trigger.parentElement!.style.height).toBe('400px');
    });

    // The distance counts from where the pin engages, which the top option moves, so it stays a
    // hold of exactly 400px rather than 400 plus the offset.
    it('counts the distance from where the pin engages, not from trigger\'s own top', () => {
      const { query, controller } = setup();
      const trigger = query('.inside');

      controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 30, end: '+=400' });
      controller.refresh();

      expect(trigger.style.top).toBe('30px');
      expect(trigger.parentElement!.style.height).toBe('400px');
    });
  });

  // How long a pin against itself holds depends on layout, so the duration is e2e's job.
  it('accepts a pin with neither endTrigger nor end', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    expect(() => controller.createStickyPin({ trigger })).not.toThrow();
    expect(() => controller.refresh()).not.toThrow();
    expect(trigger.style.position).toBe('sticky');
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

  // A start clause resolves to a plain CSS top too, so it's verifiable here for the same reason.
  // With every element height 0, only the viewport side of the clause remains (window.innerHeight,
  // via measureViewportHeight's fallback).
  it('resolves a start clause into trigger.style.top', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene'), start: 'top 20%' });
    controller.refresh();

    expect(trigger.style.top).toBe(`${window.innerHeight * 0.2}px`);
  });

  it('supports a start clause whose element side is not \'top\' (e.g. \'bottom bottom\')', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene'), start: 'bottom bottom' });
    controller.refresh();

    // In a real browser this would be viewportHeight minus trigger's own height (see e2e).
    expect(trigger.style.top).toBe(`${window.innerHeight}px`);
  });

  it('re-evaluates a function-valued start on every refresh()', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    let offset = 10;

    controller.createStickyPin({
      trigger,
      endTrigger: query('.scene'),
      start: () => `top ${offset}px`,
    });
    controller.refresh();

    expect(trigger.style.top).toBe('10px');

    offset = 25;
    controller.refresh();

    expect(trigger.style.top).toBe('25px');
  });

  it('treats top: 39 and start: \'top 39px\' as the same pinned position', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), top: 39 });
    controller.createStickyPin({
      trigger: query('.outside'),
      endTrigger: query('.scene'),
      start: 'top 39px',
    });
    controller.refresh();

    expect(query('.inside').style.top).toBe('39px');
    expect(query('.outside').style.top).toBe('39px');
  });

  it('throws when both start and top are given', () => {
    const { query, controller } = setup();

    expect(() =>
      controller.createStickyPin({
        trigger: query('.inside'),
        endTrigger: query('.scene'),
        start: 'top top',
        top: 20,
      }),
    ).toThrow(/accepts either start or top, not both/);
  });

  // Reserving the bare-number slot for GSAP's meaning is what leaves a pin no way to spell a px
  // distance in `start`, so the error points at the option that covers it.
  it('throws on an absolute start (a bare number), pointing at top', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), start: 20 });

    expect(() => controller.refresh())
      .toThrow(/start "20" is an absolute scroll position[\s\S]*top: 20/);
  });

  it('throws on an absolute start given as a numeric string', () => {
    const { query, controller } = setup();

    controller.createStickyPin({
      trigger: query('.inside'),
      endTrigger: query('.scene'),
      start: '20',
    });

    expect(() => controller.refresh()).toThrow(/start "20" is an absolute scroll position/);
  });

  // Only a value that is nothing but a number is absolute; every clause spelling resolves exactly
  // as GSAP resolves it, including the one-token forms that name the element's own side. Locking
  // the boundary down here keeps a later change from moving a spelling across it unnoticed.
  it('resolves every clause spelling the way GSAP does', () => {
    const { query, controller } = setup();
    const tops: Record<string, string> = {};

    ([['a', 'top 20'], ['b', 'top 20px'], ['c', '20px'], ['d', '20 top']] as const)
      .forEach(([key, start]) => {
        document.body.insertAdjacentHTML('beforeend', `<div class="pin-${key}"></div>`);

        const trigger = query(`.pin-${key}`);

        controller.createStickyPin({ trigger, endTrigger: query('.scene'), start });
        controller.refresh();

        tops[key] = trigger.style.top;
      });

    expect(tops).toEqual({
      a: '20px', // viewport side, px suffix omitted
      b: '20px', // viewport side, explicit (and ignored) px suffix
      c: '-20px', // one token with a unit: the element's own side, viewport side defaulting to top
      d: '-20px', // two tokens: element side 20, viewport side top
    });
  });

  it('accepts a negative top, pinning above the viewport\'s top edge', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: -30 });
    controller.refresh();

    expect(trigger.style.top).toBe('-30px');
  });

  it('throws on a non-finite top', () => {
    const { query, controller } = setup();

    expect(() =>
      controller.createStickyPin({
        trigger: query('.inside'),
        endTrigger: query('.scene'),
        top: Number.NaN,
      }),
    ).toThrow(/top must be a finite number/);
  });

  it('throws on a function-valued top that returns a non-finite number', () => {
    const { query, controller } = setup();

    controller.createStickyPin({
      trigger: query('.inside'),
      endTrigger: query('.scene'),
      top: () => Number.POSITIVE_INFINITY,
    });

    expect(() => controller.refresh()).toThrow(/top must be a finite number/);
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

  // A pin's trigger belongs to the caller and may already carry inline position/top of its own.
  it('destroy() puts the caller\'s own inline position and top back', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    trigger.style.position = 'relative';
    trigger.style.top = '8px';

    controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 39 });
    controller.refresh();

    expect(trigger.style.position).toBe('sticky');

    controller.destroy();

    expect(trigger.style.position).toBe('relative');
    expect(trigger.style.top).toBe('8px');
  });

  it('destroy() puts back inline values set after registration', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    trigger.style.position = 'relative';
    trigger.style.top = '8px';

    controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 39 });

    trigger.style.top = '24px';

    controller.refresh();
    controller.destroy();

    expect(trigger.style.position).toBe('relative');
    expect(trigger.style.top).toBe('24px');
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

// Unlike Scene/Cover layers, createStickyPin's returned Vars uses onKill/onRefreshInit for
// pinLayers-specific cleanup and auto-refresh binding. A pin wraps/unwraps independently without
// going through the shared container, so the DOM teardown is synchronous; only the re-measure it
// forces on the layers below goes through scheduleRebuild's microtask.
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

  it('onKill puts the caller\'s own inline position and top back', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    trigger.style.position = 'relative';
    trigger.style.top = '8px';

    const vars = controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 39 });

    controller.refresh();
    vars.onKill?.(fakeSelf);

    expect(trigger.style.position).toBe('relative');
    expect(trigger.style.top).toBe('8px');
  });

  // The ordinary teardown order is destroy(), then killing the ScrollTriggers, so onKill runs on
  // a pin destroy() has already unwrapped.
  it('onKill after destroy() leaves the trigger\'s inline position alone', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 39 });

    controller.refresh();
    controller.destroy();

    trigger.style.position = 'fixed';
    trigger.style.top = '12px';

    vars.onKill?.(fakeSelf);

    expect(trigger.style.position).toBe('fixed');
    expect(trigger.style.top).toBe('12px');
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

  // jsdom has no layout, so this can't check the moved freeze windows (see the note at the top
  // of this file); e2e's pinKillRemeasure.html covers the numbers.
  it('onKill schedules a re-measure of the layers below', async () => {
    const { query, controller } = setup();
    const vars = controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene') });

    controller.refresh();

    const refreshSpy = vi.spyOn(controller, 'refresh');

    vars.onKill?.(fakeSelf);
    await Promise.resolve();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(FakeScrollTrigger.refresh).toHaveBeenCalledTimes(1);
  });

  // A pin killed before any refresh() never wrapped trigger, so nothing below it moved.
  it('onKill on a pin that was never built schedules nothing', async () => {
    const { query, controller } = setup();
    const vars = controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene') });
    const refreshSpy = vi.spyOn(controller, 'refresh');

    vars.onKill?.(fakeSelf);
    await Promise.resolve();

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(FakeScrollTrigger.refresh).not.toHaveBeenCalled();
  });

  it('pins killed in the same task share one re-measure', async () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="p1"></section>
        <section class="p2"></section>
        <section class="scene"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars = [
      controller.createStickyPin({ trigger: query('.p1'), endTrigger: query('.scene') }),
      controller.createStickyPin({ trigger: query('.p2'), endTrigger: query('.scene') }),
    ];

    controller.refresh();

    const refreshSpy = vi.spyOn(controller, 'refresh');

    vars.forEach((entry) => {
      entry.onKill?.(fakeSelf);
    });
    await Promise.resolve();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
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

  // A pin gets its own refresh() like a Scene layer does, so dispatching to the second pin
  // alone still pins it.
  it('a pin other than the first still calls refresh()', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="p1"></section>
        <section class="p2"></section>
        <section class="scene"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const p2 = query('.p2');

    controller.createStickyPin({ trigger: query('.p1'), endTrigger: query('.scene') });

    const vars2 = controller.createStickyPin({ trigger: p2, endTrigger: query('.scene') });

    vars2.onRefreshInit?.(fakeSelf);

    expect(p2.style.position).toBe('sticky');
  });
});

describe('createOverlapScroll input validation', () => {
  it('rejects pin/scroller/horizontal at runtime, not just the type level', () => {
    const { query, controller } = setup();

    expect(() => controller.createOverlapScroll({
      trigger: query('.scene'),
      // @ts-expect-error horizontal isn't supported (start/end are px on the vertical axis)
      horizontal: true,
    })).toThrow('createOverlapScroll: horizontal is not supported here');
  });

  it('throws naming trigger when cover cannot be found', () => {
    const { query, controller } = setup();

    // .inside is the container's last child, so trigger.nextElementSibling (cover's default)
    // finds nothing.
    expect(() => controller.createOverlapScroll({ trigger: query('.inside') })).toThrow(
      /cover element.*not found for trigger <section\.inside>/,
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

// Every refresh() takes the lift off and puts it back, which is the only thing that can raise a
// sibling the page has grown since registration. dom.test.ts covers liftAboveStickyWrapper itself;
// what's checked here is the re-run and what it leaves alone.
describe('cover z-order lift re-sync', () => {
  const fakeSelf = makeFakeSelf();

  const setupCover = () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="base"></section>
        <section class="cover"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars = controller.createOverlapScroll({ trigger: query('.base'), cover: query('.cover') });

    return { controller, vars };
  };

  // Appends to the covering side: a cover layer's wrapper takes everything up to trigger, so
  // whatever follows cover stays a child of the shared container whether or not it's built.
  const appendSection = (className: string) => {
    const el = document.createElement('section');

    el.className = className;
    query('.root').appendChild(el);

    return el;
  };

  it('lifts a sibling added after registration', () => {
    const { controller } = setupCover();
    const later = appendSection('later');

    expect(later.style.position).toBe('');

    controller.refresh();

    expect(later.style.position).toBe('relative');
    expect(later.style.zIndex).toBe('1');
  });

  // Without the re-run, the value written at registration would mask a position a breakpoint
  // turns on later.
  it('drops its own position once the caller\'s CSS turns one on', () => {
    const { controller } = setupCover();
    const cover = query('.cover');

    expect(cover.style.position).toBe('relative');

    document.body.insertAdjacentHTML('beforeend', '<style>.cover { position: absolute; }</style>');
    controller.refresh();

    expect(cover.style.position).toBe('');
    expect(getComputedStyle(cover).position).toBe('absolute');
    expect(cover.style.zIndex).toBe('1');
  });

  it('keeps a z-index the caller writes inline after registration', () => {
    const { controller } = setupCover();
    const cover = query('.cover');

    cover.style.zIndex = '5';
    controller.refresh();

    expect(cover.style.zIndex).toBe('5');
    expect(cover.style.position).toBe('relative');
  });

  it('still hands back the caller\'s own values after repeated refreshes', () => {
    const { controller } = setupCover();
    const cover = query('.cover');

    cover.style.zIndex = '5';
    controller.refresh();
    controller.refresh();
    controller.refresh();
    controller.destroy();

    expect(cover.style.zIndex).toBe('5');
    expect(cover.style.position).toBe('');
  });

  // onKill reads the restore out of the controller rather than closing over the one made at
  // registration, which knows nothing about .later.
  it('restores through onKill once a refresh has replaced the restore', () => {
    const { controller, vars } = setupCover();
    const later = appendSection('later');

    controller.refresh();

    expect(later.style.zIndex).toBe('1');

    vars.onKill!(fakeSelf);

    expect(query('.cover').style.position).toBe('');
    expect(later.style.position).toBe('');
    expect(later.style.zIndex).toBe('');
  });

  // Building moves the second layer's trigger and everything above it into a wrapper, which cuts
  // the first layer's sibling chain short at that trigger. The elements it loses that way are the
  // second layer's own covering side, so between them the two still reach everything.
  it('keeps every cover raised once building has narrowed what each layer enumerates', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="base-a"></section>
        <section class="cover-a"></section>
        <section class="base-b"></section>
        <section class="cover-b"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));

    controller.createOverlapScroll({ trigger: query('.base-a'), cover: query('.cover-a') });
    controller.createOverlapScroll({ trigger: query('.base-b'), cover: query('.cover-b') });
    controller.refresh();

    expect(query('.cover-a').style.zIndex).toBe('1');
    expect(query('.base-b').style.zIndex).toBe('1');
    expect(query('.cover-b').style.zIndex).toBe('1');
  });

  // The lift comes off before #wrapUnwrappedPins captures the pin's inline position, so the pin
  // saves what the caller left there rather than the lift's own 'relative'. It goes back on after
  // the wrapping, so it walks over the wrapper the pin put in trigger's place.
  it('lifts a pin\'s wrapper rather than the pinned element itself', () => {
    const { controller } = setupCover();
    const pinned = appendSection('pinned');

    controller.refresh();

    expect(pinned.style.position).toBe('relative');

    controller.createStickyPin({ trigger: pinned, endTrigger: query('.base') });
    controller.refresh();

    const outer = pinned.parentElement!.parentElement!;

    expect(outer.style.position).toBe('relative');
    expect(outer.style.zIndex).toBe('1');
    expect(pinned.style.zIndex).toBe('');

    controller.destroy();

    expect(pinned.style.position).toBe('');
  });

  // The lift comes off at the top of refresh(), so anything that throws before it goes back on
  // would leave the covering side behind the sticky wrapper until the next successful refresh().
  // wrapPin is the only such throw, and it takes a pin trigger the caller has since removed.
  it('keeps the covering side raised when the pin wrapping throws', () => {
    const { controller } = setupCover();
    const pinned = appendSection('pinned');

    controller.createStickyPin({ trigger: pinned, endTrigger: query('.base') });
    pinned.remove();

    expect(() => controller.refresh()).toThrow(/is not attached to the document/);

    expect(query('.cover').style.position).toBe('relative');
    expect(query('.cover').style.zIndex).toBe('1');
  });

  // Pinning the cover element itself moves it out of the sibling chain it heads, so the walk has
  // to start from the wrapper that took its place; starting from cover would reach cover alone.
  it('walks from the pin\'s wrapper when the cover element is itself pinned', () => {
    const { controller } = setupCover();
    const after = appendSection('after');

    controller.createStickyPin({ trigger: query('.cover'), endTrigger: query('.base') });
    controller.refresh();

    const outer = query('.cover').parentElement!.parentElement!;

    expect(outer.style.position).toBe('relative');
    expect(outer.style.zIndex).toBe('1');
    expect(after.style.zIndex).toBe('1');
  });
});

// GSAP's 'max' keyword (the scroller's max scroll position) is only mathematically solvable
// where the layer itself never contributes to document height: createOverlapScroll (cover layers
// never add padding) and resolveScrollPosition/createResolvedTrigger (they never register into
// `layers` or add height). For createStickyTrigger (Scene layers) and createStickyPin, the
// layer's own padding/spacer would contribute to the very document height 'max' measures, so the
// equation never converges, so these reject it with a clear error instead of producing an unstable
// value.
// Which offset each spelling resolves to, and that a cover layer accepts them, belongs to
// measure.test.ts: resolveEndSpec is where the keyword is read.
describe('\'max\' end keyword', () => {
  // The Scene layer rejection is measure.ts's, so this covers reachability only. The pin
  // rejection below is index.ts's own, which is why that one keeps its full message here.
  it('createStickyTrigger rejects end: \'max\' (a Scene layer\'s own dwell padding is self-referential)', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: 'max' });

    expect(() => controller.refresh()).toThrow(/end "max".*Use createOverlapScroll/s);
  });

  it('createStickyPin rejects end: \'max\' (the pin\'s own spacer is self-referential)', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), end: 'max' });

    expect(() => controller.refresh()).toThrow(
      /createStickyPin's end "max".*'max'.*isn't supported/,
    );
  });

  // An end that both starts with '+=' and holds a space takes the start clause's element token as
  // its base, so a start token carrying an offset of its own can't compose (see
  // prefixSpacedRelativeEnd). Both resolution paths reach it: the layer path through measureLayer,
  // the pin path through #refreshPinLayers. What the composed value resolves to needs a real
  // layout, since the whole difference is the start clause's fraction of endTrigger's height, and
  // jsdom reports every height as 0, so that half is e2e's job.
  it('createStickyTrigger rejects a spaced \'+=\' end against a start clause carrying an offset', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({
      trigger: query('.scene'),
      start: 'top+=50 bottom',
      end: '+=100 bottom',
    });

    expect(() => controller.refresh()).toThrow(
      /end "\+=100 bottom" can't be resolved against start "top\+=50 bottom".*"top\+=50" carries an offset/,
    );
  });

  it('createStickyPin rejects a spaced \'+=\' end against a start clause carrying an offset', () => {
    const { query, controller } = setup();

    controller.createStickyPin({
      trigger: query('.inside'),
      endTrigger: query('.scene'),
      start: 'top+=50 bottom',
      end: '+=100 bottom',
    });

    expect(() => controller.refresh()).toThrow(
      /end "\+=100 bottom" can't be resolved against start "top\+=50 bottom"/,
    );
  });

  // The third path. createResolvedTrigger hands GSAP resolved numbers, so GSAP's own prefixing
  // never sees this end and the module has to compose it instead.
  it('createResolvedTrigger rejects a spaced \'+=\' end against a start clause carrying an offset', () => {
    const { query, controller } = setup();
    const vars = controller.createResolvedTrigger({
      trigger: query('.scene'),
      start: 'top+=50 bottom',
      end: '+=100 bottom',
    });

    expect(() => (vars.end as () => number)()).toThrow(
      /end "\+=100 bottom" can't be resolved against start "top\+=50 bottom"/,
    );
  });

  // A start callback is GSAP's to invoke, so composing the end must not call it a second time for
  // a plain position clause, which resolves against endTrigger and never reads start.
  it('leaves a function-valued start uncalled for a plain position clause end', () => {
    const { query, controller } = setup();
    let calls = 0;
    const vars = controller.createResolvedTrigger({
      trigger: query('.scene'),
      start: () => {
        calls += 1;

        return 'top bottom';
      },
      end: 'top center',
    });

    (vars.end as () => number)();

    expect(calls).toBe(0);
  });

  // A dwell end counts from the resolved start, so it re-runs a function-valued start, the same
  // tradeoff the spaced '+=' prefix makes.
  it('re-runs a function-valued start for a dwell end', () => {
    const { query, controller } = setup();
    let calls = 0;
    const vars = controller.createResolvedTrigger({
      trigger: query('.scene'),
      start: () => {
        calls += 1;

        return 'top bottom';
      },
      end: '+=500',
    });

    (vars.end as () => number)();

    expect(calls).toBe(1);
  });

  // The composition itself stays off the dwell path: a '+=' end without a space is still a dwell
  // distance, which ignores endTrigger and start alike whatever the start clause says.
  it('leaves a space-free \'+=\' end a dwell distance under a non-top start clause', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({
      trigger,
      endTrigger: query('.scene'),
      start: 'center center',
      end: '+=400',
    });
    controller.refresh();

    expect(trigger.parentElement!.style.height).toBe('400px');
  });

  // refreshPins measures with every Scene/Cover layer's sticky state temporarily reset, and a
  // pin's own end rejection (the 'max' case above) throws from inside that window. Restoring on the
  // way out keeps one bad option value from stripping the sticky CSS off every layer on the page
  // and leaving it that way.
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

  // The same window, on the Scene/Cover path. The end has to be function-valued and flip only on
  // the second refresh: registering a layer with a rejected value up front marks the instance
  // dirty, and the rebuild that follows hands pass 1 brand-new wrappers with no sticky state to
  // restore.
  it('leaves Scene layer sticky state intact when a Scene option throws mid-refresh', () => {
    const { query, controller } = setup();
    const stuckWrappers = () =>
      [...document.querySelectorAll<HTMLElement>('div')]
        .filter((el) => el.style.position === 'sticky').length;
    let rejected = false;

    controller.createStickyTrigger({
      trigger: query('.scene'),
      start: 'top top',
      end: () => (rejected ? 'max' : '+=500'),
    });
    controller.refresh();

    const before = stuckWrappers();

    rejected = true;

    expect(() => controller.refresh()).toThrow(/'max'/);
    expect(before).toBeGreaterThan(0);
    expect(stuckWrappers()).toBe(before);
  });

  // The third case in the same family, and the one the two above leave open: the pins' own state.
  // The throwing pin is registered first here, so pass 2 aborts before it reaches the good one.
  it('leaves the other pins\' sticky state intact when a pin option throws mid-refresh', () => {
    const { query, controller } = setup();
    let rejected = false;

    controller.createStickyPin({
      trigger: query('.outside'),
      endTrigger: query('.scene'),
      end: () => (rejected ? 'max' : 'top top'),
    });
    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), top: 39 });
    controller.refresh();

    const good = query('.inside');
    const spacer = good.parentElement!;

    expect(good.style.position).toBe('sticky');
    expect(good.style.top).toBe('39px');
    expect(spacer.style.height).toBe('39px');

    rejected = true;

    expect(() => controller.refresh()).toThrow(/'max' keyword/);
    expect(good.style.position).toBe('sticky');
    expect(good.style.top).toBe('39px');
    expect(spacer.style.height).toBe('39px');
  });

  // The rollback reaches pins pass 2 had already rewritten, not just the ones it never got to.
  // The rewritten pin's top changes on the failing refresh, so a half-written result shows 77px.
  it('rolls an already-rewritten pin back to the last successful refresh', () => {
    const { query, controller } = setup();
    let pinnedTop = 39;
    let rejected = false;

    controller.createStickyPin({
      trigger: query('.inside'),
      endTrigger: query('.scene'),
      top: () => pinnedTop,
    });
    controller.createStickyPin({
      trigger: query('.outside'),
      endTrigger: query('.scene'),
      end: () => (rejected ? 'max' : 'top top'),
    });
    controller.refresh();

    const good = query('.inside');

    expect(good.style.top).toBe('39px');

    pinnedTop = 77;
    rejected = true;

    expect(() => controller.refresh()).toThrow(/'max' keyword/);
    expect(good.style.top).toBe('39px');
  });

  // The reserved space is the one pin value the rollback doesn't restore, and doesn't need to:
  // it's re-measured before pass 2 runs, so a failing refresh leaves it matching what the page
  // renders rather than stripped or half applied. Stripped is the live risk, since the measuring
  // starts by clearing it.
  it('keeps the reserved space current through a pin option that throws mid-refresh', () => {
    const { query, controller } = setup();
    const good = query('.inside');
    let rejected = false;

    document.head.innerHTML = '<style>.root > div { height: 30px }</style>';
    controller.createStickyPin({ trigger: good, endTrigger: query('.scene') });
    controller.createStickyPin({
      trigger: query('.outside'),
      endTrigger: query('.scene'),
      end: () => (rejected ? 'max' : 'top top'),
    });
    controller.refresh();

    const outer = good.parentElement!.parentElement!;

    expect(outer.style.height).toBe('30px');

    document.head.innerHTML = '<style>.root > div { height: 50px }</style>';
    rejected = true;

    expect(() => controller.refresh()).toThrow(/'max' keyword/);
    expect(outer.style.height).toBe('50px');
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
// which is already document-absolute and works with either. The rejection is measure.ts's, so the
// two below cover reachability only, once per spelling a caller can pass.
describe('absolute start (a bare number)', () => {
  it('createOverlapScroll rejects a numeric-string start', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside'), start: '500' });

    expect(() => controller.refresh()).toThrow(/absolute scroll position/);
  });

  it('createOverlapScroll rejects a plain-number start', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside'), start: 500 });

    expect(() => controller.refresh()).toThrow(/absolute scroll position/);
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
// That both spellings are accepted, on either kind of layer (unlike start, end has no cover-layer
// restriction), belongs to measure.test.ts.
describe('absolute end (a bare number)', () => {
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

// What reaches scrollMargin.ts through this module: the option, and the two calls. Its own
// bookkeeping (the lag arithmetic, the author's value, handing targets back) is
// scrollMargin.test.ts's, which calls sync() directly with real freeze windows rather than working
// around jsdom's layout-free zeros the way the '+=800' below has to.
describe('scroll-margin-top synchronization', () => {
  // Each controller registers its own custom-property names off a module-level counter, so the
  // exact index depends on how many instances the whole suite has built by now.
  const correction = (lagPx: number) =>
    new RegExp(
      '^calc\\(0px \\+ var\\(--sst-scroll-margin-top-offset, 0px\\) \\+ var\\(--sst\\d+-c0, 0px\\) '
      + `- ${lagPx}px\\)$`,
    );

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

  // The one proof that refresh() reaches sync() at all, and with the freeze windows its passes
  // settled rather than the raw '+=800': #before sits above the scene, so no dwell precedes it,
  // while #after is delayed by the full 800.
  it('writes a correction from the freeze windows refresh() settled', () => {
    const { query, controller } = setupAnchors();

    controller.refresh();

    expect(query('#before').style.scrollMarginTop).toMatch(correction(0));
    expect(query('#after').style.scrollMarginTop).toMatch(correction(800));
  });

  // Stays here rather than moving with the rest: it's the shared container this module hands
  // sync() that keeps the search off the whole document, and scrollMargin.test.ts builds a root of
  // its own, so a sync given document.documentElement would go unnoticed there.
  it('leaves elements outside the shared container alone', () => {
    const { query, controller } = setupAnchors();

    controller.refresh();

    expect(query('#outside').style.scrollMarginTop).toBe('');
  });

  it('hands every target back on destroy', () => {
    const { query, controller } = setupAnchors();

    query('#after').style.scrollMarginTop = '40px';
    controller.refresh();
    controller.destroy();

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).toBe('40px');
  });

  it('writes nothing when scrollMarginTargets is null', () => {
    const { query, controller } = setupAnchors({ scrollMarginTargets: null });

    controller.refresh();

    expect(query('#after').style.scrollMarginTop).toBe('');
  });

  it('honors a custom scrollMarginTargets selector', () => {
    const { query, controller } = setupAnchors({ scrollMarginTargets: '#after' });

    controller.refresh();

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).not.toBe('');
  });

  it('rejects an invalid scrollMarginTargets selector at construction', () => {
    expect(() => setupAnchors({ scrollMarginTargets: ':not(' })).toThrow(
      'scrollMarginTargets ":not(" is not a valid CSS selector',
    );
  });
});

// Two properties of refresh()'s pass order that leave no trace in the DOM, which is why the tests
// below watch writes instead of reading a result. Comments in index.ts are their only other
// record, so any structural change to refresh() has to keep these passing.
describe('refresh() pass ordering', () => {
  // Shadows one CSSOM property on a single element's own style object, logging each write on its
  // way to the real setter. That setter is on the prototype chain, hence the walk.
  const traceStyleProperty = (
    el: HTMLElement,
    property: string,
    onWrite: (value: string) => void,
  ) => {
    const style = el.style;
    let node: object | null = style;
    let descriptor: PropertyDescriptor | undefined;

    while (node && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(node, property);
      node = Object.getPrototypeOf(node) as object | null;
    }

    const { get, set } = descriptor!;

    Object.defineProperty(style, property, {
      configurable: true,
      get: () => get!.call(style),
      set: (value: string) => {
        onWrite(value);
        set!.call(style, value);
      },
    });
  };

  // Freeze windows are only ever assigned in #refreshScenesAndCovers, so folding the sync into
  // the Scene pass would compute the same corrections and leave the same DOM behind. The order
  // separates writing from measuring. #syncScrollMargins writes style on the targets and the
  // container, then #refreshPins measures layout. An earlier sync recalcs style in between.
  it('writes scroll margins after the pin pass, not with the Scene pass', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="scene"></section>
        <section class="pin"></section>
        <div id="anchor"></div>
      </div>
    `;

    const controller = new StickyScrollTrigger(query('.root'));

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=800' });
    controller.createStickyPin({ trigger: query('.pin') });
    // This refresh builds and wraps, so the traced one below runs against a steady state.
    controller.refresh();

    const log: string[] = [];

    // Only #refreshPins writes trigger's own `top`, unlike the spacer height #reservePinSpace
    // also touches.
    traceStyleProperty(query('.pin'), 'top', () => log.push('pin'));
    traceStyleProperty(query('#anchor'), 'scrollMarginTop', () => log.push('scrollMargin'));
    controller.refresh();

    expect(log).toContain('pin');
    expect(log).toContain('scrollMargin');
    expect(log.lastIndexOf('pin')).toBeLessThan(log.indexOf('scrollMargin'));
  });

  // #refreshPins early-returns before it reaches #resetSceneCoverStickyState, so a controller with
  // no pins never strips a Scene wrapper on the pin pass's behalf. Bracketing the pin pass with a
  // Scene-side reset would leave the same DOM, having stripped and restored every wrapper on the
  // page for nothing.
  it('strips a Scene wrapper once per refresh when no pin is registered', () => {
    const countStrips = (register: (controller: StickyScrollTrigger) => void) => {
      document.body.innerHTML = `
        <div class="root">
          <section class="scene"></section>
          <section class="pin"></section>
        </div>
      `;

      const controller = new StickyScrollTrigger(query('.root'));

      controller.createStickyTrigger({ trigger: query('.scene'), end: '+=800' });
      register(controller);
      controller.refresh();

      let strips = 0;

      // A Scene layer freezes the whole shared container, so its wrapper is around the root, not
      // around trigger. Only a reset writes '', so the count is how many passes reached one.
      traceStyleProperty(query('.root').parentElement!, 'position', (value) => {
        if (value === '') strips += 1;
      });
      controller.refresh();

      return strips;
    };

    expect(countStrips(() => {})).toBe(1);
    expect(
      countStrips((controller) => controller.createStickyPin({ trigger: query('.pin') })),
    ).toBe(2);
  });
});
