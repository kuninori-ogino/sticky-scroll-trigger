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

const resetStickyPosition = (el: HTMLElement): void => {
  el.style.position = '';
  el.style.top = '';
};

// An element's inline position/top, captured to put back after a clear or overwrite.
export interface InlinePosition {
  position: string;
  top: string;
}

export const captureInlinePosition = (el: HTMLElement): InlinePosition => ({
  position: el.style.position,
  top: el.style.top,
});

const restoreInlinePosition = (el: HTMLElement, saved: InlinePosition): void => {
  el.style.position = saved.position;
  el.style.top = saved.top;
};

// Clears position/top on every element and returns a function that restores them.
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

// Puts a block of each height right after its element and returns a function that takes them out.
export const insertSpacers = (
  spacers: readonly { after: HTMLElement; height: number }[],
): (() => void) => {
  const inserted = spacers.map(({ after, height }) => {
    const spacer = document.createElement('div');

    spacer.style.cssText = `height:${height}px;margin:0;padding:0;border:0`;
    after.after(spacer);

    return spacer;
  });

  return () => inserted.forEach((spacer) => spacer.remove());
};

// An element the structure adds, with transition: none !important so a broad page rule (* or
// .section div, !important or not) can't animate what the library writes: a wrapper's top would
// slide on each demotion instead of landing where the table computed it.
const createStructureElement = (): HTMLDivElement => {
  const el = document.createElement('div');

  el.style.setProperty('transition', 'none', 'important');

  return el;
};

// Scene layer: wraps inner in one level of stickyContainer{ stickyWrapper, stickyPadding }
// and moves it inside the wrapper. With holdTrailingMargin, an empty flow-root after inner keeps a
// bottom margin ending inner (its own or its content's) in the wrapper, where it can't move the end
// of the freeze. A flow-root wrapper would also hold in a top margin and shift the content down.
export const wrapScene = (inner: HTMLElement, holdTrailingMargin: boolean) => {
  if (!inner.parentNode) {
    throw new Error(`StickyScrollTrigger: ${describeElement(inner)} is not attached to the document`);
  }

  const container = createStructureElement();
  const wrapper = createStructureElement();
  const padding = createStructureElement();

  padding.setAttribute('aria-hidden', 'true');
  padding.style.pointerEvents = 'none';
  inner.parentNode.insertBefore(container, inner);
  container.appendChild(wrapper);
  wrapper.appendChild(inner);
  container.appendChild(padding);

  if (holdTrailingMargin) {
    const sentinel = createStructureElement();

    sentinel.style.display = 'flow-root';
    wrapper.appendChild(sentinel);
  }

  return { container, wrapper, padding };
};

// Cover layer: moves "everything from the start up to trigger" (within trigger's own parent)
// into a sticky wrapper.
export const wrapCover = (trigger: HTMLElement): HTMLDivElement => {
  const parent = trigger.parentNode;

  if (!parent) {
    throw new Error(
      `createOverlapScroll: trigger ${describeElement(trigger)} is not attached to the document`,
    );
  }

  const wrapper = createStructureElement();

  parent.insertBefore(wrapper, parent.firstChild);

  while (wrapper.nextSibling) {
    const node = wrapper.nextSibling;

    wrapper.appendChild(node);

    if (node === trigger) break;
  }

  return wrapper;
};

export const unwrapCover = (wrapper: HTMLDivElement) => {
  const parent = wrapper.parentNode;

  if (!parent) return;

  while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);

  wrapper.remove();
};

// Pin layer: wraps trigger in two levels, outer{ inner{ trigger } }. inner holds the pin range,
// which runs far past trigger's own height; outer's own height is left to #reservePinSpace, which
// rewrites it on every refresh. outer is a flow-root, so trigger's margins stop inside it. contain
// would do that too, but it also makes outer a stacking context and the containing block for
// trigger's fixed-position descendants.
export const wrapPin = (trigger: HTMLElement) => {
  if (!trigger.parentNode) {
    throw new Error(
      `createStickyPin: trigger ${describeElement(trigger)} is not attached to the document`,
    );
  }

  const outer = createStructureElement();
  const inner = createStructureElement();

  outer.style.display = 'flow-root';
  trigger.parentNode.insertBefore(outer, trigger);
  outer.appendChild(inner);
  inner.appendChild(trigger);
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

// outer's own display: a box in a line where trigger was one, a block otherwise, a formatting
// context either way so trigger's margins stay inside it.
const outerDisplay = (layout: ItemLayout | null) =>
  (layout === 'inline' ? 'inline-block' : 'flow-root');

interface WrappedPin {
  outer: HTMLDivElement;
  inner: HTMLDivElement;
  trigger: HTMLElement;
}

// trigger's own box as the item, held on it in px as GSAP's _swapPinIn holds a pin's (max-width and
// max-height at the width and height), so its percentages, a stretched height or a flexed width
// don't resolve again inside outer.
const TRIGGER_BOX = [
  'width',
  'max-width',
  'height',
  'max-height',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
] as const;

interface HeldBox {
  // With their priority, so an !important one goes back as one.
  authored: { value: string; priority: string }[];
  written: string[];
}

const heldBoxes = new WeakMap<HTMLElement, HeldBox>();

const holdTriggerBox = (trigger: HTMLElement, values: readonly string[]) => {
  const { style } = trigger;
  const authored = TRIGGER_BOX.map((property) => ({
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  }));

  TRIGGER_BOX.forEach((property, i) => {
    style.setProperty(property, values[i]);
  });
  heldBoxes.set(trigger, {
    authored,
    // As read back, which is how a later comparison sees them.
    written: TRIGGER_BOX.map((property) => style.getPropertyValue(property)),
  });
};

// Puts trigger's own inline values back, each only while it still holds the value written: one set
// since (gsap.set, say) stays. Returns what was held, if anything.
const releaseTriggerBox = (trigger: HTMLElement): string[] | undefined => {
  const held = heldBoxes.get(trigger);

  if (!held) return undefined;

  const { style } = trigger;

  TRIGGER_BOX.forEach((property, i) => {
    const { value, priority } = held.authored[i];
    const ours = style.getPropertyValue(property) === held.written[i]
      && !style.getPropertyPriority(property);

    if (ours) style.setProperty(property, value, priority);
  });
  heldBoxes.delete(trigger);

  return held.written;
};

// Makes each pin's outer take trigger's place as the flex or grid item, float or inline-level box
// trigger was, and returns the height to reserve for each (undefined for a pin in block flow, whose
// outer measures as it stands). Expects outer's and inner's heights cleared; if a read throws,
// outer is the caller's to restore.
//
// Sized by its content, outer would shrink a flex item, float or inline-block to trigger's text,
// reserve only a stretched item's content and break an inline-level trigger's line. So trigger's
// margin box is read as the item, with outer and inner set to display: contents (moving trigger
// out instead would reload an iframe inside it and drop focus), and held on outer in px, as GSAP's
// pin-spacer holds it; a grid item's outer takes its width from its cell. trigger's own box is
// held on it too (TRIGGER_BOX).
//
// All reads come before the writes that follow them, for every pin at once, so a refresh costs a
// fixed number of style and layout passes.
export const fitPinsToItems = (pins: readonly WrappedPin[]): (number | undefined)[] => {
  // Released first, so trigger's box is read as its own rules make it.
  const held = pins.map(({ trigger }) => releaseTriggerBox(trigger));

  try {
    return fitReleasedPins(pins);
  } catch (error) {
    // Held again, to match the outer the caller puts back.
    pins.forEach(({ trigger }, i) => {
      const values = held[i];

      if (values) holdTriggerBox(trigger, values);
    });

    throw error;
  }
};

const fitReleasedPins = (pins: readonly WrappedPin[]): (number | undefined)[] => {
  // Live, so the reads below see the layout as it stands by then.
  const styles = pins.map(({ trigger }) => getComputedStyle(trigger));
  const layouts = pins.map(({ outer }, i) => itemLayout(outer, styles[i]));
  // A trigger with no box under a hidden ancestor (a hidden tab's), or off the document, has none
  // to hold yet, so outer goes by the properties alone until a refresh() can measure one.
  const rendered = pins.map(({ trigger }, i) =>
    !!layouts[i] && trigger.getClientRects().length > 0);
  // In block flow only a block-level trigger's clear moves outer (an inline one's, or one with no
  // box, applies to nothing); the rest go back to unset.
  const copied = styles.map((style, i) => PIN_ITEM_PROPERTIES.map((property) =>
    (layouts[i] || (property === 'clear' && isBlockLevel(style)) ? style[property] : '')));
  const items = pins.flatMap((pin, index) => {
    const layout = layouts[index];

    return layout && rendered[index] ? [{ ...pin, index, layout }] : [];
  });

  pins.forEach(({ outer }, i) => {
    outer.style.width = '';
    PIN_ITEM_PROPERTIES.forEach((property, j) => {
      outer.style[property] = copied[i][j];
    });
    outer.style.display = rendered[i] ? 'contents' : outerDisplay(layouts[i]);
  });
  items.forEach(({ inner }) => {
    inner.style.display = 'contents';
  });

  let boxes: { width: number | undefined; height: number; triggerBox: string[] }[];

  try {
    boxes = items.map(({ trigger, index, layout }) => {
      const style = styles[index];

      return {
        width: layout === 'grid'
          ? undefined
          : measureUsedWidth(trigger)
            + parseFloat(style.marginLeft)
            + parseFloat(style.marginRight),
        height: marginBoxHeight(trigger, style),
        triggerBox: TRIGGER_BOX.map((property) =>
          style.getPropertyValue(property.replace(/^max-/, ''))),
      };
    });
  } finally {
    items.forEach(({ outer, inner, layout }) => {
      outer.style.display = outerDisplay(layout);

      inner.style.display = '';
    });
  }

  const reserved: (number | undefined)[] = pins.map(() => undefined);

  // A box that didn't come out in px is left to outer's own measurement, and trigger to its own
  // rules.
  items.forEach(({ outer, trigger, layout, index }, i) => {
    const { width, height, triggerBox } = boxes[i];

    if (!Number.isFinite(height) || (width !== undefined && !Number.isFinite(width))) return;

    if (layout === 'flex') outer.style.flex = '0 0 auto';

    if (width !== undefined) outer.style.width = `${width}px`;

    reserved[index] = height;

    if (triggerBox.every((value) => value.endsWith('px'))) holdTriggerBox(trigger, triggerBox);
  });

  return reserved;
};

export const unwrapPin = (
  outer: HTMLDivElement,
  trigger: HTMLElement,
  saved: InlinePosition,
) => {
  const parent = outer.parentNode;

  restoreInlinePosition(trigger, saved);
  releaseTriggerBox(trigger);

  if (parent) parent.insertBefore(trigger, outer);

  if (outer.firstElementChild instanceof HTMLElement) pinRanges.delete(outer.firstElementChild);

  outer.remove();
};

type LiftProperty = 'position' | 'zIndex';

const LIFT_VALUES: Record<LiftProperty, string> = { position: 'relative', zIndex: '1' };

// State for an already-lifted element, reference-counted because several cover layers can lift
// the same one. `applied` is the properties actually written, which can be none: an element the
// author has already spoken for on both is tracked all the same, so the count stays right.
interface LiftState {
  count: number;
  applied: LiftProperty[];
}

const liftStates = new WeakMap<HTMLElement, LiftState>();

// Raises the covering side above the sticky wrapper (position:sticky creates a stacking context).
// Only fills in a property whose computed value is static/auto; author-specified values are
// respected. Both go in through CSSOM rather than a stylesheet of the module's own, which is what
// keeps a strict Content Security Policy from needing a style-src exception for them.
// Returns a restore function, which clears a property only while it still holds the value written
// here: a caller who restyles the covering side to something else (gsap.set, say) keeps that value.
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
      const applied: LiftProperty[] = [];

      if (computed.position === 'static') applied.push('position');

      if (computed.zIndex === 'auto') applied.push('zIndex');

      applied.forEach((property) => {
        element.style[property] = LIFT_VALUES[property];
      });
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

      state.applied.forEach((property) => {
        if (el.style[property] === LIFT_VALUES[property]) el.style[property] = '';
      });
      liftStates.delete(el);
    });
    lifted.length = 0;
  };
};
