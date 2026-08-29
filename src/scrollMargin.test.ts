// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStylesheet, createScrollMarginSync } from './scrollMargin';
import type { SceneDwell } from './scrollMargin';

// sync() takes its freeze windows as plain arguments, so jsdom's absent layout costs nothing here:
// every dwell below is a real number rather than the '+=' notation index.test.ts has to spell out
// to work around documentTop always reading 0. That's what makes the lag arithmetic, the
// document-order comparison and the zero-length filter checkable at all.
//
// jsdom implements no document.adoptedStyleSheets, so usesCssRamp is false and every sync() here
// takes the JS ramp path. The CSS path's own text is checked by calling buildStylesheet directly;
// whether the browser then animates it, and whether either path's numbers make a real
// scroll-into-view land correctly, is e2e/StickyScrollTrigger.spec.ts's job.

const query = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const dwell = (trigger: HTMLElement, freezeStart: number, freezeEnd: number): SceneDwell =>
  ({ trigger, freezeStart, freezeEnd });
let live: ReturnType<typeof createScrollMarginSync>[] = [];

// restore() is what takes the scroll listener back off, so every sync built here is torn down
// rather than left listening for the rest of the file.
const createSync = (root: HTMLElement = query('.root')) => {
  const sync = createScrollMarginSync(root);

  live.push(sync);

  return sync;
};

// Each sync picks its custom-property names off a module-level counter, so the instance's own id is
// read back from the attribute it marks the host with rather than matched loosely.
const instanceIdOf = (host: HTMLElement) =>
  host.getAttributeNames().find((name) => name.startsWith('data-sst'))!.slice('data-'.length);

// The exact value sync() writes: the author's own value, the offset knob, one var() per surviving
// ramp, then the dwell that precedes this target.
const correction = (
  host: HTMLElement,
  lagPx: number,
  { authorPx = 0, ramps = 1 }: { authorPx?: number; ramps?: number } = {},
) => {
  const id = instanceIdOf(host);
  const consumed = Array.from({ length: ramps }, (_, i) => `var(--${id}-c${i}, 0px)`).join(' + ');

  return `calc(${authorPx}px + var(--sst-scroll-margin-top-offset, 0px) + ${consumed} - ${lagPx}px)`;
};

// jsdom never scrolls anything, so the position is redefined outright and the event the ramps
// listen for is dispatched by hand.
const setScrollY = (y: number) => {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  window.dispatchEvent(new Event('scroll'));
};

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = `
    <div class="root">
      <div id="before"></div>
      <section class="a"></section>
      <div id="middle"></div>
      <section class="b"></section>
      <div id="after"></div>
    </div>
    <div id="outside"></div>
  `;
  setScrollY(0);
});

afterEach(() => {
  live.forEach((sync) => sync.restore());
  live = [];
  // The window spies one test installs would otherwise survive a failing assertion and stay on for
  // the rest of the file.
  vi.restoreAllMocks();
});

describe('sync', () => {
  it('writes a correction that subtracts the dwell preceding each target', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 800)], root, 'div[id]');

    // #before sits above the only layer, so nothing delays it; #middle and #after are both behind
    // its full 800. Every target still carries the scroll-dependent term, which is what makes a
    // jump started mid-page land where one started from the top does.
    expect(query('#before').style.scrollMarginTop).toBe(correction(root, 0));
    expect(query('#middle').style.scrollMarginTop).toBe(correction(root, 800));
    expect(query('#after').style.scrollMarginTop).toBe(correction(root, 800));
  });

  // The lag is a sum, not the nearest layer's dwell: #after is held back by both layers, so a
  // correction that only counted the closest one would land it 300px short.
  it('sums the dwell of every preceding layer', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 300), dwell(query('.b'), 300, 800)], root, 'div[id]');

    expect(query('#before').style.scrollMarginTop).toBe(correction(root, 0, { ramps: 2 }));
    expect(query('#middle').style.scrollMarginTop).toBe(correction(root, 300, { ramps: 2 }));
    expect(query('#after').style.scrollMarginTop).toBe(correction(root, 800, { ramps: 2 }));
  });

  // Both halves of `compareDocumentOrder(...) >= 0`: a layer below the target hasn't delayed it
  // yet, and a target that is itself a layer's trigger is reached before its own dwell starts.
  it('ignores a layer at or after the target', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 300), dwell(query('.b'), 300, 800)], root, '#before, .a, .b');

    expect(query('#before').style.scrollMarginTop).toBe(correction(root, 0, { ramps: 2 }));
    expect(query('.a').style.scrollMarginTop).toBe(correction(root, 0, { ramps: 2 }));
    expect(query('.b').style.scrollMarginTop).toBe(correction(root, 300, { ramps: 2 }));
  });

  // A zero-length window is dropped before the ramps are numbered, so the survivor becomes c0 and
  // contributes no lag. Reading the filtered list's index as the original layer's would leave every
  // target pointing at a custom property nothing ever ramps.
  it('drops a layer with a zero-length freeze window and renumbers the survivors', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(query('.a'), 500, 500), dwell(query('.b'), 500, 1000)], root, 'div[id]');

    expect(query('#middle').style.scrollMarginTop).toBe(correction(root, 0));
    expect(query('#after').style.scrollMarginTop).toBe(correction(root, 500));
  });

  it('writes nothing when no layer has any dwell', () => {
    const sync = createSync();

    sync.sync([dwell(query('.a'), 500, 500)], query('.root'), 'div[id]');

    expect(query('#after').style.scrollMarginTop).toBe('');
  });

  it('writes nothing when the target selector is null', () => {
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 800)], query('.root'), null);

    expect(query('#after').style.scrollMarginTop).toBe('');
  });

  // The host is the element the ramps are declared on, so without one there's nothing for the
  // var() terms to inherit from and no correction worth writing.
  it('writes nothing when there is no host', () => {
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 800)], null, 'div[id]');

    expect(query('#after').style.scrollMarginTop).toBe('');
  });

  it('leaves elements outside the root alone', () => {
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 800)], query('.root'), 'div[id]');

    expect(query('#outside').style.scrollMarginTop).toBe('');
  });

  it('honors the target selector it is given', () => {
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 800)], query('.root'), '#after');

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).not.toBe('');
  });

  it('folds an author\'s own scroll-margin-top into the correction instead of replacing it', () => {
    const root = query('.root');
    const sync = createSync();

    query('#after').style.scrollMarginTop = '40px';
    sync.sync([dwell(query('.a'), 0, 800)], root, 'div[id]');

    expect(query('#after').style.scrollMarginTop).toBe(correction(root, 800, { authorPx: 40 }));
  });

  it('keeps the same value across repeated syncs when nothing changed', () => {
    const root = query('.root');
    const sync = createSync();
    const scenes = [dwell(query('.a'), 0, 800)];

    query('#after').style.scrollMarginTop = '40px';
    sync.sync(scenes, root, 'div[id]');
    sync.sync(scenes, root, 'div[id]');
    sync.sync(scenes, root, 'div[id]');

    expect(query('#after').style.scrollMarginTop).toBe(correction(root, 800, { authorPx: 40 }));
  });

  // Regression test for sync()'s own two-pass reset (see its comment in scrollMargin.ts). Driven
  // through a stylesheet rule rather than an inline one, since a change the reset itself undoes
  // wouldn't exercise it.
  it('picks up a later change to the author\'s own scroll-margin-top', () => {
    const root = query('.root');
    const sync = createSync();
    const style = document.createElement('style');

    style.textContent = '#after { scroll-margin-top: 40px }';
    document.head.appendChild(style);
    sync.sync([dwell(query('.a'), 0, 800)], root, 'div[id]');

    expect(query('#after').style.scrollMarginTop).toBe(correction(root, 800, { authorPx: 40 }));

    style.textContent = '#after { scroll-margin-top: 120px }';
    sync.sync([dwell(query('.a'), 0, 800)], root, 'div[id]');

    expect(query('#after').style.scrollMarginTop).toBe(correction(root, 800, { authorPx: 120 }));
  });

  // A target that stops matching (its id removed, say) has to be handed back rather than left
  // carrying a correction nothing updates any more.
  it('restores a target that no longer matches the selector', () => {
    const sync = createSync();
    const after = query('#after');

    sync.sync([dwell(query('.a'), 0, 800)], query('.root'), 'div[id]');
    after.removeAttribute('id');
    sync.sync([dwell(query('.a'), 0, 800)], query('.root'), 'div[id]');

    expect(after.style.scrollMarginTop).toBe('');
  });

  // The same handing back, through the early return instead: a refresh that leaves no dwell at all
  // still owes every target its own value.
  it('hands every target back when a later sync has no dwell left', () => {
    const sync = createSync();

    query('#after').style.scrollMarginTop = '40px';
    sync.sync([dwell(query('.a'), 0, 800)], query('.root'), 'div[id]');
    sync.sync([dwell(query('.a'), 0, 0)], query('.root'), 'div[id]');

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).toBe('40px');
  });

  it('marks the host with its own instance attribute, and moves it when the host changes', () => {
    const root = query('.root');
    const inner = query('#before');
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 800)], root, 'div[id]');

    const id = instanceIdOf(root);

    sync.sync([dwell(query('.a'), 0, 800)], inner, 'div[id]');

    expect(root.hasAttribute(`data-${id}`)).toBe(false);
    expect(inner.hasAttribute(`data-${id}`)).toBe(true);
  });
});

describe('restore', () => {
  it('hands every target back to its pre-module inline value', () => {
    const sync = createSync();

    query('#after').style.scrollMarginTop = '40px';
    sync.sync([dwell(query('.a'), 0, 800)], query('.root'), 'div[id]');
    sync.restore();

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).toBe('40px');
  });

  // Asserted on the call rather than on behavior, because a leaked listener is invisible from the
  // outside: restore() also drops the host it writes to, so a listener left attached would go on
  // firing without changing anything observable. Nothing else hands this one back, and a controller
  // is destroyed far more often than a page is unloaded.
  it('takes its scroll listener back off', () => {
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const sync = createSync();
    // The handler is a closure over the instance, so identity is the whole assertion: handing
    // removeEventListener any other function leaves the original attached.
    const attached = addListener.mock.calls.find(([type]) => type === 'scroll')![1];

    sync.sync([dwell(query('.a'), 0, 800)], query('.root'), 'div[id]');
    sync.restore();

    expect(removeListener).toHaveBeenCalledWith('scroll', attached);
  });

  it('takes the instance attribute off the host', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 800)], root, 'div[id]');

    const id = instanceIdOf(root);

    sync.restore();

    expect(root.hasAttribute(`data-${id}`)).toBe(false);
  });
});

// The branch jsdom actually takes, standing in for the CSS ramp where scroll-driven animations or
// constructed stylesheets are missing. It writes the same h_i values the keyframes below would.
describe('the JS ramp fallback', () => {
  const consumed = (host: HTMLElement, index: number) =>
    host.style.getPropertyValue(`--${instanceIdOf(host)}-c${index}`);

  it('writes each layer\'s consumed dwell on sync, without waiting for a scroll', () => {
    const root = query('.root');
    const sync = createSync();

    setScrollY(600);
    sync.sync([dwell(query('.a'), 0, 300), dwell(query('.b'), 500, 1000)], root, 'div[id]');

    // The first layer's window is behind us, so all 300 of its dwell is consumed; the second is
    // 100 into its own.
    expect(consumed(root, 0)).toBe('300px');
    expect(consumed(root, 1)).toBe('100px');
  });

  it('clamps at 0 before the window and at the full dwell after it', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(query('.a'), 500, 1000)], root, 'div[id]');

    expect(consumed(root, 0)).toBe('0px');

    setScrollY(750);
    expect(consumed(root, 0)).toBe('250px');

    setScrollY(5000);
    expect(consumed(root, 0)).toBe('500px');
  });

  // Left at whatever it last read rather than reset, since restore() takes the host itself out of
  // the picture: the property is only ever read through a target that no longer references it.
  it('stops following the scroll once restored', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(query('.a'), 0, 500)], root, 'div[id]');
    setScrollY(200);

    const id = instanceIdOf(root);

    sync.restore();
    setScrollY(400);

    expect(root.style.getPropertyValue(`--${id}-c0`)).toBe('200px');
  });
});

describe('buildStylesheet', () => {
  // The trigger goes unread here; only each layer's own window shapes the text.
  const build = () => buildStylesheet('sstX', [
    dwell(document.createElement('div'), 0, 300),
    dwell(document.createElement('div'), 500, 1000),
  ]);

  it('registers one inheriting <length> property per layer, starting at 0', () => {
    const sheet = build();

    expect(sheet).toContain('@property --sstX-c0{syntax:"<length>";inherits:true;initial-value:0px}');
    expect(sheet).toContain('@property --sstX-c1{syntax:"<length>";inherits:true;initial-value:0px}');
  });

  // The ramp runs to the layer's dwell, not to its freezeEnd: the property carries how much of the
  // window has been consumed, which is what the correction's var() terms are summed as.
  it('ramps each property from 0 to that layer\'s own dwell', () => {
    const sheet = build();

    expect(sheet).toContain('@keyframes sstX-k0{from{--sstX-c0:0px}to{--sstX-c0:300px}}');
    expect(sheet).toContain('@keyframes sstX-k1{from{--sstX-c1:0px}to{--sstX-c1:500px}}');
  });

  // animation-range is in absolute px along the document scroller's timeline, so the freeze window
  // goes in as it stands. Each list is positional, so a layer's animation, timeline and range have
  // to stay at the same index.
  it('drives every layer off the root scroller across its own freeze window', () => {
    const sheet = build();

    expect(sheet.slice(sheet.indexOf('[data-sstX]'))).toBe(
      '[data-sstX]{'
      + 'animation:sstX-k0 linear both,sstX-k1 linear both;'
      + 'animation-timeline:scroll(root block),scroll(root block);'
      + 'animation-range:0px 300px,500px 1000px}}',
    );
  });

  // The gate is load-bearing rather than a precaution: ungated, a browser that drops
  // `animation-timeline` runs the shorthand as an ordinary 0s animation and jumps every property to
  // its `to` value on load. The registrations stay outside it so each var() still has its 0px
  // initial value to fall back to, which is the constant '-lag' form.
  it('gates the animation rule, and only that, behind @supports', () => {
    const sheet = build();

    expect(sheet).toContain('@supports (animation-timeline: scroll()) {[data-sstX]{animation:');
    expect(sheet.startsWith('@property --sstX-c0')).toBe(true);
    expect(sheet.indexOf('@keyframes sstX-k1')).toBeLessThan(sheet.indexOf('@supports'));
  });
});
