// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// A ScrollTrigger class whose refresh the test runs. getScrollFunc() holds GSAP's scroll record.
const makeClass = (scroller: { rec?: unknown }) => {
  const listeners: (() => unknown)[] = [];
  const refreshListeners: (() => unknown)[] = [];

  class Cls {
    static refresh = vi.fn();

    static isRefreshing = false;

    static scrolling = false;

    static isScrolling = () => Cls.scrolling;

    static isUpdating = false;

    static getScrollFunc = () => scroller;

    static addEventListener = (type: string, callback: () => unknown) => {
      if (type === 'refreshInit') listeners.push(callback);

      if (type === 'refresh') refreshListeners.push(callback);
    };

    static removeEventListener = (type: string, callback: () => unknown) => {
      const list = type === 'refreshInit' ? listeners : type === 'refresh' ? refreshListeners : null;

      if (list?.includes(callback)) list.splice(list.indexOf(callback), 1);
    };
  }

  // GSAP's refreshInit dispatch, with isRefreshing set. GSAP measures right after it, then
  // dispatches 'refresh' (complete); without it the refresh is one that threw before then. live:
  // GSAP's own map over the listener array, which a listener taken off or added during it shifts.
  const gsapRefresh = (complete = false, live = false) => {
    Cls.isRefreshing = true;
    (live ? listeners : [...listeners]).map((callback) => callback());
    Cls.isRefreshing = false;

    if (complete) [...refreshListeners].forEach((callback) => callback());
  };

  return { Cls, listeners, gsapRefresh };
};

// How often one refresh() of the instance calls an end function, so a test can count refreshes
// by it. Holds while the function returns the same value throughout the refreshes counted.
const endCallsPerRefresh = (controller: StickyScrollTrigger, end: ReturnType<typeof vi.fn>) => {
  end.mockClear();
  controller.refresh();

  const calls = end.mock.calls.length;

  end.mockClear();
  expect(calls).toBeGreaterThan(0);

  return calls;
};

// Runs the queued microtasks and the ones they queue, so a test checks what is done by the end of
// the task. Work moved to a later task still shows as not done.
const flushMicrotasks = async () => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
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
    await flushMicrotasks();
  } finally {
    process.off('uncaughtException', onUncaught);
  }

  return uncaught;
};

beforeEach(() => {
  FakeScrollTrigger.refresh.mockClear();
  // Cleared alongside the body each setup() swaps out, so a stylesheet one test installs can't
  // reach the next one.
  document.head.innerHTML = '';
});

// A query helper reused across tests. Since document.body.innerHTML is swapped out each time,
// there's no need to redefine this per test.
const query = (sel: string) => document.querySelector<HTMLElement>(sel)!;

// jsdom puts every element at 0, and resolveScrollPosition only adds a Scene layer's dwell to an
// element that reaches its anchor after that freeze starts, so a test that needs the dwell counted
// moves its element down first. offsetParent stays null, so this is its whole documentTop.
const placeAt = (el: HTMLElement, top: number) => {
  Object.defineProperty(el, 'offsetTop', { configurable: true, value: top });
};

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
// trigger/endTrigger). dom.test.ts owns how resolveElement resolves one and how it phrases a
// failure; what these check is that each entry point reaches it, and hands it its own name, which
// is the half of the message dom.test.ts can't see from the outside.
describe('selector-string support for trigger/endTrigger/cover', () => {
  it('resolves a selector for createStickyTrigger, createResolvedTrigger and resolveScrollPosition, builds and refreshes cleanly, and names the caller when one matches nothing', () => {
    const { query, controller } = setup();

    expect(controller
      .createStickyTrigger({ trigger: '.scene', end: 'top top', endTrigger: '.inside' }).trigger)
      .toBe(query('.scene'));
    expect(controller.createResolvedTrigger({ trigger: '.inside' }).trigger).toBe(query('.inside'));
    expect(controller.resolveScrollPosition('.inside', 'top top'))
      .toBe(controller.resolveScrollPosition(query('.inside'), 'top top'));
    // Confirms the selector resolved to a real element the build machinery can wrap, not just one
    // resolveElement can return.
    expect(() => controller.refresh()).not.toThrow();
    // Each method hands resolveElement its own name, which is what the message has to carry.
    expect(() => controller.createStickyTrigger({ trigger: '.Missing' }))
      .toThrow(/createStickyTrigger: element "\.Missing" not found/);
  });

  it('createStickyPin accepts trigger/endTrigger as selector strings', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: '.inside', endTrigger: '.scene' });
    controller.refresh();

    expect(query('.inside').style.position).toBe('sticky');
  });

  // cover is the one option with a resolution call site of its own.
  it('createOverlapScroll accepts trigger/cover/endTrigger as selector strings', () => {
    const { query, controller } = setup();
    const vars = controller.createOverlapScroll({ trigger: '.scene', cover: '.inside' });

    expect(vars.trigger).toBe(query('.scene'));
    expect(query('.inside').style.position).toBe('relative'); // confirms cover was resolved correctly
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
  // into two cases: a Scene layer's is rejected outright (see measure.ts's resolveEndSpec), a
  // cover layer's resolves (see freezeWindow.test.ts's "a Cover layer's forward reference
  // resolves..." for the numeric verification).
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

  // Every refresh() rewrites padding height and sticky top, i.e. changes layout, so by default
  // this wants function-valued tween props re-measured too (see the comment on
  // registerLayer's definition). An explicit value from the caller still wins.
  it('defaults invalidateOnRefresh to true, and respects an explicit value', () => {
    const { query, controller } = setup();

    expect(controller.createStickyTrigger({ trigger: query('.scene') }).invalidateOnRefresh)
      .toBe(true);
    expect(controller.createStickyTrigger({
      trigger: query('.inside'),
      invalidateOnRefresh: false,
    }).invalidateOnRefresh).toBe(false);
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

  // The rest of GSAP's pin family, plus containerAnimation, share #assertNoExcludedVars with
  // pin/horizontal/scroller above; one registration method is enough to prove it rejects each of
  // these too, since the check itself doesn't vary by call site. A computed key bypasses excess-
  // property checking entirely, unlike the literal keys above (each needing its own suppression
  // comment), so this one is runtime coverage only. trigger/start/end/endTrigger are in
  // EXCLUDED_VAR_KEYS as well, but never reach this check: every registration method consumes them
  // by name in the destructuring before `...rest`, for a plain JS/JSON caller the same as for one
  // honoring the types, so the destructuring alone already rules them out.
  it('rejects every other GSAP pin option, and containerAnimation, the same way', () => {
    const { query, controller } = setup();
    const excluded = [
      ['pinSpacing', true],
      ['anticipatePin', 1],
      ['pinnedContainer', document.body],
      ['pinReparent', true],
      ['pinSpacer', document.body],
      ['pinType', 'transform'],
      ['containerAnimation', {}],
    ] as const;

    excluded.forEach(([key, value]) => {
      const trigger = query('.root').appendChild(document.createElement('section'));

      expect(() => controller.createStickyTrigger({ trigger, [key]: value }))
        .toThrow(`createStickyTrigger: ${key} is not supported here`);
    });
  });

  // found.join(', ') pluralizes to 'are' once more than one excluded key is passed together,
  // untested by the single-key rejections above. TypeScript's excess-property check reports once
  // per object literal rather than once per excess key, so only the first needs its own directive.
  it('pluralizes the message when more than one excluded option is passed at once', () => {
    const { query, controller } = setup();

    expect(() => controller.createStickyTrigger({
      trigger: query('.scene'),
      // @ts-expect-error both horizontal and scroller below are excluded
      horizontal: true,
      scroller: document.body,
    })).toThrow('createStickyTrigger: horizontal, scroller are not supported here');
  });
});

// The onRefreshInit registerLayer returns binds refresh() to the refreshInit GSAP itself fires
// (resize/load, etc.), letting callers skip manually binding
// ScrollTrigger.addEventListener('refreshInit', refresh). This test bypasses GSAP and
// simulates it by directly calling the same Vars.onRefreshInit GSAP would call.
describe('registerLayer\'s onRefreshInit', () => {
  const fakeSelf = makeFakeSelf();

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
    // A refresh evaluates every layer's start once, so s1's start counts the refreshes.
    const refreshes = vi.fn(() => '0 0');
    const refreshesBefore: number[] = [];

    const track = () => () => {
      refreshesBefore.push(refreshes.mock.calls.length);
    };

    const vars = ['.s1', '.s2', '.s3'].map((selector, index) => controller.createStickyTrigger({
      trigger: query(selector),
      ...(index === 0 ? { start: refreshes } : {}),
      end: '+=100',
      onRefreshInit: track(),
    }));

    vars.forEach(({ onRefreshInit }) => onRefreshInit?.(fakeSelf));

    expect(refreshesBefore).toEqual([0, 1, 2]);
    expect(refreshes).toHaveBeenCalledTimes(3);
  });

  describe('inside GSAP\'s refresh', () => {
    class RefreshingScrollTrigger {
      static refresh = vi.fn();

      static isRefreshing = true;
    }

    const refreshingSelf = Object.create(RefreshingScrollTrigger.prototype) as ScrollTrigger;

    const setupThree = (callbacks: ((() => void) | undefined)[] = []) => {
      document.body.innerHTML = `
        <div class="root">
          <section class="s1"></section>
          <section class="s2"></section>
          <section class="s3"></section>
        </div>`;

      const controller = new StickyScrollTrigger(query('.root'));
      // A refresh evaluates every layer's start once, so s1's start counts the refreshes.
      const refreshes = vi.fn(() => '0 0');
      const vars = ['.s1', '.s2', '.s3'].map((selector, index) => controller.createStickyTrigger({
        trigger: query(selector),
        ...(index === 0 ? { start: refreshes } : {}),
        end: '+=100',
        onRefreshInit: callbacks[index],
      }));

      return { controller, vars, refreshes };
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('refreshes once when nothing changes between the layers\' calls', () => {
      const { vars, refreshes } = setupThree();

      vars.forEach(({ onRefreshInit }) => onRefreshInit?.(refreshingSelf));

      expect(refreshes).toHaveBeenCalledTimes(1);
    });

    it('refreshes again once the DOM has changed since', () => {
      const { vars, refreshes } = setupThree();

      vars[0].onRefreshInit?.(refreshingSelf);
      query('.s2').style.height = '500px';
      vars[1].onRefreshInit?.(refreshingSelf);
      vars[2].onRefreshInit?.(refreshingSelf);

      expect(refreshes).toHaveBeenCalledTimes(2);
    });

    // A registration changes no DOM until the rebuild, and a layer created during GSAP's dispatch
    // gets no call of its own in it.
    it('refreshes again once a layer has been registered since', () => {
      const { controller, vars, refreshes } = setupThree();
      const added = document.createElement('section');

      query('.root').append(added);
      vars[0].onRefreshInit?.(refreshingSelf);
      controller.createStickyTrigger({ trigger: added, end: '+=100' });
      vars[1].onRefreshInit?.(refreshingSelf);

      expect(refreshes).toHaveBeenCalledTimes(2);
      expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(4);
    });

    // A kill from a start function, say: its rebuild waits for the batch, which GSAP would only
    // run after every layer's call.
    it('refreshes again once a layer has been killed since', () => {
      const { vars, refreshes } = setupThree();

      vars[0].onRefreshInit?.(refreshingSelf);
      vars[2].onKill?.(refreshingSelf);
      vars[1].onRefreshInit?.(refreshingSelf);

      expect(refreshes).toHaveBeenCalledTimes(2);
      expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(2);
    });

    // A callback can change what refresh() reads without touching the DOM: a variable a
    // function-valued end reads, say.
    it('refreshes after every layer\'s own callback', () => {
      let dwell = 100;
      const { vars, refreshes } = setupThree([undefined, () => {
        dwell = 300;
      }]);

      vars.forEach(({ onRefreshInit }) => onRefreshInit?.(refreshingSelf));

      expect(dwell).toBe(300);
      expect(refreshes).toHaveBeenCalledTimes(2);
    });

    it('refreshes again in the next GSAP refresh', async () => {
      const { vars, refreshes } = setupThree();

      vars.forEach(({ onRefreshInit }) => onRefreshInit?.(refreshingSelf));
      await flushMicrotasks();
      vars.forEach(({ onRefreshInit }) => onRefreshInit?.(refreshingSelf));

      expect(refreshes).toHaveBeenCalledTimes(2);
    });

    // ScrollTrigger.refresh() twice in one task, a variable an end reads changed in between.
    it('refreshes again in a second GSAP refresh in the same task', () => {
      const refreshListeners: (() => void)[] = [];

      Object.assign(RefreshingScrollTrigger, {
        addEventListener: (type: string, callback: () => void) => {
          if (type === 'refresh') refreshListeners.push(callback);
        },
        removeEventListener: vi.fn(),
      });

      try {
        const { vars, refreshes } = setupThree();

        vars.forEach(({ onRefreshInit }) => onRefreshInit?.(refreshingSelf));
        [...refreshListeners].forEach((callback) => callback());
        vars.forEach(({ onRefreshInit }) => onRefreshInit?.(refreshingSelf));

        expect(refreshes).toHaveBeenCalledTimes(2);
      } finally {
        Object.assign(RefreshingScrollTrigger, {
          addEventListener: undefined,
          removeEventListener: undefined,
        });
      }
    });
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
  // and rebuild into a single pass (deferred to the end of the task). Naively tearing down and
  // rebuilding synchronously on every kill would move the subtree containing rootElement
  // once per kill, causing internal iframes to reload and focus to be lost.
  it('synchronous kills merge into one pass at the end of the task (no immediate rebuild)', async () => {
    const { query, vars } = setupThreeScenes();
    const wrapperBefore = query('.root').parentElement;

    vars[0].onKill?.(fakeSelf);
    vars[1].onKill?.(fakeSelf);
    // still synchronous: waiting on the batch, so the DOM shouldn't have moved at all yet
    expect(query('.root').parentElement).toBe(wrapperBefore);
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(3);

    await flushMicrotasks();
    expect(query('.root').parentElement).not.toBe(wrapperBefore);
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
  });

  // Nothing is left to rebuild, so the one move back to host happens in the kill's own task.
  it('killing every layer puts root back at once, and the batch still refreshes GSAP', async () => {
    const { query, vars } = setupThreeScenes();

    vars.forEach((entry) => {
      entry.onKill?.(fakeSelf);
    });
    expect(query('.root').parentElement).toBe(document.querySelector('.host'));
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);

    await flushMicrotasks();
    expect(FakeScrollTrigger.refresh).toHaveBeenCalledTimes(1);
  });

  // The caller's onKill runs after the instance has handed the page back, as GSAP's own onKill
  // runs after its cleanup.
  it('the last kill hands the page back before the caller\'s onKill runs', () => {
    document.body.innerHTML = '<div class="host"><div class="root"><section class="s1"></section></div></div>';

    const controller = new StickyScrollTrigger(query('.root'));
    let parentInOnKill: Element | null = null;
    const vars = controller.createStickyTrigger({
      trigger: query('.s1'),
      end: '+=100',
      onKill: () => {
        parentInOnKill = query('.root').parentElement;
      },
    });

    controller.refresh();
    vars.onKill?.(fakeSelf);

    expect(parentInOnKill).toBe(query('.host'));
  });

  it('layers that survive a partial kill are still correctly recomputed after the batch', async () => {
    const { vars } = setupThreeScenes();
    const survivorStartBefore = (vars[2].start as () => number)();

    vars[0].onKill?.(fakeSelf);
    vars[1].onKill?.(fakeSelf);
    await flushMicrotasks();

    // precedingGaps changes now that s1 and s2 are gone, so s3's (the survivor's)
    // freezeStart should be recomputed and move.
    expect((vars[2].start as () => number)()).not.toBe(survivorStartBefore);
    // only one padding remains, for the surviving s3 (both s1's and s2's are gone).
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
  });

  // gsap.matchMedia reverts the old setup and runs the next one in the same task, so a cover
  // wrapper left for the batch would hide trigger's siblings from that setup.
  it('a killed cover layer\'s wrapper comes off at once, without waiting for the batch', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="base"></section>
        <section class="cover"></section>
        <section class="tail"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars = controller.createOverlapScroll({ trigger: query('.base') });

    controller.refresh();
    expect(query('.base').nextElementSibling).toBeNull();

    vars.onKill?.(fakeSelf);

    expect(query('.base').parentElement).toBe(query('.root'));
    expect(query('.base').nextElementSibling).toBe(query('.cover'));
    expect(query('.root').children).toHaveLength(3);
  });

  // Inside a Scene layer's container the kill unwraps the cover in place, leaving the batch's
  // teardown nothing to undo for it.
  it('a cover killed inside a Scene layer\'s container comes off at once and the Scene is rebuilt', async () => {
    document.body.innerHTML = `
      <div class="host">
        <div class="root">
          <section class="scene"></section>
          <section class="base"></section>
          <section class="cover"></section>
        </div>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });

    const vars = controller.createOverlapScroll({ trigger: query('.base') });

    controller.refresh();
    vars.onKill?.(fakeSelf);

    const children = () => Array.from(query('.root').children, (el) => el.className);

    expect(children()).toEqual(['scene', 'base', 'cover']);
    expect(query('.root').parentElement).not.toBe(query('.host'));

    await flushMicrotasks();

    expect(children()).toEqual(['scene', 'base', 'cover']);
    expect(query('.root').parentElement).not.toBe(query('.host'));
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
  });

  // #builtLayers still lists the killed layer until the batch, its wrapper already off: destroy()'s
  // teardown has to pass over it.
  it('destroy() right after a cover\'s kill restores the DOM', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="base"></section>
        <section class="cover"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars = controller.createOverlapScroll({ trigger: query('.base') });

    controller.refresh();
    vars.onKill?.(fakeSelf);
    controller.destroy();

    expect(Array.from(query('.root').children, (el) => el.className)).toEqual(['base', 'cover']);
    expect(query('.cover').style.cssText).toBe('');
  });

  // The default cover is trigger.nextElementSibling, and an explicit one has to be trigger's
  // sibling: both threw while the wrapper stayed.
  it.each([
    ['the default cover', false],
    ['an explicit cover', true],
  ])('re-registering the same cover trigger with %s in the kill\'s task builds it again after the batch', async (_, explicit) => {
    document.body.innerHTML = `
      <div class="root">
        <section class="base"></section>
        <section class="cover"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const options = { trigger: query('.base'), ...(explicit ? { cover: query('.cover') } : {}) };
    const killed = controller.createOverlapScroll(options);

    controller.refresh();
    killed.onKill?.(fakeSelf);
    controller.createOverlapScroll(options);
    controller.refresh();
    await flushMicrotasks();

    expect(query('.base').parentElement).not.toBe(query('.root'));
    expect(query('.base').parentElement!.parentElement).toBe(query('.root'));
    expect(query('.root').lastElementChild).toBe(query('.cover'));
    // The re-created layer lifts cover again.
    expect(query('.cover').style.cssText).toBe('position: relative; z-index: 1;');
  });

  // Two covers in one parent nest: the later trigger's wrapper holds the earlier one's. Killing
  // either leaves the other's wrapper holding exactly what it held.
  describe.each([
    ['the outer (later) one', 1, '.b', '.a'],
    ['the inner (earlier) one', 0, '.a', '.b'],
  ])('killing %s of two covers in one parent', (_, killedIndex, killedSelector, survivorSelector) => {
    const setup = () => {
      document.body.innerHTML = `
        <div class="root">
          <section class="a"></section>
          <section class="a-cover"></section>
          <section class="b"></section>
          <section class="b-cover"></section>
        </div>`;

      const controller = new StickyScrollTrigger(query('.root'));
      const vars = [
        controller.createOverlapScroll({ trigger: query('.a') }),
        controller.createOverlapScroll({ trigger: query('.b') }),
      ];

      controller.refresh();

      return vars;
    };

    const order = () => Array.from(query('.root').querySelectorAll('section'), (el) => el.className);

    it('keeps the document order and the survivor wrapped, before and after the batch', async () => {
      const vars = setup();

      vars[killedIndex].onKill?.(fakeSelf);

      expect(order()).toEqual(['a', 'a-cover', 'b', 'b-cover']);
      expect(query(killedSelector).nextElementSibling).toBe(query(`${killedSelector}-cover`));
      expect(query(survivorSelector).nextElementSibling).toBeNull();

      await flushMicrotasks();

      expect(order()).toEqual(['a', 'a-cover', 'b', 'b-cover']);
      expect(query(survivorSelector).nextElementSibling).toBeNull();
      expect(query(survivorSelector).parentElement!.parentElement).toBe(query('.root'));
    });
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
    it('calls GSAP\'s static refresh once, after the batch rather than per kill', async () => {
      const { vars } = setupThreeScenes();

      vars.forEach((entry) => {
        entry.onKill?.(fakeSelf);
      });

      expect(FakeScrollTrigger.refresh).not.toHaveBeenCalled(); // still waiting on the batch
      await flushMicrotasks();
      expect(FakeScrollTrigger.refresh).toHaveBeenCalledTimes(1);
    });

    // GSAP calls onKill on every kill().
    it.each(['scene', 'cover'])('a repeated kill of a %s layer only calls the caller\'s onKill', async (kind) => {
      document.body.innerHTML = `
        <div class="root">
          <section class="s1"></section><section class="s2"></section><section class="s3"></section>
        </div>`;

      const controller = new StickyScrollTrigger(query('.root'));
      const onKill = vi.fn();
      const vars = kind === 'scene'
        ? controller.createStickyTrigger({ trigger: query('.s1'), end: '+=100', onKill })
        : controller.createOverlapScroll({ trigger: query('.s1'), onKill });

      controller.createStickyTrigger({ trigger: query('.s3'), end: '+=100' });
      controller.refresh();
      vars.onKill?.(fakeSelf);
      await flushMicrotasks();
      FakeScrollTrigger.refresh.mockClear();
      vars.onKill?.(fakeSelf);
      await flushMicrotasks();

      expect(onKill).toHaveBeenCalledTimes(2);
      expect(FakeScrollTrigger.refresh).not.toHaveBeenCalled();
      controller.destroy();
    });

    it('has recomputed freezeStart/End by the time GSAP measures', async () => {
      const { vars } = setupThreeScenes();
      const { Cls, gsapRefresh } = makeClass({ rec: 0 });
      const self = Object.create(Cls.prototype) as ScrollTrigger;
      const survivorStartBefore = (vars[2].start as () => number)();
      let survivorStartWhenMeasured: number | undefined;

      Cls.refresh.mockImplementationOnce(() => {
        gsapRefresh();
        survivorStartWhenMeasured = (vars[2].start as () => number)();
      });

      vars[0].onKill?.(self);
      vars[1].onKill?.(self);
      await flushMicrotasks();

      // GSAP measuring before the batch's refresh() would read s3's stale freezeStart.
      expect(survivorStartWhenMeasured).not.toBe(survivorStartBefore);
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
      await flushMicrotasks();

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

    controller.destroy();

    expect(query('.root').parentElement).toBe(document.body);
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);
  });

  // On the README-recommended cover-only path, Vars is built but never passed to
  // ScrollTrigger.create(), so GSAP's onKill never fires, and refresh() may never have run either.
  // destroy() is the only entry point left that can restore that z-order.
  it('restores a cover layer\'s z-order with no ScrollTrigger.create() and no refresh()', () => {
    const { query, controller } = setup();

    controller.createOverlapScroll({ trigger: query('.scene'), cover: query('.inside') });

    expect(query('.inside').style.position).toBe('relative');
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

  it('leaves a later refresh() and a second destroy() as harmless no-ops', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });
    controller.refresh();
    controller.destroy();

    const parentAfterDestroy = query('.root').parentElement;

    expect(() => controller.refresh()).not.toThrow();
    expect(() => controller.destroy()).not.toThrow();
    expect(query('.root').parentElement).toBe(parentAfterDestroy);
  });

  it('never rebuilds after destroy(), even with a pending kill batch', async () => {
    const { query, controller } = setup();
    const vars = controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });

    controller.refresh();

    vars.onKill?.(fakeSelf); // schedules the batch (not yet run)
    controller.destroy();

    const parentAfterDestroy = query('.root').parentElement;

    await flushMicrotasks(); // let the scheduled batch run

    expect(query('.root').parentElement).toBe(parentAfterDestroy); // nothing changed
  });
});

// jsdom has no layout and offsetTop/offsetHeight are always 0, so the corrected px values can't be
// verified here (that's e2e's job). What's left is what survives without layout: that a
// function-valued position is called, that a malformed clause reaches position.ts's rejection, that
// an absolute value passes through untouched, and that cover layers stay out of the gap total,
// which a dwell distance makes exact even at 0.
// gsap.matchMedia runs each setup's cleanup by killing its triggers, so an instance created per
// setup and never destroyed stays around with nothing registered.
describe('an instance with no layer or pin', () => {
  const fakeSelf = makeFakeSelf();
  const scrollListeners = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([type]) => type === 'scroll').map(([, listener]) => listener);

  const setupAnchors = () => {
    document.body.innerHTML = `
      <div class="host">
        <div class="root">
          <section class="scene"></section>
          <div id="anchor"></div>
        </div>
      </div>`;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // jsdom takes the scroll-margin ramp's JS form, the one with a window listener.
  it('attaches nothing to the page until its first registration', () => {
    setupAnchors();

    const add = vi.spyOn(window, 'addEventListener');
    const controller = new StickyScrollTrigger(query('.root'));

    expect(scrollListeners(add)).toHaveLength(0);

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });
    expect(scrollListeners(add).length).toBeGreaterThan(0);
    controller.destroy();
  });

  it('hands everything back when its last layer is killed', () => {
    setupAnchors();

    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const controller = new StickyScrollTrigger(query('.root'), { nestedStickyOptimization: 'always' });
    const vars = controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });

    vars.onRefreshInit?.(fakeSelf);
    expect(query('#anchor').style.scrollMarginTop).not.toBe('');

    vars.onKill?.(fakeSelf);

    expect(query('.root').parentElement).toBe(query('.host'));
    expect(query('#anchor').style.scrollMarginTop).toBe('');
    // The dormancy table's own listener goes off the stack (see dormancy.ts).
    expect(scrollListeners(remove)).toContain(scrollListeners(add)[0]);

    // Nothing to build: refresh() leaves the page alone.
    controller.refresh();
    expect(query('.root').parentElement).toBe(query('.host'));
    controller.destroy();
  });

  it('hands everything back when its last pin is killed', () => {
    document.body.innerHTML = '<div class="root"><div id="anchor"></div></div><div class="pin"></div>';

    const remove = vi.spyOn(window, 'removeEventListener');
    const controller = new StickyScrollTrigger(query('.root'));
    const vars = controller.createStickyPin({ trigger: query('.pin') });

    controller.refresh();
    vars.onKill?.(fakeSelf);

    expect(query('.pin').style.cssText).toBe('');
    expect(scrollListeners(remove).length).toBeGreaterThan(0);
    controller.destroy();
  });

  it('acts on the page again from its next registration', () => {
    setupAnchors();

    const controller = new StickyScrollTrigger(query('.root'));

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' }).onKill?.(fakeSelf);
    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });
    controller.refresh();

    expect(query('.root').parentElement).not.toBe(query('.host'));
    expect(query('#anchor').style.scrollMarginTop).not.toBe('');
    controller.destroy();
    expect(query('.root').parentElement).toBe(query('.host'));
  });

  // The matchMedia shape: the next setup builds a new instance on the same root in the same task.
  // The first one's deferred teardown used to take that instance's wrappers out with its own.
  it('leaves a new instance on the same root alone after its last kill', async () => {
    setupAnchors();

    const first = new StickyScrollTrigger(query('.root'));
    const firstVars = first.createStickyTrigger({ trigger: query('.scene'), end: '+=200' });

    first.refresh();
    firstVars.onKill?.(fakeSelf);

    const second = new StickyScrollTrigger(query('.root'));

    second.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });
    second.refresh();
    await flushMicrotasks();

    expect(query('.root').parentElement).not.toBe(query('.host'));
    expect(query('.host').contains(query('.root'))).toBe(true);
    expect(document.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
    second.destroy();
  });
});

describe('resolveScrollPosition()', () => {
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

  // The 'absolute' branch returns classified.value directly, without touching element or any
  // layout, so it needs no real browser to verify (unlike every other branch here, which does).
  it('returns an absolute value (string or number) as-is, regardless of element', () => {
    const { query, controller } = setup();
    const el = query('.inside');

    expect(controller.resolveScrollPosition(el, '1234')).toBe(1234);
    expect(controller.resolveScrollPosition(el, 1234)).toBe(1234);
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

  // The freeze starts at 200, but the target reaches the top at 100, while the container still
  // scrolls freely, so none of the dwell applies to it.
  it('adds no dwell for a Scene layer whose freeze starts after the element reaches its anchor', () => {
    const { query, controller } = setup();
    const target = query('.inside');

    placeAt(target, 100);
    controller.createStickyTrigger({ trigger: query('.scene'), start: 200, end: '+=500' });
    controller.refresh();

    expect(controller.resolveScrollPosition(target, 'top top')).toBe(100);
  });

  it('adds no dwell for an element outside the shared container', () => {
    const { query, controller } = setup();
    const outside = query('.outside');

    placeAt(outside, 100);

    const before = controller.resolveScrollPosition(outside, 'top top');

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=500' });
    controller.refresh();

    expect(controller.resolveScrollPosition(outside, 'top top')).toBe(before);
  });
});

describe('static getScrollTop()', () => {
  it('accepts element as a selector string', () => {
    const { query, controller } = setup();

    expect(StickyScrollTrigger.getScrollTop('.inside', [controller])).toBe(
      StickyScrollTrigger.getScrollTop(query('.inside'), [controller]),
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

      placeAt(target, 100);
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

// jsdom never sticks anything, so el reports a top 400px off whenever pin carries
// position:sticky, standing in for the shift a stuck pin causes. A measurement that lands on the
// natural value reset the pin first.
describe('measuring while a pin is stuck', () => {
  const shiftWhileSticky = (el: HTMLElement, pin: HTMLElement, natural: number) => {
    Object.defineProperty(el, 'offsetTop', {
      configurable: true,
      get: () => (pin.style.position === 'sticky' ? natural + 400 : natural),
    });
  };

  const setupPinned = () => {
    document.body.innerHTML = `
      <div class="outsidePin"></div>
      <div class="root">
        <section class="scene"></section>
        <div class="pin"><div id="child"></div></div>
      </div>
    `;

    return new StickyScrollTrigger(query('.root'));
  };

  it('resolveScrollPosition resets the pin it measures', () => {
    const controller = setupPinned();
    const pin = query('.pin');

    controller.createStickyPin({ trigger: pin });
    controller.refresh();
    shiftWhileSticky(pin, pin, 100);

    expect(controller.resolveScrollPosition(pin, 'top top')).toBe(100);
    expect(pin.style.position).toBe('sticky');
  });

  it('getScrollTop resets a pin outside every container', () => {
    const controller = setupPinned();
    const pin = query('.outsidePin');

    controller.createStickyPin({ trigger: pin });
    controller.refresh();
    shiftWhileSticky(pin, pin, 100);

    expect(StickyScrollTrigger.getScrollTop(pin, [controller])).toBe(100);
    expect(pin.style.position).toBe('sticky');
  });

  // Until refresh() wraps it, a pin's trigger is still only the author's element, so a measurement
  // leaves its inline sticky in place.
  it('getScrollTop leaves a pin that isn\'t wrapped yet as its author styled it', () => {
    const controller = setupPinned();
    const pin = query('.outsidePin');

    pin.style.position = 'sticky';
    controller.createStickyPin({ trigger: pin });
    shiftWhileSticky(pin, pin, 100);

    expect(StickyScrollTrigger.getScrollTop(pin, [controller])).toBe(500);
  });

  // The first refresh() makes the pin sticky, so the second is the one that measures around it.
  it('refresh() resets a pin holding a Scene layer\'s endTrigger', () => {
    const controller = setupPinned();
    const pin = query('.pin');
    const vars = controller.createStickyTrigger({
      trigger: query('.scene'),
      endTrigger: query('#child'),
      end: 'top top',
    });

    controller.createStickyPin({ trigger: pin });
    controller.refresh();
    shiftWhileSticky(query('#child'), pin, 300);
    controller.refresh();

    expect((vars.end as () => number)()).toBe(300);
    expect(pin.style.position).toBe('sticky');
  });

  // 300 less the 0.05px tie tolerance, with no author margin, earlier dwell or freezeStart.
  it('the scroll-margin sync resets a pin holding a target', () => {
    const controller = setupPinned();
    const pin = query('.pin');

    controller.createStickyTrigger({ trigger: query('.scene'), end: '+=800' });
    controller.createStickyPin({ trigger: pin });
    controller.refresh();
    shiftWhileSticky(query('#child'), pin, 300);
    controller.refresh();

    expect(query('#child').style.scrollMarginTop).toContain('(299.95px - var(');
    expect(pin.style.position).toBe('sticky');
  });

  // The outer pin is registered first, so it's written first.
  const setupNestedPins = () => {
    document.body.innerHTML = `
      <div class="root">
        <div class="pin"><div id="child"></div></div>
        <div class="other"></div>
      </div>
      <div class="end"></div>
    `;
    placeAt(query('.end'), 2000);

    return new StickyScrollTrigger(query('.root'));
  };

  const range = (trigger: HTMLElement) => trigger.parentElement!.style.height;

  it('refresh() measures a pin inside an earlier pin\'s trigger with that pin reset', () => {
    const controller = setupNestedPins();
    const end = { endTrigger: query('.end'), end: 'top top' };

    shiftWhileSticky(query('#child'), query('.pin'), 300);
    controller.createStickyPin({ trigger: query('.pin'), ...end });
    controller.createStickyPin({ trigger: query('#child'), ...end });
    controller.refresh();

    expect(range(query('#child'))).toBe('1700px');
    expect(range(query('.pin'))).toBe('2000px');
    expect(query('.pin').style.position).toBe('sticky');
  });

  it('refresh() measures an endTrigger inside an earlier pin\'s trigger with that pin reset', () => {
    const controller = setupNestedPins();

    placeAt(query('.other'), 100);
    shiftWhileSticky(query('#child'), query('.pin'), 1000);
    controller.createStickyPin({ trigger: query('.pin'), endTrigger: query('.end'), end: 'top top' });
    controller.createStickyPin({ trigger: query('.other'), endTrigger: query('#child'), end: 'top top' });
    controller.refresh();

    expect(range(query('.other'))).toBe('900px');
  });
});

// createResolvedTrigger is a thin wrapper that calls resolveScrollPosition once for trigger/start
// and once for endTrigger/end, registering no layer, so it sits outside refresh()'s scope. The
// pass-through shape is checked here alongside the parts that are its own rather than
// resolveScrollPosition's: the excluded-vars rejection, the start/end defaults, resolving end
// against endTrigger, and a dwell end counted from the resolved start.
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

  // GSAP's own defaults for a trigger that doesn't pin, which is every trigger here.
  it('defaults start to \'top bottom\' and end to \'bottom top\'', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createResolvedTrigger({ trigger });

    expect((vars.start as () => number)()).toBe(controller.resolveScrollPosition(trigger, 'top bottom'));
    expect((vars.end as () => number)()).toBe(controller.resolveScrollPosition(trigger, 'bottom top'));
  });

  // A Scene layer freezing at 0 for '+=500' holds back endTrigger, placed below it, but not
  // trigger, which reaches the top as that freeze starts. So end picks up the dwell only if it
  // resolves against endTrigger.
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

    placeAt(endTrigger, 100);
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

    expect(endValue - startValue).toBe(600);
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

    placeAt(endTrigger, 100);
    controller.createStickyTrigger({ trigger: query('.between'), end: '+=500' });
    controller.refresh();

    const vars = controller.createResolvedTrigger({ trigger, endTrigger });

    expect((vars.end as () => number)()).toBe(600);
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
  // stylesheet rule on outer stands in for one, leaving the plumbing as what this can check: that
  // the measured height reaches outer's inline style intact, fractional part and all, and that it's
  // taken again on each refresh().
  const styleOuter = (height: string) => {
    // The pin's outer is the only div directly inside .root: .scene and .inside are sections, and
    // .inside has moved inside the wrappers by the time this matters.
    document.head.innerHTML = `<style>.root > div { height: ${height} }</style>`;
  };

  it('writes the height it measures on outer, keeping the fraction, and re-measures each refresh()', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    styleOuter('112.5px');
    controller.createStickyPin({ trigger, endTrigger: query('.scene') });
    controller.refresh();

    const outer = trigger.parentElement!.parentElement!;

    expect(outer.style.height).toBe('112.5px');

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

    it('extends the range by trigger\'s bottom margin', () => {
      const { query, controller } = setup();
      const trigger = query('.inside');

      trigger.style.marginBottom = '50px';
      controller.createStickyPin({ trigger, endTrigger: query('.scene'), end: '+=400' });
      controller.refresh();

      expect(trigger.parentElement!.style.height).toBe('450px');
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

  // setup() registers no Scene/Cover layers, so this covers pin-only usage too: the pin pass has
  // to run whether or not any Scene layer does.
  it('makes trigger position:sticky once refresh() runs', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    controller.createStickyPin({ trigger, endTrigger: query('.scene') });

    controller.refresh();

    expect(trigger.style.position).toBe('sticky');
  });

  // Unlike the pin's natural top/height (which depends on layout, unavailable in jsdom),
  // the `top` option is a plain passthrough to commitSticky via resolveMaybeFn,
  // so the exact CSS value it writes can be verified here without layout. A negative one pins
  // above the viewport's top edge.
  it('writes the top option as trigger.style.top once refresh() runs', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), top: 39 });
    controller.createStickyPin({ trigger: query('.outside'), endTrigger: query('.scene'), top: -30 });
    controller.refresh();

    expect(query('.inside').style.top).toBe('39px');
    expect(query('.outside').style.top).toBe('-30px');
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
  // distance in `start`, so the error points at the option that covers it. A fresh controller per
  // spelling, since the first pin keeps throwing on every later refresh().
  it('throws on an absolute start, in both spellings GSAP reads as absolute, pointing at top', () => {
    const fromNumber = setup();

    fromNumber.controller.createStickyPin({
      trigger: fromNumber.query('.inside'),
      endTrigger: fromNumber.query('.scene'),
      start: 20,
    });

    expect(() => fromNumber.controller.refresh())
      .toThrow(/start "20" is an absolute scroll position[\s\S]*top: 20/);

    const fromString = setup();

    fromString.controller.createStickyPin({
      trigger: fromString.query('.inside'),
      endTrigger: fromString.query('.scene'),
      start: '20',
    });

    expect(() => fromString.controller.refresh())
      .toThrow(/start "20" is an absolute scroll position[\s\S]*top: 20/);
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

  // A plain value is rejected at registration, where a function-valued one can only be caught once
  // refresh() calls it. The rejected registration never reaches #pinLayers, so the same trigger is
  // free for the second half.
  it('throws on a non-finite top, whether given plainly or returned by a function', () => {
    const { query, controller } = setup();

    expect(() =>
      controller.createStickyPin({
        trigger: query('.inside'),
        endTrigger: query('.scene'),
        top: Number.NaN,
      }),
    ).toThrow(/top must be a finite number/);

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
  // The value is captured when the pin first wraps trigger, not back at registration, so a change
  // made in between is what comes back.
  it('destroy() puts the caller\'s own inline position and top back', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');

    trigger.style.position = 'relative';
    trigger.style.top = '8px';

    controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 39 });

    trigger.style.top = '24px';

    controller.refresh();

    expect(trigger.style.position).toBe('sticky');

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
// forces on the layers below goes through scheduleRebuild's batch.
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

  it('a pin killed from a later pin\'s end function keeps its trigger\'s inline position', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createStickyPin({ trigger, endTrigger: query('.scene') });
    let killed = false;

    controller.createStickyPin({
      trigger: query('.outside'),
      endTrigger: query('.scene'),
      end: () => {
        if (!killed) vars.onKill?.(fakeSelf);

        killed = true;

        return 'top top';
      },
    });
    controller.refresh();

    expect(trigger.style.position).toBe('');
  });

  it('a pin killed from a Scene layer\'s start function keeps its trigger\'s inline position', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    let kill: (() => void) | null = null;

    trigger.style.top = '8px';

    controller.createStickyTrigger({
      trigger: query('.scene'),
      start: () => {
        kill?.();

        return 'top top';
      },
      end: '+=500',
    });

    const vars = controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 39 });

    controller.refresh();
    expect(trigger.style.position).toBe('sticky');

    kill = () => {
      kill = null;
      vars.onKill?.(fakeSelf);
    };

    controller.refresh();

    expect(trigger.style.position).toBe('');
    expect(trigger.style.top).toBe('8px');
  });

  // The rollback after the later pin's throw skips the pin the kill gave back.
  it('a pin killed from an earlier pin\'s end function keeps its inline position when a later pin throws', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    let kill: (() => void) | null = null;
    let rejected = false;

    trigger.style.top = '8px';

    controller.createStickyPin({
      trigger: query('.outside'),
      endTrigger: query('.scene'),
      end: () => {
        kill?.();

        return 'top top';
      },
    });

    const vars = controller.createStickyPin({ trigger, endTrigger: query('.scene'), top: 39 });

    controller.createStickyPin({
      trigger: query('.scene'),
      end: () => (rejected ? 'max' : 'bottom top'),
    });
    controller.refresh();
    expect(trigger.style.position).toBe('sticky');

    kill = () => {
      kill = null;
      vars.onKill?.(fakeSelf);
    };

    rejected = true;

    expect(() => controller.refresh()).toThrow(/'max' keyword/);
    expect(trigger.style.position).toBe('');
    expect(trigger.style.top).toBe('8px');

    // Otherwise the kill's re-measure at the end of the task throws again, off the stack.
    rejected = false;
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
    // The layer below evaluates its start once per re-measure.
    const remeasures = vi.fn(() => '0 0');

    controller.createStickyTrigger({
      trigger: query('.root').appendChild(document.createElement('section')),
      start: remeasures,
    });
    controller.refresh();
    remeasures.mockClear();
    vars.onKill?.(fakeSelf);
    await flushMicrotasks();

    expect(remeasures).toHaveBeenCalledTimes(1);
    expect(FakeScrollTrigger.refresh).toHaveBeenCalledTimes(1);
  });

  // The batch refreshes GSAP for the triggers left, as a last Scene layer's kill does.
  it('the last pin\'s kill still refreshes GSAP', async () => {
    const { query, controller } = setup();
    const vars = controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene') });

    controller.refresh();
    vars.onKill?.(fakeSelf);
    await flushMicrotasks();

    expect(FakeScrollTrigger.refresh).toHaveBeenCalledTimes(1);
  });

  // A pin killed before any refresh() never wrapped trigger, so nothing below it moved.
  it('onKill on a pin that was never built schedules nothing', async () => {
    const { query, controller } = setup();
    const vars = controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene') });
    const remeasures = vi.fn(() => '0 0');

    controller.createStickyTrigger({
      trigger: query('.root').appendChild(document.createElement('section')),
      start: remeasures,
    });
    vars.onKill?.(fakeSelf);
    await flushMicrotasks();

    expect(remeasures).not.toHaveBeenCalled();
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
    const remeasures = vi.fn(() => '0 0');

    controller.createStickyTrigger({ trigger: query('.scene'), start: remeasures });
    controller.refresh();
    remeasures.mockClear();
    vars.forEach((entry) => {
      entry.onKill?.(fakeSelf);
    });
    await flushMicrotasks();

    expect(remeasures).toHaveBeenCalledTimes(1);
  });

  it('calling onRefreshInit runs refresh() and builds the pin', () => {
    const { query, controller } = setup();
    const trigger = query('.inside');
    const vars = controller.createStickyPin({ trigger, endTrigger: query('.scene') });

    vars.onRefreshInit?.(fakeSelf);

    expect(trigger.style.position).toBe('sticky');
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

// GSAP's 'max' keyword (the scroller's max scroll position) is accepted where the layer itself
// never contributes to document height: createOverlapScroll (cover layers never add padding) and
// resolveScrollPosition/createResolvedTrigger (they never register into `layers` or add height).
// A Scene layer's own padding is part of the document height 'max' measures and as long as
// its window, so 'max' can't settle the length and createStickyTrigger rejects it.
// createStickyPin rejects 'max' too for now, though a pin's range never changes the document
// height.
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

  it('createStickyPin rejects end: \'max\'', () => {
    const { query, controller } = setup();

    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), end: 'max' });

    expect(() => controller.refresh()).toThrow(
      /createStickyPin's end "max".*'max'.*isn't supported/,
    );
  });

  // An end that both starts with '+=' and holds a space takes the start clause's element token as
  // its base, so a start token carrying an offset of its own can't compose (see
  // prefixSpacedRelativeEnd). Both resolution paths reach it: the layer path through measureLayer,
  // the pin path through #planPinLayers. What the composed value resolves to needs a real
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

  // Pins are measured before any Scene/Cover wrapper goes back on sticky, and a pin's own end
  // rejection (the 'max' case above) throws from there. Writing the planned sticky tops on the way
  // out keeps one bad option value from leaving every layer on the page off sticky.
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

  // Every pin is unstuck for reading by then too.
  it('leaves pins stuck when a Scene option throws mid-refresh', () => {
    const { query, controller } = setup();
    let rejected = false;

    controller.createStickyTrigger({
      trigger: query('.scene'),
      start: 'top top',
      end: () => (rejected ? 'max' : '+=500'),
    });
    controller.createStickyPin({ trigger: query('.inside'), endTrigger: query('.scene'), top: 39 });
    controller.refresh();

    const pin = query('.inside');

    expect(pin.style.position).toBe('sticky');

    rejected = true;

    expect(() => controller.refresh()).toThrow(/'max'/);
    expect(pin.style.position).toBe('sticky');
    expect(pin.style.top).toBe('39px');
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

  // The pin's range, at the page's top, is the only thing that can stretch the page past 3000.
  // 5000px stands in for a range the previous refresh sized for a longer page.
  it('a cover\'s \'max\' leaves out a pin range left over from the previous refresh', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="base"></section>
        <section class="cover"></section>
      </div>
      <div class="pin"></div>
    `;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars = controller.createOverlapScroll({ trigger: query('.base'), end: 'max' });

    controller.createStickyPin({ trigger: query('.pin') });
    controller.refresh();

    const range = query('.pin').parentElement!;

    vi.spyOn(document.documentElement, 'scrollHeight', 'get')
      .mockImplementation(() => Math.max(3000, parseFloat(range.style.height) || 0));
    range.style.height = '5000px';

    try {
      controller.refresh();
    } finally {
      vi.restoreAllMocks();
    }

    expect((vars.end as () => number)()).toBe(3000 - window.innerHeight);
  });
});

// GSAP's own _parsePosition treats a bare number (or a numeric-only string) as an absolute
// scroll position, entirely unrelated to any element. A cover layer's stickyTop is computed
// relative to its own wrapper's natural position (see freezeWindow.ts), which has no equivalent
// for an absolute value, so createOverlapScroll rejects it, unlike a Scene layer's stickyTop,
// which is already document-absolute and works with either. The rejection is measure.ts's, so the
// test below covers reachability only, in both spellings a caller can pass.
describe('absolute start (a bare number)', () => {
  // A fresh controller per spelling, since the first layer keeps throwing on every later refresh().
  it('createOverlapScroll rejects one, in both spellings a caller can pass', () => {
    const fromString = setup();

    fromString.controller.createOverlapScroll({
      trigger: fromString.query('.scene'),
      cover: fromString.query('.inside'),
      start: '500',
    });

    expect(() => fromString.controller.refresh()).toThrow(/absolute scroll position/);

    const fromNumber = setup();

    fromNumber.controller.createOverlapScroll({
      trigger: fromNumber.query('.scene'),
      cover: fromNumber.query('.inside'),
      start: 500,
    });

    expect(() => fromNumber.controller.refresh()).toThrow(/absolute scroll position/);
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
  // Both reach the same #assertTriggerAvailable(#layers, ...) inside #registerLayer, which either
  // registration method can arrive at.
  it('throws when an element is already another layer\'s trigger, from either method', () => {
    const { query, controller } = setup();

    controller.createStickyTrigger({ trigger: query('.scene') });

    expect(() => controller.createStickyTrigger({ trigger: query('.scene') })).toThrow(
      /<section\.scene> is already registered as a trigger for another layer/,
    );
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

// What reaches scrollMargin.ts through this module: the option, the two calls, and the targets'
// natural tops. Its own bookkeeping (the lag steps, the author's value, handing targets back) is
// scrollMargin.test.ts's, which calls sync() directly with real freeze windows rather than working
// around jsdom's layout-free zeros the way the '+=800' below has to.
describe('scroll-margin-top synchronization', () => {
  // Each controller registers its own custom-property names off a module-level counter, so the
  // exact index depends on how many instances the whole suite has built by now.
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

  // The one proof that refresh() reaches sync() at all, with the freeze window its passes settled
  // (0 to 800) rather than the raw '+=800', and with each target's own natural top.
  it('writes a correction from the freeze windows refresh() settled', () => {
    const { query, controller } = setupAnchors();
    const after = query('#after');

    placeAt(after, 100);
    controller.refresh();

    // 100 - 0 (author) + 0 (no earlier dwell) - 0 (freezeStart) - 0.05 (tolerance).
    expect(after.style.scrollMarginTop).toMatch(
      /^calc\(0px \+ var\(--sst-scroll-margin-top-offset, 0px\) \+ var\(--sst\d+-c0, 0px\) - \(clamp\(0px, \(99\.95px - var\(--sst-scroll-margin-top-offset, 0px\)\) \* 1000000, 800px\)\)\)$/,
    );
  });

  // Targets are measured before the pins' start functions run, so a target added there is late.
  it('writes a correction for a target added during refresh()', () => {
    const { query, controller } = setupAnchors();
    const late = document.createElement('div');

    late.id = 'late';
    placeAt(late, 100);
    controller.createStickyPin({
      trigger: query('#before'),
      start: () => {
        query('.root').append(late);

        return 'top top';
      },
    });
    controller.refresh();

    expect(late.style.scrollMarginTop).toMatch(/\(99\.95px - var\(/);
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
// below trace DOM access instead of reading a result. Comments in index.ts are their only other
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

  // Measuring an element after the sync's style writes forces a style recalc. Only the offset
  // getters are traced, since the sync's own getComputedStyle and applyRamps' scroll read are
  // intended.
  it('measures no element after writing scroll margins', () => {
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

    let written = false;
    const readsAfter: string[] = [];

    traceStyleProperty(query('#anchor'), 'scrollMarginTop', () => {
      written = true;
    });
    (['offsetTop', 'offsetHeight', 'offsetParent'] as const).forEach((key) => {
      const { get } = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)!;

      vi.spyOn(HTMLElement.prototype, key, 'get').mockImplementation(function (this: HTMLElement) {
        if (written) readsAfter.push(key);

        return get!.call(this) as never;
      });
    });

    try {
      controller.refresh();
    } finally {
      vi.restoreAllMocks();
    }

    expect(written).toBe(true);
    expect(readsAfter).toEqual([]);
  });

  // Every read shares one sticky-off state, so a pin or a scroll-margin target adds no strip of its
  // own. Another would leave the same DOM, having stripped and restored every wrapper for nothing.
  it('strips a Scene wrapper once per refresh', () => {
    const countStrips = (register: (controller: StickyScrollTrigger) => void) => {
      document.body.innerHTML = `
        <div class="root">
          <section class="scene"></section>
          <section class="pin"></section>
          <div id="anchor"></div>
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
    ).toBe(1);
  });

  // Why those reads come first: see #refreshGeometry.
  for (const [label, end, readOf, property] of [
    ['\'max\' end', { end: 'max' }, () => document.documentElement, 'scrollHeight'],
    ['outside endTrigger', { end: 'top top', endTrigger: '.out' }, () => query('.out'), 'offsetTop'],
  ] as const) {
    it(`reads what a cover's ${label} needs before writing sticky`, () => {
      document.body.innerHTML = `
        <div class="root">
          <section class="scene"></section>
          <section class="base"></section>
          <section class="cover"></section>
        </div>
        <div class="out"></div>
      `;

      const controller = new StickyScrollTrigger(query('.root'));

      controller.createStickyTrigger({ trigger: query('.scene'), end: '+=800' });
      controller.createOverlapScroll({ trigger: query('.base'), cover: query('.cover'), ...end });
      controller.refresh();

      const stickyAtRead: number[] = [];
      const sticky = () => Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.style.position === 'sticky').length;

      vi.spyOn(readOf(), property, 'get').mockImplementation(() => {
        stickyAtRead.push(sticky());

        return 0;
      });
      controller.refresh();
      vi.restoreAllMocks();

      expect(stickyAtRead.length).toBeGreaterThan(0);
      expect(stickyAtRead.every((count) => count === 0)).toBe(true);
      expect(sticky()).toBeGreaterThan(0);
    });
  }
});

describe('a refresh() from a start or end function', () => {
  const setupScenes = (start: () => string, end: () => string) => {
    document.body.innerHTML = `
      <div class="root">
        <section class="s1"></section>
        <section class="s2"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const vars = [
      controller.createStickyTrigger({ trigger: query('.s1'), end }),
      controller.createStickyTrigger({ trigger: query('.s2'), start, end: '+=100' }),
    ];

    return { controller, vars };
  };

  const paddingHeights = () => Array.from(
    document.querySelectorAll<HTMLElement>('div[aria-hidden="true"]'),
    (el) => el.style.height,
  );

  it('measures once more when a function calls refresh()', () => {
    let controller: StickyScrollTrigger | null = null;
    const start = vi.fn(() => {
      controller?.refresh();

      return 'top top';
    });

    ({ controller } = setupScenes(start, () => '+=100'));

    expect(() => controller.refresh()).not.toThrow();
    expect(start).toHaveBeenCalledTimes(2);
  });

  // The first pass read part of the layout before the function changed the dwell.
  it('measures again after a function changes the layout and calls refresh()', () => {
    let dwell = 100;
    let controller: StickyScrollTrigger | null = null;
    let changeDwell = false;

    ({ controller } = setupScenes(() => {
      if (changeDwell) {
        changeDwell = false;
        dwell = 300;
        controller?.refresh();
      }

      return 'top top';
    }, () => `+=${dwell}`));
    controller.refresh();
    changeDwell = true;
    controller.refresh();

    expect(paddingHeights()).toEqual(['300px', '100px']);
  });

  // GSAP measures that refresh after its refreshInit, so its refreshInit runs nested.
  it('refreshes in a GSAP refresh the function starts after its own refresh()', () => {
    let dwell = 100;
    let act: (() => void) | null = null;
    let paddingsAtGsapRefresh: string[] = [];
    const { controller, vars } = setupScenes(() => {
      act?.();

      return 'top top';
    }, () => `+=${dwell}`);

    controller.refresh();

    act = () => {
      act = null;
      controller.refresh();
      dwell = 300;
      vars[0].onRefreshInit?.(makeFakeSelf());
      paddingsAtGsapRefresh = paddingHeights();
    };

    controller.refresh();

    expect(paddingsAtGsapRefresh).toEqual(['300px', '100px']);
  });

  it('runs one nested refresh for a function that starts a GSAP refresh on every evaluation', () => {
    let gsapRefresh: (() => void) | null = null;
    const start = vi.fn(() => {
      gsapRefresh?.();

      return 'top top';
    });
    const { controller, vars } = setupScenes(start, () => '+=100');

    gsapRefresh = () => vars[0].onRefreshInit?.(makeFakeSelf());
    start.mockClear();

    expect(() => controller.refresh()).not.toThrow();
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('gives each refresh() its own nested run for a GSAP refresh a function starts', () => {
    let dwell = 100;
    let act: (() => void) | null = null;
    let paddingsAtGsapRefresh: string[] = [];
    const { controller, vars } = setupScenes(() => {
      act?.();

      return 'top top';
    }, () => `+=${dwell}`);

    const changeDwellAndRefresh = (next: number) => () => {
      act = null;
      dwell = next;
      vars[0].onRefreshInit?.(makeFakeSelf());
      paddingsAtGsapRefresh = paddingHeights();
    };

    controller.refresh();
    act = changeDwellAndRefresh(300);
    controller.refresh();
    act = changeDwellAndRefresh(500);
    controller.refresh();

    expect(paddingsAtGsapRefresh).toEqual(['500px', '100px']);
  });

  it('measures once more when a pin\'s function calls refresh()', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="pin"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const start = vi.fn(() => {
      // Stops a recursion short of the stack's end.
      if (start.mock.calls.length < 50) controller.refresh();

      return 'top top';
    });

    controller.createStickyPin({ trigger: query('.pin'), start, end: '+=100' });
    controller.refresh();

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('measures again after a pin\'s function changes the layout and calls refresh()', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="p1"></section>
        <section class="p2"></section>
      </div>`;

    let dwell = 100;
    let changeDwell = false;
    const controller = new StickyScrollTrigger(query('.root'));

    controller.createStickyPin({ trigger: query('.p1'), end: () => `+=${dwell}` });
    controller.createStickyPin({
      trigger: query('.p2'),
      start: () => {
        if (changeDwell) {
          changeDwell = false;
          dwell = 300;
          controller.refresh();
        }

        return 'top top';
      },
      end: '+=100',
    });
    controller.refresh();
    changeDwell = true;
    controller.refresh();

    expect([query('.p1'), query('.p2')].map((pin) => pin.parentElement!.style.height))
      .toEqual(['300px', '100px']);
  });

  // With no later handler on the instance, only the outermost run can build the new layer before
  // GSAP measures.
  describe('a layer a function registers during a GSAP refresh', () => {
    const inGsapRefresh = (run: () => void) => {
      Object.assign(FakeScrollTrigger, { isRefreshing: true });

      try {
        run();
      } finally {
        Object.assign(FakeScrollTrigger, { isRefreshing: false });
      }
    };

    const setupRegistering = (register: (controller: StickyScrollTrigger) => void) => {
      document.body.innerHTML = `
        <div class="root">
          <section class="s1"></section>
          <section class="s2"></section>
        </div>
        <div class="pin"></div>`;

      const controller = new StickyScrollTrigger(query('.root'));
      let armed = false;
      const vars = controller.createStickyTrigger({
        trigger: query('.s1'),
        start: () => {
          if (armed) {
            armed = false;
            register(controller);
          }

          return 'top top';
        },
        end: '+=100',
      });

      controller.refresh();
      armed = true;
      inGsapRefresh(() => vars.onRefreshInit?.(makeFakeSelf()));
    };

    it('builds a Scene layer before the handler returns', () => {
      setupRegistering((controller) => {
        controller.createStickyTrigger({ trigger: query('.s2'), end: '+=200' });
      });

      expect(paddingHeights()).toEqual(['100px', '200px']);
    });

    it('builds a pin before the handler returns', () => {
      setupRegistering((controller) => {
        controller.createStickyPin({ trigger: query('.pin'), end: '+=200' });
      });

      expect(query('.pin').style.position).toBe('sticky');
    });
  });
});

// jsdom has no layout to read, so what these check is the layout each call sees and what refresh()
// does with the values the function returns; the values a real layout gives are e2e's.
describe('an end function called again in the layout GSAP shows it', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // In page order: an instance above, the one under test, an instance below.
  const setupInstances = (end: () => string | number) => {
    document.body.innerHTML = `
      <div class="above"><section class="a1"></section></div>
      <div class="root">
        <section class="s1"></section>
        <section class="s2"></section>
      </div>
      <div class="below"><section class="b1"></section></div>`;

    const above = new StickyScrollTrigger(query('.above'));
    const below = new StickyScrollTrigger(query('.below'));
    const controller = new StickyScrollTrigger(query('.root'));

    above.createStickyTrigger({ trigger: query('.a1'), end: '+=200' });
    below.createStickyTrigger({ trigger: query('.b1'), end: '+=400' });
    controller.createStickyTrigger({ trigger: query('.s1'), end: '+=300' });

    const vars = controller.createStickyTrigger({ trigger: query('.s2'), end });

    above.refresh();
    below.refresh();

    return { above, below, controller, vars };
  };

  // An instance's padding sits in the structure around its root.
  const paddingsIn = (root: string) => {
    let outermost = query(root);

    while (outermost.parentElement !== document.body) outermost = outermost.parentElement!;

    return Array.from(
      outermost.querySelectorAll<HTMLElement>('div[aria-hidden="true"]'),
      (el) => el.style.height,
    );
  };

  const layout = () => ({
    above: paddingsIn('.above'),
    root: paddingsIn('.root'),
    below: paddingsIn('.below'),
    afterS1: (query('.s1').nextElementSibling as HTMLElement | null)?.style.height ?? null,
    divs: document.querySelectorAll('div').length,
  });

  it('takes out this instance\'s padding and the padding below, with a spacer for each earlier layer', () => {
    const seen: ReturnType<typeof layout>[] = [];
    const { controller } = setupInstances(() => {
      seen.push(layout());

      return '+=100';
    });

    controller.refresh();
    seen.length = 0;
    controller.refresh();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({
      above: ['200px'],
      root: ['0px', '0px'],
      below: ['0px'],
      afterS1: '300px',
      divs: seen[0].divs + 1,
    });
  });

  it('puts every padding back and leaves no spacer', () => {
    const { controller } = setupInstances(() => '+=100');

    controller.refresh();

    const before = layout();

    controller.refresh();

    expect(layout()).toEqual(before);
    expect(before.root).toEqual(['300px', '100px']);
    expect(before.below).toEqual(['400px']);
  });

  it('plans with the value the function returns in that layout', () => {
    let calls = 0;
    const { controller, vars } = setupInstances(() => {
      calls += 1;

      return calls === 1 ? '+=100' : '+=400';
    });

    controller.refresh();

    expect(calls).toBe(3);
    expect(paddingsIn('.root')).toEqual(['300px', '400px']);
    // s1's dwell comes first.
    expect((vars.end as () => number)()).toBe(700);
  });

  it('calls a function whose value keeps moving at most six more times', () => {
    let calls = 0;
    const { controller } = setupInstances(() => {
      calls += 1;

      return `+=${calls * 100}`;
    });

    calls = 0;

    expect(() => controller.refresh()).not.toThrow();
    expect(calls).toBe(7);
  });

  it('keeps the first value when the function changes what kind of value it returns', () => {
    let calls = 0;
    const { controller } = setupInstances(() => {
      calls += 1;

      return calls === 1 ? '+=100' : 2000;
    });

    controller.refresh();

    expect(paddingsIn('.root')).toEqual(['300px', '100px']);
  });

  it('calls neither a start function nor an end function that gave a position clause again', () => {
    document.body.innerHTML = `
      <div class="root">
        <section class="s1"></section>
        <section class="s2"></section>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'));
    const start = vi.fn(() => 'top top');
    const clauseEnd = vi.fn(() => 'bottom top');
    const dwellEnd = vi.fn(() => '+=100');

    controller.createStickyTrigger({ trigger: query('.s1'), end: clauseEnd });
    controller.createStickyTrigger({ trigger: query('.s2'), start, end: dwellEnd });
    controller.refresh();
    start.mockClear();
    clauseEnd.mockClear();
    dwellEnd.mockClear();
    controller.refresh();

    expect(start).toHaveBeenCalledTimes(1);
    expect(clauseEnd).toHaveBeenCalledTimes(1);
    expect(dwellEnd).toHaveBeenCalledTimes(2);
  });

  // The function throws in the first evaluation, or in the second after the first moved a value.
  // Every call returns something new, so a write before the throw would show.
  it.each([2, 3])('leaves the last refresh\'s layout and windows when the function throws on call %i', (throwAt) => {
    let calls = 0;
    let failing = false;
    const { controller, vars } = setupInstances(() => {
      calls += 1;

      if (!failing) return '+=100';

      if (calls === throwAt) throw new Error('end failed');

      return calls === 1 ? '+=250' : '+=400';
    });

    controller.refresh();

    const before = layout();
    const endBefore = (vars.end as () => number)();

    failing = true;
    calls = 0;

    expect(() => controller.refresh()).toThrow('end failed');
    expect(layout()).toEqual(before);
    expect((vars.end as () => number)()).toBe(endBefore);
  });

  it('gives resolveScrollPosition the page refresh() left and keeps the value pass 1 gave', () => {
    // What the page looks like whenever resolveScrollPosition reads its element's position.
    const seenByMeasure: ReturnType<typeof layout>[] = [];
    let calls = 0;
    const { controller, vars } = setupInstances(() => {
      calls += 1;

      return controller.resolveScrollPosition(query('.b1'), 'top top') + 1000 + calls * 100;
    });

    Object.defineProperty(query('.b1'), 'offsetTop', {
      configurable: true,
      get: () => {
        seenByMeasure.push(layout());

        return 0;
      },
    });
    controller.refresh();

    const left = layout();

    seenByMeasure.length = 0;
    calls = 0;
    controller.refresh();

    // In pass 1 and in the evaluation alike.
    expect(seenByMeasure).toEqual([left, left]);
    expect(calls).toBe(2);
    expect((vars.end as () => number)()).toBe(1100);
  });

  it('scrolls back to where it was when taking the padding out moved the scroll', () => {
    let y = 500;
    let calls = 0;

    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => y);

    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
      y = (options as ScrollToOptions).top ?? y;
    });
    const { controller } = setupInstances(() => {
      calls += 1;

      // The browser clamps the scroll to the shorter page.
      if (calls > 1) y = 200;

      return '+=100';
    });

    calls = 0;
    controller.refresh();

    expect(scrollTo.mock.calls).toEqual([[{ top: 500, behavior: 'instant' }]]);
    expect(y).toBe(500);
  });

  // GSAP measures right after its refreshInit dispatch, so what the page looks like at the end of
  // it is what GSAP measures.
  describe('a GSAP refresh from the function', () => {
    // onCall runs on every call of the function after the arm, pass 1's included.
    const setupGsap = (onCall: (gsapRefresh: (complete?: boolean) => void) => void) => {
      const { Cls, gsapRefresh } = makeClass({ rec: 0 });
      const self = Object.create(Cls.prototype) as ScrollTrigger;
      const measured: ReturnType<typeof layout>[] = [];
      let armed = false;
      const { controller, vars } = setupInstances(() => {
        if (armed) onCall(gsapRefresh);

        return '+=100';
      });

      Cls.addEventListener('refreshInit', () => vars.onRefreshInit?.(self));
      controller.refresh();

      return {
        Cls,
        controller,
        gsapRefresh,
        measured,
        // Calls after every listener added before it, the layer's handler included.
        measureAtEnd: () => Cls.addEventListener('refreshInit', () => measured.push(layout())),
        arm: () => {
          armed = true;
        },
      };
    };

    // Calls 1 and 2 of one refresh(): pass 1, then the evaluation.
    const onEvaluation = (act: () => void) => {
      let calls = 0;

      return () => {
        calls += 1;

        if (calls === 2) act();
      };
    };

    it('measures the page refresh() left, and the evaluation goes on in its own layout', () => {
      let inEvaluation: ReturnType<typeof layout> | null = null;
      let afterGsapRefresh: ReturnType<typeof layout> | null = null;
      let gsap: (complete?: boolean) => void = () => {};
      const act = onEvaluation(() => {
        inEvaluation = layout();
        gsap(true);
        afterGsapRefresh = layout();
      });
      const { controller, measured, measureAtEnd, arm } = setupGsap((gsapRefresh) => {
        gsap = gsapRefresh;
        act();
      });
      const left = layout();

      measureAtEnd();
      arm();
      controller.refresh();

      expect(measured).toEqual([left]);
      expect(inEvaluation).not.toEqual(left);
      expect(afterGsapRefresh).toEqual(inEvaluation);
      expect(layout()).toEqual(left);
    });

    it('leaves the page as refresh() left it after a GSAP refresh that threw before its end', () => {
      let afterGsapRefresh: ReturnType<typeof layout> | null = null;
      let gsap: (complete?: boolean) => void = () => {};
      const act = onEvaluation(() => {
        gsap(false);
        afterGsapRefresh = layout();
      });
      const { controller, arm } = setupGsap((gsapRefresh) => {
        gsap = gsapRefresh;
        act();
      });
      const left = layout();

      arm();
      controller.refresh();

      expect(afterGsapRefresh).toEqual(left);
      expect(layout()).toEqual(left);
    });

    // The evaluation (call 2) starts a GSAP refresh, whose layer handler runs a nested refresh();
    // that one's pass 1 (call 3) starts another GSAP refresh inside the first. Its end must not
    // resume the evaluation while the first GSAP refresh is still to measure.
    it('resumes an evaluation only at the end of the GSAP refresh it started', () => {
      let calls = 0;
      let callsInFirst: number[] = [];
      const { controller, measured, measureAtEnd, arm } = setupGsap((gsapRefresh) => {
        calls += 1;

        if (calls === 2 || calls === 3) {
          const call = calls;

          gsapRefresh(true);

          if (call === 2) callsInFirst = [calls];
        }
      });
      const left = layout();

      measureAtEnd();
      arm();
      controller.refresh();

      // The second GSAP refresh ran inside the first.
      expect(callsInFirst[0]).toBeGreaterThan(3);
      expect(measured).toEqual([left, left]);
    });

    // As above, but the second GSAP refresh throws before its end.
    it('resumes an evaluation at the end of the GSAP refresh it started when one inside it threw', () => {
      let calls = 0;
      let inEvaluation: ReturnType<typeof layout> | null = null;
      let afterGsapRefresh: ReturnType<typeof layout> | null = null;
      const { controller, arm } = setupGsap((gsapRefresh) => {
        calls += 1;

        const call = calls;

        if (call === 2) {
          inEvaluation = layout();
          gsapRefresh(true);
          afterGsapRefresh = layout();
        }

        if (call === 3) gsapRefresh(false);
      });

      arm();
      controller.refresh();

      expect(calls).toBeGreaterThan(3);
      expect(afterGsapRefresh).toEqual(inEvaluation);
    });

    // The second GSAP refresh throws out of a layer's onRefreshInit, through the handler of the
    // first one that ran the nested refresh(), which catches it.
    it('resumes an evaluation after a throw went through a layer handler', async () => {
      const { Cls, gsapRefresh } = makeClass({ rec: 0 });
      const self = Object.create(Cls.prototype) as ScrollTrigger;
      const error = new Error('onRefreshInit');
      let calls = 0;
      let throwing = false;
      let inEvaluation: ReturnType<typeof layout> | null = null;
      let afterGsapRefresh: ReturnType<typeof layout> | null = null;

      document.body.innerHTML = `
        <div class="root"><section class="s1"></section></div>
        <div class="below"><section class="b1"></section></div>`;

      const layout = () => ({ root: paddingsIn('.root'), divs: document.querySelectorAll('div').length });
      const controller = new StickyScrollTrigger(query('.root'));
      const below = new StickyScrollTrigger(query('.below'));
      const vars = controller.createStickyTrigger({
        trigger: query('.s1'),
        end: () => {
          calls += 1;

          // The second call runs the third inside it.
          const call = calls;

          if (call === 2) {
            inEvaluation = layout();
            gsapRefresh(true);
            afterGsapRefresh = layout();
          }

          if (call === 3) {
            throwing = true;

            try {
              gsapRefresh(true);
            } finally {
              throwing = false;
            }
          }

          return '+=100';
        },
      });
      const belowVars = below.createStickyTrigger({
        trigger: query('.b1'),
        end: '+=400',
        onRefreshInit: () => {
          if (throwing) throw error;
        },
      });

      below.refresh();
      controller.refresh();
      Cls.addEventListener('refreshInit', () => vars.onRefreshInit?.(self));
      Cls.addEventListener('refreshInit', () => belowVars.onRefreshInit?.(self));
      calls = 0;

      const uncaught = await runDispatch(() => controller.refresh());

      expect(uncaught).toEqual([error]);
      expect(calls).toBeGreaterThan(3);
      expect(afterGsapRefresh).toEqual(inEvaluation);
    });

    // A listener after the layer's handler takes off one before it, as a kill does, so GSAP's
    // dispatch also calls a listener added during it, and skips the next.
    it('resumes an evaluation though a listener came off during the GSAP refresh it started', () => {
      const { Cls, gsapRefresh } = makeClass({ rec: 0 });
      const self = Object.create(Cls.prototype) as ScrollTrigger;
      const before = () => undefined;
      let armed = false;
      let inEvaluation: ReturnType<typeof layout> | null = null;
      let afterGsapRefresh: ReturnType<typeof layout> | null = null;
      const { controller, vars } = setupInstances(() => {
        if (armed && !inEvaluation && paddingsIn('.root')[1] === '0px') {
          inEvaluation = layout();
          gsapRefresh(true, true);
          afterGsapRefresh = layout();
        }

        return '+=100';
      });

      Cls.addEventListener('refreshInit', before);
      Cls.addEventListener('refreshInit', () => vars.onRefreshInit?.(self));
      Cls.addEventListener('refreshInit', () => Cls.removeEventListener('refreshInit', before));
      // Leaves GSAP's map a slot to visit after the removal.
      Cls.addEventListener('refreshInit', () => undefined);
      controller.refresh();
      armed = true;
      controller.refresh();

      expect(inEvaluation).not.toBeNull();
      expect(afterGsapRefresh).toEqual(inEvaluation);
    });

    // The evaluation runs in the handler of a GSAP refresh already under way, and the one the
    // function starts throws before its end: the 'refresh' of the outer one comes after the
    // evaluation is over.
    it('leaves the page as refresh() left it at the end of the GSAP refresh the evaluation ran in', () => {
      let gsap: (complete?: boolean) => void = () => {};
      const act = onEvaluation(() => gsap(false));
      const { controller, gsapRefresh, arm } = setupGsap((inner) => {
        gsap = inner;
        act();
      });

      controller.refresh();

      const left = layout();

      arm();
      gsapRefresh(true);

      expect(layout()).toEqual(left);
    });

    // A dwell of 0 writes the same 0 the evaluation does. With the GSAP refresh's end missing, the
    // evaluation ends while still held.
    it.each([[700, true], [0, true], [0, false]])('keeps what the GSAP refresh had the instance below write (dwell %i, ends: %s)', (newDwell, complete) => {
      const { Cls, gsapRefresh } = makeClass({ rec: 0 });
      const self = Object.create(Cls.prototype) as ScrollTrigger;
      let belowDwell = 400;
      let calls = 0;

      document.body.innerHTML = `
        <div class="root"><section class="s1"></section></div>
        <div class="below"><section class="b1"></section></div>`;

      const controller = new StickyScrollTrigger(query('.root'));
      const below = new StickyScrollTrigger(query('.below'));
      const belowVars = below.createStickyTrigger({ trigger: query('.b1'), end: () => `+=${belowDwell}` });

      controller.createStickyTrigger({
        trigger: query('.s1'),
        end: () => {
          calls += 1;

          if (calls === 2) {
            belowDwell = newDwell;
            gsapRefresh(complete);
          }

          return '+=100';
        },
      });
      Cls.addEventListener('refreshInit', () => belowVars.onRefreshInit?.(self));
      below.refresh();
      calls = 0;
      controller.refresh();

      expect(paddingsIn('.below')).toEqual([`${newDwell}px`]);
    });

    it('measures the page refresh() left after a resolveScrollPosition from a GSAP measurement', () => {
      let gsap: (complete?: boolean) => void = () => {};
      const act = onEvaluation(() => gsap(true));
      const { Cls, controller, measured, measureAtEnd, arm } = setupGsap((gsapRefresh) => {
        gsap = gsapRefresh;
        act();
      });
      const left = layout();

      // A plain trigger's start function, which GSAP calls as it measures.
      Cls.addEventListener('refreshInit', () => controller.resolveScrollPosition(query('.b1'), 'top top'));
      measureAtEnd();
      arm();
      controller.refresh();

      expect(measured).toEqual([left]);
    });

    it('gives a resolveScrollPosition after the GSAP refresh the page refresh() left', () => {
      const seen: ReturnType<typeof layout>[] = [];
      let resolving = false;
      let gsap: (complete?: boolean) => void = () => {};
      let controller: StickyScrollTrigger | null = null;
      const act = onEvaluation(() => {
        gsap(true);
        resolving = true;
        controller!.resolveScrollPosition(query('.b1'), 'top top');
        resolving = false;
      });
      const setup = setupGsap((gsapRefresh) => {
        gsap = gsapRefresh;
        act();
      });

      controller = setup.controller;
      Object.defineProperty(query('.b1'), 'offsetTop', {
        configurable: true,
        get: () => {
          if (resolving) seen.push(layout());

          return 0;
        },
      });

      const left = layout();

      setup.arm();
      controller.refresh();

      expect(seen).toEqual([left]);
    });

    // The function reads 700 in its own layout and 100 in the page refresh() left, before calling
    // ScrollTrigger.refresh() each time. GSAP measuring through resolveScrollPosition is not the
    // function measuring through it.
    it('keeps the value of a function whose GSAP refresh measures through resolveScrollPosition', () => {
      const { Cls, gsapRefresh } = makeClass({ rec: 0 });
      const self = Object.create(Cls.prototype) as ScrollTrigger;
      let armed = false;
      const { controller, vars } = setupInstances(() => {
        const dwell = paddingsIn('.root')[1] === '0px' ? '+=700' : '+=100';

        if (armed) gsapRefresh(true);

        return dwell;
      });

      Cls.addEventListener('refreshInit', () => vars.onRefreshInit?.(self));
      Cls.addEventListener('refreshInit', () => controller.resolveScrollPosition(query('.b1'), 'top top'));
      controller.refresh();
      armed = true;
      controller.refresh();

      expect(paddingsIn('.root')[1]).toBe('700px');
    });
  });

  // The instance below has a function-valued end too, so its refresh() runs an evaluation of its
  // own inside this one's.
  describe('a refresh() of the instance below from the function', () => {
    const setupNested = (end: (below: StickyScrollTrigger) => string | number) => {
      document.body.innerHTML = `
        <div class="root"><section class="s1"></section></div>
        <div class="below"><section class="b1"></section></div>`;

      const state = { belowDwell: 400 };
      const controller = new StickyScrollTrigger(query('.root'));
      const below = new StickyScrollTrigger(query('.below'));
      const vars = controller.createStickyTrigger({ trigger: query('.s1'), end: () => end(below) });

      below.createStickyTrigger({ trigger: query('.b1'), end: () => `+=${state.belowDwell}` });
      below.refresh();

      return { state, controller, vars };
    };

    it('keeps what that refresh() wrote', () => {
      let calls = 0;
      const { state, controller } = setupNested((below) => {
        calls += 1;

        if (calls === 2) {
          state.belowDwell = 700;
          below.refresh();
        }

        return '+=100';
      });

      controller.refresh();

      expect(paddingsIn('.below')).toEqual(['700px']);
    });

    it('still gives resolveScrollPosition the page refresh() left afterwards', () => {
      let calls = 0;
      const { controller, vars } = setupNested((below) => {
        calls += 1;

        if (calls === 2) below.refresh();

        return controller.resolveScrollPosition(query('.s1'), 'top top') + 1000 + calls * 100;
      });

      controller.refresh();

      expect(calls).toBe(2);
      expect((vars.end as () => number)()).toBe(1100);
    });

    // The instance below's evaluation runs inside this one's, and what its function does in its
    // evaluation (onBelowEvaluation) sees neither evaluation's layout.
    const setupTwoEvaluations = (onBelowEvaluation: (controller: StickyScrollTrigger) => void) => {
      document.body.innerHTML = `
        <div class="root"><section class="s1"></section><section class="s2"></section></div>
        <div class="below"><section class="b1"></section></div>`;

      const nestedLayout = () => ({
        root: paddingsIn('.root'),
        below: paddingsIn('.below'),
        divs: document.querySelectorAll('div').length,
      });
      const controller = new StickyScrollTrigger(query('.root'));
      const below = new StickyScrollTrigger(query('.below'));
      let calls = 0;
      let belowCalls = 0;

      controller.createStickyTrigger({ trigger: query('.s1'), end: '+=300' });

      const vars = controller.createStickyTrigger({
        trigger: query('.s2'),
        end: () => {
          calls += 1;

          // 700 in this evaluation's layout, 100 in the page refresh() left.
          const dwell = paddingsIn('.root')[1] === '0px' ? '+=700' : '+=100';

          if (calls === 2) {
            belowCalls = 0;
            below.refresh();
          }

          return dwell;
        },
      });

      below.createStickyTrigger({
        trigger: query('.b1'),
        end: () => {
          belowCalls += 1;

          if (calls === 2 && belowCalls === 2) onBelowEvaluation(controller);

          return '+=400';
        },
      });
      below.refresh();
      controller.refresh();

      return {
        controller,
        vars,
        nestedLayout,
        // The second refresh() of the instance, with the first one's layout as left.
        run: () => {
          const left = nestedLayout();

          calls = 0;
          controller.refresh();

          expect(nestedLayout()).toEqual(left);

          return left;
        },
      };
    };

    it('lets a GSAP refresh from the function below measure the page refresh() left', () => {
      const { Cls, gsapRefresh } = makeClass({ rec: 0 });
      const self = Object.create(Cls.prototype) as ScrollTrigger;
      const { vars, nestedLayout, run } = setupTwoEvaluations(() => gsapRefresh(true));
      const measured: ReturnType<typeof nestedLayout>[] = [];

      Cls.addEventListener('refreshInit', () => vars.onRefreshInit?.(self));
      Cls.addEventListener('refreshInit', () => measured.push(nestedLayout()));

      const left = run();

      expect(measured).toEqual([left]);
    });

    it('gives a resolveScrollPosition from the function below the page refresh() left', () => {
      const seen: unknown[] = [];
      let armed = false;
      let resolving = false;
      const { nestedLayout, run } = setupTwoEvaluations((controller) => {
        resolving = armed;
        controller.resolveScrollPosition(query('.b1'), 'top top');
        resolving = false;
      });

      armed = true;
      Object.defineProperty(query('.b1'), 'offsetTop', {
        configurable: true,
        get: () => {
          if (resolving) seen.push(nestedLayout());

          return 0;
        },
      });

      const left = run();

      expect(seen).toEqual([left]);
      // The function below measured through it, not this one.
      expect(left.root[1]).toBe('700px');
    });
  });
});

// dormancy.test.ts owns the table and its windows. What's checked here is that each instance
// reaches it: the option, its refresh(), a pin's unwrap and destroy(). jsdom puts everything at 0,
// so a scroll far past 0 is past every range.
describe('nestedStickyOptimization', () => {
  const fakeSelf = makeFakeSelf();
  let scroll = 0;
  let userResult: { render: (time: number) => void } | undefined;

  beforeEach(() => {
    scroll = 0;
    userResult = undefined;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const setupPinned = (nestedStickyOptimization: 'always' | 'off') => {
    document.body.innerHTML = `
      <div class="root"><section class="scene"></section></div>
      <div class="pin"></div>
    `;

    const controller = new StickyScrollTrigger(query('.root'), { nestedStickyOptimization });
    const sceneVars = controller.createStickyTrigger({
      trigger: query('.scene'),
      end: '+=100',
      onRefreshInit: () => userResult,
    });
    const pinVars = controller.createStickyPin({ trigger: query('.pin') });

    // What ScrollTrigger.create() does first, and how the instance learns GSAP's class.
    sceneVars.onRefreshInit?.(fakeSelf);
    scroll = 5000;
    window.dispatchEvent(new Event('scroll'));

    return { controller, sceneVars, pinVars, wrapper: query('.root').parentElement! };
  };

  // First in this block: the page-level listener is attached once, so a test after another
  // that leaked it would see no attach at all.
  it('stops listening for scroll once the last instance is destroyed', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { controller } = setupPinned('always');
    const added = add.mock.calls.filter(([type]) => type === 'scroll').map(([, listener]) => listener);

    expect(added.length).toBeGreaterThan(0);
    controller.destroy();
    added.forEach((listener) => expect(remove).toHaveBeenCalledWith('scroll', listener));
  });

  // GSAP measures at scroll 0 between its refreshInit dispatch and the render(-1) it calls on what
  // each listener returned. ScrollTrigger.create() runs onRefreshInit, whose refresh() puts the
  // table's own listener on before GSAP's first refresh; the caller's result goes back untouched.
  it('shows GSAP\'s refresh the layout for scroll 0 and puts the current one back on render(-1)', () => {
    const listeners: Record<string, () => unknown> = {};

    Object.assign(FakeScrollTrigger, {
      addEventListener: (type: string, callback: () => unknown) => {
        listeners[type] = callback;
      },
      removeEventListener: vi.fn(),
    });
    userResult = { render: vi.fn() };

    const { controller, sceneVars, wrapper } = setupPinned('always');

    // From 5000, past every range: the same element, far before its range at 0.
    window.dispatchEvent(new Event('scroll'));
    expect(wrapper.style.top).toBe('0px');
    Object.assign(FakeScrollTrigger, { isRefreshing: true });

    try {
      const init = listeners.refreshInit() as { render: (time: number) => void };

      expect(sceneVars.onRefreshInit?.(fakeSelf)).toBe(userResult);
      expect(wrapper.style.position).toBe('relative');
      scroll = 0;
      init.render(-1);
      expect(wrapper.style.position).toBe('sticky');
    } finally {
      Object.assign(FakeScrollTrigger, {
        isRefreshing: false,
        addEventListener: undefined,
        removeEventListener: undefined,
      });
      controller.destroy();
    }
  });

  // jsdom always runs the scroll-margin ramp in its JS form.
  it('reads the scroll for the JS ramp only once the far wrappers are demoted again', () => {
    const listeners: Record<string, () => unknown> = {};

    Object.assign(FakeScrollTrigger, {
      addEventListener: (type: string, callback: () => unknown) => {
        listeners[type] = callback;
      },
      removeEventListener: vi.fn(),
    });

    const { controller, sceneVars } = setupPinned('always');
    const stickyAtRead: number[] = [];

    window.dispatchEvent(new Event('scroll'));
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => {
      stickyAtRead.push(Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.style.position === 'sticky').length);

      return scroll;
    });
    Object.assign(FakeScrollTrigger, { isRefreshing: true });

    try {
      listeners.refreshInit();
      sceneVars.onRefreshInit?.(fakeSelf);
    } finally {
      Object.assign(FakeScrollTrigger, {
        isRefreshing: false,
        addEventListener: undefined,
        removeEventListener: undefined,
      });
    }

    // The ramps' host carries the instance's own attribute (see scrollMargin.test.ts).
    const host = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .find((el) => el.getAttributeNames().some((name) => name.startsWith('data-sst')))!;
    const id = host.getAttributeNames().find((name) => name.startsWith('data-sst'))!.slice(5);

    expect(stickyAtRead.length).toBeGreaterThan(0);
    expect(stickyAtRead.every((count) => count === 0)).toBe(true);
    // The scene's whole dwell is behind a scroll of 5000.
    expect(host.style.getPropertyValue(`--${id}-c0`)).toBe('100px');
    controller.destroy();
  });

  // Taken for the first time inside one of GSAP's refreshes, the class's own refreshInit listener
  // missed that dispatch: the instance's result carries the restore, the caller's render included.
  it('hands back the restore through its own result when it first sees GSAP mid-refresh', () => {
    const render = vi.fn();

    class RefreshingScrollTrigger {
      static refresh = vi.fn();

      static isRefreshing = true;
    }

    userResult = { render };

    const { controller, sceneVars, wrapper } = setupPinned('always');

    window.dispatchEvent(new Event('scroll'));

    const returned = sceneVars.onRefreshInit?.(
      Object.create(RefreshingScrollTrigger.prototype) as ScrollTrigger,
    ) as unknown as typeof userResult;

    expect(wrapper.style.position).toBe('relative');
    scroll = 0;
    returned!.render(-1);
    expect(render).toHaveBeenCalledWith(-1);
    expect(wrapper.style.position).toBe('sticky');
    controller.destroy();
  });

  it('reports refresh()\'s own error when rebuilding the table throws too, and gives up the table', async () => {
    document.body.innerHTML = '<div class="root"><section class="scene"></section></div><div class="pin"></div>';

    let end = 'bottom top';
    const controller = new StickyScrollTrigger(query('.root'), { nestedStickyOptimization: 'always' });
    const sceneVars = controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });

    controller.createStickyPin({ trigger: query('.pin'), end: () => end });
    sceneVars.onRefreshInit?.(fakeSelf);
    scroll = 5000;
    window.dispatchEvent(new Event('scroll'));
    expect(query('.pin').style.position).toBe('relative');
    end = 'max';
    // Past the end of the task, so the build scans the document again.
    await flushMicrotasks();

    const scan = document.querySelectorAll.bind(document);

    vi.spyOn(document, 'querySelectorAll').mockImplementation((selector: string) => {
      if (selector === '*') throw new Error('table');

      return scan(selector);
    });

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    process.on('uncaughtException', onUncaught);

    try {
      expect(() => controller.refresh()).toThrow(/'max' keyword/);
      // Not left relative without the z-index/will-change the refresh took back.
      expect(query('.pin').style.position).toBe('sticky');
      await flushMicrotasks();
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    // The table's error is reported too, from a microtask.
    expect(uncaught).toEqual([new Error('table')]);
    vi.mocked(document.querySelectorAll).mockRestore();
    controller.destroy();
  });

  // The other instance's pin stays relative while this one fails: emptying the table gives it back
  // whole, z-index/will-change included.
  it('gives up the table when only rebuilding it throws, and reports that error off the stack', async () => {
    const { controller } = setupPinned('always');

    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="other"><section class="otherScene"></section></div>',
    );

    const other = new StickyScrollTrigger(query('.other'), { nestedStickyOptimization: 'off' });

    other.createStickyTrigger({ trigger: query('.otherScene'), end: '+=100' });
    window.dispatchEvent(new Event('scroll'));
    expect(query('.pin').style.position).toBe('relative');
    // Past the end of the task, so the build scans the document again.
    await flushMicrotasks();

    const scan = document.querySelectorAll.bind(document);

    vi.spyOn(document, 'querySelectorAll').mockImplementation((selector: string) => {
      if (selector === '*') throw new Error('table');

      return scan(selector);
    });

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    process.on('uncaughtException', onUncaught);

    try {
      // A caller like #scheduleRebuild carries on to GSAP's refresh: the error comes off the stack.
      expect(() => other.refresh()).not.toThrow();
      expect(query('.pin').style.cssText).toBe('position: sticky; top: 0px;');
      await flushMicrotasks();
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(uncaught).toEqual([new Error('table')]);
    vi.mocked(document.querySelectorAll).mockRestore();
    other.destroy();
    controller.destroy();
  });

  // A pin destroy() unwraps after unregistering must not register the instance again: it would
  // keep the page's table and GSAP listeners alive for an instance that's gone.
  it('stays unregistered once destroy() has unwrapped its pins', () => {
    const { controller } = setupPinned('always');
    const add = vi.fn();

    // A class of its own, so the table can't take it for one it already listens to.
    class OtherScrollTrigger {
      static refresh = vi.fn();

      static addEventListener = add;

      static removeEventListener = vi.fn();
    }

    controller.destroy();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="other"><section class="otherScene"></section></div>',
    );

    const other = new StickyScrollTrigger(query('.other'), { nestedStickyOptimization: 'off' });
    const vars = other.createStickyTrigger({ trigger: query('.otherScene'), end: '+=100' });

    vars.onRefreshInit?.(Object.create(OtherScrollTrigger.prototype) as ScrollTrigger);
    other.destroy();

    // With no instance using the table left, nothing is added to GSAP.
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects a value other than auto, always or off', () => {
    document.body.innerHTML = '<div class="root"></div>';

    expect(() => new StickyScrollTrigger(query('.root'), {
      nestedStickyOptimization: 'on' as never,
    })).toThrow('nestedStickyOptimization must be \'auto\', \'always\' or \'off\', got on');
  });

  // scrollMarginTargets: null turns that option off; null here mustn't quietly mean 'auto'.
  it('rejects null', () => {
    document.body.innerHTML = '<div class="root"></div>';

    expect(() => new StickyScrollTrigger(query('.root'), {
      nestedStickyOptimization: null as never,
    })).toThrow('nestedStickyOptimization must be \'auto\', \'always\' or \'off\', got null');
  });

  it('demotes this instance\'s wrappers and pins on refresh() with always', () => {
    const { controller, wrapper } = setupPinned('always');

    expect(wrapper.style.position).toBe('relative');
    expect(query('.pin').style.position).toBe('relative');
    controller.destroy();
  });

  it('demotes nothing with off', () => {
    const { controller, wrapper } = setupPinned('off');

    expect(wrapper.style.position).toBe('sticky');
    expect(query('.pin').style.position).toBe('sticky');
    controller.destroy();
  });

  it('gives a killed pin\'s trigger back without anything demotion wrote', () => {
    const { controller, pinVars } = setupPinned('always');

    expect(query('.pin').style.position).toBe('relative');
    pinVars.onKill?.(fakeSelf);

    expect(query('.pin').style.cssText).toBe('');
    controller.destroy();
  });

  it('gives every element back on destroy()', () => {
    const { controller } = setupPinned('always');

    controller.destroy();

    expect(query('.pin').style.cssText).toBe('');
    expect(query('.root').parentElement).toBe(document.body);
  });
});

describe('a kill followed by a GSAP refresh in the same task', () => {
  let dwell = 100;

  const setupScenes = (
    cls: object,
    end: () => string = () => `+=${dwell}`,
    options: ConstructorParameters<typeof StickyScrollTrigger>[1] = {},
  ) => {
    document.body.innerHTML = `
      <div class="host">
        <div class="root">
          <section class="s1"></section>
          <section class="s2"></section>
          <section class="s3"></section>
        </div>
      </div>`;

    const controller = new StickyScrollTrigger(query('.root'), options);
    const vars = ['.s1', '.s2', '.s3'].map((sel) =>
      controller.createStickyTrigger({ trigger: query(sel), end }));

    controller.refresh();

    const self = Object.create((cls as { prototype: object }).prototype) as ScrollTrigger;

    return { controller, vars, self };
  };

  const paddings = () => document.querySelectorAll<HTMLElement>('div[aria-hidden="true"]');
  const paddingTotal = () => Array.from(paddings())
    .reduce((sum, el) => sum + (parseFloat(el.style.height) || 0), 0);

  // The browser's scroll anchoring, with every padding above the viewport: the scroll follows
  // whatever their heights lose or gain.
  const anchorScroll = (from: number) => {
    const total = paddingTotal();

    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => from - (total - paddingTotal()));
  };

  afterEach(() => {
    vi.restoreAllMocks();
    dwell = 100;
  });

  // A start function's refresh() waits for the second pass, but a kill's rebuild can't.
  it('measures without a layer a function kills after its refresh()', () => {
    const { Cls, gsapRefresh } = makeClass({ rec: 0 });
    let act: (() => void) | null = null;
    const { controller, vars, self } = setupScenes(Cls, () => {
      act?.();

      return `+=${dwell}`;
    });
    let paddingsAtGsapRefresh: number | null = null;

    act = () => {
      act = null;
      controller.refresh();
      vars[0].onKill?.(self);
      gsapRefresh();
      paddingsAtGsapRefresh = paddings().length;
    };

    controller.refresh();

    expect(paddingsAtGsapRefresh).toBe(2);
  });

  // The first refreshInit spends the nested run, but the kill's rebuild still gets one.
  it('measures without a layer a function kills after its GSAP refresh', () => {
    const { Cls, gsapRefresh } = makeClass({ rec: 0 });
    let act: (() => void) | null = null;
    const { controller, vars, self } = setupScenes(Cls, () => {
      act?.();

      return `+=${dwell}`;
    });
    let paddingsAtGsapRefresh: number | null = null;

    act = () => {
      act = null;
      vars[1].onRefreshInit?.(self);
      vars[0].onKill?.(self);
      gsapRefresh();
      paddingsAtGsapRefresh = paddings().length;
    };

    controller.refresh();

    expect(paddingsAtGsapRefresh).toBe(2);
  });

  // The function's refresh() has already rebuilt without the layer, but GSAP measures the change.
  it('measures a change a function makes after a kill and its refresh() in its GSAP refresh', () => {
    const { Cls, gsapRefresh } = makeClass({ rec: 0 });
    let act: (() => void) | null = null;
    const { controller, vars, self } = setupScenes(Cls, () => {
      act?.();

      return `+=${dwell}`;
    });
    let paddingsAtGsapRefresh: string[] = [];

    act = () => {
      act = null;
      vars[0].onKill?.(self);
      controller.refresh();
      dwell = 300;
      gsapRefresh();
      paddingsAtGsapRefresh = Array.from(paddings(), (el) => el.style.height);
    };

    controller.refresh();

    expect(paddingsAtGsapRefresh).toEqual(['300px', '300px']);
  });

  // An earlier GSAP refresh has spent the nested run, but the kill's catch-up still runs.
  it('measures a change a function makes after a GSAP refresh, a kill and its refresh()', () => {
    const { Cls, gsapRefresh } = makeClass({ rec: 0 });
    let act: (() => void) | null = null;
    const { controller, vars, self } = setupScenes(Cls, () => {
      act?.();

      return `+=${dwell}`;
    });
    let paddingsAtGsapRefresh: string[] = [];

    act = () => {
      act = null;
      vars[1].onRefreshInit?.(self);
      vars[0].onKill?.(self);
      controller.refresh();
      dwell = 300;
      gsapRefresh();
      paddingsAtGsapRefresh = Array.from(paddings(), (el) => el.style.height);
    };

    controller.refresh();

    expect(paddingsAtGsapRefresh).toEqual(['300px', '300px']);
  });

  // The GSAP refresh comes back to the catch-up it starts from.
  it('stops catching up for a function that kills and starts a GSAP refresh on every evaluation', () => {
    const { Cls, gsapRefresh } = makeClass({ rec: 0 });
    let act: (() => void) | null = null;
    const end = vi.fn(() => {
      // Stops a recursion short of the stack's end.
      if (end.mock.calls.length < 50) act?.();

      return `+=${dwell}`;
    });
    const { controller, vars, self } = setupScenes(Cls, end);

    act = () => {
      vars[0].onKill?.(self);
      gsapRefresh();
    };

    end.mockClear();
    controller.refresh();

    expect(end.mock.calls.length).toBeLessThan(50);
  });

  it('refreshes once for a batch a layer\'s refreshInit runs', () => {
    const { Cls, listeners } = makeClass({ rec: 0 });
    const end = vi.fn(() => `+=${dwell}`);
    const { controller, vars, self } = setupScenes(Cls, end);

    vars[0].onKill?.(self);
    end.mockClear();
    Cls.isRefreshing = true;
    vars[1].onRefreshInit?.(self);
    vars[2].onRefreshInit?.(self);
    [...listeners].forEach((callback) => callback());
    Cls.isRefreshing = false;

    const inBatch = end.mock.calls.length;

    // As many reads as one refresh() of the two layers left makes.
    expect(inBatch).toBe(endCallsPerRefresh(controller, end));
  });

  // The batch is gone by its own listener, so nothing else builds the new layer in this refresh.
  it('refreshes again for a layer registered during the batch it ran', () => {
    const { Cls, listeners } = makeClass({ rec: 0 });
    let register = false;
    const { controller, vars, self } = setupScenes(Cls, () => {
      if (register) {
        register = false;
        controller.createStickyTrigger({ trigger: query('.s4'), end: '+=100' });
      }

      return `+=${dwell}`;
    });

    query('.root').append(Object.assign(document.createElement('section'), { className: 's4' }));
    vars[0].onKill?.(self);
    register = true;
    Cls.isRefreshing = true;
    vars[2].onRefreshInit?.(self);
    [...listeners].forEach((callback) => callback());
    Cls.isRefreshing = false;

    expect(paddings()).toHaveLength(3);
  });

  // The instance created first is dispatched first, before the batch's listener.
  it('rebuilds before an instance created earlier measures in that refresh', () => {
    const { Cls, listeners } = makeClass({ rec: 0 });

    document.body.innerHTML = `
      <div class="first"><section class="f1"></section></div>
      <div class="root"><section class="s1"></section><section class="s2"></section></div>`;

    const paddingsSeen: number[] = [];
    const first = new StickyScrollTrigger(query('.first'));
    const firstVars = first.createStickyTrigger({
      trigger: query('.f1'),
      start: () => {
        paddingsSeen.push(paddings().length);

        return 'top top';
      },
      end: '+=100',
    });
    const controller = new StickyScrollTrigger(query('.root'));
    const vars = ['.s1', '.s2'].map((sel) =>
      controller.createStickyTrigger({ trigger: query(sel), end: '+=100' }));
    const self = Object.create(Cls.prototype) as ScrollTrigger;

    first.refresh();
    controller.refresh();
    paddingsSeen.length = 0;
    vars[1].onKill?.(self);
    Cls.isRefreshing = true;
    firstVars.onRefreshInit?.(self);
    vars[0].onRefreshInit?.(self);
    [...listeners].forEach((callback) => callback());
    Cls.isRefreshing = false;

    expect(paddingsSeen).toEqual([2]);
  });

  it('rebuilds in that refresh\'s refreshInit, and skips the batch', async () => {
    const { Cls, listeners, gsapRefresh } = makeClass({ rec: 0 });
    const { vars, self } = setupScenes(Cls);

    vars[0].onKill?.(self);
    vars[1].onKill?.(self);
    expect(paddings()).toHaveLength(3);

    gsapRefresh();
    expect(paddings()).toHaveLength(1);

    await flushMicrotasks();
    expect(Cls.refresh).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });

  it('rebuilds in the batch and drops the listener when no GSAP refresh comes', async () => {
    const { Cls, listeners } = makeClass({ rec: 0 });
    const { vars, self } = setupScenes(Cls);

    vars[0].onKill?.(self);
    expect(listeners.length).toBeGreaterThan(0);

    await flushMicrotasks();
    expect(Cls.refresh).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0);
  });

  // Every padding is above the viewport: the content there sits 200px higher without the two.
  it('moves GSAP\'s scroll record so the content at the viewport\'s top stays put', () => {
    const scroller = { rec: 2500 };
    const { Cls, gsapRefresh } = makeClass(scroller);
    const { vars, self } = setupScenes(Cls);

    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(2500);
    vars[0].onKill?.(self);
    vars[1].onKill?.(self);
    gsapRefresh();

    expect(paddings()).toHaveLength(1);
    expect(scroller.rec).toBe(2300);
  });

  // GSAP records the scroll after the browser's anchoring has already followed the kill.
  it('doesn\'t add the browser\'s anchoring to the record it moves', () => {
    const scroller = { rec: 2500 };
    const { Cls, gsapRefresh } = makeClass(scroller);
    const { vars, self } = setupScenes(Cls);

    anchorScroll(2500);
    vars[0].onKill?.(self);
    vars[1].onKill?.(self);
    gsapRefresh();

    expect(scroller.rec).toBe(2300);
  });

  // Once the shrunk dwell is written, no scroll read comes before the table demotes the wrappers
  // again. jsdom puts everything at 0: the table built at 0 leaves every wrapper behind 5000, and
  // the one rebuilt near 5000 leaves them ahead of the 0 GSAP measures at.
  it('reads the scroll for the record only once the far wrappers are demoted again', () => {
    const scroller = { rec: 5000 };
    const { Cls, gsapRefresh } = makeClass(scroller);
    const { vars, self } = setupScenes(Cls, undefined, { nestedStickyOptimization: 'always' });
    const stickyWrappers = () => Array.from(document.querySelectorAll<HTMLElement>('*'))
      .filter((el) => el.style.position === 'sticky');
    const total = paddingTotal();
    const stickyAtReadAfterShrink: number[] = [];
    let from = 0;

    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => {
      if (paddingTotal() < total) stickyAtReadAfterShrink.push(stickyWrappers().length);

      return from - (total - paddingTotal());
    });
    vars[0].onRefreshInit?.(self);
    from = 5000;
    window.dispatchEvent(new Event('scroll'));
    expect(stickyWrappers()).toHaveLength(0);

    vars[0].onKill?.(self);
    vars[1].onKill?.(self);
    gsapRefresh();

    expect(stickyAtReadAfterShrink.length).toBeGreaterThan(0);
    expect(stickyAtReadAfterShrink.every((count) => count === 0)).toBe(true);
    expect(scroller.rec).toBe(4800);
  });

  // A refreshInit listener ahead of this one can move the scroll, and GSAP still scrolls back to
  // its record.
  it('keeps the content at GSAP\'s record, not at the scroll during its refresh', () => {
    const scroller = { rec: 2500 };
    const { Cls, gsapRefresh } = makeClass(scroller);
    const { vars, self } = setupScenes(Cls);

    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(2400);
    vars[0].onKill?.(self);
    vars[1].onKill?.(self);
    gsapRefresh();

    expect(scroller.rec).toBe(2300);
  });

  // GSAP sets the scroll itself once it has measured, record or not.
  it('never scrolls inside GSAP\'s refresh, even with no record to move', () => {
    const { Cls, gsapRefresh } = makeClass({ rec: 0 });
    const { vars, self } = setupScenes(Cls);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(2500);
    vars[0].onKill?.(self);
    gsapRefresh();

    expect(paddings()).toHaveLength(2);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  // A resize changes the dwell above the viewport too, and GSAP scrolls back to its number then.
  it('leaves GSAP\'s scroll record alone in a refresh no kill started', () => {
    const scroller = { rec: 2500 };
    const { Cls } = makeClass(scroller);
    const { controller, vars, self } = setupScenes(Cls);

    vars[0].onRefreshInit?.(self);
    anchorScroll(2500);
    dwell = 50;
    Cls.isRefreshing = true;
    controller.refresh();
    Cls.isRefreshing = false;

    expect(paddingTotal()).toBe(150);
    expect(scroller.rec).toBe(2500);
  });

  const scrollToSpy = () => vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

  // The scroll follows scrollTo here, as a browser's does.
  const followScrollTo = (from: number) => {
    let y = from;

    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => y);

    return vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
      y = (options as ScrollToOptions).top ?? y;
    });
  };

  // GSAP's record outlives its refresh, so a stale one is left in place: only the scroll counts.
  describe('with no GSAP refresh in the task', () => {
    it('scrolls the batch\'s rebuild back to the content at the viewport\'s top', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { controller, vars, self } = setupScenes(Cls);
      const scrollTo = scrollToSpy();

      vi.spyOn(window, 'scrollY', 'get').mockReturnValue(2500);
      vars[0].onKill?.(self);
      vars[1].onKill?.(self);
      expect(scrollTo).not.toHaveBeenCalled();

      await flushMicrotasks();
      expect(paddings()).toHaveLength(1);
      expect(scrollTo.mock.calls).toEqual([[{ top: 2300, behavior: 'instant' }]]);

      // The batch is done: a refresh after it is a resize's and keeps the scroll.
      dwell = 50;
      controller.refresh();
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    // GSAP's dispatch runs each trigger's onRefreshInit, then the listeners added since.
    it('rebuilds once, in the refreshInit of the GSAP refresh the batch starts', async () => {
      const { Cls, listeners } = makeClass({ rec: 0 });
      const inGsapRefresh: boolean[] = [];
      const end = vi.fn(() => {
        inGsapRefresh.push(Cls.isRefreshing);

        return '+=100';
      });
      const { controller, vars, self } = setupScenes(Cls, end);

      Cls.refresh.mockImplementation(() => {
        Cls.isRefreshing = true;
        vars.slice(1).forEach((layerVars) => layerVars.onRefreshInit?.(self));
        [...listeners].forEach((callback) => callback());
        Cls.isRefreshing = false;
      });
      inGsapRefresh.length = 0;
      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(Cls.refresh).toHaveBeenCalledTimes(1);
      // Every evaluation inside GSAP's refresh, as many as one refresh() of the layers left makes.
      expect(inGsapRefresh).not.toContain(false);

      const inBatch = inGsapRefresh.length;

      expect(inBatch).toBe(endCallsPerRefresh(controller, end));
    });

    it('leaves a kill during the batch\'s GSAP refresh to a GSAP refresh of its own', async () => {
      const { Cls, gsapRefresh } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);

      // The second kill comes from onRefresh, once GSAP has measured.
      Cls.refresh.mockImplementationOnce(() => {
        gsapRefresh();
        vars[1].onKill?.(self);
      });
      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(Cls.refresh).toHaveBeenCalledTimes(2);
      expect(paddings()).toHaveLength(1);
    });

    // GSAP's dispatch has no try/catch: a listener before the batch's stops the rest.
    it('still rebuilds when a refreshInit listener before the batch\'s throws', async () => {
      const { Cls, listeners } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);

      Cls.refresh.mockImplementation(() => {
        throw new Error('listener');
      });

      const uncaught = await runDispatch(() => vars[0].onKill?.(self));

      expect(uncaught.map((error) => (error as Error).message)).toEqual(['listener']);
      expect(paddings()).toHaveLength(2);
      expect(listeners).toHaveLength(0);
    });

    it('doesn\'t scroll where the browser\'s anchoring has already kept the content', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = scrollToSpy();

      anchorScroll(2500);
      vars[0].onKill?.(self);
      vars[1].onKill?.(self);
      await flushMicrotasks();

      expect(paddings()).toHaveLength(1);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('scrolls the last kill\'s teardown back to the content at the viewport\'s top', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = scrollToSpy();

      vi.spyOn(window, 'scrollY', 'get').mockReturnValue(2500);
      vars.forEach((layerVars) => layerVars.onKill?.(self));
      expect(paddings()).toHaveLength(0);

      await flushMicrotasks();
      expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
    });

    it('doesn\'t scroll the last kill where the browser\'s anchoring has kept the content', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = scrollToSpy();

      anchorScroll(2500);
      vars.forEach((layerVars) => layerVars.onKill?.(self));
      await flushMicrotasks();

      expect(paddings()).toHaveLength(0);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    // A setup run again in the task puts the dwell back, and the content stays put without a
    // scroll; keeping it would shift it by that dwell.
    it('leaves the scroll alone when a registration follows the last kill in the task', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { controller, vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);

      vars.forEach((layerVars) => layerVars.onKill?.(self));
      controller.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
      controller.refresh();
      await flushMicrotasks();

      expect(paddings()).toHaveLength(1);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    // Nested instances: the outer one's layers were there all along and put nothing back.
    it('keeps the content beside an instance on a container around it that was armed already', async () => {
      const { Cls } = makeClass({ rec: 2500 });

      document.body.innerHTML = `
        <div class="outer"><section class="o1"></section>
          <div class="host"><div class="root">
            <section class="s1"></section><section class="s2"></section><section class="s3"></section>
          </div></div>
        </div>`;

      const outer = new StickyScrollTrigger(query('.outer'));

      outer.createStickyTrigger({ trigger: query('.o1'), end: '+=100' });

      const controller = new StickyScrollTrigger(query('.root'));
      const vars = ['.s1', '.s2', '.s3'].map((sel) =>
        controller.createStickyTrigger({ trigger: query(sel), end: '+=100' }));
      const self = Object.create(Cls.prototype) as ScrollTrigger;

      controller.refresh();

      const scrollTo = followScrollTo(2500);

      vars.forEach((layerVars) => layerVars.onKill?.(self));
      await flushMicrotasks();

      expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
      outer.destroy();
    });

    // No trigger updates at a scroll in between.
    it('keeps the content with one move around the batch\'s GSAP refresh', async () => {
      const scroller = { rec: 0 };
      const { Cls, gsapRefresh } = makeClass(scroller);
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);
      const scrollAfterGsapRefresh: number[] = [];

      // GSAP's refresh records the scroll, dispatches refreshInit, measures, then scrolls back to
      // its record and clears it.
      Cls.refresh.mockImplementation(() => {
        scroller.rec = window.scrollY;
        gsapRefresh();
        window.scrollTo({ top: scroller.rec, behavior: 'instant' });
        scroller.rec = 0;
        scrollAfterGsapRefresh.push(window.scrollY);
      });
      vars.forEach((layerVars) => layerVars.onKill?.(self));
      await flushMicrotasks();

      expect(scrollAfterGsapRefresh).toEqual([2200]);
      expect(new Set(scrollTo.mock.calls.map(([options]) => (options as ScrollToOptions).top)))
        .toEqual(new Set([2200]));
    });

    // GSAP has scrolled back and cleared its record by onRefresh and the update after it.
    it('keeps the content for a last kill after GSAP has scrolled back in its refresh', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);

      Cls.isRefreshing = true;
      vars.forEach((layerVars) => layerVars.onKill?.(self));
      Cls.isRefreshing = false;
      expect(paddings()).toHaveLength(0);
      expect(scrollTo).not.toHaveBeenCalled();

      await flushMicrotasks();
      expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
    });

    it('moves GSAP\'s record for a last kill when GSAP refreshes later in the task', () => {
      const scroller = { rec: 2500 };
      const { Cls, gsapRefresh } = makeClass(scroller);
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);

      vars.forEach((layerVars) => layerVars.onKill?.(self));
      gsapRefresh();

      expect(scroller.rec).toBe(2200);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    // A layer killed before the first refresh() never padded anything.
    it('leaves the scroll alone for a kill before the first build', async () => {
      const { Cls } = makeClass({ rec: 0 });

      document.body.innerHTML = `
        <div class="host"><div class="root">
          <section class="s1"></section><section class="s2"></section><section class="s3"></section>
        </div></div>`;

      const controller = new StickyScrollTrigger(query('.root'));
      const vars = ['.s1', '.s2', '.s3'].map((sel) =>
        controller.createStickyTrigger({ trigger: query(sel), end: '+=100' }));
      const self = Object.create(Cls.prototype) as ScrollTrigger;
      const scrollTo = followScrollTo(2500);

      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(paddings()).toHaveLength(2);
      expect(scrollTo).not.toHaveBeenCalled();
      controller.destroy();
    });

    // A scroll listener ahead of GSAP's sees the first scroll after a pause as no scroll yet.
    it('drops the last kill\'s keep when a scroll has begun by the time it runs', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);

      vars.forEach((layerVars) => layerVars.onKill?.(self));
      Cls.scrolling = true;
      await flushMicrotasks();

      expect(paddings()).toHaveLength(0);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    // A gsap.context revert and re-run with an instance per run.
    it('leaves the scroll alone when a new instance on the container registers in the task', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);

      vars.forEach((layerVars) => layerVars.onKill?.(self));

      const next = new StickyScrollTrigger(query('.host'));

      next.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
      await flushMicrotasks();

      expect(scrollTo).not.toHaveBeenCalled();
      next.destroy();
    });

    it('keeps the content when only an instance elsewhere registers in the task', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);
      const elsewhere = document.createElement('div');

      elsewhere.innerHTML = '<section class="other"></section>';
      document.body.append(elsewhere);
      vars.forEach((layerVars) => layerVars.onKill?.(self));

      const next = new StickyScrollTrigger(elsewhere);

      next.createStickyTrigger({ trigger: query('.other'), end: '+=100' });
      await flushMicrotasks();

      expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
      next.destroy();
    });

    it('still batches the next kill after the batch\'s rebuild throws', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      let fail = false;
      const { vars, self } = setupScenes(Cls, () => {
        if (fail) throw new Error('boom');

        return '+=100';
      });
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown) => uncaught.push(error);

      vars[0].onKill?.(self);
      fail = true;
      process.on('uncaughtException', onUncaught);

      try {
        await flushMicrotasks();
      } finally {
        process.off('uncaughtException', onUncaught);
        fail = false;
      }

      expect(uncaught).toHaveLength(1);

      vars[1].onKill?.(self);
      await flushMicrotasks();
      expect(paddings()).toHaveLength(1);
    });

    it('keeps the content for a kill after a refresh() that already used up an earlier one', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { controller, vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);

      vars[0].onKill?.(self);
      controller.refresh();
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 2400, behavior: 'instant' });

      vars[1].onKill?.(self);
      await flushMicrotasks();
      expect(paddings()).toHaveLength(1);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 2300, behavior: 'instant' });
    });

    it('batches a kill made during the batch\'s own rebuild', async () => {
      const { Cls } = makeClass({ rec: 2500 });
      let killDuringRebuild = false;
      const { vars, self } = setupScenes(Cls, () => {
        if (killDuringRebuild) {
          killDuringRebuild = false;
          vars[1].onKill?.(self);
        }

        return '+=100';
      });
      const scrollTo = followScrollTo(2500);

      vars[0].onKill?.(self);
      killDuringRebuild = true;
      await flushMicrotasks();

      expect(paddings()).toHaveLength(1);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 2300, behavior: 'instant' });
    });

    it('leaves the scroll alone in a refresh no kill started', () => {
      const { Cls } = makeClass({ rec: 2500 });
      const { controller } = setupScenes(Cls);
      const scrollTo = scrollToSpy();

      vi.spyOn(window, 'scrollY', 'get').mockReturnValue(2500);
      dwell = 50;
      controller.refresh();

      expect(paddingTotal()).toBe(150);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  // The next refresh puts back what a failed one left unpadded.
  it('leaves GSAP\'s scroll record alone when the rebuild throws', async () => {
    const scroller = { rec: 2500 };
    const { Cls, gsapRefresh } = makeClass(scroller);
    let fail = false;
    const { vars, self } = setupScenes(Cls, () => {
      if (fail) throw new Error('boom');

      return '+=100';
    });

    anchorScroll(2500);
    vars[0].onKill?.(self);
    fail = true;

    // The listener's throw goes off the stack, as the onRefreshInit handler's does.
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    process.on('uncaughtException', onUncaught);

    try {
      gsapRefresh();
      await flushMicrotasks();
    } finally {
      process.off('uncaughtException', onUncaught);
      fail = false;
    }

    expect(uncaught).toHaveLength(1);
    expect(scroller.rec).toBe(2500);
  });

  // GSAP holds its own refresh for the end of a scroll; a scroll mid-fling would stop the fling.
  describe('while GSAP reports a scroll', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('holds the batch until the scroll stops, then keeps the content and refreshes GSAP once', async () => {
      const { Cls, listeners } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);

      Cls.scrolling = true;
      vars[0].onKill?.(self);
      await flushMicrotasks();
      vi.advanceTimersByTime(250);

      expect(paddings()).toHaveLength(3);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(Cls.refresh).not.toHaveBeenCalled();

      // No scrollEnd or other event: ScrollTrigger.killAll() drops every GSAP listener.
      listeners.length = 0;
      Cls.scrolling = false;
      vi.advanceTimersByTime(100);

      expect(paddings()).toHaveLength(2);
      expect(scrollTo.mock.calls).toEqual([[{ top: 2400, behavior: 'instant' }]]);
      expect(Cls.refresh).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('lets a GSAP refresh before the scroll stops run the held batch', async () => {
      const scroller = { rec: 2500 };
      const { Cls, listeners, gsapRefresh } = makeClass(scroller);
      const { vars, self } = setupScenes(Cls);

      vi.spyOn(window, 'scrollY', 'get').mockReturnValue(2500);
      Cls.scrolling = true;
      vars[0].onKill?.(self);
      await flushMicrotasks();
      gsapRefresh();

      expect(paddings()).toHaveLength(2);
      expect(scroller.rec).toBe(2400);

      Cls.scrolling = false;
      vi.advanceTimersByTime(100);
      expect(Cls.refresh).not.toHaveBeenCalled();
      expect(listeners).toHaveLength(0);
    });

    it('drops the held batch on destroy()', async () => {
      const { Cls, listeners } = makeClass({ rec: 0 });
      const { controller, vars, self } = setupScenes(Cls);

      Cls.scrolling = true;
      vars[0].onKill?.(self);
      await flushMicrotasks();
      controller.destroy();

      expect(listeners).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      Cls.scrolling = false;
      vi.advanceTimersByTime(100);
      expect(Cls.refresh).not.toHaveBeenCalled();
    });

    it('drops the listener of a held batch a GSAP refresh ran, when a later kill holds another', async () => {
      const { Cls, listeners, gsapRefresh } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);

      followScrollTo(2500);
      Cls.scrolling = true;
      vars[0].onKill?.(self);
      await flushMicrotasks();
      gsapRefresh();
      vars[1].onKill?.(self);
      await flushMicrotasks();

      Cls.scrolling = false;
      vi.advanceTimersByTime(100);
      expect(paddings()).toHaveLength(1);
      expect(Cls.refresh).toHaveBeenCalledTimes(1);
      expect(listeners).toHaveLength(0);
    });

    // As GSAP holds its own refresh: a finger held still keeps isScrolling() true, and so does
    // ScrollTrigger.disable() mid-scroll.
    it('waits as long as GSAP reports a scroll, however long the scroll stands still', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);

      followScrollTo(2500);
      Cls.scrolling = true;
      vars[0].onKill?.(self);
      await flushMicrotasks();
      vi.advanceTimersByTime(5000);
      expect(paddings()).toHaveLength(3);

      Cls.scrolling = false;
      vi.advanceTimersByTime(100);
      expect(paddings()).toHaveLength(2);
    });

    // A refresh() the page calls itself is no fling: kd6 skipped its scroll and the content
    // jumped where the browser doesn't anchor.
    it('keeps the content in a refresh() called mid-scroll', () => {
      const { Cls } = makeClass({ rec: 0 });
      const { controller, vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(2500);

      Cls.scrolling = true;
      vars[0].onKill?.(self);
      controller.refresh();

      expect(paddings()).toHaveLength(2);
      expect(scrollTo.mock.calls).toEqual([[{ top: 2400, behavior: 'instant' }]]);
    });

    // That function scrolls too, which mid-fling would stop it.
    // GSAP's scroll function: a getter that returns the cached scroll, a setter that scrolls.
    const cachingScroller = (initial: number) => {
      let cached = initial;

      return vi.fn((value?: number) => {
        if (value === undefined) return cached;

        cached = Math.round(value);

        return undefined;
      });
    };

    it('updates GSAP\'s cached scroll after the browser\'s anchoring has moved it', async () => {
      const scroller = cachingScroller(2500);
      const { Cls } = makeClass(scroller as { rec?: unknown });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = scrollToSpy();

      anchorScroll(2500);
      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(paddings()).toHaveLength(2);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(scroller).toHaveBeenLastCalledWith(2400);
    });

    // That function scrolls too, which mid-fling would stop it.
    it('leaves GSAP\'s scroll function alone when its cache already holds the scroll', async () => {
      const scroller = cachingScroller(2400);
      const { Cls } = makeClass(scroller as { rec?: unknown });
      const { vars, self } = setupScenes(Cls);

      scrollToSpy();
      anchorScroll(2500);
      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(paddings()).toHaveLength(2);
      expect(scroller.mock.calls.every((args) => args.length === 0)).toBe(true);
    });

    it('scrolls to a whole pixel, as GSAP\'s scroll function sets the cache', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls, () => '+=100.4');
      const scrollTo = followScrollTo(2500);

      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(scrollTo.mock.calls).toEqual([[{ top: 2400, behavior: 'instant' }]]);
    });

    // A trigger created before the next scroll event scrolls back up to GSAP's cached number.
    it('tells GSAP\'s scroll function where it scrolled', async () => {
      const scroller = vi.fn();
      const { Cls } = makeClass(scroller as { rec?: unknown });
      const { vars, self } = setupScenes(Cls);

      followScrollTo(2500);
      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(scroller).toHaveBeenLastCalledWith(2400);
    });

    describe('the last kill', () => {
      it('keeps the structure until the scroll stops, and refresh() leaves it alone', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        await flushMicrotasks();
        dwell = 50;
        controller.refresh();

        expect(paddingTotal()).toBe(300);
        expect(scrollTo).not.toHaveBeenCalled();

        Cls.scrolling = false;
        vi.advanceTimersByTime(100);
        await flushMicrotasks();

        expect(paddings()).toHaveLength(0);
        expect(query('.root').parentElement).toBe(query('.host'));
        expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
        expect(Cls.refresh).toHaveBeenCalledTimes(1);
      });

      it('keeps the structure when a function kills every layer and calls refresh()', async () => {
        const { Cls } = makeClass({ rec: 0 });
        let act: (() => void) | null = null;
        const { controller, vars, self } = setupScenes(Cls, () => {
          act?.();

          return `+=${dwell}`;
        });
        const scrollTo = followScrollTo(2500);

        act = () => {
          act = null;
          vars.forEach((layerVars) => layerVars.onKill?.(self));
          controller.refresh();
        };

        Cls.scrolling = true;
        controller.refresh();
        await flushMicrotasks();

        expect(paddings()).toHaveLength(3);
        expect(scrollTo).not.toHaveBeenCalled();
      });

      // GSAP measures in that refresh, and nothing refreshes it again once the scroll stops.
      it('tears down in a GSAP refresh before the scroll stops', async () => {
        const scroller = { rec: 2500 };
        const { Cls, gsapRefresh } = makeClass(scroller);
        const { vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        await flushMicrotasks();
        gsapRefresh();

        expect(paddings()).toHaveLength(0);
        expect(scroller.rec).toBe(2200);

        Cls.scrolling = false;
        vi.advanceTimersByTime(100);
        expect(Cls.refresh).not.toHaveBeenCalled();
        expect(scrollTo).not.toHaveBeenCalled();
      });

      // Inside a trigger callback, the first scroll after a pause doesn't read as scrolling yet.
      it('waits out a GSAP update alone, and tears down before GSAP measures', async () => {
        const { Cls, gsapRefresh } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const paddingsAtGsapRefresh: number[] = [];

        Cls.refresh.mockImplementation(() => {
          gsapRefresh();
          paddingsAtGsapRefresh.push(paddings().length);
        });
        Cls.isUpdating = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        expect(paddings()).toHaveLength(3);

        Cls.isUpdating = false;
        await flushMicrotasks();

        expect(paddings()).toHaveLength(0);
        expect(paddingsAtGsapRefresh).toEqual([0]);
      });

      it('tears down at once inside GSAP\'s refresh', () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);

        Cls.scrolling = true;
        Cls.isRefreshing = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        Cls.isRefreshing = false;

        expect(paddings()).toHaveLength(0);
      });

      it('reuses the structure for a registration before the scroll stops', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        controller.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
        controller.refresh();

        // As at rest: the setup puts the dwell back, so the content isn't kept.
        expect(paddings()).toHaveLength(1);
        expect(scrollTo).not.toHaveBeenCalled();

        Cls.scrolling = false;
        await flushMicrotasks();
        vi.advanceTimersByTime(100);
        expect(paddings()).toHaveLength(1);
      });

      it('hands the root back to a new instance that only resolves a trigger on it', () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        const next = new StickyScrollTrigger(query('.root'));

        expect(paddings()).toHaveLength(3);

        next.createResolvedTrigger({ trigger: query('.s1') });
        expect(paddings()).toHaveLength(0);
        expect(query('.root').parentElement).toBe(query('.host'));
        next.destroy();
      });

      // A gsap.context revert and re-run on the same instance, mid-freeze: the progress goes on.
      it('leaves the scroll alone once the scroll stops after the same setup ran again', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(150);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        ['.s1', '.s2', '.s3'].forEach((sel) =>
          controller.createStickyTrigger({ trigger: query(sel), end: '+=100' }));
        await flushMicrotasks();

        Cls.scrolling = false;
        vi.advanceTimersByTime(100);
        await flushMicrotasks();

        expect(paddings()).toHaveLength(3);
        expect(Cls.refresh).toHaveBeenCalledTimes(1);
        expect(scrollTo).not.toHaveBeenCalled();
      });

      // A pin killed before the first refresh() never wrapped anything, so it schedules no batch.
      it('hands the page back from a last pin kill held by a GSAP update alone', async () => {
        const { Cls } = makeClass({ rec: 0 });

        document.body.innerHTML = '<div class="root"></div><div class="pin"></div>';

        const remove = vi.spyOn(window, 'removeEventListener');
        const controller = new StickyScrollTrigger(query('.root'));
        const vars = controller.createStickyPin({ trigger: query('.pin') });
        const self = Object.create(Cls.prototype) as ScrollTrigger;

        Cls.isUpdating = true;
        vars.onKill?.(self);
        expect(remove.mock.calls.some(([type]) => type === 'scroll')).toBe(false);

        Cls.isUpdating = false;
        await flushMicrotasks();
        expect(remove.mock.calls.some(([type]) => type === 'scroll')).toBe(true);
      });

      // A new instance per gsap.matchMedia setup expects the root back as it was. Mid-scroll the
      // content isn't kept: the new setup puts the dwell back.
      it('hands the root back to a new instance on it', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        const next = new StickyScrollTrigger(query('.root'));

        expect(paddings()).toHaveLength(3);

        next.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
        await flushMicrotasks();
        expect(paddings()).toHaveLength(0);
        expect(query('.root').parentElement).toBe(query('.host'));
        expect(scrollTo).not.toHaveBeenCalled();
        next.destroy();
      });

      // Its setup puts the dwell back by registering in the task.
      it('leaves the scroll alone for a new instance that registers, once the scroll has stopped', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        Cls.scrolling = false;

        const next = new StickyScrollTrigger(query('.root'));

        next.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
        await flushMicrotasks();
        expect(paddings()).toHaveLength(0);
        expect(scrollTo).not.toHaveBeenCalled();
        next.destroy();
      });

      // A setup that registers nothing (effects off at this breakpoint) puts no dwell back.
      it('keeps the content for a new instance that registers nothing, once the scroll has stopped', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        Cls.scrolling = false;

        const next = new StickyScrollTrigger(query('.root'));

        await flushMicrotasks();
        expect(paddings()).toHaveLength(0);
        expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
        next.destroy();
      });

      // Reverting GSAP's own pins mid-scroll leaves the scroll alone too, and a new setup that
      // usually follows puts the dwell back.
      it('gives everything back on destroy() mid-scroll, leaving the scroll alone', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        controller.destroy();
        await flushMicrotasks();

        expect(paddings()).toHaveLength(0);
        expect(query('.root').parentElement).toBe(query('.host'));
        expect(vi.getTimerCount()).toBe(0);
        expect(scrollTo).not.toHaveBeenCalled();
      });

      // As the held kill would have: the scroll has stopped, the poll just hasn't seen it yet.
      it('keeps the content on destroy() once the scroll has stopped', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        Cls.scrolling = false;
        controller.destroy();
        await flushMicrotasks();

        expect(paddings()).toHaveLength(0);
        expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
      });

      it('hands the page back to a new instance on a container around it, not elsewhere', () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const elsewhere = document.createElement('div');

        document.body.append(elsewhere);
        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        const unrelated = new StickyScrollTrigger(elsewhere);
        const section = document.createElement('section');

        elsewhere.append(section);
        unrelated.createStickyTrigger({ trigger: section, end: '+=100' });
        expect(paddings()).toHaveLength(3);

        const around = new StickyScrollTrigger(query('.host'));

        around.createStickyTrigger({ trigger: query('.root'), end: '+=100' });
        expect(paddings()).toHaveLength(0);
        expect(query('.root').parentElement).toBe(query('.host'));
        unrelated.destroy();
        around.destroy();
      });

      // Instances made up front, one per gsap.matchMedia setup, arm only when their setup runs.
      it('hands the page back to an existing instance that arms on a container around it', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const around = new StickyScrollTrigger(query('.host'));

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        expect(paddings()).toHaveLength(3);

        around.createStickyTrigger({ trigger: query('.root'), end: '+=100' });
        expect(paddings()).toHaveLength(0);

        around.refresh();
        Cls.scrolling = false;
        vi.advanceTimersByTime(100);
        await flushMicrotasks();

        expect(paddings()).toHaveLength(1);
        around.destroy();
      });

      // Before the default cover is read: the held wrappers hold the container away from its
      // sibling.
      it('hands the page back before an overlap registration around it reads its cover', () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const after = document.createElement('div');

        query('.host').append(after);
        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        const around = new StickyScrollTrigger(query('.host'));

        expect(() => around.createOverlapScroll({ trigger: query('.root') })).not.toThrow();
        expect(paddings()).toHaveLength(0);
        around.destroy();
      });

      it('hands the page back to a pin registration around it', () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        const around = new StickyScrollTrigger(query('.host'));

        around.createStickyPin({ trigger: query('.root') });
        expect(paddings()).toHaveLength(0);
        around.destroy();
      });

      // A lazily mounted component, say: tearing down mid-scroll would jump the content.
      it('leaves the hold to the end of the scroll for a new instance that registers nothing', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        const next = new StickyScrollTrigger(query('.root'));

        await flushMicrotasks();
        expect(paddings()).toHaveLength(3);

        Cls.scrolling = false;
        vi.advanceTimersByTime(100);
        await flushMicrotasks();
        expect(paddings()).toHaveLength(0);
        expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
        next.destroy();
      });

      it('hands the page back to a new instance on a container inside it', () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);

        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        const inside = new StickyScrollTrigger(query('.s2'));
        const child = document.createElement('div');

        query('.s2').append(child);
        inside.createStickyTrigger({ trigger: child, end: '+=100' });
        expect(paddings()).toHaveLength(0);
        inside.destroy();
      });

      // Inside GSAP's update the first scroll after a pause doesn't read as scrolling yet.
      it('leaves the scroll alone on destroy() during a GSAP update that holds the last kill', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.isUpdating = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        controller.destroy();
        // GSAP marks the scroll once the update for its first event is over.
        Cls.isUpdating = false;
        Cls.scrolling = true;
        await flushMicrotasks();

        expect(paddings()).toHaveLength(0);
        expect(scrollTo).not.toHaveBeenCalled();
      });

      it('leaves the scroll alone for a new instance during a GSAP update that holds the last kill', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.isUpdating = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        const next = new StickyScrollTrigger(query('.root'));

        next.createStickyTrigger({ trigger: query('.s1'), end: '+=100' });
        Cls.isUpdating = false;
        Cls.scrolling = true;
        await flushMicrotasks();

        expect(paddings()).toHaveLength(0);
        expect(scrollTo).not.toHaveBeenCalled();
        next.destroy();
      });

      // GSAP's 250ms sync tick runs an update at rest too.
      it('keeps the content on destroy() during a GSAP update no scroll started', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(2500);

        Cls.isUpdating = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        controller.destroy();
        Cls.isUpdating = false;
        await flushMicrotasks();

        expect(paddings()).toHaveLength(0);
        expect(scrollTo.mock.calls).toEqual([[{ top: 2200, behavior: 'instant' }]]);
      });

      it('tells GSAP\'s scroll function where it scrolled after a destroy() in the task', async () => {
        const scroller = vi.fn();
        const { Cls } = makeClass(scroller as { rec?: unknown });
        const { controller, vars, self } = setupScenes(Cls);

        followScrollTo(2500);
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        controller.destroy();
        await flushMicrotasks();

        expect(scroller).toHaveBeenLastCalledWith(2200);
      });

      it('reports both errors when the held teardown and the batch throw', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        let fail = false;

        vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => {
          if (!fail) return 2500;

          fail = false;
          throw new Error('teardown');
        });
        scrollToSpy();
        Cls.refresh.mockImplementation(() => {
          throw new Error('batch');
        });
        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        await flushMicrotasks();

        const uncaught: unknown[] = [];
        const onUncaught = (error: unknown) => uncaught.push(error);

        Cls.scrolling = false;
        fail = true;
        process.on('uncaughtException', onUncaught);

        try {
          expect(() => vi.advanceTimersByTime(100)).toThrow('teardown');
          await flushMicrotasks();
        } finally {
          process.off('uncaughtException', onUncaught);
        }

        expect(uncaught).toEqual([new Error('batch')]);
      });

      it('still destroys the instance when the held teardown throws in destroy()', async () => {
        const { Cls, listeners } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        let fail = false;

        vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => {
          if (!fail) return 2500;

          fail = false;
          throw new Error('boom');
        });
        scrollToSpy();
        vars[0].onKill?.(self);
        await flushMicrotasks();
        Cls.scrolling = true;
        vars[1].onKill?.(self);
        vars[2].onKill?.(self);
        await flushMicrotasks();
        Cls.scrolling = false;
        fail = true;

        expect(() => controller.destroy()).toThrow('boom');
        expect(vi.getTimerCount()).toBe(0);
        expect(listeners).toHaveLength(0);
        expect(() => controller.createStickyTrigger({ trigger: query('.s1') })).toThrow();
      });

      it('leaves another instance\'s hold alone for a registration on a destroyed one', () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const around = new StickyScrollTrigger(query('.host'));

        around.destroy();
        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));

        expect(() => around.createStickyTrigger({ trigger: query('.root') })).toThrow();
        expect(paddings()).toHaveLength(3);
      });

      // A kill from a page whose cleanup throws still refreshes GSAP for the triggers left.
      it('still runs the held batch when the held teardown throws', async () => {
        const { Cls, listeners } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        let fail = false;

        // The teardown's first read throws.
        vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => {
          if (!fail) return 2500;

          fail = false;
          throw new Error('boom');
        });
        scrollToSpy();
        Cls.scrolling = true;
        vars.forEach((layerVars) => layerVars.onKill?.(self));
        await flushMicrotasks();

        Cls.scrolling = false;
        fail = true;
        expect(() => vi.advanceTimersByTime(100)).toThrow('boom');
        expect(paddings()).toHaveLength(0);
        expect(Cls.refresh).toHaveBeenCalledTimes(1);
        expect(listeners).toHaveLength(0);
      });
    });

    // The killed layer's padding is still in the DOM until the scroll stops. jsdom puts every
    // section at 0, so 'top -150px' reaches the viewport's top at 150.
    it('resolves positions against the padding still in place', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { controller, vars, self } = setupScenes(Cls);
      const before = controller.resolveScrollPosition(query('.s3'), 'top -150px');

      Cls.scrolling = true;
      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(before).toBe(450);
      expect(controller.resolveScrollPosition(query('.s3'), 'top -150px')).toBe(before);
    });

    // jsdom never sticks anything, so .s3 reports a top 400px off whenever a wrapper around it
    // carries position:sticky, standing in for the shift a stuck one causes.
    it('resets the killed layer\'s wrappers still in place before measuring', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { controller, vars, self } = setupScenes(Cls);
      const s3 = query('.s3');

      Object.defineProperty(s3, 'offsetTop', {
        configurable: true,
        get: () => {
          for (let el = s3.parentElement; el; el = el.parentElement) {
            if (el.style.position === 'sticky') return 400;
          }

          return 0;
        },
      });

      const before = controller.resolveScrollPosition(s3, 'top -150px');

      Cls.scrolling = true;
      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(before).toBe(450);
      expect(controller.resolveScrollPosition(s3, 'top -150px')).toBe(before);
    });

    it('drops every listener when an earlier held batch throws', async () => {
      const { Cls, listeners, gsapRefresh } = makeClass({ rec: 0 });
      let fail = false;
      const { vars, self } = setupScenes(Cls, () => {
        if (fail) throw new Error('boom');

        return '+=100';
      });

      followScrollTo(2500);
      Cls.scrolling = true;
      vars[0].onKill?.(self);
      await flushMicrotasks();
      gsapRefresh();
      vars[1].onKill?.(self);
      await flushMicrotasks();

      fail = true;
      Cls.scrolling = false;
      Cls.refresh.mockClear();

      // The catch-up's throw goes off the stack, as inside GSAP's refreshInit, and GSAP still
      // refreshes.
      let uncaught: unknown[];

      try {
        uncaught = await runDispatch(() => vi.advanceTimersByTime(100));
      } finally {
        fail = false;
      }

      expect(uncaught.map((error) => (error as Error).message)).toEqual(['boom']);
      expect(Cls.refresh).toHaveBeenCalledTimes(1);
      expect(listeners).toHaveLength(0);
    });
  });

  // Windows here: s1 0-100, s2 100-200, s3 200-300, every section at 0.
  describe('mid-freeze', () => {
    it('keeps the scroll\'s progress through a freeze that stays', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(150);

      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(scrollTo.mock.calls).toEqual([[{ top: 50, behavior: 'instant' }]]);
    });

    it('caps that progress at the freeze\'s new dwell', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(150);

      vars[0].onKill?.(self);
      dwell = 30;
      await flushMicrotasks();

      expect(scrollTo.mock.calls).toEqual([[{ top: 30, behavior: 'instant' }]]);
    });

    // Every section sits at 0 here, so the windows tie: the scroll in s2 had gone through all of
    // s1, which stays counted, and s3 hadn't started.
    it('drops the progress through a freeze that was killed, keeping the ones before it', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(150);

      vars[1].onKill?.(self);
      await flushMicrotasks();

      expect(scrollTo.mock.calls).toEqual([[{ top: 100, behavior: 'instant' }]]);
    });

    // A layer registered with the kill counts as dwellBeforeReach counts it: s4's freeze ties at
    // the content's natural spot but starts after s2's, which the scroll hasn't reached.
    it('counts a layer new since the kill only if the content is past it', () => {
      const { Cls } = makeClass({ rec: 0 });
      const { controller, vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(50);
      const s4 = document.createElement('section');

      s4.className = 's4';
      query('.root').append(s4);
      vars[2].onKill?.(self);
      controller.createStickyTrigger({ trigger: s4, end: '+=100' });
      controller.refresh();

      expect(paddings()).toHaveLength(3);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    // An inner trigger at its outer's top: s2's freeze starts where s1's natural start ties.
    it('leaves the scroll alone when a layer after a tied freeze is killed', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(150);

      vars[2].onKill?.(self);
      await flushMicrotasks();

      expect(paddings()).toHaveLength(2);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('keeps a passed freeze passed when its dwell grows', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(250);

      vars[2].onKill?.(self);
      dwell = 130;
      await flushMicrotasks();

      expect(scrollTo.mock.calls).toEqual([[{ top: 260, behavior: 'instant' }]]);
    });

    it('keeps the progress of a freeze registered again on the same trigger in the task', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { controller, vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(250);

      vars[2].onKill?.(self);
      controller.createStickyTrigger({ trigger: query('.s3'), end: '+=100' });
      await flushMicrotasks();

      expect(scrollTo).not.toHaveBeenCalled();
    });

    // Every element sits at base (jsdom has no layout), so the windows run 1000-1100, 1100-1200,
    // 1200-1300. Another instance's rebuild then takes 100px of dwell off above the container and
    // its catch-up scrolls with it, from 1250 to 1150. The new dwells are 30 each, so s3 keeps 30
    // of its 50.
    describe('with the container moved since its windows were measured', () => {
      let base = 1000;

      beforeEach(() => {
        base = 1000;
        vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(() => base);
      });

      const rebuildAnother = () => {
        const other = document.createElement('div');

        other.innerHTML = '<section class="o1"></section><section class="o2"></section>';
        document.body.append(other);

        const instance = new StickyScrollTrigger(other);

        instance.createStickyTrigger({ trigger: query('.o1'), end: '+=100' });
        instance.refresh();

        return () => {
          instance.createStickyTrigger({ trigger: query('.o2'), end: '+=100' });
          instance.refresh();
        };
      };

      it('reads the scroll against the layout its windows were measured in', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const rebuild = rebuildAnother();
        const scrollTo = followScrollTo(1150);

        base = 900;
        rebuild();
        vars[0].onKill?.(self);
        dwell = 30;
        await flushMicrotasks();

        expect(scrollTo.mock.calls).toEqual([[{ top: 960, behavior: 'instant' }]]);
      });

      // As before any rebuild elsewhere: what moved it (a stuck ancestor, say) didn't move its
      // windows' measurements for it.
      it('reads the scroll as it is when no other structure came down since', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { vars, self } = setupScenes(Cls);
        const scrollTo = followScrollTo(1150);

        base = 900;
        vars[0].onKill?.(self);
        dwell = 30;
        await flushMicrotasks();

        expect(scrollTo.mock.calls).toEqual([[{ top: 1030, behavior: 'instant' }]]);
      });

      // A rebuild whose refresh throws before pass 1 (on a detached pin's trigger) leaves its
      // structure unmeasured: the top the old one had says nothing about it.
      it('reads the scroll as it is for a structure not measured yet', async () => {
        const { Cls } = makeClass({ rec: 0 });
        const { controller, vars, self } = setupScenes(Cls);
        const rebuild = rebuildAnother();
        const s4 = document.createElement('section');
        const pin = document.createElement('div');

        query('.root').append(s4);
        document.body.append(pin);

        controller.createStickyTrigger({ trigger: s4, end: '+=100' });

        const pinVars = controller.createStickyPin({ trigger: pin });

        pin.remove();
        expect(() => controller.refresh()).toThrow();
        pinVars.onKill?.(self);

        const scrollTo = followScrollTo(1150);

        base = 900;
        rebuild();
        vars[0].onKill?.(self);
        dwell = 30;
        await flushMicrotasks();

        expect(scrollTo.mock.calls).toEqual([[{ top: 1130, behavior: 'instant' }]]);
      });
    });

    // .s4 goes after .s3 in the DOM, so its freeze runs 200-300, before the content at 50.
    it('counts a freeze registered since on another trigger in full when it starts before the content', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { controller, vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(350);
      const s4 = document.createElement('section');

      s4.className = 's4';
      query('.root').append(s4);
      vars[2].onKill?.(self);
      controller.createStickyTrigger({ trigger: s4, end: '+=100' });
      await flushMicrotasks();

      expect(scrollTo).not.toHaveBeenCalled();
    });

    // Snapping to a freeze's end lands exactly there.
    it('keeps a scroll exactly at a freeze\'s end there', async () => {
      const { Cls } = makeClass({ rec: 0 });
      const { vars, self } = setupScenes(Cls);
      const scrollTo = followScrollTo(200);

      vars[0].onKill?.(self);
      await flushMicrotasks();

      expect(scrollTo.mock.calls).toEqual([[{ top: 100, behavior: 'instant' }]]);
    });
  });
});

describe('an instance that measured earlier in the same GSAP refresh', () => {
  // jsdom puts nothing anywhere, so each block's elements sit where `tops` says, which may follow
  // other blocks' padding. offsetParent stays null, so offsetTop is each one's whole documentTop.
  let tops: Record<string, () => number> = {};
  const paddingIn = (block: string) => Array.from(
    document.querySelectorAll<HTMLElement>(`.${block} div[aria-hidden="true"]`),
    (el) => parseFloat(el.style.height) || 0,
  ).reduce((sum, height) => sum + height, 0);

  beforeEach(() => {
    tops = {};
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function offsetTop(
      this: HTMLElement,
    ) {
      const block = Object.keys(tops).find((name) => this.closest(`.${name}`));

      return block ? tops[block]() : 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Each block holds one instance with one Scene layer whose end the test gives.
  const setupBlocks = (blocks: Record<string, () => string>) => {
    document.body.innerHTML = Object.keys(blocks)
      .map((name) => `<div class="${name}"><div class="root"><section></section></div></div>`)
      .join('');

    return Object.fromEntries(Object.entries(blocks).map(([name, end]) => {
      const controller = new StickyScrollTrigger(query(`.${name} .root`));
      const vars = controller.createStickyTrigger({ trigger: query(`.${name} section`), end });

      return [name, { controller, vars, start: () => (vars.start as () => number)() }];
    }));
  };

  // GSAP adds each trigger's onRefreshInit to its refreshInit listeners as the trigger is created,
  // and calls it with that trigger.
  const listen = (cls: ReturnType<typeof makeClass>, ...layers: ScrollTrigger.Vars[]) =>
    layers.map((vars) => {
      const self = Object.create(cls.Cls.prototype) as ScrollTrigger;
      const listener = () => vars.onRefreshInit?.(self);

      cls.listeners.push(listener);

      return listener;
    });

  it('measures again when a later handler moves its container', () => {
    const gsap = makeClass({ rec: 0 });
    let upperDwell = 100;
    const { upper, lower } = setupBlocks({
      upper: () => `+=${upperDwell}`,
      lower: () => '+=200',
    });

    tops.lower = () => 1000 + paddingIn('upper');
    upper.controller.refresh();
    lower.controller.refresh();
    listen(gsap, lower.vars, upper.vars);
    upperDwell = 300;
    gsap.gsapRefresh(true);

    expect(lower.start()).toBe(1300);
  });

  it('measures again when a later handler moves an endTrigger outside its container', () => {
    const gsap = makeClass({ rec: 0 });
    let lowerDwell = 100;

    document.body.innerHTML = `
      <div class="upper"><div class="root"><section class="c1"></section><section></section></div></div>
      <div class="lower"><div class="root"><section></section></div></div>
      <div class="after"></div>`;
    tops.lower = () => 1000;
    tops.after = () => 2000 + paddingIn('lower');

    const upper = new StickyScrollTrigger(query('.upper .root'));
    const cover = upper.createOverlapScroll({
      trigger: query('.c1'),
      endTrigger: query('.after'),
      end: 'top top',
    });
    const lower = new StickyScrollTrigger(query('.lower .root'));
    const scene = lower.createStickyTrigger({
      trigger: query('.lower section'),
      end: () => `+=${lowerDwell}`,
    });

    upper.refresh();
    lower.refresh();
    listen(gsap, cover, scene);
    lowerDwell = 300;
    gsap.gsapRefresh(true);

    expect((cover.end as () => number)()).toBe(2300);
  });

  // Two GSAP refreshes in one task (a resize handler's, say) share the record of what each instance
  // read, so one whose trigger GSAP stopped refreshing in between (disabled) measures again too.
  it('measures again for a GSAP refresh earlier in the same task', () => {
    const gsap = makeClass({ rec: 0 });
    let upperDwell = 100;
    const { upper, lower } = setupBlocks({
      upper: () => `+=${upperDwell}`,
      lower: () => '+=200',
    });

    tops.lower = () => 1000 + paddingIn('upper');
    upper.controller.refresh();
    lower.controller.refresh();

    const [lowerListener] = listen(gsap, lower.vars, upper.vars);

    gsap.gsapRefresh(true);
    gsap.Cls.removeEventListener('refreshInit', lowerListener);
    upperDwell = 300;
    gsap.gsapRefresh(true);

    expect(lower.start()).toBe(1300);
  });

  // A refresh in a later task has no record of what an instance read before, so one whose
  // trigger GSAP no longer refreshes (disabled) keeps what it measured.
  it('measures nothing again for a GSAP refresh in an earlier task', async () => {
    const gsap = makeClass({ rec: 0 });
    let upperDwell = 100;
    const { upper, lower } = setupBlocks({
      upper: () => `+=${upperDwell}`,
      lower: () => '+=200',
    });

    tops.lower = () => 1000 + paddingIn('upper');
    upper.controller.refresh();
    lower.controller.refresh();

    const [lowerListener] = listen(gsap, lower.vars, upper.vars);

    gsap.gsapRefresh(true);
    await flushMicrotasks();
    gsap.Cls.removeEventListener('refreshInit', lowerListener);
    upperDwell = 300;
    gsap.gsapRefresh(true);

    expect(lower.start()).toBe(1100);
  });

  it('measures again when a later handler moves the page\'s end its \'max\' reads', () => {
    const gsap = makeClass({ rec: 0 });
    let lowerDwell = 100;

    document.body.innerHTML = `
      <div class="upper"><div class="root"><section class="c1"></section><section></section></div></div>
      <div class="lower"><div class="root"><section></section></div></div>`;
    vi.spyOn(document.documentElement, 'scrollHeight', 'get')
      .mockImplementation(() => 3000 + paddingIn('lower'));

    const upper = new StickyScrollTrigger(query('.upper .root'));
    const cover = upper.createOverlapScroll({ trigger: query('.c1'), end: 'max' });
    const lower = new StickyScrollTrigger(query('.lower .root'));
    const scene = lower.createStickyTrigger({
      trigger: query('.lower section'),
      end: () => `+=${lowerDwell}`,
    });

    upper.refresh();
    lower.refresh();
    listen(gsap, cover, scene);
    lowerDwell = 300;
    gsap.gsapRefresh(true);

    expect((cover.end as () => number)()).toBe(3300 - window.innerHeight);
  });

  // A pin's range stops at the page's end.
  it('measures again when a later handler moves the page\'s end a pin reads', () => {
    const gsap = makeClass({ rec: 0 });
    let lowerDwell = 100;

    document.body.innerHTML = `
      <div class="upper"><div class="root"><section class="pin"></section></div></div>
      <div class="lower"><div class="root"><section></section></div></div>`;
    vi.spyOn(document.documentElement, 'scrollHeight', 'get')
      .mockImplementation(() => 3000 + paddingIn('lower'));

    const upper = new StickyScrollTrigger(query('.upper .root'));
    const pin = upper.createStickyPin({ trigger: query('.pin'), end: '+=5000' });
    const lower = new StickyScrollTrigger(query('.lower .root'));
    const scene = lower.createStickyTrigger({
      trigger: query('.lower section'),
      end: () => `+=${lowerDwell}`,
    });

    upper.refresh();
    lower.refresh();
    listen(gsap, pin, scene);
    lowerDwell = 300;
    gsap.gsapRefresh(true);

    expect(query('.pin').parentElement!.style.height).toBe('3300px');
  });

  // Creating instances top to bottom is the usual order, and a lower one's dwell moves the page's
  // end on most resizes.
  it('measures nothing again when a later handler moves the page\'s end and nothing read it', () => {
    const gsap = makeClass({ rec: 0 });
    let lowerDwell = 100;
    const upperEnd = vi.fn(() => '+=200');
    const { upper, lower } = setupBlocks({ upper: upperEnd, lower: () => `+=${lowerDwell}` });

    vi.spyOn(document.documentElement, 'scrollHeight', 'get')
      .mockImplementation(() => 3000 + paddingIn('upper') + paddingIn('lower'));
    tops.lower = () => 1000 + paddingIn('upper');
    upper.controller.refresh();
    lower.controller.refresh();
    listen(gsap, upper.vars, lower.vars);

    const perRefresh = endCallsPerRefresh(upper.controller, upperEnd);

    lowerDwell = 300;
    gsap.gsapRefresh(true);

    expect(upperEnd).toHaveBeenCalledTimes(perRefresh);
    expect(lower.start()).toBe(1200);
  });

  // middle's measurement moves top's container again, and top keeps what it read before that until
  // the next refresh: each handler measures an earlier instance once, so reads that keep moving
  // can't multiply the cost.
  it('measures each earlier instance once per handler', () => {
    const gsap = makeClass({ rec: 0 });
    let bottomDwell = 100;
    // middle's dwell follows bottom's, from bottom's last measurement.
    let middleDwell = 0;
    const topEnd = vi.fn(() => '+=200');
    const { top, middle, bottom } = setupBlocks({
      top: topEnd,
      middle: () => `+=${middleDwell}`,
      bottom: () => {
        middleDwell = bottomDwell;

        return `+=${bottomDwell}`;
      },
    });

    tops.top = () => 1000 + paddingIn('bottom') + paddingIn('middle');
    tops.middle = () => 3000 + paddingIn('bottom');
    bottom.controller.refresh();
    middle.controller.refresh();
    top.controller.refresh();
    listen(gsap, top.vars, middle.vars, bottom.vars);

    const perRefresh = endCallsPerRefresh(top.controller, topEnd);

    bottomDwell = 300;
    gsap.gsapRefresh(true);

    // Its own handler, then once for bottom's, before middle's padding grew.
    expect(topEnd).toHaveBeenCalledTimes(2 * perRefresh);
    expect(top.start()).toBe(1400);
    expect(middle.start()).toBe(3300);
  });

  it('measures nothing again when no later handler moves what it read', () => {
    const gsap = makeClass({ rec: 0 });
    let upperDwell = 100;
    const upperEnd = vi.fn(() => `+=${upperDwell}`);
    const { upper, lower } = setupBlocks({ upper: upperEnd, lower: () => '+=200' });

    tops.lower = () => 1000 + paddingIn('upper');
    upper.controller.refresh();
    lower.controller.refresh();
    listen(gsap, upper.vars, lower.vars);

    const perRefresh = endCallsPerRefresh(upper.controller, upperEnd);

    upperDwell = 300;
    gsap.gsapRefresh(true);

    expect(upperEnd).toHaveBeenCalledTimes(perRefresh);
    expect(lower.start()).toBe(1300);
  });

  it('leaves an instance\'s later handlers alone after measuring it again', () => {
    const gsap = makeClass({ rec: 0 });
    let upperDwell = 100;
    const lowerEnd = vi.fn(() => '+=200');

    document.body.innerHTML = `
      <div class="upper"><div class="root"><section class="u1"></section></div></div>
      <div class="lower"><div class="root"><section class="l1"></section><section class="l2"></section></div></div>`;
    tops.lower = () => 1000 + paddingIn('upper');

    const upper = new StickyScrollTrigger(query('.upper .root'));
    const lower = new StickyScrollTrigger(query('.lower .root'));
    const first = lower.createStickyTrigger({ trigger: query('.l1'), end: lowerEnd });
    const middle = upper.createStickyTrigger({ trigger: query('.u1'), end: () => `+=${upperDwell}` });
    const last = lower.createStickyTrigger({ trigger: query('.l2'), end: lowerEnd });

    upper.refresh();
    lower.refresh();
    listen(gsap, first, middle, last);

    const perRefresh = endCallsPerRefresh(lower, lowerEnd);

    upperDwell = 300;
    gsap.gsapRefresh(true);

    // Its own handler's refresh() and again for upper's; last's has nothing new.
    expect(lowerEnd).toHaveBeenCalledTimes(2 * perRefresh);
    expect((last.start as () => number)()).toBe(1300 + 200);
  });

  // GSAP calls every layer's handler, and a page with many layers pays for each read here.
  it('reads no layout in a handler that doesn\'t refresh', () => {
    const gsap = makeClass({ rec: 0 });

    document.body.innerHTML = `
      <div class="upper"><div class="root"><section class="u1"></section></div></div>
      <div class="lower"><div class="root"><section class="l1"></section><section class="l2"></section></div></div>`;
    tops.lower = () => 1000 + paddingIn('upper');

    const upper = new StickyScrollTrigger(query('.upper .root'));
    const lower = new StickyScrollTrigger(query('.lower .root'));
    const layers = [
      upper.createStickyTrigger({ trigger: query('.u1'), end: '+=100' }),
      ...['.l1', '.l2'].map((sel) =>
        lower.createStickyTrigger({ trigger: query(sel), end: '+=200' })),
    ];
    const reads = [
      vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')!.get!),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get'),
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get'),
      vi.spyOn(Element.prototype, 'scrollHeight', 'get'),
      vi.spyOn(Element.prototype, 'scrollTop', 'get'),
      vi.spyOn(Element.prototype, 'clientHeight', 'get'),
      vi.spyOn(Element.prototype, 'getBoundingClientRect'),
      vi.spyOn(Element.prototype, 'getClientRects'),
      vi.spyOn(window, 'getComputedStyle'),
      vi.spyOn(window, 'innerHeight', 'get'),
      vi.spyOn(window, 'scrollY', 'get'),
    ];
    const readCount = () => reads.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    let readsInLast = -1;

    upper.refresh();
    lower.refresh();

    const [, , last] = listen(gsap, ...layers);

    gsap.listeners[gsap.listeners.indexOf(last)] = () => {
      const before = readCount();

      last();
      readsInLast = readCount() - before;
    };

    gsap.gsapRefresh(true);

    expect(readsInLast).toBe(0);
  });

  it('measures the other instances again when one of them throws, and rethrows off the stack', async () => {
    const gsap = makeClass({ rec: 0 });
    let upperDwell = 100;
    let failing = false;
    const { upper, first, second } = setupBlocks({
      upper: () => `+=${upperDwell}`,
      first: () => {
        if (failing) throw new Error('first end');

        return '+=200';
      },
      second: () => '+=200',
    });

    tops.first = () => 1000 + paddingIn('upper');
    tops.second = () => 2000 + paddingIn('upper');
    upper.controller.refresh();
    first.controller.refresh();
    second.controller.refresh();

    const [, , upperListener] = listen(gsap, first.vars, second.vars, upper.vars);

    // first's own handler measures; it fails only when measured again for upper's.
    gsap.listeners[gsap.listeners.indexOf(upperListener)] = () => {
      failing = true;
      upperListener();
    };

    upperDwell = 300;

    const uncaught = await runDispatch(() => gsap.gsapRefresh(true));

    expect(uncaught).toEqual([new Error('first end')]);
    expect(second.start()).toBe(2300);
    // first keeps its last measurement, which the throw left unwritten.
    expect(first.start()).toBe(1100);
    expect(paddingIn('first')).toBe(200);
  });
});
