// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStylesheet, createScrollMarginSync, planCarryRamps } from './scrollMargin';
import type { CoverCarry, PlannedCarry, SceneDwell } from './scrollMargin';

// sync() takes its freeze windows and the targets' natural tops as plain arguments, so jsdom's
// absent layout costs nothing here, and the text sync() writes is checkable exactly. jsdom can't
// evaluate that text, though: whether each layer's clamp() step counts its dwell is only visible
// in a real browser.
//
// jsdom implements no document.adoptedStyleSheets, so usesCssRamp is false and every sync() here
// takes the JS ramp path. The CSS path's own text is checked by calling buildStylesheet directly;
// whether the browser then animates it, and whether either path's numbers make a real
// scroll-into-view land correctly, is e2e/StickyScrollTrigger.spec.ts's job.

const query = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const dwell = (freezeStart: number, freezeEnd: number): SceneDwell => ({ freezeStart, freezeEnd });
const carry = (wrapper: HTMLElement, start: number, room: number): CoverCarry => (
  { wrapper, start, room });
// Stands in for index.ts's measurement, which jsdom can't do: each fixture element carries its
// natural top as data-top.
const naturalTops = (targets: readonly HTMLElement[]) =>
  targets.map((target) => Number(target.dataset.top));
let live: ReturnType<typeof createScrollMarginSync>[] = [];

// restore() is what takes the scroll listener back off, so every sync built here is torn down
// rather than left listening for the rest of the file.
const createSync = (targetSelector: string | null = 'div[id]', root = query('.root')) => {
  const sync = createScrollMarginSync(root, targetSelector);

  live.push(sync);

  return sync;
};

// Each sync picks its custom-property names off a module-level counter, so the instance's own id is
// read back from the attribute it marks the host with (a cover wrapper's names it as data-<id>-w)
// rather than matched loosely.
const instanceIdOf = (marked: HTMLElement) => marked.getAttributeNames()
  .find((name) => name.startsWith('data-sst'))!.slice('data-'.length).replace(/-w$/, '');

// The exact scroll-margin-top sync() writes: the author's own value, the offset knob, one var()
// per surviving ramp and one per cover wrapper around the target (by its number in `carried`),
// then one step per layer in freeze order. Each step's constant is the target's natural top less
// the author's value, plus every earlier layer's dwell, less the layer's own freezeStart and the
// 0.05px tie tolerance.
const correction = (
  marked: HTMLElement,
  { top = 0, windows = [], authorPx = 0, carried = [] }:
  { top?: number; windows?: [number, number][]; authorPx?: number; carried?: number[] },
) => {
  const id = instanceIdOf(marked);
  const added = [
    ...windows.map((_, i) => `var(--${id}-c${i}, 0px)`),
    ...carried.map((k) => `var(--${id}-w${k}, 0px)`),
  ].map((v) => ` + ${v}`).join('');
  let earlierDwell = 0;
  const lag = windows.map(([freezeStart, freezeEnd]) => {
    const margin = top - authorPx + earlierDwell - freezeStart - 0.05;

    earlierDwell += freezeEnd - freezeStart;

    return `clamp(0px, (${margin}px - var(--sst-scroll-margin-top-offset, 0px)) * 1000000,`
      + ` ${freezeEnd - freezeStart}px)`;
  }).join(' + ');

  return `calc(${authorPx}px + var(--sst-scroll-margin-top-offset, 0px)${added}${lag ? ` - (${lag})` : ''})`;
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
      <div id="before" data-top="0"></div>
      <section class="a" data-top="100"></section>
      <div id="middle" data-top="200"></div>
      <section class="b" data-top="300"></section>
      <div id="after" data-top="400"></div>
    </div>
    <div id="outside" data-top="500"></div>
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

// refresh() measures these before sync() runs, so they have to be the ones sync() writes.
describe('targets', () => {
  it('lists the elements sync() writes, in document order', () => {
    expect(createSync().targets()).toEqual([query('#before'), query('#middle'), query('#after')]);
  });
});

describe('sync', () => {
  // Every target carries the scroll-dependent term, which is what makes a jump started mid-page
  // land where one started from the top does, and a step per layer that decides in CSS whether
  // that layer's dwell delays it, from the target's own natural top.
  it('writes each target a correction from its own natural top', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(100, 900)], root, naturalTops);

    ['#before', '#middle', '#after'].forEach((selector) => {
      const target = query(selector);

      expect(target.style.scrollMarginTop).toBe(
        correction(root, { top: Number(target.dataset.top), windows: [[100, 900]] }),
      );
    });
  });

  // Each step assumes every earlier layer counted, so the steps run in freeze order however the
  // layers are handed over.
  it('orders the steps by freeze start', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(300, 800), dwell(0, 300)], root, naturalTops);

    expect(query('#after').style.scrollMarginTop).toBe(
      correction(root, { top: 400, windows: [[0, 300], [300, 800]] }),
    );
  });

  // A zero-length window is dropped before the ramps are numbered, so the survivor becomes c0.
  // Reading the filtered list's index as the original layer's would leave every target pointing at
  // a custom property nothing ever ramps.
  it('drops a layer with a zero-length freeze window and renumbers the survivors', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(500, 500), dwell(500, 1000)], root, naturalTops);

    expect(query('#after').style.scrollMarginTop).toBe(
      correction(root, { top: 400, windows: [[500, 1000]] }),
    );
  });

  it('writes nothing when no layer has any dwell', () => {
    const sync = createSync();

    sync.sync([dwell(500, 500)], query('.root'), naturalTops);

    expect(query('#after').style.scrollMarginTop).toBe('');
  });

  // A null selector matches nothing, so only the ramps can show it opted out.
  it('starts no ramps when the target selector is null', () => {
    const sync = createSync(null);

    sync.sync([dwell(0, 800)], query('.root'), naturalTops);

    expect(query('.root').getAttributeNames()).not.toContainEqual(expect.stringMatching(/^data-sst/));
  });

  // The host is the element the ramps are declared on, so without one there's nothing for the
  // var() terms to inherit from and no correction worth writing.
  it('writes nothing when there is no host', () => {
    const sync = createSync();

    sync.sync([dwell(0, 800)], null, naturalTops);

    expect(query('#after').style.scrollMarginTop).toBe('');
  });

  it('leaves elements outside the root alone', () => {
    const sync = createSync();

    sync.sync([dwell(0, 800)], query('.root'), naturalTops);

    expect(query('#outside').style.scrollMarginTop).toBe('');
  });

  it('honors the target selector it is given', () => {
    const sync = createSync('#after');

    sync.sync([dwell(0, 800)], query('.root'), naturalTops);

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).not.toBe('');
  });

  it('folds an author\'s own scroll-margin-top into the correction instead of replacing it', () => {
    const root = query('.root');
    const sync = createSync();

    query('#after').style.scrollMarginTop = '40px';
    sync.sync([dwell(0, 800)], root, naturalTops);

    expect(query('#after').style.scrollMarginTop).toBe(
      correction(root, { top: 400, windows: [[0, 800]], authorPx: 40 }),
    );
  });

  // Regression test for sync()'s own two-pass reset (see its comment in scrollMargin.ts). Driven
  // through a stylesheet rule rather than an inline one, since a change the reset itself undoes
  // wouldn't exercise it. Syncing twice also covers the repeat case: without the reset, the second
  // pass would read this module's own calc() back and fold it in again.
  it('picks up a later change to the author\'s own scroll-margin-top', () => {
    const root = query('.root');
    const sync = createSync();
    const style = document.createElement('style');

    style.textContent = '#after { scroll-margin-top: 40px }';
    document.head.appendChild(style);
    sync.sync([dwell(0, 800)], root, naturalTops);

    expect(query('#after').style.scrollMarginTop).toBe(
      correction(root, { top: 400, windows: [[0, 800]], authorPx: 40 }),
    );

    style.textContent = '#after { scroll-margin-top: 120px }';
    sync.sync([dwell(0, 800)], root, naturalTops);

    expect(query('#after').style.scrollMarginTop).toBe(
      correction(root, { top: 400, windows: [[0, 800]], authorPx: 120 }),
    );
  });

  // A stylesheet's !important beats a plain inline value, so only an !important correction applies
  // to such a target. The next sync and restore() still have to recognize that write as their own.
  it('writes the correction !important over a stylesheet !important, and still re-reads it', () => {
    const root = query('.root');
    const sync = createSync();
    const style = document.createElement('style');
    const after = query('#after');

    style.textContent = '#after { scroll-margin-top: 40px !important }';
    document.head.appendChild(style);
    sync.sync([dwell(0, 800)], root, naturalTops);

    expect(after.style.getPropertyValue('scroll-margin-top')).toBe(
      correction(root, { top: 400, windows: [[0, 800]], authorPx: 40 }),
    );
    expect(after.style.getPropertyPriority('scroll-margin-top')).toBe('important');

    style.textContent = '#after { scroll-margin-top: 120px !important }';
    sync.sync([dwell(0, 800)], root, naturalTops);

    expect(after.style.getPropertyValue('scroll-margin-top')).toBe(
      correction(root, { top: 400, windows: [[0, 800]], authorPx: 120 }),
    );

    sync.restore();

    expect(after.style.getPropertyValue('scroll-margin-top')).toBe('');
  });

  it('picks up an inline scroll-margin-top set since the last sync, and hands that one back', () => {
    const root = query('.root');
    const sync = createSync();

    query('#after').style.scrollMarginTop = '40px';
    sync.sync([dwell(0, 800)], root, naturalTops);
    query('#after').style.scrollMarginTop = '120px';
    sync.sync([dwell(0, 800)], root, naturalTops);

    expect(query('#after').style.scrollMarginTop).toBe(
      correction(root, { top: 400, windows: [[0, 800]], authorPx: 120 }),
    );

    sync.restore();

    expect(query('#after').style.scrollMarginTop).toBe('120px');
  });

  // Folding the other instance's calc() in would count its dwell on top of this one's.
  it('reads the author\'s value under another instance\'s correction on a target moved in', () => {
    const rootA = query('.root');
    const rootB = document.createElement('div');
    const after = query('#after');
    const syncA = createSync('div[id]', rootA);
    const syncB = createSync('div[id]', rootB);

    document.body.appendChild(rootB);
    after.style.scrollMarginTop = '40px';
    syncA.sync([dwell(0, 800)], rootA, naturalTops);
    rootB.appendChild(after);
    syncB.sync([dwell(0, 300)], rootB, naturalTops);
    syncA.sync([dwell(0, 800)], rootA, naturalTops);

    expect(after.style.scrollMarginTop).toBe(
      correction(rootB, { top: 400, windows: [[0, 300]], authorPx: 40 }),
    );

    syncA.restore();
    syncB.restore();

    expect(after.style.scrollMarginTop).toBe('40px');
  });

  // A target that stops matching (its id removed, say) has to be handed back rather than left
  // carrying a correction nothing updates any more.
  it('restores a target that no longer matches the selector', () => {
    const sync = createSync();
    const after = query('#after');

    sync.sync([dwell(0, 800)], query('.root'), naturalTops);
    after.removeAttribute('id');
    sync.sync([dwell(0, 800)], query('.root'), naturalTops);

    expect(after.style.scrollMarginTop).toBe('');
  });

  // The same handing back, through the early return instead: a refresh that leaves no dwell at all
  // still owes every target its own value.
  it('hands every target back when a later sync has no dwell left', () => {
    const sync = createSync();

    query('#after').style.scrollMarginTop = '40px';
    sync.sync([dwell(0, 800)], query('.root'), naturalTops);
    sync.sync([dwell(0, 0)], query('.root'), naturalTops);

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).toBe('40px');
  });

  it('marks the host with its own instance attribute, and moves it when the host changes', () => {
    const root = query('.root');
    const inner = query('#before');
    const sync = createSync();

    sync.sync([dwell(0, 800)], root, naturalTops);

    const id = instanceIdOf(root);

    sync.sync([dwell(0, 800)], inner, naturalTops);

    expect(root.hasAttribute(`data-${id}`)).toBe(false);
    expect(inner.hasAttribute(`data-${id}`)).toBe(true);
  });
});

describe('restore', () => {
  it('hands every target back to its pre-module inline value', () => {
    const sync = createSync();

    query('#after').style.scrollMarginTop = '40px';
    sync.sync([dwell(0, 800)], query('.root'), naturalTops);
    sync.restore();

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#after').style.scrollMarginTop).toBe('40px');
  });

  it('leaves an inline value set since the last sync where it is', () => {
    const sync = createSync();

    query('#after').style.scrollMarginTop = '40px';
    sync.sync([dwell(0, 800)], query('.root'), naturalTops);
    query('#after').style.scrollMarginTop = '120px';
    sync.restore();

    expect(query('#after').style.scrollMarginTop).toBe('120px');
  });

  it('puts an !important inline value back as one', () => {
    const sync = createSync();

    query('#after').style.setProperty('scroll-margin-top', '40px', 'important');
    sync.sync([dwell(0, 800)], query('.root'), naturalTops);
    sync.restore();

    expect(query('#after').style.getPropertyValue('scroll-margin-top')).toBe('40px');
    expect(query('#after').style.getPropertyPriority('scroll-margin-top')).toBe('important');
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

    sync.sync([dwell(0, 800)], query('.root'), naturalTops);
    sync.restore();

    expect(removeListener).toHaveBeenCalledWith('scroll', attached);
  });

  it('takes the instance attribute off the host', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(0, 800)], root, naturalTops);

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

  it('writes each layer\'s consumed dwell on applyRamps(), without waiting for a scroll', () => {
    const root = query('.root');
    const sync = createSync();

    setScrollY(600);
    sync.sync([dwell(0, 300), dwell(500, 1000)], root, naturalTops);
    sync.applyRamps();

    // The first layer's window is behind us, so all 300 of its dwell is consumed; the second is
    // 100 into its own.
    expect(consumed(root, 0)).toBe('300px');
    expect(consumed(root, 1)).toBe('100px');
  });

  it('clamps at 0 before the window and at the full dwell after it', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(500, 1000)], root, naturalTops);
    sync.applyRamps();

    expect(consumed(root, 0)).toBe('0px');

    setScrollY(750);
    expect(consumed(root, 0)).toBe('250px');

    setScrollY(5000);
    expect(consumed(root, 0)).toBe('500px');
  });

  // Reading the scroll forces a layout, which the caller puts off until it's cheap.
  it('leaves the scroll unread in sync()', () => {
    const scrollY = vi.spyOn(window, 'scrollY', 'get');
    const sync = createSync();

    sync.sync([dwell(0, 500)], query('.root'), naturalTops);

    expect(scrollY).not.toHaveBeenCalled();
  });

  // A null selector opts out of the module entirely, so the listener would spend the instance's
  // whole life firing on every scroll with nothing to write to.
  it('attaches no listener when the target selector is null', () => {
    const addListener = vi.spyOn(window, 'addEventListener');

    createSync(null);

    expect(addListener.mock.calls.map(([type]) => type)).not.toContain('scroll');
  });

  // Left at whatever it last read rather than reset, since restore() takes the host itself out of
  // the picture: the property is only ever read through a target that no longer references it.
  it('stops following the scroll once restored', () => {
    const root = query('.root');
    const sync = createSync();

    sync.sync([dwell(0, 500)], root, naturalTops);
    setScrollY(200);

    const id = instanceIdOf(root);

    sync.restore();
    setScrollY(400);

    expect(root.style.getPropertyValue(`--${id}-c0`)).toBe('200px');
  });
});

describe('buildStylesheet', () => {
  const build = () => buildStylesheet('sstX', [
    dwell(0, 300),
    dwell(500, 1000),
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

// A cover's wrapper holds the leading range stuck while the cover rises, so a target inside it is
// carried down the page by how far the content has moved since the wrapper stuck, up to its room.
describe('cover carries', () => {
  // The leading range: #before, .a and #middle in a wrapper, as wrapCover builds it; #after stays
  // outside it.
  const wrap = (...selectors: string[]) => {
    const wrapper = document.createElement('div');
    const first = query(selectors[0]);

    first.before(wrapper);
    selectors.forEach((selector) => wrapper.append(query(selector)));

    return wrapper;
  };

  // A second cover's wrapper around the first and #middle, as a row of covers builds them.
  const nest = () => {
    const inner = wrap('#before', '.a');
    const outer = document.createElement('div');

    inner.before(outer);
    outer.append(inner, query('#middle'));

    return [outer, inner];
  };

  it('adds the carry to the targets a wrapper holds, and only to them', () => {
    const root = query('.root');
    const wrapper = wrap('#before', '.a', '#middle');
    const sync = createSync();

    sync.sync([dwell(0, 800)], root, naturalTops, [carry(wrapper, 1000, 500)]);

    const withCarry = (top: number) => correction(root, { top, windows: [[0, 800]], carried: [0] });

    expect(query('#before').style.scrollMarginTop).toBe(withCarry(0));
    expect(query('#middle').style.scrollMarginTop).toBe(withCarry(200));
    expect(query('#after').style.scrollMarginTop).toBe(correction(root, { top: 400, windows: [[0, 800]] }));
  });

  // With no Scene layer dwell, nothing outside a cover's wrapper needs a correction.
  it('writes only the targets a wrapper holds when no Scene layer has dwell', () => {
    const wrapper = wrap('#before', '.a', '#middle');
    const sync = createSync();

    sync.sync([], null, naturalTops, [carry(wrapper, 1000, 500)]);

    expect(query('#before').style.scrollMarginTop).toBe(correction(wrapper, { carried: [0] }));
    expect(query('#middle').style.scrollMarginTop).toBe(correction(wrapper, { carried: [0] }));
    expect(query('#after').style.scrollMarginTop).toBe('');
  });

  // Each carry restyles everything its wrapper holds on every frame it changes, so one no target
  // reads isn't started.
  it('starts no carry for a wrapper with no target or no room', () => {
    const empty = wrap('.a');
    const full = wrap('#middle');
    const sync = createSync();

    sync.sync([], null, naturalTops, [carry(empty, 1000, 500), carry(full, 1000, 0)]);

    expect(empty.getAttributeNames()).toEqual([]);
    expect(full.getAttributeNames()).toEqual([]);
    expect(query('#middle').style.scrollMarginTop).toBe('');
  });

  // A wrapper inside another is carried in that one's frame, so the outer one comes first, whatever
  // order the covers are handed over in, and a target in both reads both.
  it('numbers the carries outermost first, and adds every one around a target', () => {
    const [outer, inner] = nest();
    const sync = createSync();

    sync.sync([], null, naturalTops, [carry(inner, 1100, 1000), carry(outer, 1000, 500)]);

    const id = instanceIdOf(outer);

    expect(outer.getAttribute(`data-${id}-w`)).toBe('0');
    expect(inner.getAttribute(`data-${id}-w`)).toBe('1');
    expect(query('#before').style.scrollMarginTop).toBe(correction(outer, { carried: [0, 1] }));
    expect(query('#middle').style.scrollMarginTop).toBe(correction(outer, { carried: [0] }));
  });

  // Stuck from the top of the page, the wrapper already carries at scroll 0, where a jump lands
  // right without the term. The wrapper's property leaves that out, so a target reads no constant
  // of it: one a killed cover's unwrap takes out of the wrapper reads 0.
  it('leaves what the wrapper carries at scroll 0 out of its targets\' value', () => {
    const wrapper = wrap('#before', '.a', '#middle');
    const sync = createSync();

    sync.sync([], null, naturalTops, [carry(wrapper, -400, 500)]);

    expect(query('#before').style.scrollMarginTop).toBe(correction(wrapper, { carried: [0] }));
  });

  // A page's MutationObserver sees a write even of the same value.
  it('leaves the wrapper\'s attribute alone when a later sync numbers it the same', () => {
    const wrapper = wrap('#before', '.a', '#middle');
    const sync = createSync();
    const observer = new MutationObserver(() => {});

    sync.sync([], null, naturalTops, [carry(wrapper, 1000, 500)]);
    observer.observe(wrapper, { attributes: true, attributeFilter: [`data-${instanceIdOf(wrapper)}-w`] });
    sync.sync([], null, naturalTops, [carry(wrapper, 1000, 500)]);

    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it('hands the targets and the wrapper back once nothing carries', () => {
    const wrapper = wrap('#before', '.a', '#middle');
    const sync = createSync();

    query('#middle').style.scrollMarginTop = '40px';
    sync.sync([], null, naturalTops, [carry(wrapper, 1000, 500)]);
    setScrollY(1200);
    sync.sync([], null, naturalTops, []);

    expect(query('#before').style.scrollMarginTop).toBe('');
    expect(query('#middle').style.scrollMarginTop).toBe('40px');
    expect(wrapper.getAttributeNames()).toEqual(['style']);
    expect(wrapper.style.length).toBe(0);
  });

  it('takes the carry off the wrapper on restore', () => {
    const wrapper = wrap('#before', '.a', '#middle');
    const sync = createSync();

    sync.sync([], null, naturalTops, [carry(wrapper, 1000, 500)]);
    setScrollY(1200);
    sync.restore();

    expect(wrapper.getAttributeNames()).toEqual(['style']);
    expect(wrapper.style.length).toBe(0);
  });

  describe('on the JS ramp', () => {
    const carried = (wrapper: HTMLElement, index: number) =>
      wrapper.style.getPropertyValue(`--${instanceIdOf(wrapper)}-w${index}`);

    it('carries from where the wrapper sticks, by the scroll less the dwell consumed, up to its room', () => {
      const root = query('.root');
      const wrapper = wrap('#before', '.a', '#middle');
      const sync = createSync();

      sync.sync([dwell(0, 300)], root, naturalTops, [carry(wrapper, 1000, 500)]);
      sync.applyRamps();
      expect(carried(wrapper, 0)).toBe('0px');

      // 300 of the 1200 went to the dwell, so the content has moved 900 and not reached 1000 yet.
      setScrollY(1200);
      expect(carried(wrapper, 0)).toBe('0px');

      setScrollY(1500);
      expect(carried(wrapper, 0)).toBe('200px');

      setScrollY(5000);
      expect(carried(wrapper, 0)).toBe('500px');
    });

    it('carries a wrapper inside another by what the outer one has not', () => {
      const [outer, inner] = nest();
      const sync = createSync();

      sync.sync([], null, naturalTops, [carry(inner, 1100, 1000), carry(outer, 1000, 500)]);
      setScrollY(1300);
      expect([carried(outer, 0), carried(inner, 1)]).toEqual(['300px', '0px']);

      setScrollY(2000);
      expect([carried(outer, 0), carried(inner, 1)]).toEqual(['500px', '400px']);
    });

    // Each property is the carry less the one at scroll 0, the outer one's added back for the
    // inner wrapper: at scroll 0 the outer wrapper carries 200 and the inner one 100.
    it('writes each carry less what it carries at scroll 0', () => {
      const [outer, inner] = nest();
      const sync = createSync();

      sync.sync([], null, naturalTops, [carry(inner, -300, 1000), carry(outer, -200, 500)]);
      sync.applyRamps();
      expect([carried(outer, 0), carried(inner, 1)]).toEqual(['0px', '0px']);

      setScrollY(1000);
      expect([carried(outer, 0), carried(inner, 1)]).toEqual(['300px', '700px']);
    });

    // A wrapper a later sync drops or numbers differently keeps nothing of its old number.
    it('takes the old number off a wrapper a later sync drops or renumbers', () => {
      const [outer, inner] = nest();
      const sync = createSync();
      const both = [carry(inner, 1100, 1000), carry(outer, 1000, 500)];

      sync.sync([], null, naturalTops, both);

      const id = instanceIdOf(outer);

      const numbers = () => {
        sync.applyRamps();

        return [outer, inner].map((wrapper) => [
          wrapper.getAttribute(`data-${id}-w`),
          Array.from(wrapper.style),
        ]);
      };

      expect(numbers()).toEqual([['0', [`--${id}-w0`]], ['1', [`--${id}-w1`]]]);

      sync.sync([], null, naturalTops, [carry(inner, 1100, 1000)]);
      expect(numbers()).toEqual([[null, []], ['0', [`--${id}-w0`]]]);

      sync.sync([], null, naturalTops, both);
      expect(numbers()).toEqual([['0', [`--${id}-w0`]], ['1', [`--${id}-w1`]]]);
    });

    // A Scene window opening at -360 has consumed 360 of its dwell at scroll 0, so the wrapper
    // that would stick at -60 doesn't carry there yet.
    it('counts the dwell consumed at scroll 0 in what a wrapper carries there', () => {
      const root = query('.root');
      const wrapper = wrap('#before', '.a', '#middle');
      const sync = createSync();

      sync.sync([dwell(-360, 440)], root, naturalTops, [carry(wrapper, -60, 500)]);
      sync.applyRamps();
      expect(carried(wrapper, 0)).toBe('0px');

      // The whole 800 consumed by 1000: 1000 - 800 + 60.
      setScrollY(1000);
      expect(carried(wrapper, 0)).toBe('260px');
    });
  });
});

describe('buildStylesheet with cover carries', () => {
  const build = (scenes: SceneDwell[] = []) => buildStylesheet('sstX', scenes, [
    { value: 'clamp(0px, var(--sstX-s0) - 1000px, 500px)', from: 1000, to: 1500 },
  ]);

  // The scroll it reads stays on the wrapper, so a frame restyles what the wrapper holds through
  // the carry alone, and only while the carry changes.
  it('reads the scroll into a property the wrapper keeps to itself, and carries an inheriting one', () => {
    const sheet = build();

    expect(sheet).toContain('@property --sstX-s0{syntax:"<length>";inherits:false;initial-value:0px}');
    expect(sheet).toContain('@property --sstX-w0{syntax:"<length>";inherits:true;initial-value:0px}');
    expect(sheet).toContain('@keyframes sstX-ks0{from{--sstX-s0:1000px}to{--sstX-s0:1500px}}');
  });

  it('ramps each wrapper across its own window alone, behind @supports', () => {
    const sheet = build();

    expect(sheet.slice(sheet.indexOf('@supports'))).toBe(
      '@supports (animation-timeline: scroll()) {[data-sstX-w="0"]{'
      + 'animation:sstX-ks0 linear both;animation-timeline:scroll(root block);'
      + 'animation-range:1000px 1500px;--sstX-w0:clamp(0px, var(--sstX-s0) - 1000px, 500px)}}',
    );
  });

  // The host only carries the Scene layers' ramps.
  it('writes the host rule only for Scene layers', () => {
    expect(build()).not.toContain('[data-sstX]{');
    expect(build([dwell(0, 300)])).toContain('[data-sstX]{animation:sstX-k0 linear both;');
  });
});

describe('planCarryRamps', () => {
  const planned = (start: number, room: number, outer: number[] = [], atTop = 0): PlannedCarry => ({
    carry: carry(document.createElement('div'), start, room),
    outer,
    atTop,
  });

  it('reads the scroll less where the wrapper sticks, clamped to its room', () => {
    expect(planCarryRamps('sstX', [], [planned(1000, 500)])).toEqual([{
      value: 'clamp(0px, var(--sstX-s0) - 1000px, 500px)',
      from: 1000,
      to: 1500,
    }]);
  });

  // The window runs until the carry is full for certain: every dwell begun by then delays it by
  // that dwell, and so does a carry around it, by up to its room. A dwell that begins later isn't
  // subtracted: past the window the scroll the ramp reads stops while that dwell goes on being
  // consumed, which would take the carry back down from full.
  it('takes off the dwell and the outer carries, and runs the window past both', () => {
    const [, inner] = planCarryRamps('sstX', [dwell(0, 300), dwell(1700, 1900), dwell(5000, 6000)], [
      planned(1000, 500),
      planned(1100, 400, [0]),
    ]);

    expect(inner).toEqual({
      value: 'clamp(0px, var(--sstX-s1) - 1100px - var(--sstX-c0, 0px) - var(--sstX-c1, 0px)'
        + ' - var(--sstX-w0, 0px), 400px)',
      from: 1100,
      // 1100 + 400 + 500, then 300 for the dwell at 0 and 200 for the one at 1700; 5000 is past.
      to: 2500,
    });
  });

  // A wrapper already stuck at the top of the page carries from scroll 0, where a range starts.
  it('starts the window at scroll 0, and keeps it open for a carry full from the start', () => {
    expect(planCarryRamps('sstX', [], [planned(-200, 500), planned(-800, 300)]).map(({ from, to }) => [from, to]))
      .toEqual([[0, 300], [0, 1]]);
  });

  // As the JS ramp writes it: the outer wrapper carries 200 at scroll 0, the inner one 100.
  it('leaves each carry at scroll 0 out of the property, adding the outer one\'s back', () => {
    expect(planCarryRamps('sstX', [], [planned(-200, 500, [], 200), planned(-300, 1000, [0], 100)])
      .map(({ value }) => value)).toEqual([
      'calc(clamp(0px, var(--sstX-s0) - -200px, 500px) - 200px)',
      'calc(clamp(0px, var(--sstX-s1) - -100px - var(--sstX-w0, 0px), 1000px) - 100px)',
    ]);
  });
});
