// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScrollTrigger } from 'gsap/ScrollTrigger';
import StickyScrollTrigger from './index';

// Apart from index.test.ts, whose instances stay armed from one test to the next: this needs a
// module with none armed, where a read outside every container takes no armed instance's class.

let scroll = 1200;
let scrolls: number[] = [];
let clock = 1e12;

beforeEach(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scroll);
  vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
    scroll = (options as ScrollToOptions).top ?? scroll;
    scrolls.push(scroll);
  });
});

afterEach(() => vi.restoreAllMocks());

const query = (sel: string) => document.querySelector<HTMLElement>(sel)!;

it('takes GSAP\'s word from the class it last took while no instance is armed', async () => {
  document.body.innerHTML = `
    <div class="auth" style="position: sticky; top: 0px">
      <div class="root"><section class="scene"></section><section class="inside"></section></div>
      <section class="outside"></section>
    </div>
  `;

  class Cls {
    static refresh = vi.fn();

    static isRefreshing = false;

    static scrolling = false;

    static isScrolling = () => Cls.scrolling;

    static getScrollFunc = () => ({ rec: 0 });

    static addEventListener = vi.fn();

    static removeEventListener = vi.fn();
  }

  const self = Object.create(Cls.prototype) as ScrollTrigger;
  const controller = new StickyScrollTrigger(query('.root'));
  const vars = controller.createStickyTrigger({ trigger: query('.scene'), end: '+=100' });

  vars.onKill?.(self);

  for (let i = 0; i < 50; i += 1) await Promise.resolve();

  // Past the trips the kill made.
  clock += 1000;
  scrolls = [];
  Cls.scrolling = true;
  StickyScrollTrigger.getScrollTop(query('.inside'), [controller]);
  // Outside every container: no instance of its own to take GSAP's class from.
  StickyScrollTrigger.getScrollTop(query('.outside'), [controller]);
  expect(scrolls).toEqual([]);

  // GSAP counts a trip of the library's own as a scroll too, one that leaves the page where it was.
  Cls.scrolling = false;
  StickyScrollTrigger.getScrollTop(query('.inside'), [controller]);
  Cls.scrolling = true;
  StickyScrollTrigger.getScrollTop(query('.inside'), [controller]);
  expect(scrolls).toEqual([0, 1200, 0, 1200]);
});
