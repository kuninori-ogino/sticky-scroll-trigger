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

// Matches GSAP's own scrollerMax for the window scroller (see _maxScroll in GSAP's
// ScrollTrigger source): total document height minus the viewport height, floored at 0.
export const measureDocumentMaxScroll = (viewportHeight: number): number => {
  const doc = document.documentElement;

  return Math.max(0, (doc.scrollHeight || document.body.scrollHeight) - viewportHeight);
};

// A side's border width, zero unless that side has a border-style. Browsers already compute it
// that way; jsdom reports the initial 'medium' regardless, which is what the check is here for.
const measureBorderWidth = (borderStyle: string, width: string): number => (
  borderStyle === 'none' || borderStyle === 'hidden' ? 0 : parseFloat(width)
);

// The height an element is currently using, at full precision, where offsetHeight rounds to whole
// pixels. Reading it off the computed style keeps a transform out of the number, unlike
// getBoundingClientRect: a scaled element still occupies its untransformed height in the flow, the
// layout-not-paint measurement documentTop and offsetHeight both take.
// That computed height follows box-sizing, so a content-box element's padding and borders are
// added back to reach the border box; all of them arrive resolved to px, percentages included. An
// element with no used height at all (an inline box, a display:none subtree, outside the document)
// reports 'auto' or nothing, and the fallback is offsetHeight.
// offsetHeight also takes precedence on any disagreement of a pixel or more, which happens only
// when the arithmetic can't model the box: WebKit takes a space-taking scrollbar out of the height
// it reports (Safari's "always show scrollbars"), leaving the sum a whole scrollbar short. Where
// offsetHeight is 0 the comparison is skipped, since jsdom reports 0 for everything and would
// otherwise reject every measurement here.
export const measureUsedHeight = (el: HTMLElement): number => {
  const rounded = el.offsetHeight;
  const style = getComputedStyle(el);
  const height = parseFloat(style.height);

  if (!Number.isFinite(height)) return rounded;

  const measured = style.boxSizing === 'border-box'
    ? height
    : height
      + parseFloat(style.paddingTop)
      + parseFloat(style.paddingBottom)
      + measureBorderWidth(style.borderTopStyle, style.borderTopWidth)
      + measureBorderWidth(style.borderBottomStyle, style.borderBottomWidth);

  return rounded > 0 && Math.abs(measured - rounded) >= 1 ? rounded : measured;
};

export const compareDocumentOrder = (a: HTMLElement, b: HTMLElement): number => {
  const position = a.compareDocumentPosition(b);

  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;

  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;

  return 0;
};

export const resetStickyPosition = (el: HTMLElement): void => {
  el.style.position = '';
  el.style.top = '';
};

export const applyStickyPosition = (el: HTMLElement, topPx: number): void => {
  el.style.position = 'sticky';
  el.style.top = `${topPx}px`;
};

// An element's own inline position/top, captured before a pin overwrites them. Only
// createStickyPin needs this: everything else this module positions is a wrapper it created,
// so clearing back to '' is already correct.
export interface InlinePosition {
  position: string;
  top: string;
}

export const captureInlinePosition = (el: HTMLElement): InlinePosition => ({
  position: el.style.position,
  top: el.style.top,
});

export const restoreInlinePosition = (el: HTMLElement, saved: InlinePosition): void => {
  el.style.position = saved.position;
  el.style.top = saved.top;
};

// Scene layer: wraps inner in one level of stickyContainer{ stickyWrapper, stickyPadding }
// and moves it inside the wrapper.
export const wrapScene = (inner: HTMLElement) => {
  if (!inner.parentNode) {
    throw new Error(`StickyScrollTrigger: ${describeElement(inner)} is not attached to the document`);
  }

  const container = document.createElement('div');
  const wrapper = document.createElement('div');
  const padding = document.createElement('div');

  padding.setAttribute('aria-hidden', 'true');
  padding.style.pointerEvents = 'none';
  inner.parentNode.insertBefore(container, inner);
  container.appendChild(wrapper);
  wrapper.appendChild(inner);
  container.appendChild(padding);

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

  const wrapper = document.createElement('div');

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
// which runs far past trigger's own height, and contain:layout keeps that out of the layout
// outside outer. outer's own height is left to #reservePinSpace, which rewrites it on every
// refresh.
export const wrapPin = (trigger: HTMLElement) => {
  if (!trigger.parentNode) {
    throw new Error(
      `createStickyPin: trigger ${describeElement(trigger)} is not attached to the document`,
    );
  }

  const outer = document.createElement('div');
  const inner = document.createElement('div');

  outer.style.contain = 'layout';
  trigger.parentNode.insertBefore(outer, trigger);
  outer.appendChild(inner);
  inner.appendChild(trigger);

  return { outer, inner };
};

export const unwrapPin = (
  outer: HTMLDivElement,
  trigger: HTMLElement,
  saved: InlinePosition,
) => {
  const parent = outer.parentNode;

  restoreInlinePosition(trigger, saved);

  if (parent) parent.insertBefore(trigger, outer);

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
