// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dormancyAfterScrollZero,
  dormancyAtScrollZero,
  movedPastFreeze,
  invertStuckUnion,
  isWebKit,
  mergeIntervals,
  rebuildDormancy,
  registerDormancyClient,
  setGsapRefreshReturn,
  takeGsapRefreshRestore,
  releaseDormant,
  unregisterDormancyClient,
} from './dormancy';
import type { DormancyClient } from './dormancy';

// Runs the queued microtasks and the ones they queue, so a test checks what is done by the end of
// the task.
const flushMicrotasks = async () => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

describe('mergeIntervals', () => {
  it('merges overlapping and touching intervals and drops empty ones', () => {
    expect(mergeIntervals([[50, 60], [0, 10], [10, 20], [55, 70], [30, 30]])).toEqual([
      [0, 20],
      [50, 70],
    ]);
  });
});

// jsdom reports WebKit's vendor; a suite running the library there must get the 'off' behavior.
describe('isWebKit', () => {
  afterEach(() => vi.restoreAllMocks());

  it('takes Apple\'s vendor as WebKit, but not jsdom\'s', () => {
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
    expect(isWebKit()).toBe(false);

    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    );
    expect(isWebKit()).toBe(true);
  });
});

describe('invertStuckUnion', () => {
  it('adds the length of every stretch starting before the running scroll', () => {
    expect(invertStuckUnion([[100, 200], [400, 450]], 50, true)).toBe(50);
    expect(invertStuckUnion([[100, 200], [400, 450]], 150, true)).toBe(250);
    expect(invertStuckUnion([[100, 200], [400, 450]], 350, true)).toBe(500);
  });

  it('takes the far end of a stretch starting exactly at y only when inclusive', () => {
    expect(invertStuckUnion([[100, 200]], 100, true)).toBe(200);
    expect(invertStuckUnion([[100, 200]], 100, false)).toBe(100);
  });
});

// jsdom has no layout, so each test states the static layout the table measures: document top,
// height and the parent's bottom edge, all at scroll 0.
interface Box {
  top: number;
  height: number;
}

const boxes = new Map<Element, Box>();
let scroll = 0;
const place = (el: Element, top: number, height: number) => boxes.set(el, { top, height });

const scrollTo = (y: number) => {
  scroll = y;
  window.dispatchEvent(new Event('scroll'));
};

const clients: DormancyClient[] = [];

const addClient = (elements: HTMLElement[], mode: DormancyClient['mode'] = 'always') => {
  const client: DormancyClient = { mode, ownedElements: () => elements };

  clients.push(client);
  registerDormancyClient(client);

  return client;
};

const byId = (id: string) => document.getElementById(id)!;
// GSAP's class outside its own refresh.
const gsap = { isRefreshing: false };

beforeEach(() => {
  boxes.clear();
  scroll = 0;
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(10000);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = boxes.get(this) ?? { top: 0, height: 0 };
    const top = box.top - scroll;

    return { top, bottom: top + box.height, height: box.height } as DOMRect;
  });
});

afterEach(() => {
  clients.splice(0).forEach(unregisterDormancyClient);
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// One owned sticky element, stuck from 2000 to 2500 (500px of travel in its parent). The buffer is
// the viewport height, 600, since a single level never exceeds the chain limit.
const setupSingle = () => {
  document.body.innerHTML = '<div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>';
  place(byId('parent'), 2000, 600);
  place(byId('el'), 2000, 100);

  return byId('el');
};

describe('rebuildDormancy', () => {
  it('demotes an owned element far before or after its range to relative at the sticky offset', () => {
    const el = setupSingle();

    addClient([el]);
    rebuildDormancy(gsap);

    expect(el.style.cssText).toBe('position: relative; top: 0px; z-index: 0; will-change: opacity;');

    scrollTo(1500);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');

    scrollTo(3100);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');

    scrollTo(3101);
    expect(el.style.cssText).toBe('position: relative; top: 500px; z-index: 0; will-change: opacity;');
  });

  // Without the class a GSAP refresh can't be told apart from any other.
  it('demotes nothing until some instance has seen GSAP\'s class', () => {
    const el = setupSingle();

    addClient([el]);
    rebuildDormancy(null);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');

    rebuildDormancy(gsap);
    expect(el.style.position).toBe('relative');

    rebuildDormancy(null);
    expect(el.style.position).toBe('relative');
  });

  // Like the cover lift's restore: a value written while demoted (gsap.set on a pin trigger, say)
  // isn't the switch's to take back.
  it('keeps what was written on a demoted element when promoting it', () => {
    const el = setupSingle();

    addClient([el]);
    rebuildDormancy(gsap);
    el.style.zIndex = '5';
    el.style.willChange = 'transform';
    scrollTo(1500);

    expect(el.style.cssText).toBe('position: sticky; top: 0px; z-index: 5; will-change: transform;');
  });

  // Only the static measurement's own static is taken back: one written in between (gsap.set to
  // switch a pin off, say) stays when the table is emptied.
  it('keeps a static written on an element outside the measurement', () => {
    const el = setupSingle();

    addClient([el]);
    scroll = 1500;
    rebuildDormancy(gsap);
    el.style.position = 'static';
    document.documentElement.style.overflowY = 'hidden';
    document.body.style.overflowY = 'auto';
    rebuildDormancy(gsap);
    document.documentElement.style.overflowY = '';
    document.body.style.overflowY = '';

    expect(el.style.position).toBe('static');
  });

  it('keeps an author z-index and will-change', () => {
    const el = setupSingle();

    el.style.zIndex = '4';
    el.style.willChange = 'transform';
    addClient([el]);
    rebuildDormancy(gsap);

    expect(el.style.cssText).toBe('position: relative; top: 0px; z-index: 4; will-change: transform;');
  });

  it('places a nested element\'s range after its sticky ancestor\'s', () => {
    document.body.innerHTML = `
      <div id="outerParent"><div id="outer" style="position: sticky; top: 0px">
        <div id="innerParent"><div id="inner" style="position: sticky; top: 0px"></div></div>
      </div></div>`;
    place(byId('outerParent'), 1000, 400);
    place(byId('outer'), 1000, 100);
    place(byId('innerParent'), 3000, 300);
    place(byId('inner'), 3000, 100);
    addClient([byId('outer'), byId('inner')]);
    rebuildDormancy(gsap);

    // outer holds still for 300px from 1000, so inner reaches the top at 3300 and stays to 3500.
    scrollTo(2699);
    expect(byId('inner').style.position).toBe('relative');
    scrollTo(2700);
    expect(byId('inner').style.position).toBe('sticky');
    scrollTo(4100);
    expect(byId('inner').style.position).toBe('sticky');
    scrollTo(4101);
    expect(byId('inner').style.top).toBe('200px');
  });

  it('never demotes an element it doesn\'t own, or one owned by an instance left out', () => {
    const el = setupSingle();

    rebuildDormancy(gsap);
    expect(el.style.position).toBe('sticky');

    addClient([]);
    rebuildDormancy(gsap);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');
  });

  it('leaves the descendants of an author sticky element it can\'t model alone', () => {
    document.body.innerHTML = `
      <div id="author" style="position: sticky; bottom: 0">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('sticky');
    expect(byId('author').style.cssText).toBe('position: sticky; bottom: 0px;');
  });

  // calc() with a percentage left in it keeps its calc() form, which reads as no number at all.
  it('leaves the descendants of an author sticky element with a top it can\'t read alone', () => {
    document.body.innerHTML = `
      <div id="author" style="position: sticky; top: calc(50% - 10px)">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('sticky');
  });

  // With no inset at all it never sticks, so it holds nothing still and blocks nothing.
  it('models an author sticky element with no inset as one that never holds', () => {
    document.body.innerHTML = `
      <div id="author" style="position: sticky">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div>`;
    place(byId('author'), 0, 9000);
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('relative');
    scrollTo(1400);
    expect(byId('el').style.position).toBe('sticky');
    expect(byId('author').style.cssText).toBe('position: sticky;');
  });

  // Its containing block is further up then, and the parent's box says nothing about its travel.
  it('leaves an element whose parent is display: contents or inline alone', () => {
    ['contents', 'inline'].forEach((display) => {
      document.body.innerHTML = `
        <div id="parent" style="display: ${display}"><div id="el" style="position: sticky; top: 0px"></div></div>`;
      place(byId('parent'), 2000, 600);
      place(byId('el'), 2000, 100);

      const client = addClient([byId('el')]);

      rebuildDormancy(gsap);
      expect(byId('el').style.position).toBe('sticky');
      unregisterDormancyClient(client);
      clients.pop();
    });
  });

  // An author top: 10% !important against the library's 10px reads as the same number.
  it('leaves an owned element whose top an author overrides in another unit alone', () => {
    document.body.innerHTML = `<style>#el { top: 10% !important; }</style>
      <div id="parent"><div id="el" style="position: sticky; top: 10px"></div></div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('sticky');
  });

  it('leaves an element under a transform alone', () => {
    document.body.innerHTML = `
      <div style="transform: translateY(10px)">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('sticky');
  });

  // A relative offset counts toward the scrollable area where a sticky one doesn't, so content
  // reaching past the page's end once moved down would make the page taller.
  it('keeps an element sticky past its range when its overflow would grow the page', () => {
    const el = setupSingle();

    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(9500);
    addClient([el]);
    rebuildDormancy(gsap);
    expect(el.style.position).toBe('relative');

    scrollTo(3101);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');
  });

  // Relative offsets add up: inner's overflow fits below the page's end moved by its own 50px of
  // travel, not by outer's 500 on top.
  it('counts the travel of demoted ancestors when checking overflow past the page\'s end', () => {
    document.body.innerHTML = `
      <div id="outerParent"><div id="outer" style="position: sticky; top: 0px">
        <div id="inner" style="position: sticky; top: 0px"></div>
      </div></div>`;
    place(byId('outerParent'), 2000, 600);
    place(byId('outer'), 2000, 100);
    place(byId('inner'), 2000, 50);
    vi.spyOn(byId('inner'), 'scrollHeight', 'get').mockReturnValue(7500);
    addClient([byId('outer'), byId('inner')]);
    rebuildDormancy(gsap);

    scrollTo(9000);
    expect(byId('outer').style.position).toBe('relative');
    expect(byId('inner').style.position).toBe('sticky');
  });

  // Chromium and Firefox keep 6 significant digits of a length: 500.123456px reads back as
  // 500.123px, and the table still knows that write for its own.
  it('gives back an element whose demoted top the browser rounded', () => {
    const el = setupSingle();
    let top = el.style.top;

    place(byId('parent'), 2000, 600.123456);
    Object.defineProperty(el.style, 'top', {
      configurable: true,
      get: () => top,
      set: (value: string) => {
        top = value.endsWith('px') ? `${Number(parseFloat(value).toPrecision(6))}px` : value;
      },
    });
    addClient([el]);
    rebuildDormancy(gsap);
    scrollTo(5000);
    expect(el.style.position).toBe('relative');
    expect(top).toBe('500.123px');

    document.documentElement.style.overflowY = 'hidden';
    document.body.style.overflowY = 'auto';
    rebuildDormancy(gsap);
    document.documentElement.style.overflowY = '';
    document.body.style.overflowY = '';
    expect(el.style.position).toBe('sticky');
    expect(top).toBe('0px');
  });

  // A throw partway through the static measurement still gives every element its position back.
  it('puts every position back when the static measurement throws', () => {
    document.body.innerHTML = `
      <div id="author" style="position: sticky; top: 0px">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    vi.spyOn(byId('el'), 'getBoundingClientRect').mockImplementation(() => {
      throw new Error('measure');
    });

    expect(() => rebuildDormancy(gsap)).toThrow('measure');
    expect(byId('author').style.position).toBe('sticky');
    expect(byId('el').style.position).toBe('sticky');
  });

  // An instance constructed and never refreshed has nothing to demote, and doesn't keep the
  // whole-document scan going for the others.
  it('drops a client with no element at all', () => {
    const el = setupSingle();
    const scan = vi.spyOn(document, 'querySelectorAll');

    addClient([]);
    addClient([el], 'auto');
    rebuildDormancy(gsap);

    expect(scan).not.toHaveBeenCalledWith('*');
  });

  // html's overflow keeps body's from going to the viewport, so body scrolls the page itself.
  it('leaves everything alone when body is the page\'s scroller', () => {
    const el = setupSingle();

    document.documentElement.style.overflowY = 'hidden';
    document.body.style.overflowY = 'auto';
    addClient([el]);
    rebuildDormancy(gsap);
    document.documentElement.style.overflowY = '';
    document.body.style.overflowY = '';

    expect(el.style.position).toBe('sticky');
  });

  it('gives a demoted element taken off the page back whole', () => {
    const el = setupSingle();

    addClient([el]);
    rebuildDormancy(gsap);
    expect(el.style.position).toBe('relative');

    el.remove();
    rebuildDormancy(gsap);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');
  });

  // Around a library element an author one is set static to measure, then gets its style
  // attribute back as it was: none where it had none, the same declarations in the same order.
  it('gives an author element around a library one back its style attribute exactly', () => {
    document.head.innerHTML = '<style>#plain { position: sticky; top: 0px; }</style>';
    document.body.innerHTML = `
      <div id="plain"><div id="styled" style="position: sticky; top: 0px">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div></div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    rebuildDormancy(gsap);
    document.head.innerHTML = '';

    expect(byId('el').style.position).toBe('relative');
    expect(byId('plain').hasAttribute('style')).toBe(false);
    expect(byId('styled').getAttribute('style')).toBe('position: sticky; top: 0px');
  });

  it('gives an !important position around a library element back as it was', () => {
    document.body.innerHTML = `
      <div id="important" style="position: sticky !important; top: 0px">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    rebuildDormancy(gsap);

    expect(byId('important').getAttribute('style')).toBe('position: sticky !important; top: 0px');
  });

  // Neither around nor inside a library element, an author one has nothing to do with the table.
  it('never writes to an author sticky element beside the library ones', async () => {
    document.body.innerHTML = `
      <header id="header" style="position: sticky; top: 0px"></header>
      <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((list) => mutations.push(...list));

    observer.observe(byId('header'), { attributes: true });
    addClient([byId('el')]);
    rebuildDormancy(gsap);
    await flushMicrotasks();
    observer.disconnect();

    expect(byId('el').style.position).toBe('relative');
    expect(mutations).toEqual([]);
  });

  // Inside a library element an author one is a level on its chain, but moves none of the library
  // ones: it isn't set static to measure them.
  it('never writes to an author sticky element inside a library one', async () => {
    document.body.innerHTML = `
      <div id="parent"><div id="el" style="position: sticky; top: 0px">
        <h2 id="inner" style="position: sticky; top: 0px"></h2>
      </div></div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((list) => mutations.push(...list));

    observer.observe(byId('inner'), { attributes: true });
    addClient([byId('el')]);
    rebuildDormancy(gsap);
    await flushMicrotasks();
    observer.disconnect();

    expect(byId('el').style.position).toBe('relative');
    expect(mutations).toEqual([]);
  });

  // Nor does a chain of them elsewhere shrink the buffer: no switch can make it shallower.
  it('leaves author sticky elements beside the library ones out of the buffer', () => {
    document.body.innerHTML = `${'<div class="p"><div class="a" style="position: sticky; top: 0px">'.repeat(5)}
      ${'</div></div>'.repeat(5)}
      <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>`;
    document.querySelectorAll('.p').forEach((p) => place(p, 0, 100));
    document.querySelectorAll('.a').forEach((a) => place(a, 0, 10));
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    scroll = 1500;
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('sticky');
  });

  // An instance taken off the page without destroy() stops counting, here as the 'always' one
  // that would keep the whole-document scan running.
  it('drops a client whose elements have all left the page', () => {
    const el = setupSingle();
    const scan = vi.spyOn(document, 'querySelectorAll');

    addClient([document.createElement('div')]);
    addClient([el], 'auto');
    rebuildDormancy(gsap);

    expect(scan).not.toHaveBeenCalledWith('*');
  });

  it('leaves an element inside a scroll container alone', () => {
    document.body.innerHTML = `
      <div style="overflow-y: auto">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div>`;
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('sticky');
  });

  it('turns an auto client on only at 7 nested levels', () => {
    const nest = (depth: number) => {
      document.body.innerHTML = Array.from({ length: depth }, (_, i) =>
        `<div class="p"><div id="l${i}" style="position: sticky; top: 0px">`).join('')
      + '</div></div>'.repeat(depth);

      return Array.from({ length: depth }, (_, i) => byId(`l${i}`));
    };

    // Every level stuck only near 5000, so all of them are far away at 0.
    const shallow = nest(6);

    shallow.forEach((el) => place(el, 5000, 10));
    addClient(shallow, 'auto');
    rebuildDormancy(gsap);
    expect(shallow.every((el) => el.style.position === 'sticky')).toBe(true);

    const deep = nest(7);

    deep.forEach((el) => place(el, 5000, 10));
    addClient(deep, 'auto');
    rebuildDormancy(gsap);
    expect(deep.every((el) => el.style.position === 'relative')).toBe(true);

    // Left relative by the build above, the outer levels still count on the next one.
    deep.slice(1).forEach((el) => {
      el.style.position = 'sticky';
    });
    rebuildDormancy(gsap);
    expect(deep.every((el) => el.style.position === 'relative')).toBe(true);
  });

  // The deep instance's depth says nothing about a shallow one beside it, which gains nothing.
  it('turns each auto client on by its own depth', () => {
    document.body.innerHTML = `${Array.from({ length: 7 }, (_, i) =>
      `<div class="p"><div id="l${i}" style="position: sticky; top: 0px">`).join('')}
      ${'</div></div>'.repeat(7)}
      <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>`;

    const deep = Array.from({ length: 7 }, (_, i) => byId(`l${i}`));

    deep.forEach((el) => place(el, 5000, 10));
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient(deep, 'auto');
    addClient([byId('el')], 'auto');
    rebuildDormancy(gsap);

    expect(deep.every((el) => el.style.position === 'relative')).toBe(true);
    expect(byId('el').style.position).toBe('sticky');
  });

  it('skips the whole-document scan for auto clients nested less than 7 deep', () => {
    const el = setupSingle();
    const scan = vi.spyOn(document, 'querySelectorAll');

    addClient([el], 'auto');
    rebuildDormancy(gsap);

    expect(scan).not.toHaveBeenCalledWith('*');
    expect(el.style.position).toBe('sticky');
  });

  // A record that's never switched is sticky at every scroll: four author levels above leave no
  // room under the chain limit, so the buffer drops to its 325px floor.
  it('counts an element it never switches as sticky everywhere when sizing the buffer', () => {
    document.body.innerHTML = `${'<div class="p"><div class="a" style="position: sticky; top: 0px">'.repeat(4)}
      <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      ${'</div></div>'.repeat(4)}`;
    document.querySelectorAll('.p').forEach((p) => place(p, 8000, 100));
    document.querySelectorAll('.a').forEach((a) => place(a, 8000, 10));
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    scroll = 1600;
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('relative');
    scrollTo(1675);
    expect(byId('el').style.position).toBe('sticky');
  });

  // The same with author levels that fill their parents and so never move: WebKit lays those out
  // as slowly as any other sticky level.
  it('counts a sticky element with no travel when sizing the buffer', () => {
    document.body.innerHTML = `${'<div class="p"><div class="a" style="position: sticky; top: 0px">'.repeat(4)}
      <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      ${'</div></div>'.repeat(4)}`;
    document.querySelectorAll('.p').forEach((p) => place(p, 8000, 100));
    document.querySelectorAll('.a').forEach((a) => place(a, 8000, 100));
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);
    addClient([byId('el')]);
    scroll = 1600;
    rebuildDormancy(gsap);

    expect(byId('el').style.position).toBe('relative');
    scrollTo(1675);
    expect(byId('el').style.position).toBe('sticky');
  });

  // GSAP's dispatch runs refresh() once per layer: the later builds in the same task measure the
  // elements already known instead of scanning the document again.
  it('scans the whole document once per task', async () => {
    const el = setupSingle();

    addClient([el]);

    const scan = vi.spyOn(document, 'querySelectorAll');

    rebuildDormancy(gsap);
    rebuildDormancy(gsap);
    expect(scan.mock.calls.filter(([selector]) => selector === '*')).toHaveLength(1);

    // Measured again all the same: a wider parent moves the range.
    place(byId('parent'), 2000, 900);
    rebuildDormancy(gsap);
    scrollTo(3300);
    expect(el.style.position).toBe('sticky');

    await flushMicrotasks();
    rebuildDormancy(gsap);
    expect(scan.mock.calls.filter(([selector]) => selector === '*')).toHaveLength(2);
  });

  // The scan, not the table: a build that emptied the table in between still knows the author's
  // sticky ancestor, here one holding el still for 1000px from 0.
  it('keeps what the task\'s scan found when the table was emptied in between', () => {
    document.body.innerHTML = `
      <div id="authorParent"><div id="author" style="position: sticky; top: 0px">
        <div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>
      </div></div>`;
    place(byId('authorParent'), 0, 1100);
    place(byId('author'), 0, 100);
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);

    const client = addClient([byId('el')]);

    rebuildDormancy(gsap);
    unregisterDormancyClient(client);
    clients.pop();
    addClient([byId('el')]);
    rebuildDormancy(gsap);

    // el reaches the top at 3000, not 2000: 2350 is far before it.
    scrollTo(2350);
    expect(byId('el').style.position).toBe('relative');
  });

  // A fake ScrollTrigger class that keeps its listeners by event type.
  // rec: the scroll record GSAP took before its refreshInit.
  const fakeGsap = (rec = 0) => {
    const listeners: Record<string, () => unknown> = {};

    return {
      isRefreshing: true,
      listeners,
      getScrollFunc: () => ({ rec }),
      addEventListener: (type: string, callback: () => unknown) => {
        listeners[type] = callback;
      },
      removeEventListener: vi.fn(),
    };
  };

  // What GSAP's refreshInit dispatch gets back from the module's own listener.
  const refreshInit = (refreshing: ReturnType<typeof fakeGsap>) =>
    refreshing.listeners.refreshInit() as { render: (time: number) => void };

  it('applies the state for scroll 0 inside GSAP\'s refresh, and the current one on render(-1)', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    // Taken mid-refresh, as an instance's refreshInit handler does: refresh(), then this.
    rebuildDormancy(refreshing);
    takeGsapRefreshRestore();
    expect(el.style.top).toBe('0px');

    // GSAP scrolls to 0 to measure; the restore still targets where it started.
    const result = refreshInit(refreshing);

    scroll = 0;
    result.render(-1);
    expect(el.style.top).toBe('500px');
  });

  // After the restore GSAP has measured and scrolled back, so a refresh() from onRefresh gets the
  // current scroll's state, and GSAP's 'refresh' event ends the phase.
  it('applies the current scroll\'s state to a build after GSAP\'s restore', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    refreshInit(refreshing).render(-1);
    rebuildDormancy(refreshing);
    expect(el.style.top).toBe('500px');

    // The next GSAP refresh starts over, from its refreshInit dispatch.
    refreshing.isRefreshing = false;
    refreshing.listeners.refresh();
    refreshing.isRefreshing = true;
    refreshInit(refreshing);
    rebuildDormancy(refreshing);
    expect(el.style.top).toBe('0px');
  });

  // A refresh() from a later refreshInit result's render(-1) runs before GSAP scrolls back to
  // where it started.
  it('applies the state for the scroll GSAP returns to in a build before it scrolls back', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    refreshing.listeners.refresh();

    const result = refreshInit(refreshing);

    scroll = 0;
    result.render(-1);
    rebuildDormancy(refreshing);
    expect(el.style.top).toBe('500px');
  });

  // The scroll GSAP took was moved after the table took it.
  it('applies the state for the scroll GSAP\'s return was moved to', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    refreshing.listeners.refresh();
    scroll = 0;

    const result = refreshInit(refreshing);

    setGsapRefreshReturn(3500);
    result.render(-1);
    expect(el.style.top).toBe('500px');
  });

  // A refreshInit listener ahead of the table's scrolled to 0 to measure, as GSAP is about to.
  it('applies the state for GSAP\'s record when a listener ahead has scrolled to 0', () => {
    const el = setupSingle();
    const refreshing = fakeGsap(3500);

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    refreshing.listeners.refresh();
    scroll = 0;
    refreshInit(refreshing).render(-1);
    expect(el.style.top).toBe('500px');
  });

  // GSAP takes none in a refresh while its triggers are reverted.
  it('applies the state for the scroll as it is when GSAP took no record', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    refreshing.listeners.refresh();
    refreshInit(refreshing).render(-1);
    expect(el.style.top).toBe('500px');
  });

  // After GSAP has gone back to its record, a measurement goes back where it was told to, which a
  // kill's catch-up can move.
  it('applies the state for the scroll a measurement goes back to after GSAP has measured', () => {
    const el = setupSingle();
    const refreshing = fakeGsap(3500);

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    refreshing.listeners.refresh();
    refreshInit(refreshing).render(-1);
    expect(el.style.top).toBe('500px');

    dormancyAfterScrollZero(0);
    expect(el.style.top).toBe('0px');
  });

  it('keeps the state for 0 after a measurement at 0 inside GSAP\'s refresh', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    refreshing.listeners.refresh();
    refreshInit(refreshing);
    dormancyAfterScrollZero(3500);
    expect(el.style.top).toBe('0px');
  });

  it('puts the current scroll\'s state back on GSAP\'s refresh event when no restore ran', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    takeGsapRefreshRestore();
    expect(el.style.top).toBe('0px');

    refreshing.listeners.refresh();
    expect(el.style.top).toBe('500px');
  });

  // Added after GSAP's first refresh had already dispatched, the module's own refreshInit listener
  // covers every later one, a refresh() bound by hand included.
  it('restores from its own refreshInit listener on GSAP\'s render(-1)', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    refreshing.listeners.refresh();

    const result = refreshInit(refreshing);

    rebuildDormancy(refreshing);
    expect(el.style.top).toBe('0px');
    result.render(-1);
    expect(el.style.top).toBe('500px');
  });

  // A GSAP refresh that threw leaves isRefreshing set and never fires its 'refresh' event.
  it('puts the current scroll\'s state back after the task when GSAP\'s refresh never ends', async () => {
    const el = setupSingle();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy({ isRefreshing: true });
    takeGsapRefreshRestore();
    expect(el.style.top).toBe('0px');

    await flushMicrotasks();
    expect(el.style.top).toBe('500px');
  });

  // No instance's refresh() runs inside this GSAP refresh: the module's own listener still shows
  // GSAP the layout for 0, and a refresh() after the restore gets the current scroll's.
  it('shows the layout for 0 from its own refreshInit listener when no refresh() runs', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    refreshing.isRefreshing = false;
    rebuildDormancy(refreshing);
    expect(el.style.top).toBe('500px');

    refreshing.isRefreshing = true;

    const result = refreshInit(refreshing);

    expect(el.style.top).toBe('0px');
    result.render(-1);
    expect(el.style.top).toBe('500px');
    rebuildDormancy(refreshing);
    expect(el.style.top).toBe('500px');
  });

  // GSAP leaves isRefreshing set after a refresh that threw. Taken before that, the class's own
  // refreshInit listener would have started any real refresh, so a build now gets the current
  // scroll's state.
  it('ignores an isRefreshing left set when no refresh began', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    refreshing.isRefreshing = false;
    rebuildDormancy(refreshing);
    refreshing.isRefreshing = true;
    rebuildDormancy(refreshing);

    expect(el.style.top).toBe('500px');
    expect(takeGsapRefreshRestore()).toBeNull();
  });

  // Taken during one of GSAP's refreshes, the class's listener missed that refreshInit dispatch:
  // the restore goes out through the instance's own result instead.
  it('hands the restore to the instance when it took the class mid-refresh', () => {
    const el = setupSingle();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(fakeGsap());

    const restore = takeGsapRefreshRestore()!;

    expect(el.style.top).toBe('0px');
    restore();
    expect(el.style.top).toBe('500px');
  });

  // Taken in an onRefresh callback, after GSAP has measured: isRefreshing is still set, but no
  // render(-1) is coming, so the build keeps the current scroll's state.
  it('keeps the current scroll\'s state when it took the class after GSAP measured', () => {
    const el = setupSingle();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(fakeGsap());
    expect(el.style.top).toBe('500px');
  });

  // GSAP may change its own pin spacing after the instances' refresh() measured: the table is
  // built again on GSAP's 'refresh' event.
  it('rebuilds on GSAP\'s refresh event', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    refreshing.isRefreshing = false;
    rebuildDormancy(refreshing);
    refreshing.isRefreshing = true;
    refreshInit(refreshing).render(-1);
    place(byId('parent'), 3000, 600);
    place(el, 3000, 100);
    refreshing.isRefreshing = false;
    refreshing.listeners.refresh();

    // In range now only with the range starting at 3000.
    scrollTo(2600);
    expect(el.style.position).toBe('sticky');
    scrollTo(2399);
    expect(el.style.position).toBe('relative');
  });

  it('adds nothing to GSAP on a page with no instance using it', () => {
    const refreshing = fakeGsap();

    rebuildDormancy(refreshing);
    expect(refreshing.listeners).toEqual({});
  });

  // Every refresh() of a non-WebKit 'auto' instance builds with no client: nothing is queued.
  it('queues nothing on a page with no instance using it', () => {
    const tasks = vi.spyOn(globalThis, 'queueMicrotask');

    rebuildDormancy(fakeGsap());
    expect(tasks).not.toHaveBeenCalled();
  });

  // A table emptied mid-refresh keeps where GSAP's refresh started, for the build after it.
  it('keeps the scroll to restore when the table is emptied while GSAP measures', () => {
    const el = setupSingle();
    const refreshing = fakeGsap();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(refreshing);
    takeGsapRefreshRestore();
    document.documentElement.style.overflowY = 'hidden';
    document.body.style.overflowY = 'auto';
    rebuildDormancy(refreshing);
    document.documentElement.style.overflowY = '';
    document.body.style.overflowY = '';
    rebuildDormancy(refreshing);
    expect(el.style.top).toBe('0px');

    refreshInit(refreshing).render(-1);
    expect(el.style.top).toBe('500px');
  });
});

// A refresh() writes sticky back on the elements it owns, over a demoted one's relative.
// A measurement outside GSAP's refresh scrolls to 0 and back within the task, as GSAP's does.
describe('a measurement at scroll 0', () => {
  it('puts what sits past its freeze where it sits at 0, then back', () => {
    const el = setupSingle();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(gsap);
    dormancyAtScrollZero();
    expect(el.style.cssText).toBe('position: relative; top: 0px; z-index: 0; will-change: opacity;');

    dormancyAfterScrollZero(3500);
    expect(el.style.top).toBe('500px');
  });

  // What a read outside the table asks to know whether it must go to 0.
  it('names what it moved past its freeze, and nothing at 0', () => {
    const el = setupSingle();

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(gsap);
    expect([...movedPastFreeze()]).toEqual([el]);

    dormancyAtScrollZero();
    expect([...movedPastFreeze()]).toEqual([]);
  });

  // Stuck at 0 is the state for 0, but making it sticky is the layout the table avoids.
  it('makes nothing sticky', () => {
    document.body.innerHTML = '<div id="parent"><div id="el" style="position: sticky; top: 0px"></div></div>';
    place(byId('parent'), 0, 600);
    place(byId('el'), 0, 100);

    const el = byId('el');

    addClient([el]);
    scroll = 3500;
    rebuildDormancy(gsap);
    dormancyAtScrollZero();
    expect(el.style.position).toBe('relative');
  });
});

describe('an element a refresh() wrote sticky again while demoted', () => {
  const demoteThenRewrite = () => {
    const el = setupSingle();

    addClient([el]);
    rebuildDormancy(gsap);
    expect(el.style.cssText).toBe('position: relative; top: 0px; z-index: 0; will-change: opacity;');
    el.style.position = 'sticky';
    el.style.top = '5px';

    return el;
  };

  it('keeps the refresh\'s values and its own z-index/will-change on the next build', () => {
    const el = demoteThenRewrite();

    scroll = 1500;
    rebuildDormancy(gsap);
    expect(el.style.cssText).toBe('position: sticky; top: 5px;');
  });

  it('keeps the refresh\'s values when the table is emptied instead', () => {
    const el = demoteThenRewrite();

    document.documentElement.style.overflowY = 'hidden';
    document.body.style.overflowY = 'auto';
    rebuildDormancy(gsap);
    document.documentElement.style.overflowY = '';
    document.body.style.overflowY = '';
    expect(el.style.cssText).toBe('position: sticky; top: 5px;');
  });

  // Demoted 'before' writes top 0px; a refresh() replanning the element's top to 0px as well
  // leaves a top that reads like the demoted one but isn't.
  it('keeps a refresh\'s top that matches the demoted one when the table is emptied', () => {
    document.body.innerHTML = '<div id="parent"><div id="el" style="position: sticky; top: 120px"></div></div>';
    place(byId('parent'), 2000, 600);
    place(byId('el'), 2000, 100);

    const el = byId('el');

    addClient([el]);
    rebuildDormancy(gsap);
    expect(el.style.top).toBe('0px');
    el.style.position = 'sticky';
    el.style.top = '0px';
    document.documentElement.style.overflowY = 'hidden';
    document.body.style.overflowY = 'auto';
    rebuildDormancy(gsap);
    document.documentElement.style.overflowY = '';
    document.body.style.overflowY = '';
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');
  });
});

const fakeGsapClass = () => ({
  isRefreshing: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

describe('rebuildDormancy after a teardown', () => {
  // The torn-down instance's wrapper held the one left still for 300px; without it, inner reaches
  // the top at 3000 rather than 3300.
  it('rebuilds the ranges of the instances left', async () => {
    document.body.innerHTML = `
      <div id="outerParent"><div id="outer" style="position: sticky; top: 0px">
        <div id="innerParent"><div id="inner" style="position: sticky; top: 0px"></div></div>
      </div></div>`;
    place(byId('outerParent'), 1000, 400);
    place(byId('outer'), 1000, 100);
    place(byId('innerParent'), 3000, 300);
    place(byId('inner'), 3000, 100);

    const torn = addClient([byId('outer')]);

    addClient([byId('inner')]);
    rebuildDormancy(gsap);
    scrollTo(2500);
    expect(byId('inner').style.position).toBe('relative');

    unregisterDormancyClient(torn);
    clients.splice(clients.indexOf(torn), 1);
    byId('outer').style.position = '';
    // Once at the end of the task.
    expect(byId('inner').style.position).toBe('relative');
    await flushMicrotasks();
    expect(byId('inner').style.position).toBe('sticky');
  });

  // The one left was taken off the page without destroy(): with nothing on the page using the
  // table, GSAP's listeners come off at the end of the task.
  it('leaves GSAP alone once the instances left are all gone from the page', async () => {
    const el = setupSingle();
    const goneElement = document.createElement('div');

    document.body.append(goneElement);
    addClient([goneElement]);

    const refreshing = fakeGsapClass();

    addClient([el]);
    rebuildDormancy(refreshing);
    expect(refreshing.addEventListener).toHaveBeenCalledWith('refreshInit', expect.any(Function));
    goneElement.remove();
    unregisterDormancyClient(clients.pop()!);
    await flushMicrotasks();

    expect(refreshing.removeEventListener).toHaveBeenCalledWith('refreshInit', expect.any(Function));
  });

  // GSAP's _dispatch is `_listeners[type].map(f => f())`: a listener spliced out from inside it
  // shifts the next one past the end of the map.
  it('leaves GSAP\'s listener list alone during its dispatch', async () => {
    const el = setupSingle();
    const listeners: (() => unknown)[] = [];
    const cls = {
      isRefreshing: false,
      addEventListener: (_type: string, callback: () => unknown) => {
        listeners.push(callback);
      },
      removeEventListener: (_type: string, callback: () => unknown) => {
        const index = listeners.indexOf(callback);

        if (index >= 0) listeners.splice(index, 1);
      },
    };
    const client = addClient([el]);

    rebuildDormancy(cls);

    const later = vi.fn();

    listeners.push(() => {
      unregisterDormancyClient(client);
      clients.length = 0;
    }, later);
    listeners.map((f) => f());

    expect(later).toHaveBeenCalled();
    await flushMicrotasks();
    expect(listeners).toEqual([expect.any(Function), later]);
  });

  // A page running two copies of GSAP: a refresh of either one shows its triggers the layout for 0.
  it('keeps listening to every class it has seen', () => {
    const el = setupSingle();
    const first = fakeGsapClass();
    const second = fakeGsapClass();

    addClient([el]);
    rebuildDormancy(first);
    rebuildDormancy(second);
    expect(first.removeEventListener).not.toHaveBeenCalled();
    expect(second.addEventListener).toHaveBeenCalledWith('refreshInit', expect.any(Function));

    const refreshInit = first.addEventListener.mock.calls
      .find(([type]) => type === 'refreshInit')![1] as () => { render: (time: number) => void };

    scroll = 3500;
    window.dispatchEvent(new Event('scroll'));
    expect(el.style.top).toBe('500px');

    const result = refreshInit();

    expect(el.style.top).toBe('0px');
    result.render(-1);
    expect(el.style.top).toBe('500px');
  });

  // Held weakly: once an instance dropped without destroy() is collected, the table forgets it.
  it('forgets a client whose instance has been collected', () => {
    const el = setupSingle();

    addClient([el]);
    vi.spyOn(WeakRef.prototype, 'deref').mockReturnValueOnce(undefined);
    rebuildDormancy(gsap);
    expect(el.style.position).toBe('sticky');

    // Gone from the table, not just skipped once.
    rebuildDormancy(gsap);
    expect(el.style.position).toBe('sticky');
  });
});

describe('releaseDormant and unregisterDormancyClient', () => {
  it('promote a demoted element whole and stop tracking it', () => {
    const el = setupSingle();

    addClient([el]);
    rebuildDormancy(gsap);
    releaseDormant([el]);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');

    scrollTo(3500);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');
  });

  it('promote every element of the last client and stop listening', () => {
    const el = setupSingle();
    const client = addClient([el]);

    rebuildDormancy(gsap);
    unregisterDormancyClient(client);
    clients.length = 0;
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');

    scrollTo(3500);
    expect(el.style.cssText).toBe('position: sticky; top: 0px;');
  });
});
