/**
 * DOM helpers for building the nested sticky structure and measuring positions.
 */

export const resolveRoot = (root: string | HTMLElement): HTMLElement => {
  const el = typeof root === 'string' ? document.querySelector<HTMLElement>(root) : root;

  if (!el) {
    const description = typeof root === 'string' ? `"${root}"` : String(root);

    throw new Error(`StickyScrollTrigger: root ${description} not found`);
  }

  return el;
};

// Resolves a trigger/endTrigger/cover option given as either an element or a CSS selector
// string (GSAP ScrollTrigger's trigger/endTrigger accept both forms). The selector is resolved
// against the whole document, not scoped to the shared container.
export const resolveElement = (value: string | HTMLElement, context: string): HTMLElement => {
  const el = typeof value === 'string' ? document.querySelector<HTMLElement>(value) : value;

  if (!el) {
    const description = typeof value === 'string' ? `"${value}"` : String(value);

    throw new Error(`${context}: element ${description} not found`);
  }

  return el;
};

// Resolves an optional endTrigger option, defaulting to trigger itself when omitted. Every
// registration method shares this default.
export const resolveEndTrigger = (
  trigger: HTMLElement,
  endTriggerInput: string | HTMLElement | undefined,
  context: string,
): HTMLElement =>
  (endTriggerInput === undefined ? trigger : resolveElement(endTriggerInput, context));

// Formats an element as a human-readable tag+id+class string for error messages.
export const describeElement = (el: HTMLElement): string => {
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList.length > 0 ? `.${Array.from(el.classList).join('.')}` : '';

  return `<${el.tagName.toLowerCase()}${id}${cls}>`;
};

// Computes an element's absolute top position in the document via the offsetParent chain
// (unlike getBoundingClientRect, this is unaffected by sticky pinning or transforms).
// offsetTop excludes the offsetParent's top border width, so clientTop is added back at each step.
export const documentTop = (el: HTMLElement): number => {
  let top = 0;
  let node: HTMLElement | null = el;

  while (node) {
    top += node.offsetTop;

    const parent = node.offsetParent as HTMLElement | null;

    if (parent) top += parent.clientTop;

    node = parent;
  }

  return top;
};

// Measures a viewport height that stays stable as a mobile browser's address bar shows and hides,
// which window.innerHeight doesn't. This appends a temporary height:100vh div and reads its
// offsetHeight instead, the same technique GSAP uses in _refresh100vh. Environments where
// offsetHeight is always 0 (jsdom) fall back to window.innerHeight.
export const measureViewportHeight = (): number => {
  const probe = document.createElement('div');

  probe.style.height = '100vh';
  probe.style.position = 'absolute';
  document.body.appendChild(probe);

  const height = probe.offsetHeight || window.innerHeight;

  probe.remove();

  return height;
};

export const measureDocumentHeight = (): number =>
  document.documentElement.scrollHeight || document.body.scrollHeight;

// Every pin range on the page, whichever instance wrapped it. Module-level because another
// instance's range, sized for a longer page, sticks out past the end until that instance
// refreshes, and would otherwise be measured as page.
const pinRanges = new Set<HTMLElement>();

// The page's height with every pin range cleared, so none of them counts toward it. Clearing a
// range moves nothing else: its outer keeps the reserved height.
export const measureDocumentHeightWithoutPinRanges = (): number => {
  // A range taken off the page without an unwrap (its subtree removed, say) adds nothing to the
  // height, and leaving it here would keep it alive.
  pinRanges.forEach((inner) => {
    if (!inner.isConnected) pinRanges.delete(inner);
  });

  const saved = [...pinRanges].map((inner) => ({ inner, height: inner.style.height }));

  saved.forEach(({ inner }) => {
    inner.style.height = '';
  });

  const height = measureDocumentHeight();

  saved.forEach(({ inner, height: range }) => {
    inner.style.height = range;
  });

  return height;
};

// Matches GSAP's own scrollerMax for the window scroller (see _maxScroll in GSAP's
// ScrollTrigger source): total document height minus the viewport height, floored at 0.
export const measureDocumentMaxScroll = (viewportHeight: number): number =>
  Math.max(0, measureDocumentHeight() - viewportHeight);

// A side's border width, zero unless that side has a border-style. Browsers already compute it
// that way; jsdom reports the initial 'medium' regardless, which is what the check is here for.
const measureBorderWidth = (borderStyle: string, width: string): number => (
  borderStyle === 'none' || borderStyle === 'hidden' ? 0 : parseFloat(width)
);

// The height (or width) an element is currently using, at full precision, where offsetHeight
// rounds to whole pixels. Reading it off the computed style keeps a transform out of the number,
// unlike getBoundingClientRect: a scaled element still occupies its untransformed height in the
// flow, the layout-not-paint measurement documentTop and offsetHeight both take.
// That computed height follows box-sizing, so a content-box element's padding and borders are
// added back to reach the border box; all of them arrive resolved to px, percentages included. An
// element with no used height at all (an inline box, a display:none subtree, outside the document)
// reports 'auto' or nothing, and the fallback is offsetHeight.
// offsetHeight also takes precedence on any disagreement of a pixel or more, which happens only
// when the arithmetic can't model the box: WebKit takes a space-taking scrollbar out of the height
// it reports (Safari's "always show scrollbars"), leaving the sum a whole scrollbar short. Where
// offsetHeight is 0 the comparison is skipped, since jsdom reports 0 for everything and would
// otherwise reject every measurement here.
const measureUsedSize = (el: HTMLElement, axis: 'height' | 'width'): number => {
  const rounded = axis === 'height' ? el.offsetHeight : el.offsetWidth;
  const style = getComputedStyle(el);
  const size = parseFloat(style[axis]);

  if (!Number.isFinite(size)) return rounded;

  const [start, end] = axis === 'height' ? (['Top', 'Bottom'] as const) : (['Left', 'Right'] as const);
  const measured = style.boxSizing === 'border-box'
    ? size
    : size
      + parseFloat(style[`padding${start}`])
      + parseFloat(style[`padding${end}`])
      + measureBorderWidth(style[`border${start}Style`], style[`border${start}Width`])
      + measureBorderWidth(style[`border${end}Style`], style[`border${end}Width`]);

  return rounded > 0 && Math.abs(measured - rounded) >= 1 ? rounded : measured;
};

export const measureUsedHeight = (el: HTMLElement): number => measureUsedSize(el, 'height');

const measureUsedWidth = (el: HTMLElement): number => measureUsedSize(el, 'width');
const marginBoxHeight = (el: HTMLElement, style: CSSStyleDeclaration) =>
  measureUsedHeight(el) + parseFloat(style.marginTop) + parseFloat(style.marginBottom);

export const compareDocumentOrder = (a: HTMLElement, b: HTMLElement): number => {
  const position = a.compareDocumentPosition(b);

  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;

  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;

  return 0;
};

// The unstuck state a read needs: in flow, unshifted, and still a containing block for absolute
// children, all !important so no stylesheet rule shifts it. bottom too, though a pin's trigger is
// the page's: a relative box takes a sheet's bottom as it does top.
const resetStickyPosition = (el: HTMLElement): void => {
  el.style.setProperty('position', 'relative', 'important');
  el.style.setProperty('top', 'auto', 'important');
  el.style.setProperty('bottom', 'auto', 'important');
};

// An element's inline value for one property, with its priority so an !important one goes back as
// one.
export interface InlineValue {
  value: string;
  priority: string;
}

export const captureInline = (el: HTMLElement, property: string): InlineValue => ({
  value: el.style.getPropertyValue(property),
  priority: el.style.getPropertyPriority(property),
});

export const restoreInline = (el: HTMLElement, property: string, saved: InlineValue): void => {
  el.style.setProperty(property, saved.value, saved.priority);
};

// An element's inline position/top/bottom, captured to put back after a clear or overwrite.
export interface InlinePosition {
  position: InlineValue;
  top: InlineValue;
  bottom: InlineValue;
}

export const captureInlinePosition = (el: HTMLElement): InlinePosition => ({
  position: captureInline(el, 'position'),
  top: captureInline(el, 'top'),
  bottom: captureInline(el, 'bottom'),
});

// bottom goes back only while it holds the reset's value, so one set since (gsap.set, say) stays.
export const restoreInlinePosition = (el: HTMLElement, saved: InlinePosition): void => {
  restoreInline(el, 'position', saved.position);
  restoreInline(el, 'top', saved.top);
  restoreIfWritten(el, 'bottom', saved.bottom, 'auto', 'important');
};

// Returns the value as the browser keeps it, for restoreIfWritten to compare.
export const writeInline = (
  el: HTMLElement,
  property: string,
  value: string,
  priority = '',
): string => {
  el.style.setProperty(property, value, priority);

  return el.style.getPropertyValue(property);
};

// Puts saved back while property still holds the writeInline result made with `priority`, and says
// whether it did. A value or priority set since (gsap.set, say) is the author's and stays.
export const restoreIfWritten = (
  el: HTMLElement,
  property: string,
  saved: InlineValue,
  written: string,
  priority = '',
): boolean => {
  const { style } = el;

  if (style.getPropertyValue(property) !== written
    || style.getPropertyPriority(property) !== priority) {
    return false;
  }

  restoreInline(el, property, saved);

  return true;
};

// Puts every element in its unstuck state and returns a function that restores it.
export const stripStickyPositions = (elements: readonly HTMLElement[]): (() => void) => {
  const saved = elements.map(captureInlinePosition);

  elements.forEach(resetStickyPosition);

  return () => elements.forEach((el, i) => restoreInlinePosition(el, saved[i]));
};

// Reads, then restores what was set up for the read (a reset's return), on a throw too.
export const readThenRestore = <T>(restore: () => void, read: () => T): T => {
  try {
    return read();
  } finally {
    restore();
  }
};

// An element the structure adds, with transition: none !important so a broad page rule (* or
// .section div, !important or not) can't animate what the library writes: a wrapper's top would
// slide on each demotion instead of landing where the table computed it.
const createStructureElement = (): HTMLDivElement => {
  const el = document.createElement('div');

  el.style.setProperty('transition', 'none', 'important');

  return el;
};

// An empty block whatever a page rule sets on divs (.section div { display: flex }, say): every
// property that sizes or places an empty box or stops margins collapsing through it is set, then
// the given styles. A list, since all: initial made refresh() about three times slower in WebKit.
const createEmptyBlock = (styles: Record<string, string> = {}): HTMLDivElement => {
  const el = createStructureElement();

  Object.entries({
    'display': 'block', 'writing-mode': 'inherit', 'float': 'none', 'clear': 'none',
    'position': 'static', 'order': '0', 'grid-area': 'auto', 'flex': 'none', 'overflow': 'visible',
    'contain': 'none', 'content-visibility': 'visible', 'container-type': 'normal',
    'columns': 'auto', 'transform': 'none', 'translate': 'none', 'scale': 'none', 'rotate': 'none',
    'zoom': '1', 'animation': 'none', 'box-sizing': 'content-box', 'height': '0', 'min-height': '0',
    'max-height': 'none', 'padding': '0', 'border': '0', 'margin': '0', ...styles,
  }).forEach(([property, value]) => el.style.setProperty(property, value, 'important'));

  return el;
};

// Far beyond any page's margin, so a margin of it collapses with any other to itself.
const SPACER_PROBE_PX = 1e6;
// How far what follows a spacer may move off the spacer's height and still count as exact.
const SPACER_SHIFT_TOLERANCE_PX = 0.5;

// How a spacer goes after its element. 'block' (block flow): the margins escaping the element's
// bottom edge, positive and negative part, are cancelled before the spacer and emitted again after
// it, so they still collapse with what follows. 'stack' (a flex column or one-column grid): the
// spacer takes the row gap back, so the element and what follows stay one gap apart. 'plain': a
// bare block, which stops the margins collapsing and adds a gap.
// margins: the top and bottom margin of the block carrying them, the one after the spacer for
// 'block', the spacer (minus the gap, 0) for 'stack'. height: the one the plan was checked at.
type SpacerPlan = { kind: 'block' | 'stack' | 'plain'; margins: [number, number]; height: number };

// Plans by element, for the evaluations of one refresh() to share.
export type SpacerPlans = Map<HTMLElement, SpacerPlan>;

const plainPlan = (height: number): SpacerPlan => ({ kind: 'plain', margins: [0, 0], height });

// A 'block' plan's margins are read afterwards (readEscapingMargins).
const planSpacer = (el: HTMLElement, height: number): SpacerPlan => {
  const style = getComputedStyle(el);
  const parent = layoutContainer(el);
  const parentStyle = parent && getComputedStyle(parent);

  if (!parentStyle || !el.offsetHeight || style.position === 'absolute' || style.position === 'fixed'
    || FLOATS.includes(style.cssFloat) || style.display.startsWith('inline')) {
    return plainPlan(height);
  }

  const flex = parentStyle.display.includes('flex');

  if (!flex && !parentStyle.display.includes('grid')) return { kind: 'block', margins: [0, 0], height };

  const oneColumn = flex
    ? parentStyle.flexDirection.startsWith('column') && parentStyle.flexWrap === 'nowrap'
    // Line names ([full-start], say) aren't tracks.
    : parentStyle.gridTemplateColumns.replace(/\[[^\]]*\]/g, '').trim().split(/\s+/).length === 1;

  // 'normal' is 0. A % gap reads as its number, and the check below sends it plain.
  return oneColumn
    ? { kind: 'stack', margins: [-(parseFloat(parentStyle.rowGap) || 0), 0], height }
    : plainPlan(height);
};

// The positive and negative part of the margins escaping each element's bottom edge: a probe
// right after it with its top margin at 0, -SPACER_PROBE_PX and +SPACER_PROBE_PX, each giving
// the collapsed margin as the distance to a 1px marker after it. The marker's bottom margin
// takes the probe's back, so what follows moves by the margins the pair splits, never by
// SPACER_PROBE_PX. Distances, not positions, so a transform or relative offset on the element
// cancels out. An element inside another is read first, with nothing of the outer one's in place.
const readEscapingMargins = (elements: readonly HTMLElement[], plans: SpacerPlans) => {
  let left = [...elements];

  while (left.length) {
    const batch = left.filter((el) => !left.some((other) => other !== el && el.contains(other)));
    const probes = batch.map((el) => {
      const probe = createEmptyBlock();
      const marker = createEmptyBlock({ height: '1px' });

      el.after(probe, marker);

      return { el, probe, marker };
    });

    const read = (margin: number) => {
      probes.forEach(({ probe, marker }) => {
        probe.style.setProperty('margin-top', `${margin}px`, 'important');
        marker.style.setProperty('margin-bottom', `${-margin}px`, 'important');
      });

      return probes.map(({ el, marker }) =>
        marker.getBoundingClientRect().top - el.getBoundingClientRect().bottom);
    };

    const collapsed = read(0);
    const withNegative = read(-SPACER_PROBE_PX);
    const withPositive = read(SPACER_PROBE_PX);

    probes.forEach(({ el, probe, marker }, i) => {
      probe.remove();
      marker.remove();
      plans.get(el)!.margins = [
        collapsed[i] - withPositive[i] + SPACER_PROBE_PX,
        collapsed[i] - withNegative[i] - SPACER_PROBE_PX,
      ];
    });
    left = left.filter((el) => !batch.includes(el));
  }
};

const buildSpacer = (height: number, { kind, margins: [top, bottom] }: SpacerPlan) => {
  const spacer = createEmptyBlock({ height: `${height}px` });

  if (kind === 'stack') spacer.style.setProperty('margin-top', `${top}px`, 'important');

  // With no margin escaping, a block plan's spacer alone lays out the same.
  if (kind !== 'block' || (!top && !bottom)) return [spacer];

  return [
    createEmptyBlock({
      'margin-top': `${SPACER_PROBE_PX}px`, 'margin-bottom': `${-SPACER_PROBE_PX}px`,
    }),
    spacer,
    createEmptyBlock({ 'margin-top': `${top}px`, 'margin-bottom': `${bottom}px` }),
  ];
};

// What comes after el, at each level up to the body's children, starting below el's top: what
// sits beside el or an ancestor (a sidebar in a flex row, say) is left out, as is anything out of
// flow, boxless or sticky (a stuck one stays where it is).
const followingInFlow = (el: HTMLElement): Element[] => {
  const found: Element[] = [];
  const top = el.getBoundingClientRect().top;

  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.getClientRects().length && next.getBoundingClientRect().top > top
        && !['absolute', 'fixed', 'sticky'].includes(getComputedStyle(next).position)) found.push(next);
    }
  }

  return found;
};

const placeSpacers = (spacers: readonly { after: HTMLElement; height: number }[],
  plans: SpacerPlans) => spacers.flatMap(({ after, height }) => {
  const elements = buildSpacer(height, plans.get(after)!);

  after.after(...elements);

  return elements;
});

// Whether these spacers, in place together, move everything after each by exactly the heights of
// those before it.
const movesFollowingExactly = (spacers: readonly { after: HTMLElement; height: number }[],
  plans: SpacerPlans) => {
  const following = [...new Set(spacers.flatMap(({ after }) => followingInFlow(after)))];
  const before = following.map((el) => el.getBoundingClientRect().top);
  const inserted = placeSpacers(spacers, plans);
  const exact = following.length > 0 && following.every((el, i) => {
    const expected = spacers.reduce((sum, { after, height }) => sum
      + (after.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
        && !after.contains(el)
        ? height
        : 0), 0);

    return Math.abs(el.getBoundingClientRect().top - before[i] - expected)
      <= SPACER_SHIFT_TOLERANCE_PX;
  });

  inserted.forEach((el) => el.remove());

  return exact;
};

// Puts a block of each height right after its element, shaped so that what follows sits where the
// dwell would put it (see SpacerPlan), and returns a function that takes them out. A plan stays
// only where it moves everything after its element by exactly the height (this call's plans
// together or, failing that, each alone); one that doesn't (a grid row's minimum height, free space
// a flex column spreads, a clearing element, ...) goes plain.
export const insertSpacers = (
  spacers: readonly { after: HTMLElement; height: number }[],
  plans: SpacerPlans = new Map(),
): (() => void) => {
  // Planned again at another height: whether a plan moves what follows exactly can depend on it.
  const fresh = spacers.filter(({ after, height }) => plans.get(after)?.height !== height);

  fresh.forEach(({ after, height }) => plans.set(after, planSpacer(after, height)));
  readEscapingMargins(fresh.map(({ after }) => after)
    .filter((after) => plans.get(after)!.kind === 'block'), plans);

  const shaped = fresh.filter(({ after }) => plans.get(after)!.kind !== 'plain');

  if (shaped.length && !movesFollowingExactly(shaped, plans)) {
    shaped.forEach(({ after, height }) => {
      if (!movesFollowingExactly([{ after, height }], plans)) plans.set(after, plainPlan(height));
    });
  }

  const inserted = placeSpacers(spacers, plans);

  return () => inserted.forEach((el) => el.remove());
};

type MoveTarget = Node & { moveBefore?: (node: Node, child: Node | null) => void };

let movesUnderWay = 0;

// Whether a move below is under way. The browser can run page code inside one (see #runRefresh in
// index.ts).
export const isMovingDom = (): boolean => movesUnderWay > 0;

// moveBefore(), where the browser has it, keeps an iframe inside loaded and focus in place. It
// needs both ends in the document; anything else it refuses goes to insertBefore(), which moves
// the node or throws.
export const moveInto = (parent: Node, node: Node, before: Node | null = null): void => {
  const target = parent as MoveTarget;

  movesUnderWay += 1;

  try {
    if (target.moveBefore && parent.isConnected && node.isConnected) {
      try {
        target.moveBefore(node, before);

        return;
      } catch {
        // Falls through to the plain insert.
      }
    }

    parent.insertBefore(node, before);
  } finally {
    movesUnderWay -= 1;
  }
};

// Every instance's pin and Scene nodes, which registration reads through so that registration
// order doesn't change a cover. An instance passes its own cover wrappers in `own`: to the others,
// a cover wrapper is part of the page until its owner takes it down.
const transparentNodes = new WeakSet<Element>();
const isTransparent = (el: Element, own: ReadonlySet<Element>): boolean =>
  transparentNodes.has(el) || own.has(el);

export const logicalParent = (el: Element, own: ReadonlySet<Element>): Element | null => {
  let parent = el.parentElement;

  while (parent && isTransparent(parent, own)) parent = parent.parentElement;

  return parent;
};

const firstLogicalAt = (el: Element, own: ReadonlySet<Element>): Element | null => {
  if (!isTransparent(el, own)) return el;

  for (const child of Array.from(el.children)) {
    const found = firstLogicalAt(child, own);

    if (found) return found;
  }

  return null;
};

export const logicalNextSibling = (el: Element, own: ReadonlySet<Element>): Element | null => {
  for (let node = el; ;) {
    for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      const found = firstLogicalAt(sibling, own);

      if (found) return found;
    }

    const parent = node.parentElement;

    if (!parent || !isTransparent(parent, own)) return null;

    node = parent;
  }
};

// The outermost pin or Scene node around el, which holds el's place among its physical siblings.
export const physicalHolder = (el: HTMLElement): HTMLElement => {
  let node = el;

  while (node.parentElement && transparentNodes.has(node.parentElement)) node = node.parentElement;

  return node;
};

// Every Scene sentinel, which sceneSentinel finds from the shared container it follows.
const sentinels = new WeakSet<Element>();

export const sceneSentinel = (root: HTMLElement): HTMLElement | null => {
  const next = root.nextElementSibling;

  return next instanceof HTMLElement && sentinels.has(next) ? next : null;
};

// Scene layer: wraps inner in one level of stickyContainer{ stickyWrapper, stickyPadding }
// and moves it inside the wrapper. A bottom margin ending inner, its own or its content's,
// collapses out of the wrapper; refresh() carries it past the dwell (commitCarriedMargin), or,
// where it can't get out, holds it in with the sentinel the innermost wrapper gets after inner
// (commitHeldMargin), which lays out nothing until then.
export const wrapScene = (inner: HTMLElement, withSentinel: boolean) => {
  if (!inner.parentNode) {
    throw new Error(`StickyScrollTrigger: ${describeElement(inner)} is not attached to the document`);
  }

  const container = createStructureElement();
  const wrapper = createStructureElement();
  const padding = createStructureElement();

  [container, wrapper, padding].forEach((node) => transparentNodes.add(node));
  padding.setAttribute('aria-hidden', 'true');
  padding.style.pointerEvents = 'none';
  inner.parentNode.insertBefore(container, inner);
  container.appendChild(wrapper);
  moveInto(wrapper, inner);
  container.appendChild(padding);

  if (withSentinel) {
    const sentinel = createStructureElement();

    sentinel.style.display = 'none';
    transparentNodes.add(sentinel);
    sentinels.add(sentinel);
    wrapper.appendChild(sentinel);
  }

  return { container, wrapper, padding };
};

// Cover layer: moves everything from the start through trigger into a sticky wrapper. Another
// instance's pin or Scene wrappers around trigger go in whole, as if built after this one.
export const wrapCover = (trigger: HTMLElement): HTMLDivElement => {
  const holder = physicalHolder(trigger);
  const parent = holder.parentNode;

  if (!parent) {
    throw new Error(
      `createOverlapScroll: trigger ${describeElement(trigger)} is not attached to the document`,
    );
  }

  const wrapper = createStructureElement();

  parent.insertBefore(wrapper, parent.firstChild);

  while (wrapper.nextSibling) {
    const node = wrapper.nextSibling;

    moveInto(wrapper, node);

    if (node === holder) break;
  }

  return wrapper;
};

export const unwrapCover = (wrapper: HTMLDivElement) => {
  const parent = wrapper.parentNode;

  if (!parent) return;

  while (wrapper.firstChild) moveInto(parent, wrapper.firstChild, wrapper);

  wrapper.remove();
};

// Pin layer: wraps trigger in two levels, outer{ inner{ trigger } }. inner holds the pin range,
// which runs far past trigger's own height; outer's own height is left to #reservePinSpace, which
// rewrites it on every refresh. In block flow outer is a plain block, so trigger's margins and
// floats meet the page's as they would unwrapped (fitPinBoxes carries the bottom margin past
// the height outer holds). Its display is written all the same, so a page rule that matches it in
// trigger's place (.col > div, say) can't make it a flex container.
export const wrapPin = (trigger: HTMLElement) => {
  if (!trigger.parentNode) {
    throw new Error(
      `createStickyPin: trigger ${describeElement(trigger)} is not attached to the document`,
    );
  }

  const outer = createStructureElement();
  const inner = createStructureElement();

  setOuterLayout(outer, null);
  transparentNodes.add(outer);
  transparentNodes.add(inner);
  trigger.parentNode.insertBefore(outer, trigger);
  outer.appendChild(inner);
  moveInto(inner, trigger);
  pinRanges.add(inner);

  return { outer, inner };
};

// Where trigger sits among its siblings, which outer takes over with trigger's place. GSAP's
// pin-spacer copies most of these (_propNamesToCopy, where placeSelf and gridArea stand for the
// longhands) but not flexGrow or clear, without which a grown flex item or a cleared float moves.
// The offsets, margins and z-index it also copies stay on trigger. The flex longhands are what
// outer goes by until a refresh() can measure trigger (one in a hidden tab, say), flex: 0 0 auto
// after.
const PIN_ITEM_PROPERTIES = [
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'justifySelf',
  'order',
  'gridColumnStart',
  'gridColumnEnd',
  'gridRowStart',
  'gridRowEnd',
  'cssFloat',
  'clear',
  'verticalAlign',
] as const;

// The box outer is laid out in: its parent, or past a display: contents parent, the nearest
// ancestor that has a box.
const layoutContainer = (outer: HTMLElement): HTMLElement | null => {
  let parent = outer.parentElement;

  while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;

  return parent;
};

const FLOATS = ['left', 'right', 'inline-start', 'inline-end'];

type ItemLayout = 'flex' | 'grid' | 'float' | 'inline';

const hasOwnBox = (style: CSSStyleDeclaration) =>
  style.display !== 'none' && style.display !== 'contents';
const isBlockLevel = (style: CSSStyleDeclaration) =>
  hasOwnBox(style) && !style.display.startsWith('inline');

// How trigger is laid out where outer stands: as a flex or grid item, a float, an inline-level box
// in a line (inline-block, say), or (null) in block flow, or with no box of its own at all.
const itemLayout = (outer: HTMLElement, style: CSSStyleDeclaration): ItemLayout | null => {
  if (!hasOwnBox(style)) return null;

  const container = layoutContainer(outer);
  const display = container ? getComputedStyle(container).display : '';

  if (display.includes('flex')) return 'flex';

  if (display.includes('grid')) return 'grid';

  if (FLOATS.includes(style.cssFloat)) return 'float';

  // An atomic box only (inline-block, inline-flex...): a plain inline one is a run of text that can
  // wrap over lines, with no box of its own to hold.
  return style.display.startsWith('inline-') ? 'inline' : null;
};

// outer's own display: a box in a line where trigger was one, a formatting context holding
// trigger's margin box where it's an item, a plain block in block flow.
const outerDisplay = (layout: ItemLayout | null) =>
  (layout === 'inline' ? 'inline-block' : layout ? 'flow-root' : 'block');

// outer's display, with box-sizing: border-box in block flow, where the height it holds is the
// border box measured, a page rule's padding included. An item's outer keeps the page's
// box-sizing, so under content-box it holds trigger's margin box with such padding around it.
const setOuterLayout = (outer: HTMLElement, layout: ItemLayout | null) => {
  outer.style.display = outerDisplay(layout);
  outer.style.boxSizing = layout ? '' : 'border-box';
};

interface WrappedPin {
  outer: HTMLDivElement;
  inner: HTMLDivElement;
  trigger: HTMLElement;
}

// trigger's own box as the item, held on it in px as GSAP's _swapPinIn holds a pin's (max-width at
// the width, max-height and min-height at the height), so its percentages, a stretched height or a
// flexed width don't resolve again inside outer.
const TRIGGER_BOX = [
  'width',
  'max-width',
  'height',
  'max-height',
  'min-height',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
] as const;
// What a block-flow trigger holds: inside outer only its height resolves against something new
// (inner, which holds the pin range); width, padding and margins resolve as before.
const BLOCK_BOX = ['height', 'max-height', 'min-height'] as const;
// An inner height no pin range reaches, to see whether trigger's height follows inner's.
const PROBE_HEIGHT = '123456px';

type HeldProperties = typeof TRIGGER_BOX | typeof BLOCK_BOX;

// Each property's value in style, max-* and min-* taken at the size itself.
const readHeldBox = (style: CSSStyleDeclaration, properties: HeldProperties) =>
  properties.map((property) => style.getPropertyValue(property.replace(/^m(ax|in)-/, '')));
// Written !important: a page stylesheet's !important beats a plain inline value, but not an
// inline !important one.
const HELD_PRIORITY = 'important';

interface HeldBox {
  properties: HeldProperties;
  authored: InlineValue[];
  written: string[];
}

const heldBoxes = new WeakMap<HTMLElement, HeldBox>();

const holdTriggerBox = (
  trigger: HTMLElement,
  properties: HeldProperties,
  values: readonly string[],
) => {
  const authored = properties.map((property) => captureInline(trigger, property));

  heldBoxes.set(trigger, {
    properties,
    authored,
    written: properties.map((property, i) =>
      writeInline(trigger, property, values[i], HELD_PRIORITY)),
  });
};

// Puts trigger's own inline values back, each only while it still holds the value written: one set
// since (gsap.set, say) stays. Returns what was held, if anything.
const releaseTriggerBox = (trigger: HTMLElement): HeldBox | undefined => {
  const held = heldBoxes.get(trigger);

  if (!held) return undefined;

  held.properties.forEach((property, i) => {
    restoreIfWritten(trigger, property, held.authored[i], held.written[i], HELD_PRIORITY);
  });
  heldBoxes.delete(trigger);

  return held;
};

// Makes each pin's outer take trigger's place as the flex or grid item, float or inline-level box
// trigger was, or the block it was in block flow, and returns the height to reserve for each
// (undefined for a pin with nothing rendered, whose outer measures as it stands). Expects outer's
// and inner's heights cleared; if a read throws, outer is the caller's to restore.
//
// Sized by its content, outer would shrink a flex item, float or inline-block to trigger's text,
// reserve only a stretched item's content and break an inline-level trigger's line. So trigger's
// margin box is read as the item, with outer and inner set to display: contents (moving trigger
// out instead would reload an iframe inside it and drop focus without moveBefore()), and held on
// outer in px, as GSAP's pin-spacer holds it; a grid item's outer takes its width from its cell.
// trigger's own box is held on it too (TRIGGER_BOX).
//
// A block-flow pin is read in its own place the same way, for its height alone, and holds it only
// where it would resolve against inner (heightsFollowingInner): a pin sized by its content or the
// viewport keeps following them between refreshes. Its outer reserves its block height, and the
// bottom margin escaping trigger goes on outer (fitEscapingMargins).
//
// Nested pins are read and fitted first, innermost depth first, with their enclosing pins'
// wrappers out of the layout too. An enclosing pin is then read around them, with their margins
// already in place.
//
// At each depth all reads come before the writes, so a refresh costs a fixed number of style and
// layout passes per nesting depth.
export const fitPinBoxes = (pins: readonly WrappedPin[]): (number | undefined)[] => {
  // Released first, so trigger's box is read as its own rules make it.
  const held = pins.map(({ trigger }) => releaseTriggerBox(trigger));
  const enclosing = pins.map(({ trigger }) =>
    pins.filter((other) => other.trigger !== trigger && other.trigger.contains(trigger)));
  const reserved: (number | undefined)[] = pins.map(() => undefined);

  try {
    for (let depth = Math.max(0, ...enclosing.map(({ length }) => length)); depth >= 0; depth--) {
      const indexes = pins.flatMap((_, i) => (enclosing[i].length === depth ? [i] : []));
      const around = new Set(indexes.flatMap((i) => enclosing[i]));

      fitReleasedPins(indexes.map((i) => pins[i]), [...around]).forEach((height, j) => {
        reserved[indexes[j]] = height;
      });
    }

    return reserved;
  } catch (error) {
    // Held again as before, to match the outer the caller puts back.
    pins.forEach(({ trigger }, i) => {
      const box = held[i];

      releaseTriggerBox(trigger);

      if (box) holdTriggerBox(trigger, box.properties, box.written);
    });

    throw error;
  }
};

// A rendered pin with its index among the pins fitted and its layout where outer stands.
type MeasuredPin = WrappedPin & { index: number; layout: ItemLayout | null };

interface MeasuredBox {
  // An item's margin box, its width undefined where a grid cell gives outer one.
  item?: { width: number | undefined; height: number };
  box: string[];
  // A block-flow outer's own bottom margin, from a page rule (see takeCarriedMargins).
  ownMargin?: string;
}

// around: the pins enclosing these, taken out of the layout with them while they're read.
const fitReleasedPins = (
  pins: readonly WrappedPin[],
  around: readonly WrappedPin[],
): (number | undefined)[] => {
  // Live, so the reads below see the layout as it stands by then.
  const styles = pins.map(({ trigger }) => getComputedStyle(trigger));
  const layouts = pins.map(({ outer }, i) => itemLayout(outer, styles[i]));
  // A trigger with no box under a hidden ancestor (a hidden tab's), or off the document, has none
  // to hold yet, so outer goes by the properties alone until a refresh() can measure one.
  const rendered = pins.map(({ trigger }) => trigger.getClientRects().length > 0);
  // In block flow only a block-level trigger's clear moves outer (an inline one's, or one with no
  // box, applies to nothing); the rest go back to unset.
  const copied = styles.map((style, i) => PIN_ITEM_PROPERTIES.map((property) =>
    (layouts[i] || (property === 'clear' && isBlockLevel(style)) ? style[property] : '')));
  const measured = pins.flatMap((pin, index) =>
    (rendered[index] ? [{ ...pin, index, layout: layouts[index] }] : []));
  const aroundDisplays = around.map(({ outer, inner }) =>
    [outer.style.display, inner.style.display]);
  const restoreAround = () => around.forEach(({ outer, inner }, i) => {
    [outer.style.display, inner.style.display] = aroundDisplays[i];
  });

  pins.forEach(({ outer }, i) => {
    outer.style.width = '';
    PIN_ITEM_PROPERTIES.forEach((property, j) => {
      outer.style[property] = copied[i][j];
    });

    if (rendered[i]) outer.style.display = 'contents';
    else setOuterLayout(outer, layouts[i]);
  });
  [...measured, ...around].forEach(({ outer, inner }) => {
    outer.style.display = 'contents';
    inner.style.display = 'contents';
  });

  try {
    return fitInsideAround(measured, styles, pins);
  } finally {
    restoreAround();
  }
};

// The enclosing pins stay out of the layout through the reads, the probes and the margin read, so
// these pins are laid out at the width their enclosing triggers give them, not the one last
// refresh held on those outers.
const fitInsideAround = (
  measured: readonly MeasuredPin[],
  styles: readonly CSSStyleDeclaration[],
  pins: readonly WrappedPin[],
): (number | undefined)[] => {
  let boxes: MeasuredBox[];
  // Taken off for the reads below, so outer's own margin reads as the page's rules give it, in the
  // layout those reads flush anyway.
  const restoreCarried = takeCarriedMargins(measured.map(({ outer }) => outer));

  try {
    boxes = measured.map(({ outer, trigger, index, layout }) => {
      const style = styles[index];

      if (!layout) {
        const ownMargin = outerStyle(outer).marginBottom;

        return { box: readHeldBox(style, BLOCK_BOX), ownMargin };
      }

      return {
        item: {
          width: layout === 'grid'
            ? undefined
            : measureUsedWidth(trigger)
              + parseFloat(style.marginLeft)
              + parseFloat(style.marginRight),
          height: marginBoxHeight(trigger, style),
        },
        box: readHeldBox(style, TRIGGER_BOX),
      };
    });
  } finally {
    restoreCarried();
    measured.forEach(({ outer, inner, layout }) => {
      setOuterLayout(outer, layout);

      inner.style.display = '';
    });
  }

  return fitBlocksAndItems(measured, boxes, styles, pins);
};

const fitBlocksAndItems = (
  measured: readonly MeasuredPin[],
  boxes: readonly MeasuredBox[],
  styles: readonly CSSStyleDeclaration[],
  pins: readonly WrappedPin[],
): (number | undefined)[] => {
  const inPx = boxes.map(({ box }) => box.every((value) => value.endsWith('px')));
  const reserved: (number | undefined)[] = pins.map(() => undefined);
  // The block-flow pins, those with no item box. A display: contents trigger lays its content out
  // in outer's block, so its outer goes with them too, read as it stands.
  const measuredIndexes = new Set(measured.map(({ index }) => index));
  const blocks = [
    ...measured.flatMap((pin, i) =>
      (boxes[i].item ? [] : [{ ...pin, ownMargin: boxes[i].ownMargin ?? '' }])),
    ...pins.flatMap((pin, index) => (!measuredIndexes.has(index)
      && pin.outer.getClientRects().length > 0
      ? [{ ...pin, index, ownMargin: '' }]
      : [])),
  ];
  const inBlockFlow = new Set(blocks.map(({ index }) => index));
  // Each block-flow outer goes to the height it reserves before anything inside it changes, and
  // stays there: nothing after it moves under the probes and the margin read (a page resized under
  // a read had WebKit move its scroll, or stopped a smooth scroll), and an enclosing pin is read
  // around this one as the refresh leaves it.
  const heights = blocks.map(({ outer }) => measureUsedHeight(outer));
  // outer's bottom edge less inner's, read before outer is held: the height written back from its
  // computed style is rounded, which moves the edge.
  const gaps = blocks.map(({ outer, inner }) => bottomGap(outer, inner));

  blocks.forEach(({ outer }, j) => {
    outer.style.height = `${heights[j]}px`;
  });

  const dependent = heightsFollowingInner(measured, boxes, inPx, styles);

  // A box that didn't come out in px is left to outer's own measurement, and trigger to its own
  // rules.
  measured.forEach(({ outer, trigger, index, layout }, i) => {
    const { item, box } = boxes[i];

    if (!item) {
      if (inPx[i] && dependent.has(i)) holdTriggerBox(trigger, BLOCK_BOX, box);

      return;
    }

    const { width, height } = item;

    if (!Number.isFinite(height) || (width !== undefined && !Number.isFinite(width))) return;

    if (layout === 'flex') outer.style.flex = '0 0 auto';

    if (width !== undefined) outer.style.width = `${width}px`;

    reserved[index] = height;

    if (inPx[i]) holdTriggerBox(trigger, TRIGGER_BOX, box);
  });

  // A trigger held at a height that followed inner's was read at its auto one above: its outer is
  // measured again with it held, all cleared before any is read.
  const held = new Set([...dependent].map((i) => measured[i].index));
  const regrown = blocks.flatMap(({ index }, j) => (held.has(index) ? [j] : []));

  regrown.forEach((j) => {
    blocks[j].outer.style.height = '';
  });
  regrown.forEach((j) => {
    heights[j] = measureUsedHeight(blocks[j].outer);
    gaps[j] = bottomGap(blocks[j].outer, blocks[j].inner);
  });
  regrown.forEach((j) => {
    blocks[j].outer.style.height = `${heights[j]}px`;
  });
  // A pin that's an item or has nothing rendered holds none of trigger's margins outside outer: one
  // a block-flow refresh carried goes.
  pins.forEach(({ outer }, i) => {
    if (!inBlockFlow.has(i) && outer.style.marginBottom) {
      outer.style.removeProperty('margin-bottom');
    }
  });
  fitEscapingMargins(blocks, gaps);
  blocks.forEach(({ index }, j) => {
    reserved[index] = heights[j];
  });

  return reserved;
};

// Each outer's computed style, kept for its lifetime: in Firefox a fresh getComputedStyle() of a
// display: contents element on every refresh made each refresh slower than the last.
const outerStyles = new WeakMap<HTMLElement, CSSStyleDeclaration>();

const outerStyle = (outer: HTMLElement): CSSStyleDeclaration => {
  let style = outerStyles.get(outer);

  if (!style) {
    style = getComputedStyle(outer);
    outerStyles.set(outer, style);
  }

  return style;
};

// Takes the bottom margin carried onto each outer off, returning the way back: with it off, outer's
// computed margin is the one the page's rules give it, and a rule matching outer in trigger's place
// (.stack > *, say) gives it trigger's margin. Only while outer is display: contents, where the
// margin lays nothing out. A percentage or calc() reads as written.
const takeCarriedMargins = (outers: readonly HTMLElement[]): (() => void) => {
  const carried = outers.map((outer) => captureInline(outer, 'margin-bottom'));

  outers.forEach((outer) => outer.style.removeProperty('margin-bottom'));

  return () => outers.forEach((outer, j) => restoreInline(outer, 'margin-bottom', carried[j]));
};

// The escaping margin collapsed with outer's own: the larger positive one plus the more negative
// one. One the page writes in px is collapsed here; a percentage or calc() is left to the browser,
// which resolves it against outer's containing block.
const carriedMargin = (escaping: number, own: string): string => {
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?px$|^0$/.test(own)) {
    const px = parseFloat(own);

    return `${Math.max(escaping, px, 0) + Math.min(escaping, px, 0)}px`;
  }

  if (own === 'auto' || own === '') return `${escaping}px`;

  return `calc(max(${escaping}px, ${own}, 0px) + min(${escaping}px, ${own}, 0px))`;
};

// The bottom border measureUsedHeight counts.
const bottomBorder = (el: HTMLElement) => {
  const style = getComputedStyle(el);

  return measureBorderWidth(style.borderBottomStyle, style.borderBottomWidth);
};

// Whether outer keeps its content's bottom margin inside its natural height (or cuts it off), as a
// page rule matching it in trigger's place can make it, so none escapes. Most such rules move
// outer's bottom edge away from inner's (gap): a bottom padding or border, a height, min-height,
// max-height, size containment, or a formatting context such as a float, an absolute position,
// an overflow or an align-content where the engine makes it one (iOS 16 doesn't). The gap misses
// the rest: a display other than the block written (only a page rule's !important sets one), a
// writing mode other than its parent's, and columns.
const holdsBottomMargin = (style: CSSStyleDeclaration, gap: number, parent: Element | null) =>
  Math.abs(gap) > 0.01
  || !['block', 'list-item'].includes(style.display)
  || (parent !== null && style.writingMode !== getComputedStyle(parent).writingMode)
  || ![undefined, '', 'auto'].includes(style.columnCount)
  || ![undefined, '', 'auto'].includes(style.columnWidth);
const bottomGap = (outer: HTMLElement, inner: HTMLElement) =>
  outer.getBoundingClientRect().bottom - inner.getBoundingClientRect().bottom;
// A transparent border, which keeps the margins of a box's content inside it but no float.
const HOLD_MARGINS = '1px solid transparent';

// Carries the bottom margin escaping each block-flow pin's trigger (trigger's own, collapsed with
// its content's) onto outer, collapsed with outer's own. outer holds a height, which stops that
// margin collapsing through its bottom while the top one still does. The margin is how much taller
// inner gets with HOLD_MARGINS at its bottom, which leaves out a float overflowing trigger, as
// unwrapped. outer keeps the last refresh's margin until the new one is written, so the page keeps
// its height.
const fitEscapingMargins = (
  pins: readonly (WrappedPin & { ownMargin: string })[],
  gaps: readonly number[],
) => {
  const plain = pins.map(({ inner }) => measureUsedHeight(inner) - bottomBorder(inner));
  // Bottom edges, not heights: a page rule's top padding or border on outer keeps trigger's top
  // margin inside it too. An inner with no height has every margin inside it collapsing through:
  // they leave through outer's top, so none is left for its bottom.
  const holding = pins.map(({ outer }, j) => plain[j] < 0.01
    || holdsBottomMargin(getComputedStyle(outer), gaps[j], outer.parentElement));

  pins.forEach(({ inner }) => {
    inner.style.borderBottom = HOLD_MARGINS;
  });

  let margins: number[];

  try {
    // Each less its border as measureUsedHeight counts it: this one can snap below 1px under a
    // zoom, and the plain one is a page rule's, if any.
    margins = pins.map(({ inner }, j) => (holding[j]
      ? 0
      : measureUsedHeight(inner) - bottomBorder(inner) - plain[j]));
  } finally {
    pins.forEach(({ inner }) => {
      inner.style.borderBottom = '';
    });
  }

  // !important, as trigger's held box is, so a page rule's !important doesn't win over it.
  pins.forEach(({ outer, ownMargin }, j) => {
    outer.style.setProperty('margin-bottom', carriedMargin(margins[j], ownMargin), HELD_PRIORITY);
  });
};

// The block-flow pins in measured (by index) whose height resolves against inner's and so needs
// holding. A percentage height or min-height follows inner up to PROBE_HEIGHT. A percentage
// max-height can only clamp an inner shorter than trigger, and a pin range is at least trigger's
// height (#planPinLayers), so it's tried with inner at trigger's height. Other heights (auto, px,
// vh) keep following their content and the viewport.
const heightsFollowingInner = (
  measured: readonly (WrappedPin & { index: number })[],
  boxes: readonly MeasuredBox[],
  inPx: readonly boolean[],
  styles: readonly CSSStyleDeclaration[],
): Set<number> => {
  const blocks = measured.flatMap((pin, i) => (!boxes[i].item && inPx[i] ? [{ ...pin, i }] : []));
  const dependent = new Set(probeInner(blocks, () => PROBE_HEIGHT, boxes));
  const capped = blocks.filter(({ index, i }) =>
    !dependent.has(i) && styles[index].maxHeight.includes('%'));

  probeInner(capped, ({ i }) => boxes[i].box[0], boxes).forEach((i) => dependent.add(i));

  return dependent;
};

// The blocks whose trigger changes height with inner at height(block), their outer held at its
// height meanwhile (fitBlocksAndItems).
const probeInner = <T extends WrappedPin & { i: number }>(
  blocks: readonly T[],
  height: (block: T) => string,
  boxes: readonly MeasuredBox[],
): number[] => {
  const saved = blocks.map(({ inner }) => inner.style.height);

  blocks.forEach((block) => {
    block.inner.style.height = height(block);
  });

  try {
    return blocks.flatMap(({ trigger, i }) =>
      (getComputedStyle(trigger).height !== boxes[i].box[0] ? [i] : []));
  } finally {
    blocks.forEach(({ inner }, j) => {
      inner.style.height = saved[j];
    });
  }
};

export const unwrapPin = (
  outer: HTMLDivElement,
  trigger: HTMLElement,
  saved: InlinePosition,
) => {
  const parent = outer.parentNode;

  restoreInlinePosition(trigger, saved);
  releaseTriggerBox(trigger);

  if (parent) moveInto(parent, trigger, outer);

  if (outer.firstElementChild instanceof HTMLElement) pinRanges.delete(outer.firstElementChild);

  outer.remove();
};

type LiftProperty = 'position' | 'z-index';

const LIFT_VALUES: Record<LiftProperty, string> = { 'position': 'relative', 'z-index': '1' };

interface LiftedProperty {
  property: LiftProperty;
  authored: InlineValue;
  written: string;
}

// State for an already-lifted element, reference-counted because several cover layers can lift
// the same one. `applied` is the properties actually written, which can be none: an element the
// author has already spoken for on both is tracked all the same, so the count stays right.
interface LiftState {
  count: number;
  applied: LiftedProperty[];
}

const liftStates = new WeakMap<HTMLElement, LiftState>();

// Raises the covering side above the sticky wrapper (position:sticky creates a stacking context).
// Only sets a property whose computed value is static/auto, so other values are respected. Both go
// in through CSSOM rather than a stylesheet of the module's own, which is what keeps a strict
// Content Security Policy from needing a style-src exception for them.
// Returns a restore function, which puts back the element's own inline values, a static or auto the
// lift wrote over included, each only while it still holds the lift's value: one restyled since
// (gsap.set, say) stays.
export const liftAboveStickyWrapper = (cover: HTMLElement): (() => void) => {
  const lifted: HTMLElement[] = [];

  for (let node: Element | null = cover; node; node = node.nextElementSibling) {
    if (!(node instanceof HTMLElement)) continue;

    const element = node;
    const existing = liftStates.get(element);

    if (existing) {
      existing.count += 1;
    } else {
      const computed = getComputedStyle(element);
      const properties: LiftProperty[] = [];

      if (computed.position === 'static') properties.push('position');

      if (computed.zIndex === 'auto') properties.push('z-index');

      const applied = properties.map((property) => ({
        property,
        authored: captureInline(element, property),
        written: writeInline(element, property, LIFT_VALUES[property]),
      }));

      liftStates.set(element, { count: 1, applied });
    }

    lifted.push(element);
  }

  return () => {
    lifted.forEach((el) => {
      const state = liftStates.get(el);

      if (!state) return;

      state.count -= 1;

      if (state.count > 0) return;

      state.applied.forEach(({ property, authored, written }) => {
        restoreIfWritten(el, property, authored, written);
      });
      liftStates.delete(el);
    });
    lifted.length = 0;
  };
};
