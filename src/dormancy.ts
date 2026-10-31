/**
 * Nested-sticky dormancy. WebKit lays out nested position:sticky about 3x slower per level, and
 * the number of levels sticky at once is the only lever: depth itself is structural. So a sticky
 * element this module owns is switched to position:relative at the offset sticky would give it
 * while the scroll is far from its range, and back to sticky as the scroll nears it. Nothing moves
 * differently; only the number of sticky levels the engine lays out each frame drops.
 *
 * One page-level table serves every instance: an element's range depends on every sticky ancestor
 * above it, whichever instance (or the page author) made it sticky.
 */

import { compareDocumentOrder, measureDocumentHeight } from './dom';
import {
  addGsapListener,
  isRefreshing,
  removeGsapListener,
  revertAfterMeasure,
  scrollRecord,
} from './gsap';
import type { ScrollTriggerClassLike } from './gsap';

export type NestedStickyOptimization = 'auto' | 'always' | 'off';

// 'auto' turns on at this many nested sticky levels. Measured on Mac WebKit: 9 levels already take
// 17ms of layout per frame, 11 take 111ms.
const AUTO_MIN_DEPTH = 7;
// The buffer grows while no more than this many sticky levels along one ancestor chain are in band
// at once.
const MAX_CHAIN_IN_BAND = 4;
// The buffer never drops below this: the largest scroll-event delta seen during hard flings on an
// iPhone was 306px, and a smaller buffer would let the scroll cross into a range before the
// listener promotes it.
const BUFFER_FLOOR_PX = 325;
const BUFFER_STEP_PX = 25;

type State = 'in' | 'before' | 'after';

// What one instance contributes. ownedElements() lists the elements the library made sticky: the
// Scene/Cover wrappers and the pin triggers. demotableElements() lists the wrappers, the only ones
// ever demoted: a pin trigger is the page's own, so a demotion would stay on it under the page's
// CSS (a transition on top). The table holds it weakly, so an instance dropped without destroy()
// can still be collected.
export interface DormancyClient {
  mode: 'auto' | 'always';
  ownedElements(): readonly HTMLElement[];
  demotableElements(): readonly HTMLElement[];
}

interface LiveClient {
  client: DormancyClient;
  owned: readonly HTMLElement[];
  demotable: readonly HTMLElement[];
}

interface StickyRecord {
  el: HTMLElement;
  demotable: boolean;
  // Inline values to put back on promotion: the library's own for an owned element. An author
  // element only ever has its position touched, by the static measurement.
  position: string;
  top: string;
  zIndex: string;
  willChange: string;
  zIndexAuto: boolean;
  willChangeAuto: boolean;
  // Sticky top (px), static document top, and how far the element can travel inside its
  // containing block.
  stickyTop: number;
  naturalTop: number;
  travel: number;
  ancestors: StickyRecord[];
  // The scroll range over which the element is stuck, with full-sticky semantics.
  lo: number;
  hi: number;
  // Moved down by its travel, content overflowing the element would reach past the page's end and
  // make the page taller: a sticky offset never counts toward the scrollable area, a relative one
  // does. Such an element stays sticky past its range. overflowBottom is where that content ends in
  // the static layout.
  overflowBottom: number;
  holdsAfter: boolean;
  state: State;
  // style.top as read back after demotion wrote it, which is how promote recognizes its own write.
  demotedTop: string;
}

// True only on WebKit, which every browser on iOS/iPadOS uses. The font keyword exists only in
// Apple's builds; every WebKit build reports Apple as the vendor, Linux's included. So does jsdom,
// which has no layout to spare: a test suite running the library there gets the 'off' behavior.
export const isWebKit = (): boolean =>
  (typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    && CSS.supports('font', '-apple-system-body'))
  || (typeof navigator !== 'undefined' && navigator.vendor === 'Apple Computer, Inc.'
    && !/\bjsdom\//.test(navigator.userAgent));

export const mergeIntervals = (intervals: readonly [number, number][]): [number, number][] => {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];

  sorted.forEach(([a, b]) => {
    const last = merged.at(-1);

    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  });

  return merged;
};

// The scroll at which an element whose natural reach point is y gets there, when the merged
// intervals in union hold it still. inclusive picks the far end of a stretch starting exactly at y.
export const invertStuckUnion = (
  union: readonly [number, number][],
  y: number,
  inclusive: boolean,
): number => {
  let scroll = y;

  for (const [a, b] of union) {
    if (inclusive ? a <= scroll : a < scroll) scroll += b - a;
    else break;
  }

  return scroll;
};

const isTransformed = (style: CSSStyleDeclaration): boolean =>
  [style.transform, style.translate, style.scale, style.rotate]
    .some((value) => value !== undefined && value !== '' && value !== 'none');

// Whether el or an ancestor is transformed, which moves the box getBoundingClientRect reports
// away from where the layout has it. memo keeps nested records from walking a shared chain again.
const hasTransform = (el: HTMLElement | null, memo: Map<Element, boolean>): boolean => {
  if (!el) return false;

  const known = memo.get(el);

  if (known !== undefined) return known;

  const result = isTransformed(getComputedStyle(el)) || hasTransform(el.parentElement, memo);

  memo.set(el, result);

  return result;
};

const scrolls = (style: CSSStyleDeclaration): boolean =>
  ![style.overflowX, style.overflowY].every((v) => v === 'visible' || v === 'clip');
// body scrolls the page itself once html's overflow isn't visible (it no longer goes to the
// viewport), and then window.scrollY stays 0 and the window gets no scroll events.
const bodyScrolls = (): boolean =>
  scrolls(getComputedStyle(document.documentElement)) && scrolls(getComputedStyle(document.body));

// memo keeps elements sharing an ancestor chain from walking it again, as in hasTransform.
const isInsideScroller = (el: HTMLElement, memo: Map<Element, boolean>): boolean => {
  const node = el.parentElement;

  if (!node || node === document.body || node === document.documentElement) return false;

  const known = memo.get(node);

  if (known !== undefined) return known;

  const style = getComputedStyle(node);
  // A fixed ancestor doesn't scroll with the page, so the window model doesn't apply either.
  const result = style.position === 'fixed' || scrolls(style) || isInsideScroller(node, memo);

  memo.set(node, result);

  return result;
};

// How deep the most deeply nested owned element sits, counting its window-scroll sticky ancestors
// and the ones left demoted. Reads only the owned elements' ancestor chains, so a shallow page
// skips the whole-document scan.
const ownedDepth = (owned: Iterable<HTMLElement>, demoted: ReadonlySet<Element>): number => {
  // Sticky levels from each node up, shared by every owned element below it.
  const levels = new Map<Element, number>();

  const levelsUpFrom = (node: HTMLElement | null): number => {
    if (!node) return 0;

    const known = levels.get(node);

    if (known !== undefined) return known;

    const own = demoted.has(node) || getComputedStyle(node).position === 'sticky' ? 1 : 0;
    const level = own + levelsUpFrom(node.parentElement);

    levels.set(node, level);

    return level;
  };

  const scrollerMemo = new Map<Element, boolean>();
  let depth = 0;

  for (const el of owned) {
    if (!el.isConnected || isInsideScroller(el, scrollerMemo)) continue;

    depth = Math.max(depth, 1 + levelsUpFrom(el.parentElement));
  }

  return depth;
};

// A sticky top the model can use: a plain px value or a percentage of the viewport. Anything else
// (a calc() with a percentage left in it, say) reads as a number it isn't.
const SIMPLE_TOP = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(px|%)$/i;
const clients = new Set<WeakRef<DormancyClient>>();
let records: StickyRecord[] = [];
let buffer = 0;
let listening = false;
// The scroll GSAP's refresh in progress started from, while the table shows it the layout for 0.
let scrollBeforeGsapRefresh: number | null = null;
// Where GSAP's refresh stands: 'measuring' from the first build inside it until the restore runs,
// 'restored' from then until its 'refresh' event. A build in 'restored' (a refresh() called from
// onRefresh, say) comes after GSAP has measured and scrolled back, so it gets the current scroll's
// state.
let gsapPhase: 'idle' | 'measuring' | 'restored' = 'idle';
// The class was taken during one of its refreshes, whose refreshInit the listener missed (see
// takeGsapRefreshRestore).
let adoptedMidRefresh = false;
// The whole-document scan, kept until the next microtask checkpoint. GSAP's dispatch can call
// refresh() once per layer in one synchronous run, and a kill's rebuild calls it right before
// ScrollTrigger.refresh(); the later builds in it take the elements already known plus every
// library-owned one. An author sticky element added in between waits for the next task.
let scannedThisTask: HTMLElement[] | null = null;
// Every class an instance has seen: one, unless the page runs two copies of GSAP. Without one a
// GSAP refresh can't be told apart, and would measure every plain ScrollTrigger in the nesting
// against the layout for the wrong scroll.
const gsapClasses = new Set<ScrollTriggerClassLike>();
const gsapRefreshing = (): boolean =>
  Array.from(gsapClasses).some((cls) => isRefreshing(cls));

const stateAt = (record: StickyRecord, scroll: number): State => {
  if (!record.demotable) return 'in';

  if (scroll < record.lo - buffer) return 'before';

  return scroll > record.hi + buffer && !record.holdsAfter ? 'after' : 'in';
};

// Puts back what this module wrote, each property only while it still holds the value written: a
// different value written since (a refresh() writing sticky again) stays, and an identical one
// can't be told apart. static is ours only after the static measurement (afterMeasure), relative
// and the rest only on a demoted record. A refresh() writes position and top together, so once the
// position isn't ours, the top isn't either.
const promote = (record: StickyRecord, afterMeasure = false): void => {
  const { style } = record.el;
  const demoted = record.state !== 'in';
  const positionOurs = (afterMeasure && style.position === 'static')
    || (demoted && style.position === 'relative');

  if (positionOurs) style.position = record.position;

  if (demoted && positionOurs && style.top === record.demotedTop) style.top = record.top;

  if (demoted && record.zIndexAuto && style.zIndex === '0') style.zIndex = record.zIndex;

  if (demoted && record.willChangeAuto && style.willChange === 'opacity') {
    style.willChange = record.willChange;
  }

  record.state = 'in';
};

const applyState = (record: StickyRecord, state: State): void => {
  if (record.state === state) return;

  if (state === 'in') {
    promote(record);

    return;
  }

  const { style } = record.el;

  style.position = 'relative';
  style.top = `${state === 'before' ? 0 : record.travel}px`;
  record.demotedTop = style.top;

  // relative alone would change the paint order: sticky makes a stacking context, relative with
  // z-index auto doesn't. An author value is left alone.
  if (record.zIndexAuto) style.zIndex = '0';

  // Keeps the composited layer sticky had, which removed a white flash on Safari trackpad scrolls.
  if (record.willChangeAuto) style.willChange = 'opacity';

  record.state = state;
};

const update = (scroll: number): void => {
  records.forEach((record) => applyState(record, stateAt(record, scroll)));
};

const onScroll = (): void => update(window.scrollY);

const listen = (on: boolean): void => {
  if (on === listening) return;

  listening = on;

  if (on) window.addEventListener('scroll', onScroll, { passive: true });
  else window.removeEventListener('scroll', onScroll);
};

// Gives every demoted record back and empties the table, a detached one too.
const clearTable = (): void => {
  records.forEach((record) => promote(record));
  records = [];
  listen(false);
};

// Puts back the state for the scroll GSAP's refresh started from, once GSAP has measured. A no-op
// outside that window.
const restoreAfterGsapMeasure = (): void => {
  const scroll = scrollBeforeGsapRefresh;

  if (gsapPhase !== 'measuring' || scroll === null) return;

  gsapPhase = 'restored';

  if (records.length) update(scroll);
};

const endGsapRefresh = (): void => {
  gsapPhase = 'idle';
  scrollBeforeGsapRefresh = null;
  adoptedMidRefresh = false;
};

// A build outside refresh(): a throw empties the table rather than leave it half-written, and goes
// out of the way of whatever called this (GSAP's own dispatch has no guard).
const rebuildSafely = (): void => {
  try {
    rebuildDormancy(null);
  } catch (error) {
    clearTable();
    queueMicrotask(() => {
      throw error;
    });
  }
};

// GSAP's refresh is over, on its 'refresh' event: rebuild, since GSAP may have changed its own pin
// spacing after the instances' refresh() measured. The microtask does the same for a GSAP refresh
// that threw before that event and left isRefreshing set.
const onGsapRefreshDone = (): void => {
  const wasRefreshing = gsapPhase !== 'idle';

  endGsapRefresh();

  if (wasRefreshing && liveClients().length) rebuildSafely();
};

// The scroll GSAP's refresh goes back to: the record it took before its refreshInit, which a
// listener ahead of the table's that scrolls to 0 to measure leaves alone. None (0) when GSAP took
// none, in a refresh while its triggers are reverted (ScrollTrigger.js:274; a matchMedia switch
// records first, 1370), and then the scroll as it is.
const gsapRefreshScroll = (): number => {
  const refreshing = Array.from(gsapClasses).find((cls) => isRefreshing(cls));

  return scrollRecord(refreshing)?.read() ?? window.scrollY;
};

// GSAP calls render(-1) on what each refreshInit listener returns, once every trigger is measured.
// Also where a GSAP refresh begins: no instance's refresh() may run inside it (its triggers
// disabled, say), and GSAP still measures every plain trigger against the layout for 0.
const onGsapRefreshInit = () => {
  if (gsapPhase === 'idle') {
    gsapPhase = 'measuring';
    scrollBeforeGsapRefresh = gsapRefreshScroll();
    queueMicrotask(onGsapRefreshDone);

    if (records.length) update(0);
  }

  return revertAfterMeasure(restoreAfterGsapMeasure);
};

const adoptGsapClass = (cls: ScrollTriggerClassLike): void => {
  if (gsapClasses.has(cls)) return;

  if (isRefreshing(cls)) adoptedMidRefresh = true;

  gsapClasses.add(cls);
  addGsapListener(cls, 'refresh', onGsapRefreshDone);
  addGsapListener(cls, 'refreshInit', onGsapRefreshInit);
};

// Off the stack: GSAP's dispatch maps over its listener array, so removing one from inside it
// (a destroy() from a refreshInit callback, say) would shift the next listener out of that
// dispatch. Kept when an instance has come back by then. Nothing to queue on a page that never
// adopted one: every refresh() on a non-WebKit 'auto' page ends up here.
const dropGsapClassesLater = (): void => {
  if (!gsapClasses.size) return;

  queueMicrotask(() => {
    if (liveClients().length) return;

    gsapClasses.forEach((cls) => {
      removeGsapListener(cls, 'refresh', onGsapRefreshDone);
      removeGsapListener(cls, 'refreshInit', onGsapRefreshInit);
    });
    gsapClasses.clear();
  });
};

const scanStickyElements = (owned: Iterable<HTMLElement>): HTMLElement[] => {
  const scrollerMemo = new Map<Element, boolean>();
  const isWindowSticky = (el: HTMLElement) => el.isConnected
    && getComputedStyle(el).position === 'sticky' && !isInsideScroller(el, scrollerMemo);

  if (scannedThisTask) {
    return Array.from(new Set([...scannedThisTask, ...records.map((r) => r.el), ...owned]))
      .filter(isWindowSticky);
  }

  const found = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(isWindowSticky);

  scannedThisTask = found;
  queueMicrotask(() => {
    scannedThisTask = null;
  });

  return found;
};

// Largest number of in-band records along one ancestor chain at any scroll position, given a
// buffer of b. Chain depth only grows where a band starts: at 0 for a record never switched, so 0
// and the switched records' starts are enough.
const maxChainInBand = (b: number, maxScroll: number): number => {
  // A record that's never switched is sticky at every scroll. One with no travel counts all the
  // same: WebKit lays out a sticky level that can't move as slowly as one that can.
  const bands = records.flatMap((r) => {
    const band: [number, number] = r.demotable
      ? [Math.max(0, r.lo - b), Math.min(maxScroll, r.hi + (r.holdsAfter ? Infinity : b))]
      : [0, maxScroll];

    return band[1] >= band[0] ? [{ record: r, start: band[0], end: band[1] }] : [];
  });
  let max = 0;
  const starts = new Set([
    0,
    ...bands.filter(({ record }) => record.demotable).map(({ start }) => start),
  ]);

  starts.forEach((scroll) => {
    const inBand = new Set(bands
      .filter(({ start, end }) => start <= scroll && scroll <= end)
      .map(({ record }) => record));

    inBand.forEach((r) => {
      max = Math.max(max, 1 + r.ancestors.filter((a) => inBand.has(a)).length);
    });
  });

  return max;
};

// The largest buffer in 25px steps, up to the viewport height, that keeps the chain limit, and
// never below the floor. A larger buffer only puts more records in band, so the steps are
// searched by halves.
const chooseBuffer = (viewportHeight: number, maxScroll: number): number => {
  let low = Math.ceil(BUFFER_FLOOR_PX / BUFFER_STEP_PX);
  let high = Math.floor(viewportHeight / BUFFER_STEP_PX);

  if (high < low || maxChainInBand(low * BUFFER_STEP_PX, maxScroll) > MAX_CHAIN_IN_BAND) {
    return BUFFER_FLOOR_PX;
  }

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);

    if (maxChainInBand(mid * BUFFER_STEP_PX, maxScroll) <= MAX_CHAIN_IN_BAND) low = mid;
    else high = mid - 1;
  }

  return low * BUFFER_STEP_PX;
};

// The clients with an element on the page. One without (not refreshed yet, or taken off the page
// without destroy()) stays registered and counts again once it has one; a collected one is dropped.
const liveClients = (): LiveClient[] => {
  const live: LiveClient[] = [];

  clients.forEach((ref) => {
    const client = ref.deref();

    if (!client) {
      clients.delete(ref);

      return;
    }

    const owned = client.ownedElements();

    if (owned.some((el) => el.isConnected)) {
      live.push({ client, owned, demotable: client.demotableElements() });
    }
  });

  return live;
};

// The static measurement, run with every record static: each record's natural top, travel and
// overflow, and which ones the model can't take.
const measureStatic = (
  all: readonly StickyRecord[],
  owned: ReadonlyMap<HTMLElement, DormancyClient>,
  unmodeled: Set<StickyRecord>,
): { scroll: number; viewportHeight: number; documentHeight: number } => {
  const scroll = window.scrollY;
  // The scrollport a sticky percentage resolves against: no scrollbar in it, unlike innerHeight.
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const transformMemo = new Map<Element, boolean>();
  const documentHeight = measureDocumentHeight();

  all.forEach((record) => {
    const { el } = record;
    const rect = el.getBoundingClientRect();
    const computed = getComputedStyle(el);
    const parent = el.parentElement;
    let containerBottom = rect.bottom + scroll;

    if (parent) {
      const parentStyle = getComputedStyle(parent);

      containerBottom = parent.getBoundingClientRect().bottom + scroll
        - parseFloat(parentStyle.borderBottomWidth) - parseFloat(parentStyle.paddingBottom);

      // The containing block is then further up, and the parent's box says nothing about it.
      if (parentStyle.display === 'contents' || parentStyle.display === 'inline') {
        unmodeled.add(record);
      }
    }

    record.naturalTop = rect.top + scroll;
    record.travel = Math.max(
      0,
      containerBottom - (record.naturalTop + rect.height + parseFloat(computed.marginBottom)),
    );
    record.overflowBottom = record.naturalTop + el.clientTop + el.scrollHeight;

    // A static write that didn't take (an author !important) leaves nothing measured here, and
    // a transform moves the box the rect reports.
    if (computed.position !== 'static' || hasTransform(el, transformMemo)) unmodeled.add(record);

    // Only a top-sticky element is modeled: left/right move a demoted one sideways, and bottom
    // holds it at the other edge. An author element carries its own top, read while static.
    if (computed.bottom !== 'auto' || computed.left !== 'auto' || computed.right !== 'auto') {
      unmodeled.add(record);
    }

    // An author's top: ... !important on an owned element overrides the library's inline top, and
    // would override a demoted top just the same. The library's top is always px; a static
    // element's computed top keeps any other unit as written.
    if (owned.has(el) && (!computed.top.endsWith('px')
      || Math.abs(parseFloat(computed.top) - parseFloat(el.style.top)) > 0.01)) {
      unmodeled.add(record);
    }

    if (!owned.has(el) && computed.top === 'auto') {
      // Sticky with no inset at all never sticks: no travel leaves it an empty range, so it holds
      // nothing below it still.
      record.stickyTop = 0;
      record.travel = 0;
    } else if (!owned.has(el)) {
      const unit = SIMPLE_TOP.exec(computed.top)?.[1];

      if (!unit) unmodeled.add(record);
      else if (unit === '%') record.stickyTop = (parseFloat(computed.top) * viewportHeight) / 100;
      else record.stickyTop = parseFloat(computed.top);
    }
  });

  return { scroll, viewportHeight, documentHeight };
};

// Nothing on the page uses the table any more: empty it and leave GSAP alone.
const teardown = (): void => {
  clearTable();
  endGsapRefresh();
  dropGsapClassesLater();
};

// Rebuilds the table after a refresh() and applies the state for the current scroll. No layout is
// read while every record is sticky: that read is the cost being avoided.
export const rebuildDormancy = (scrollTriggerClass: ScrollTriggerClassLike | null): void => {
  const live = liveClients();

  // A page with no instance using this leaves GSAP alone.
  if (!live.length) {
    teardown();

    return;
  }

  if (scrollTriggerClass) adoptGsapClass(scrollTriggerClass);

  // Only resets: the update below applies the state from the fresh table, where one now from the
  // old table would write its stale sticky values over the ones the refresh just wrote.
  if (!gsapRefreshing()) endGsapRefresh();

  // Pins only: nothing to switch, so no scan.
  if (!gsapClasses.size || bodyScrolls() || !live.some(({ demotable }) => demotable.length)) {
    clearTable();

    return;
  }

  const owned = new Map<HTMLElement, DormancyClient>();

  live.forEach(({ client, owned: elements }) => {
    elements.forEach((el) => owned.set(el, client));
  });

  const autoOnly = live.every(({ client }) => client.mode === 'auto');
  const demoted = new Set(records.filter((r) => r.state !== 'in').map((r) => r.el));

  if (autoOnly && ownedDepth(owned.keys(), demoted) < AUTO_MIN_DEPTH) {
    clearTable();

    return;
  }

  // Every window-scroll sticky element is a record: an author one is never demoted, but it holds
  // its descendants still all the same. One left demoted by an earlier build isn't computed-sticky
  // now, and keeps the library values it was captured with.
  const sticky = scanStickyElements(owned.keys());
  const stickySet = new Set(sticky);
  const leftover = records.filter((r) => r.state !== 'in' && !stickySet.has(r.el));

  // A detached one leaves the table whole, as clearTable has it.
  leftover.filter((r) => !r.el.isConnected).forEach((r) => promote(r));

  const kept = leftover.filter((r) => r.el.isConnected);
  const previous = new Map(records.map((r) => [r.el, r]));
  const fresh = sticky.map((el): StickyRecord => {
    const computed = getComputedStyle(el);
    // Demoted until the refresh that just wrote sticky back: the z-index/will-change on it are the
    // ones demotion wrote, and the element's own are the ones captured before.
    const before = previous.get(el);

    if (before && before.state !== 'in') {
      return {
        ...before,
        demotable: false,
        position: el.style.position,
        top: el.style.top,
        stickyTop: parseFloat(el.style.top) || 0,
        ancestors: [],
        state: 'before',
      };
    }

    return {
      el,
      demotable: false,
      position: el.style.position,
      top: el.style.top,
      zIndex: el.style.zIndex,
      willChange: el.style.willChange,
      zIndexAuto: computed.zIndex === 'auto',
      willChangeAuto: computed.willChange === 'auto',
      // An owned element's top is the library's own value: a computed read here would lay out
      // every record sticky.
      stickyTop: parseFloat(el.style.top) || 0,
      naturalTop: 0,
      travel: 0,
      ancestors: [],
      lo: 0,
      hi: 0,
      overflowBottom: 0,
      holdsAfter: false,
      state: 'in',
      demotedTop: '',
    };
  });
  const found = [...fresh, ...kept];

  found.sort((a, b) => compareDocumentOrder(a.el, b.el));
  found.forEach((record, index) => {
    record.ancestors = found.slice(0, index).filter((a) => a.el.contains(record.el));
  });

  // An author sticky element counts only around a library one (it holds that one still) or inside
  // one (a level on its chain). One beside them is left out, never written to, not even for the
  // static measurement. A record left demoted stays, to be given back.
  const holdsOwned = new Set<StickyRecord>();

  found.forEach((record) => {
    if (owned.has(record.el)) record.ancestors.forEach((a) => holdsOwned.add(a));
  });

  const all = found.filter((r) => owned.has(r.el) || holdsOwned.has(r) || r.state !== 'in'
    || r.ancestors.some((a) => owned.has(a.el)));
  const inTable = new Set(all);

  all.forEach((record) => {
    record.ancestors = record.ancestors.filter((a) => inTable.has(a));
  });

  // Each client by its own deepest element: a shallow instance elsewhere on the page gains nothing
  // from a deep one. Counted as in ownedDepth, except that an author sticky element added since
  // this task's scan only counts from the next task.
  const depths = new Map<DormancyClient, number>();

  all.forEach((record) => {
    const client = owned.get(record.el);

    if (client) {
      depths.set(client, Math.max(depths.get(client) ?? 0, record.ancestors.length + 1));
    }
  });

  const active = new Set(live.map(({ client }) => client).filter(
    (client) => client.mode === 'always' || (depths.get(client) ?? 0) >= AUTO_MIN_DEPTH,
  ));
  const wrappers = new Set(live.flatMap((entry) => entry.demotable));

  all.forEach((record) => {
    const client = owned.get(record.el);

    record.demotable = client !== undefined && active.has(client) && wrappers.has(record.el);
  });

  // Before clearTable below, so records an earlier build demoted go back too.
  records = all;

  if (!all.some((r) => r.demotable)) {
    clearTable();

    return;
  }

  // Static measurement: with every record that can move a library element static, the natural
  // layout is cheap to lay out. An author element only inside library ones moves none of them and
  // isn't touched; one around them gets its style attribute back exactly as it was.
  const toMeasure = all.filter((r) => owned.has(r.el) || holdsOwned.has(r) || r.state !== 'in');
  const authorStyle = new Map(toMeasure.filter((r) => !owned.has(r.el) && r.state === 'in')
    .map(({ el }) => [el, el.getAttribute('style')]));
  // Puts every record back, also when measuring throws. Writes only, so the state applied below
  // re-demotes without a layout in between.
  const restorePositions = () => toMeasure.forEach((record) => {
    if (!authorStyle.has(record.el)) {
      promote(record, true);

      return;
    }

    const saved = authorStyle.get(record.el);

    if (saved === null || saved === undefined) record.el.removeAttribute('style');
    else record.el.setAttribute('style', saved);
  });

  toMeasure.forEach(({ el }) => {
    el.style.position = 'static';
  });

  const unmodeled = new Set<StickyRecord>();
  let measured: ReturnType<typeof measureStatic>;

  try {
    measured = measureStatic(toMeasure, owned, unmodeled);
  } finally {
    restorePositions();
  }

  const { scroll, viewportHeight, documentHeight } = measured;
  const maxScroll = Math.max(0, documentHeight - viewportHeight);

  all.forEach((record) => {
    const union = mergeIntervals(record.ancestors.map((a) => [a.lo, a.hi]));
    const reach = record.naturalTop - record.stickyTop;

    record.lo = invertStuckUnion(union, reach, true);
    record.hi = invertStuckUnion(union, reach + record.travel, false);

    if (unmodeled.has(record) || record.ancestors.some((a) => unmodeled.has(a))) {
      record.demotable = false;
    }

    // Relative offsets add up down a chain: every ancestor that can sit 'after' as well moves the
    // overflow further.
    const carried = record.ancestors
      .filter((a) => a.demotable && !a.holdsAfter)
      .reduce((sum, a) => sum + a.travel, 0);

    record.holdsAfter = record.overflowBottom + record.travel + carried > documentHeight + 1;
  });

  buffer = chooseBuffer(viewportHeight, maxScroll);

  // GSAP's own refresh scrolls to 0 and measures every trigger in this same task, so a build before
  // it measures gets the state for 0. The refreshInit listener (or takeGsapRefreshRestore) starts
  // that phase; isRefreshing alone also stays set after GSAP has measured, and after a GSAP refresh
  // that threw. Once restored, the state is for the scroll GSAP goes back to: a build from a
  // render(-1) runs before GSAP has scrolled back.
  const returnTo = gsapPhase === 'restored' ? scrollBeforeGsapRefresh : null;

  update(gsapPhase === 'measuring' ? 0 : returnTo ?? scroll);
  listen(true);
};

// For a GSAP refresh that began before the table listened to it: starts the scroll-0 phase the
// listener missed and returns the restore, for the instance's own refreshInit result. Only that
// handler calls this, so a refresh() from onRefresh (isRefreshing still set) never starts a phase
// no render(-1) would end. Null when the listener covers it.
export const takeGsapRefreshRestore = (): (() => void) | null => {
  if (!adoptedMidRefresh || !gsapRefreshing()) return null;

  onGsapRefreshInit();

  return restoreAfterGsapMeasure;
};

// Moves the scroll GSAP's refresh in progress goes back to, for one whose record was moved after
// the table took the scroll.
export const setGsapRefreshReturn = (scroll: number): void => {
  if (gsapPhase !== 'idle') scrollBeforeGsapRefresh = scroll;
};

// Promotes every demoted element and empties the table, for a refresh() that couldn't rebuild it.
export const clearDormancy = clearTable;

// For a measurement that scrolls to 0 as GSAP's refresh does: what sits past its freeze goes to
// where it sits there, and nothing goes sticky.
export const dormancyAtScrollZero = (): void => {
  records.forEach((record) => {
    if (record.state === 'after') applyState(record, 'before');
  });
};

// What the table has moved down past its freeze: off its place at scroll 0, where it sits at the
// top of its travel.
export const movedPastFreeze = (): ReadonlySet<HTMLElement> =>
  new Set(records.filter((record) => record.state === 'after' && record.travel > 0)
    .map((record) => record.el));

// The state for `scroll` once that measurement scrolls back, or for 0 while GSAP measures.
export const dormancyAfterScrollZero = (scroll: number): void => {
  if (!records.length) return;

  update(gsapPhase === 'measuring' ? 0 : scroll);
};

// Promotes the given elements for good and drops them from the table, before something else puts
// back its own values (a removed Scene level made inert).
export const releaseDormant = (elements: readonly HTMLElement[]): void => {
  const released = new Set(elements);

  records = records.filter((record) => {
    if (!released.has(record.el)) return true;

    promote(record);

    return false;
  });
};

export const registerDormancyClient = (client: DormancyClient): void => {
  clients.add(new WeakRef(client));
};

let rebuildQueued = false;

// Rebuilds once at the end of the task for the instances left after one is torn down: its wrappers
// were ancestors in their ranges. Once per task, however many instances go.
const queueRebuild = (): void => {
  if (rebuildQueued) return;

  rebuildQueued = true;
  queueMicrotask(() => {
    rebuildQueued = false;
    rebuildSafely();
  });
};

export const unregisterDormancyClient = (client: DormancyClient | null): void => {
  clients.forEach((ref) => {
    if (ref.deref() !== client) return;

    clients.delete(ref);
    releaseDormant(client.ownedElements());
  });

  if (liveClients().length) queueRebuild();
  else teardown();
};
