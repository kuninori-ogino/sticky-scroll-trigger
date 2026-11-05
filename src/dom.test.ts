// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureInline,
  captureInlinePosition,
  compareDocumentOrder,
  describeElement,
  fitPinsToItems,
  insertSpacers,
  isMovingDom,
  liftAboveStickyWrapper,
  measureDocumentHeightWithoutPinRanges,
  measureDocumentMaxScroll,
  measureUsedHeight,
  measureViewportHeight,
  moveInto,
  resolveElement,
  resolveEndTrigger,
  resolveRoot,
  restoreIfWritten,
  restoreInlinePosition,
  stripStickyPositions,
  unwrapCover,
  unwrapPin,
  wrapCover,
  wrapPin,
  wrapScene,
  writeInline,
} from './dom';

// jsdom has no layout engine, so offsetTop/offsetParent/clientTop/offsetHeight are always 0/null,
// meaning `documentTop`'s and measureViewportHeight's "actually measure a 100vh div" path can't
// be verified here (running it would just pass through without catching any real measurement bug).
// That needs real layout, so it's e2e's job. See e2e/StickyScrollTrigger.spec.ts's "documentTop"
// and "measureViewportHeight" tests.
// Everything else here is just DOM structure and inline style manipulation, which jsdom can verify
// fully (measureViewportHeight's fallback path, specifically, is naturally exercised here too since
// offsetHeight is always 0 in jsdom).

const ids = (parent: Element) => Array.from(parent.children).map((el) => el.id);

describe('resolveRoot', () => {
  it('looks up the shared container from a selector string', () => {
    document.body.innerHTML = '<div class="Main__inner"></div>';
    expect(resolveRoot('.Main__inner')).toBe(document.querySelector('.Main__inner'));
  });

  it('returns an HTMLElement as-is', () => {
    const el = document.createElement('div');

    expect(resolveRoot(el)).toBe(el);
  });

  it('throws for a selector that matches nothing', () => {
    document.body.innerHTML = '';
    expect(() => resolveRoot('.Missing')).toThrow(/root "\.Missing" not found/);
  });

  // TypeScript's types never let this branch be reached when an HTMLElement is passed,
  // but for the README's "using it from JavaScript" audience, this confirms that
  // even without type checking, passing null etc. doesn't produce an unreadable message
  // like "[object HTMLDivElement]".
  it('produces a readable stringified message even for a non-element value', () => {
    document.body.innerHTML = '';
    expect(() => resolveRoot(null as unknown as HTMLElement)).toThrow(
      'StickyScrollTrigger: root null not found',
    );
  });
});

describe('resolveElement', () => {
  it('looks up an element from a selector string', () => {
    document.body.innerHTML = '<div class="target"></div>';
    expect(resolveElement('.target', 'createStickyTrigger')).toBe(document.querySelector('.target'));
  });

  // document.querySelector returns the first match in document order, same as
  // gsap.utils.toArray(selector)[0] (what GSAP ScrollTrigger itself uses to resolve selectors).
  it('resolves to the first match in document order when a selector matches multiple elements', () => {
    document.body.innerHTML = '<div class="target" id="first"></div><div class="target" id="second"></div>';
    expect(resolveElement('.target', 'createStickyTrigger')).toBe(document.querySelector('#first'));
  });

  it('returns an HTMLElement as-is', () => {
    const el = document.createElement('div');

    expect(resolveElement(el, 'createStickyTrigger')).toBe(el);
  });

  it('throws naming the context and selector when nothing matches', () => {
    document.body.innerHTML = '';
    expect(() => resolveElement('.Missing', 'createStickyTrigger')).toThrow(
      /createStickyTrigger: element "\.Missing" not found/,
    );
  });
});

describe('resolveEndTrigger', () => {
  it('defaults to trigger when endTriggerInput is omitted', () => {
    const trigger = document.createElement('div');

    expect(resolveEndTrigger(trigger, undefined, 'createStickyTrigger')).toBe(trigger);
  });

  it('resolves endTriggerInput when given', () => {
    document.body.innerHTML = '<div class="trigger"></div><div class="end"></div>';

    const trigger = document.querySelector<HTMLElement>('.trigger')!;

    expect(resolveEndTrigger(trigger, '.end', 'createStickyTrigger'))
      .toBe(document.querySelector('.end'));
  });
});

describe('describeElement', () => {
  it('produces a readable format including the tag name, id, and class', () => {
    const el = document.createElement('section');

    el.id = 'hero';
    el.className = 'Scene Scene--1';
    expect(describeElement(el)).toBe('<section#hero.Scene.Scene--1>');
  });

  it('falls back to just the tag name when there is no id or class', () => {
    expect(describeElement(document.createElement('div'))).toBe('<div>');
  });
});

// See createStructureElement.
const transitionOff = (el: HTMLElement) => [
  el.style.getPropertyValue('transition'),
  el.style.getPropertyPriority('transition'),
];

describe('wrapScene', () => {
  it('wraps inner in container{wrapper[inner], padding} and inserts it at the original position', () => {
    document.body.innerHTML
      = '<div id="host"><i id="before"></i><div id="inner"></div><i id="after"></i></div>';

    const host = document.getElementById('host')!;
    const inner = document.getElementById('inner')!;
    const { container, wrapper, padding } = wrapScene(inner, false);

    // container takes inner's original slot
    expect(Array.from(host.children)).toEqual([
      document.getElementById('before'),
      container,
      document.getElementById('after'),
    ]);
    // padding must always sit after wrapper (i.e. after the content). If this order breaks,
    // padding gets mixed into documentTop's measurement, double-counting precedingGaps.
    expect(Array.from(container.children)).toEqual([wrapper, padding]);
    expect(wrapper.firstElementChild).toBe(inner);
  });

  it('with holdTrailingMargin, follows inner with an empty flow-root inside the wrapper', () => {
    document.body.innerHTML = '<div><div id="inner"></div></div>';

    const inner = document.getElementById('inner')!;
    const { wrapper } = wrapScene(inner, true);
    const sentinel = wrapper.lastElementChild as HTMLElement;

    expect(Array.from(wrapper.children)).toEqual([inner, sentinel]);
    expect(sentinel.style.display).toBe('flow-root');
    expect(sentinel.childNodes).toHaveLength(0);
  });

  it('excludes padding from assistive tech and hit testing', () => {
    document.body.innerHTML = '<div><div id="inner"></div></div>';

    const { padding } = wrapScene(document.getElementById('inner')!, false);

    expect(padding.getAttribute('aria-hidden')).toBe('true');
    expect(padding.style.pointerEvents).toBe('none');
  });

  it('turns transitions off on everything it adds', () => {
    document.body.innerHTML = '<div><div id="inner"></div></div>';

    const { container, wrapper, padding } = wrapScene(document.getElementById('inner')!, true);

    [container, wrapper, padding, wrapper.lastElementChild as HTMLElement].forEach((el) => {
      expect(transitionOff(el)).toEqual(['none', 'important']);
    });
  });

  it('throws for an inner not attached to the document', () => {
    expect(() => wrapScene(document.createElement('div'), false)).toThrow(/not attached to the document/);
  });
});

// jsdom has no moveBefore(), so a stub on the prototype stands in for the browser's. The
// prototype's own one, should jsdom gain it, comes back after each test.
describe('moveInto', () => {
  type WithMoveBefore = { moveBefore?: (node: Node, child: Node | null) => void };

  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'moveBefore');

  const stubMoveBefore = (impl: (this: Node, node: Node, child: Node | null) => void) => {
    const calls: Node[] = [];

    (Element.prototype as WithMoveBefore).moveBefore = function (this: Node, node, child) {
      calls.push(node);
      impl.call(this, node, child);
    };

    return calls;
  };

  afterEach(() => {
    if (original) {
      Object.defineProperty(Element.prototype, 'moveBefore', original);
    } else {
      delete (Element.prototype as WithMoveBefore).moveBefore;
    }
  });

  const setup = () => {
    document.body.innerHTML = '<div id="from"><i id="node"></i></div><div id="to"><i id="ref"></i></div>';

    return {
      node: document.getElementById('node')!,
      to: document.getElementById('to')!,
      ref: document.getElementById('ref')!,
    };
  };

  it('moves with moveBefore() when both ends are in the document', () => {
    const { node, to, ref } = setup();
    const calls = stubMoveBefore(function (this: Node, moved, child) {
      this.insertBefore(moved, child);
    });

    moveInto(to, node, ref);

    expect(calls).toEqual([node]);
    expect(ids(to)).toEqual(['node', 'ref']);
  });

  it('inserts instead when either end is outside the document', () => {
    const { node, to } = setup();
    const calls = stubMoveBefore(() => {});
    const loose = document.createElement('i');
    const detached = document.createElement('div');

    loose.id = 'loose';
    moveInto(to, loose);
    moveInto(detached, node);

    expect(calls).toEqual([]);
    expect(ids(to)).toEqual(['ref', 'loose']);
    expect(ids(detached)).toEqual(['node']);
  });

  it('inserts instead when moveBefore() refuses the move', () => {
    const { node, to } = setup();

    stubMoveBefore(() => {
      throw new DOMException('refused', 'HierarchyRequestError');
    });
    moveInto(to, node);

    expect(ids(to)).toEqual(['ref', 'node']);
  });

  // The page code a browser runs inside a move, here a custom element's connectedCallback.
  it('counts as moving only while the move runs, a failed one included', () => {
    const seen: boolean[] = [];

    if (!customElements.get('x-move-probe')) {
      customElements.define('x-move-probe', class extends HTMLElement {
        connectedCallback() {
          seen.push(isMovingDom());
        }
      });
    }

    const { to } = setup();
    const probe = document.createElement('x-move-probe');

    document.body.appendChild(probe);
    moveInto(to, probe);

    expect(seen).toEqual([false, true]);
    expect(isMovingDom()).toBe(false);
    expect(() => moveInto(probe, to)).toThrow();
    expect(isMovingDom()).toBe(false);
  });
});

describe('wrapPin', () => {
  it('wraps trigger in outer{ inner{ trigger } } and inserts it at the original position', () => {
    document.body.innerHTML
      = '<div id="host"><i id="before"></i><div id="trigger"></div><i id="after"></i></div>';

    const host = document.getElementById('host')!;
    const trigger = document.getElementById('trigger')!;
    const { outer, inner } = wrapPin(trigger);

    expect(Array.from(host.children)).toEqual([
      document.getElementById('before'),
      outer,
      document.getElementById('after'),
    ]);
    expect(outer.firstElementChild).toBe(inner);
    expect(inner.firstElementChild).toBe(trigger);
  });

  it('turns transitions off on outer and inner, not on trigger', () => {
    document.body.innerHTML = '<div><div id="trigger"></div></div>';

    const trigger = document.getElementById('trigger')!;
    const { outer, inner } = wrapPin(trigger);

    expect(transitionOff(outer)).toEqual(['none', 'important']);
    expect(transitionOff(inner)).toEqual(['none', 'important']);
    expect(trigger.getAttribute('style')).toBeNull();
  });

  it('throws for a trigger not attached to the document', () => {
    expect(() => wrapPin(document.createElement('div'))).toThrow(/not attached to the document/);
  });

  it('unwrapPin restores the original position', () => {
    document.body.innerHTML
      = '<div id="host"><i id="before"></i><div id="trigger"></div><i id="after"></i></div>';

    const host = document.getElementById('host')!;
    const trigger = document.getElementById('trigger')!;
    const { outer } = wrapPin(trigger);

    unwrapPin(outer, trigger, captureInlinePosition(trigger));

    expect(Array.from(host.children).map((el) => el.id)).toEqual(['before', 'trigger', 'after']);
    expect(outer.parentElement).toBeNull();
  });

  it('unwrapPin puts back the inline position/top it was given', () => {
    document.body.innerHTML = '<div id="host"><div id="trigger"></div></div>';

    const trigger = document.getElementById('trigger')!;
    const { outer } = wrapPin(trigger);

    trigger.style.position = 'sticky';
    trigger.style.top = '39px';
    unwrapPin(outer, trigger, {
      position: { value: 'relative', priority: '' },
      top: { value: '8px', priority: '' },
      bottom: { value: '', priority: '' },
    });

    expect(trigger.style.position).toBe('relative');
    expect(trigger.style.top).toBe('8px');
  });

  it('unwrapPin puts an !important inline top back as one', () => {
    document.body.innerHTML = '<div id="host"><div id="trigger" style="top: 8px !important"></div></div>';

    const trigger = document.getElementById('trigger')!;
    const saved = captureInlinePosition(trigger);
    const { outer } = wrapPin(trigger);

    trigger.style.position = 'sticky';
    trigger.style.top = '39px';
    unwrapPin(outer, trigger, saved);

    expect(trigger.style.cssText).toBe('top: 8px !important;');
  });
});

// jsdom lays nothing out, so every size here is 0 and no element has a box: each trigger gets one
// client rect to count as rendered. What's checked is which styles go where, and that a read taking
// outer and inner out of the layout always puts them back. The sizes themselves are e2e's (the
// "a pinned ... keeps its own box and its siblings in place" tests).
describe('fitPinsToItems', () => {
  const NO_POSITION = captureInlinePosition(document.createElement('div'));

  const rendered = (trigger: HTMLElement) => {
    trigger.getClientRects = () => [new DOMRect()] as unknown as DOMRectList;
  };

  const wrapIn = (parentStyle: string, triggerStyle = '') => {
    document.body.innerHTML
      = `<div id="host" style="${parentStyle}"><div id="trigger" style="${triggerStyle}"></div></div>`;

    const trigger = document.getElementById('trigger')!;

    rendered(trigger);

    return { trigger, ...wrapPin(trigger) };
  };

  it('gives outer trigger\'s place among a flex item\'s siblings', () => {
    const pin = wrapIn('display: flex', 'order: 2; flex: 1 0 30px; align-self: end; clear: both');

    fitPinsToItems([pin]);

    expect(pin.outer.style.order).toBe('2');
    expect(pin.outer.style.alignSelf).toBe('end');
    expect(pin.outer.style.clear).toBe('both');
  });

  it('copies only clear in block flow, and unsets what an item copied before', () => {
    const pin = wrapIn('display: flex', 'order: 2; clear: both');

    fitPinsToItems([pin]);
    document.getElementById('host')!.style.display = 'block';

    expect(fitPinsToItems([pin])).toEqual([undefined]);
    expect(pin.outer.style.order).toBe('');
    expect(pin.outer.style.clear).toBe('both');
    expect(pin.outer.style.width).toBe('');
  });

  it('copies a flex item\'s place but holds no box for a trigger that has none', () => {
    const pin = wrapIn('display: flex', 'flex: 1 0 30px');

    pin.trigger.getClientRects = () => [] as unknown as DOMRectList;

    expect(fitPinsToItems([pin])).toEqual([undefined]);
    expect(pin.outer.style.flexGrow).toBe('1');
    expect(pin.outer.style.flexBasis).toBe('30px');
    expect(pin.outer.style.width).toBe('');
    expect(pin.outer.style.display).toBe('flow-root');
  });

  it('holds a flex item\'s box on outer in px, and leaves inner alone', () => {
    const pin = wrapIn('display: flex', 'flex: 0 0 200px');

    expect(fitPinsToItems([pin])).toEqual([0]);
    expect(pin.outer.style.display).toBe('flow-root');
    expect(pin.outer.style.flex).toBe('0 0 auto');
    expect(pin.outer.style.width).toBe('0px');
    expect(pin.inner.getAttribute('style')).toBe('transition: none !important;');
  });

  it('floats outer with trigger and sizes it in px', () => {
    const pin = wrapIn('', 'float: left');

    expect(fitPinsToItems([pin])).toEqual([0]);
    expect(pin.outer.style.float).toBe('left');
    expect(pin.outer.style.width).toBe('0px');
  });

  it('leaves a grid item\'s width to its cell', () => {
    const pin = wrapIn('display: grid', 'grid-column-start: 2');

    expect(fitPinsToItems([pin])).toEqual([0]);
    expect(pin.outer.style.width).toBe('');
    expect(pin.outer.style.gridColumnStart).toBe('2');
  });

  it('treats trigger as an item of the container past a display: contents parent', () => {
    document.body.innerHTML
      = '<div style="display: flex"><div style="display: contents"><div id="trigger"></div></div></div>';

    const trigger = document.getElementById('trigger')!;

    rendered(trigger);

    const pin = { trigger, ...wrapPin(trigger) };

    expect(fitPinsToItems([pin])).toEqual([0]);
    expect(pin.outer.style.flex).toBe('0 0 auto');
  });

  it('copies nothing from a trigger with no box of its own', () => {
    const pin = wrapIn('display: flex', 'display: none; flex: 0 0 200px; clear: both');

    expect(fitPinsToItems([pin])).toEqual([undefined]);
    expect(pin.outer.style.flexBasis).toBe('');
    expect(pin.outer.style.clear).toBe('');
  });

  it('keeps outer in the line an inline-level trigger sat in, sized in px', () => {
    const pin = wrapIn('', 'display: inline-block; vertical-align: top');

    expect(fitPinsToItems([pin])).toEqual([0]);
    expect(pin.outer.style.display).toBe('inline-block');
    expect(pin.outer.style.verticalAlign).toBe('top');
    expect(pin.outer.style.width).toBe('0px');

    pin.trigger.style.display = 'block';
    fitPinsToItems([pin]);

    expect(pin.outer.style.display).toBe('flow-root');
  });

  // jsdom resolves no percentages or stretching, so a stylesheet's px values stand in for the box
  // the container gives trigger: what's checked is that it lands inline, and leaves again.
  const BOX = 'width: 30px; height: 20px; padding: 1px 2px; margin: 3px 4px';

  const wrapWithBox = (triggerStyle: string) => {
    const pin = wrapIn('display: flex', triggerStyle);

    document.head.insertAdjacentHTML('beforeend', `<style id="box">#trigger { ${BOX} }</style>`);

    return pin;
  };

  const BLOCK_HELD = 'height: 20px !important; max-height: 20px !important; min-height: 20px !important;';

  // Puts trigger in block flow, with a height that follows inner's once inner has one, as a
  // percentage height does in a browser.
  const followInner = () => {
    document.getElementById('host')!.style.display = 'block';
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style id="follows">div[style*="height"] > #trigger { height: 99px }</style>',
    );
  };

  afterEach(() => {
    document.getElementById('box')?.remove();
    document.getElementById('follows')?.remove();
  });

  // !important, so a stylesheet's !important doesn't beat it.
  it('holds trigger\'s own box on it in px, max-width at its width, max- and min-height at its height', () => {
    const pin = wrapWithBox('');

    fitPinsToItems([pin]);

    expect(pin.trigger.style.cssText).toBe(
      'width: 30px !important; max-width: 30px !important; height: 20px !important; '
      + 'max-height: 20px !important; min-height: 20px !important; '
      + 'padding: 1px 2px !important; margin: 3px 4px !important;',
    );
  });

  it('holds only a block-flow trigger\'s height, leaving its width, padding and margins to its rules', () => {
    const pin = wrapWithBox('');

    followInner();

    expect(fitPinsToItems([pin])).toEqual([undefined]);
    expect(pin.trigger.style.cssText).toBe(BLOCK_HELD);
    expect(pin.outer.style.display).toBe('flow-root');
    expect(pin.inner.style.display).toBe('');
  });

  it('leaves a block-flow trigger\'s height to its rules where it doesn\'t follow inner\'s', () => {
    const pin = wrapWithBox('');

    document.getElementById('host')!.style.display = 'block';
    pin.inner.style.height = '7px';
    fitPinsToItems([pin]);

    expect(pin.trigger.style.cssText).toBe('');
    expect(pin.inner.style.height).toBe('7px');
    expect(pin.outer.style.height).toBe('');
  });

  // A percentage max-height is tried with inner at trigger's own height; the second stylesheet
  // makes it clamp there.
  it('holds a block-flow trigger\'s percentage max-height only where it clamps', () => {
    const pin = wrapWithBox('max-height: 50%');

    document.getElementById('host')!.style.display = 'block';
    fitPinsToItems([pin]);

    expect(pin.trigger.style.cssText).toBe('max-height: 50%;');

    document.head.insertAdjacentHTML(
      'beforeend',
      '<style id="follows">div[style*="height: 20px"] > #trigger { height: 10px }</style>',
    );
    fitPinsToItems([pin]);

    expect(pin.trigger.style.cssText).toBe(
      'max-height: 20px !important; height: 20px !important; min-height: 20px !important;',
    );
  });

  it('holds no height on a block-flow trigger with no box, or one not in px', () => {
    const pin = wrapWithBox('');

    document.getElementById('host')!.style.display = 'block';
    pin.trigger.getClientRects = () => [] as unknown as DOMRectList;
    fitPinsToItems([pin]);

    expect(pin.trigger.style.cssText).toBe('');

    rendered(pin.trigger);
    document.getElementById('box')!.remove();
    fitPinsToItems([pin]);

    expect(pin.trigger.style.cssText).toBe('');
  });

  it('puts trigger\'s own inline values back before the next read, and on unwrap', () => {
    const pin = wrapWithBox('max-width: 50%');

    fitPinsToItems([pin]);
    followInner();
    fitPinsToItems([pin]);

    // The item's box gives way to the block's.
    expect(pin.trigger.style.cssText).toBe(`max-width: 50%; ${BLOCK_HELD}`);

    document.getElementById('host')!.style.display = 'flex';
    fitPinsToItems([pin]);
    unwrapPin(pin.outer, pin.trigger, NO_POSITION);

    expect(pin.trigger.style.cssText).toBe('max-width: 50%;');
  });

  it('puts a block-flow trigger\'s !important min-height back as one', () => {
    const pin = wrapWithBox('min-height: 100% !important');

    followInner();
    fitPinsToItems([pin]);

    expect(pin.trigger.style.minHeight).toBe('20px');

    unwrapPin(pin.outer, pin.trigger, NO_POSITION);

    expect(pin.trigger.style.cssText).toBe('min-height: 100% !important;');
  });

  it('puts an !important inline value back as one', () => {
    const pin = wrapWithBox('max-width: 50% !important');

    fitPinsToItems([pin]);

    expect(pin.trigger.style.maxWidth).toBe('30px');

    unwrapPin(pin.outer, pin.trigger, NO_POSITION);

    expect(pin.trigger.style.cssText).toBe('max-width: 50% !important;');
  });

  it('keeps a value set on trigger since the last read', () => {
    const pin = wrapWithBox('');

    fitPinsToItems([pin]);
    pin.trigger.style.height = '7px';
    // The value written, made plain since.
    pin.trigger.style.width = '30px';
    unwrapPin(pin.outer, pin.trigger, NO_POSITION);

    expect(pin.trigger.style.cssText).toBe('width: 30px; height: 7px;');
  });

  it('holds trigger\'s last box again when a read throws', () => {
    const pin = wrapWithBox('');

    fitPinsToItems([pin]);

    pin.trigger.getClientRects = () => {
      throw new Error('read failed');
    };

    expect(() => fitPinsToItems([pin])).toThrow('read failed');
    expect(pin.trigger.style.width).toBe('30px');

    unwrapPin(pin.outer, pin.trigger, NO_POSITION);

    expect(pin.trigger.style.cssText).toBe('');
  });

  it('holds a block-flow trigger\'s last height again when a read throws', () => {
    const pin = wrapWithBox('width: 50%');

    followInner();
    fitPinsToItems([pin]);

    pin.trigger.getClientRects = () => {
      throw new Error('read failed');
    };

    expect(() => fitPinsToItems([pin])).toThrow('read failed');
    expect(pin.trigger.style.cssText).toBe(`width: 50%; ${BLOCK_HELD}`);

    unwrapPin(pin.outer, pin.trigger, NO_POSITION);

    expect(pin.trigger.style.cssText).toBe('width: 50%;');
  });

  // jsdom leaves an auto margin unresolved, as a browser does for an element it doesn't lay out.
  it('leaves a box that doesn\'t come out in px to outer\'s own height', () => {
    const pin = wrapIn('display: flex', 'margin-left: auto');

    expect(fitPinsToItems([pin])).toEqual([undefined]);
    expect(pin.outer.style.width).toBe('');
    expect(pin.trigger.style.width).toBe('');
  });

  // The rest of outer is the caller's to restore (index.test.ts).
  it('puts outer and inner back in the layout when the read throws', () => {
    const pin = wrapIn('display: flex', 'flex: 1 0 30px');

    Object.defineProperty(pin.trigger, 'offsetWidth', {
      get: () => {
        throw new Error('read failed');
      },
    });

    expect(() => fitPinsToItems([pin])).toThrow('read failed');
    expect(pin.outer.style.display).toBe('flow-root');
    expect(pin.inner.style.display).toBe('');
  });

  // #a is a flex item pinned in #host, holding #b, a flex item pinned in #a's own row.
  const wrapNested = () => {
    document.body.innerHTML = '<div id="host" style="display: flex"><div id="a">'
      + '<div id="row" style="display: flex"><div id="b"></div></div></div></div>';

    const [a, b] = ['a', 'b'].map((id) => {
      const trigger = document.getElementById(id)!;

      rendered(trigger);

      return { trigger, ...wrapPin(trigger) };
    });

    return { a, b };
  };

  // offsetWidth is the read measureUsedWidth makes of an item.
  const onRead = (trigger: HTMLElement, read: () => number) => {
    Object.defineProperty(trigger, 'offsetWidth', { configurable: true, get: read });
  };

  it('reads a pin inside another\'s trigger first, with both in their own places', () => {
    const { a, b } = wrapNested();
    const reads: string[][] = [];

    onRead(b.trigger, () => {
      reads.push(['b', a.outer.style.display, a.inner.style.display, b.outer.style.display]);

      return 0;
    });
    onRead(a.trigger, () => {
      reads.push(['a', a.outer.style.display, b.outer.style.display]);

      return 0;
    });
    fitPinsToItems([a, b]);

    // #b is in its wrappers by the time #a is read around it.
    expect(reads).toEqual([['b', 'contents', 'contents', 'contents'], ['a', 'contents', 'flow-root']]);
    expect(a.outer.style.display).toBe('flow-root');
    expect(a.inner.style.display).toBe('');
  });

  it('holds a nested pin\'s last box again when the enclosing pin\'s read throws', () => {
    const { a, b } = wrapNested();

    document.head.insertAdjacentHTML('beforeend', `<style id="box">#b { ${BOX} }</style>`);
    fitPinsToItems([a, b]);

    const heldBefore = b.trigger.style.cssText;

    onRead(a.trigger, () => {
      throw new Error('read failed');
    });

    expect(() => fitPinsToItems([a, b])).toThrow('read failed');
    expect(b.trigger.style.cssText).toBe(heldBefore);

    unwrapPin(b.outer, b.trigger, NO_POSITION);

    expect(b.trigger.style.cssText).toBe('');
  });

  it('leaves a plain inline trigger in block flow, without its clear', () => {
    const pin = wrapIn('', 'display: inline; clear: both');

    expect(fitPinsToItems([pin])).toEqual([undefined]);
    expect(pin.outer.style.display).toBe('flow-root');
    expect(pin.outer.style.clear).toBe('');
  });
});

describe('restoreIfWritten', () => {
  // A browser keeps a value in its own form, so the comparison uses writeInline's read-back.
  it('recognizes its own write in the form the browser keeps it', () => {
    const el = document.createElement('div');

    el.style.marginTop = '5px';

    const saved = captureInline(el, 'margin-top');
    const written = writeInline(el, 'margin-top', '0');

    expect(written).toBe('0px');
    expect(restoreIfWritten(el, 'margin-top', saved, written)).toBe(true);
    expect(el.style.marginTop).toBe('5px');
  });

  it('recognizes its own write only under the priority it was made with', () => {
    const el = document.createElement('div');
    const saved = captureInline(el, 'margin-top');
    const written = writeInline(el, 'margin-top', '0', 'important');

    expect(el.style.getPropertyPriority('margin-top')).toBe('important');
    expect(restoreIfWritten(el, 'margin-top', saved, written)).toBe(false);
    expect(restoreIfWritten(el, 'margin-top', saved, written, 'important')).toBe(true);
    expect(el.style.marginTop).toBe('');
  });

  it('leaves a value whose priority was changed since', () => {
    const el = document.createElement('div');
    const saved = captureInline(el, 'margin-top');
    const written = writeInline(el, 'margin-top', '0', 'important');

    el.style.setProperty('margin-top', written);

    expect(restoreIfWritten(el, 'margin-top', saved, written, 'important')).toBe(false);
    expect(el.style.marginTop).toBe('0px');
  });
});

// jsdom has no layout, so the page's height is stubbed to report whether the range is still set.
describe('measureDocumentHeightWithoutPinRanges', () => {
  it('measures with every pin range cleared, and puts each one back afterwards', () => {
    document.body.innerHTML = '<div id="trigger"></div>';

    const { inner } = wrapPin(document.getElementById('trigger')!);
    const root = document.documentElement;

    inner.style.height = '500px';
    Object.defineProperty(root, 'scrollHeight', {
      configurable: true,
      get: () => (inner.style.height ? 900 : 100),
    });

    try {
      expect(measureDocumentHeightWithoutPinRanges()).toBe(100);
      expect(inner.style.height).toBe('500px');
    } finally {
      delete (root as { scrollHeight?: number }).scrollHeight;
    }
  });
});

describe('wrapCover', () => {
  const setup = () => {
    document.body.innerHTML
      = '<div id="host"><div id="a"></div><div id="b"></div><div id="base"></div><div id="cover"></div><div id="tail"></div></div>';

    return {
      host: document.getElementById('host')!,
      base: document.getElementById('base')!,
    };
  };

  it('moves only the start through base into wrapper, leaving cover onward outside', () => {
    const { host, base } = setup();
    const wrapper = wrapCover(base);

    expect(ids(wrapper)).toEqual(['a', 'b', 'base']);
    expect(host.children[0]).toBe(wrapper);
    expect(ids(host).slice(1)).toEqual(['cover', 'tail']);
  });

  it('turns transitions off on the wrapper', () => {
    const { base } = setup();

    expect(transitionOff(wrapCover(base))).toEqual(['none', 'important']);
  });

  it('throws for a base not attached to the document', () => {
    expect(() => wrapCover(document.createElement('div'))).toThrow(/not attached to the document/);
  });

  it('unwrapCover restores the original position and order', () => {
    const { host, base } = setup();
    const wrapper = wrapCover(base);

    unwrapCover(wrapper);

    expect(ids(host)).toEqual(['a', 'b', 'base', 'cover', 'tail']);
    expect(wrapper.parentElement).toBeNull();
  });

  it('unwrapping a parentless wrapper does nothing', () => {
    const orphan = document.createElement('div');

    orphan.appendChild(document.createElement('span'));

    expect(() => unwrapCover(orphan)).not.toThrow();
    expect(orphan.children).toHaveLength(1);
  });
});

describe('liftAboveStickyWrapper', () => {
  const byId = (id: string) => document.getElementById(id)!;
  const lifted = (id: string) => `${byId(id).style.position || '-'}/${byId(id).style.zIndex || '-'}`;

  it('gives only the siblings from cover onward a position and z-index', () => {
    document.body.innerHTML
      = '<div id="host"><div id="base"></div><div id="cover"></div><div id="tail"></div></div>';

    liftAboveStickyWrapper(byId('cover'));

    expect(lifted('cover')).toBe('relative/1');
    expect(lifted('tail')).toBe('relative/1');
    // base is on the wrapper side, so it's left untouched
    expect(lifted('base')).toBe('-/-');
  });

  it('respects values the author specified explicitly', () => {
    document.body.innerHTML
      = '<div id="host"><div id="cover" style="position:absolute;z-index:5"></div></div>';

    liftAboveStickyWrapper(byId('cover'));

    expect(lifted('cover')).toBe('absolute/5');
  });

  it('fills in only the missing half when just one is specified explicitly', () => {
    document.body.innerHTML
      = '<div id="host"><div id="cover" style="position:relative"></div></div>';

    liftAboveStickyWrapper(byId('cover'));

    expect(lifted('cover')).toBe('relative/1');
  });

  // With multiple cover layers, the lifted ranges overlap
  // (an earlier cover's following siblings include a later base/cover). Without reference counting,
  // killing the earlier one would strip the z-order from the still-alive later one too.
  describe('when there are multiple cover layers (overlapping ranges)', () => {
    const setupTwoCovers = () => {
      document.body.innerHTML
        = '<div id="root"><div id="b1"></div><div id="c1"></div><div id="b2"></div><div id="c2"></div></div>';

      return {
        restore1: liftAboveStickyWrapper(byId('c1')),
        restore2: liftAboveStickyWrapper(byId('c2')),
      };
    };

    it('killing the earlier cover keeps the still-alive later cover\'s z-order intact', () => {
      const { restore1 } = setupTwoCovers();

      restore1();

      // c2 is cover #2's cover, so it must stay raised until cover #2 itself is killed
      expect(lifted('c2')).toBe('relative/1');
      // b2, meanwhile, is cover #2's base (the wrapper's contents).
      // It only needed lifting to sit above cover #1's wrapper, so it's correct for it to revert
      // as soon as cover #1 is killed
      expect(lifted('b2')).toBe('-/-');
    });

    it('killing only the later cover keeps it lifted until the earlier one is killed', () => {
      const { restore2 } = setupTwoCovers();

      restore2();

      expect(lifted('c2')).toBe('relative/1');
    });

    it('only reverts once both are killed (no leftover styles)', () => {
      const { restore1, restore2 } = setupTwoCovers();

      restore1();
      restore2();

      expect(lifted('c1')).toBe('-/-');
      expect(lifted('b2')).toBe('-/-');
      expect(lifted('c2')).toBe('-/-');
    });

    it('calling the restore function twice does not over-decrement the count', () => {
      const { restore1, restore2 } = setupTwoCovers();

      restore1();
      restore1();

      expect(lifted('c2')).toBe('relative/1');

      restore2();
      expect(lifted('c2')).toBe('-/-');
    });
  });

  it('the restore function clears only what it filled in', () => {
    document.body.innerHTML
      = '<div id="host"><div id="cover" style="position:relative"></div><div id="tail"></div></div>';

    liftAboveStickyWrapper(byId('cover'))();

    // The position the author wrote stays; only the z-index this function added is cleared
    expect(lifted('cover')).toBe('relative/-');
    expect(lifted('tail')).toBe('-/-');
  });

  it('puts back the inline static or auto it wrote over, !important included', () => {
    document.body.innerHTML
      = '<div id="host"><div id="cover" style="position: static !important; z-index: auto"></div></div>';

    const restore = liftAboveStickyWrapper(byId('cover'));

    expect(lifted('cover')).toBe('relative/1');

    restore();

    expect(byId('cover').style.cssText).toBe('position: static !important; z-index: auto;');
  });

  // A caller may restyle the covering side after registration (gsap.set, say), and the restore has
  // no business taking that value back.
  it('leaves a value written since the lift alone', () => {
    document.body.innerHTML = '<div id="host"><div id="cover"></div></div>';

    const restore = liftAboveStickyWrapper(byId('cover'));

    byId('cover').style.zIndex = '7';
    restore();

    expect(lifted('cover')).toBe('-/7');
  });

  // Same case one step further on: the caller's value is what the next lift measures, so the
  // property is the author's from then on.
  it('does not fill a property back in once the caller has claimed it', () => {
    document.body.innerHTML = '<div id="host"><div id="cover"></div></div>';

    const restore = liftAboveStickyWrapper(byId('cover'));

    byId('cover').style.zIndex = '7';
    restore();
    liftAboveStickyWrapper(byId('cover'));

    expect(lifted('cover')).toBe('relative/7');
  });
});

describe('compareDocumentOrder', () => {
  it('is negative when earlier in DOM order, positive when later, 0 when identical', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';

    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;

    expect(compareDocumentOrder(a, b)).toBe(-1);
    expect(compareDocumentOrder(b, a)).toBe(1);
    expect(compareDocumentOrder(a, a)).toBe(0);
  });

  it('places an ancestor before its descendant', () => {
    document.body.innerHTML = '<div id="outer"><div id="inner"></div></div>';

    const outer = document.getElementById('outer')!;
    const inner = document.getElementById('inner')!;

    expect(compareDocumentOrder(outer, inner)).toBe(-1);
    expect(compareDocumentOrder(inner, outer)).toBe(1);
  });

  it('sorting layers with this comparator is independent of registration order', () => {
    document.body.innerHTML = '<div id="1"></div><div id="2"></div><div id="3"></div>';

    const byId = (id: string) => document.getElementById(id)!;
    const shuffled = [byId('3'), byId('1'), byId('2')];

    shuffled.sort(compareDocumentOrder);

    expect(shuffled.map((el) => el.id)).toEqual(['1', '2', '3']);
  });
});

describe('stripStickyPositions', () => {
  const element = (style: string) => {
    document.body.innerHTML = `<div id="el" style="${style}"></div>`;

    return document.getElementById('el') as HTMLElement;
  };

  it('puts each element in flow with no offset, !important so no stylesheet rule shifts it', () => {
    const el = element('position: sticky; top: 10px');

    stripStickyPositions([el]);

    expect(el.style.cssText)
      .toBe('position: relative !important; top: auto !important; bottom: auto !important;');
  });

  it('puts an element with no inline values back to none', () => {
    const el = element('color: red');
    const restore = stripStickyPositions([el]);

    restore();

    expect(el.style.cssText).toBe('color: red;');
  });

  it('puts position, top and bottom back with their priority', () => {
    const sticky = element('position: sticky; top: 10px; bottom: 5px !important');
    const important = document.createElement('div');

    important.style.cssText = 'position: sticky !important; top: 3px !important';
    document.body.append(important);

    const restore = stripStickyPositions([sticky, important]);

    restore();

    expect(sticky.style.cssText).toBe('position: sticky; top: 10px; bottom: 5px !important;');
    expect(important.style.cssText).toBe('position: sticky !important; top: 3px !important;');
  });
});

describe('restoreInlinePosition', () => {
  it('takes off the bottom a reset wrote, for unwrapPin on a pin killed mid-read', () => {
    document.body.innerHTML = '<div id="outer"><div id="el" style="position: sticky; top: 4px"></div></div>';

    const el = document.getElementById('el') as HTMLElement;
    const saved = captureInlinePosition(el);

    stripStickyPositions([el]);
    unwrapPin(document.getElementById('outer') as HTMLDivElement, el, saved);

    expect(el.style.cssText).toBe('position: sticky; top: 4px;');
  });

  it('leaves a bottom set since the capture alone', () => {
    document.body.innerHTML = '<div id="el"></div>';

    const el = document.getElementById('el') as HTMLElement;
    const saved = captureInlinePosition(el);

    el.style.bottom = '9px';
    restoreInlinePosition(el, saved);

    expect(el.style.bottom).toBe('9px');
  });
});

describe('insertSpacers', () => {
  it('puts a block of each height right after its element and takes them all out again', () => {
    document.body.innerHTML = '<div id="parent"><div id="a"></div><div id="b"></div></div>';

    const parent = document.getElementById('parent')!;
    const remove = insertSpacers([
      { after: document.getElementById('a')!, height: 300 },
      { after: document.getElementById('b')!, height: 50 },
    ]);
    const spacers = Array.from(parent.children as HTMLCollectionOf<HTMLElement>)
      .filter((el) => !el.id);

    expect(Array.from(parent.children, (el) => el.id || (el as HTMLElement).style.height))
      .toEqual(['a', '300px', 'b', '50px']);
    expect(spacers.map(({ style }) => [style.margin, style.padding, style.borderWidth]))
      .toEqual([['0px', '0px', '0px'], ['0px', '0px', '0px']]);

    remove();

    expect(ids(parent)).toEqual(['a', 'b']);
  });
});

describe('measureViewportHeight', () => {
  it('falls back to window.innerHeight since jsdom\'s offsetHeight is always 0', () => {
    document.body.innerHTML = '';

    expect(measureViewportHeight()).toBe(window.innerHeight);
  });

  it('leaves no measuring div behind (body\'s child count is unchanged before/after the call)', () => {
    document.body.innerHTML = '<div id="unrelated"></div>';

    const before = document.body.children.length;

    measureViewportHeight();

    expect(document.body.children.length).toBe(before);
  });
});

// jsdom resolves declared values through getComputedStyle, which is where measureUsedHeight gets
// every number it uses, so the box-sizing arithmetic is verifiable here. Only offsetHeight (always
// 0 without layout) needs e2e.
describe('measureUsedHeight', () => {
  const measure = (css: string) => {
    document.body.innerHTML = `<div id="el" style="${css}"></div>`;

    return measureUsedHeight(document.getElementById('el') as HTMLElement);
  };

  it('adds a content-box element\'s padding and borders back, keeping the fractions', () => {
    expect(measure(
      'height:100.25px;padding:5.5px 0;border-top:1.25px solid red;border-bottom:2.25px solid red',
    )).toBe(114.75);
  });

  it('adds nothing to a border-box element, whose computed height is the border box', () => {
    expect(measure('box-sizing:border-box;height:100.25px;padding:5.5px 0')).toBe(100.25);
  });

  it('counts no border on a side whose border-style leaves it undrawn', () => {
    expect(measure('height:30.5px;border-top-width:4px')).toBe(30.5);
  });

  it('falls back to offsetHeight where there is no used height to read', () => {
    expect(measure('padding:5px 0')).toBe(0);
    expect(measureUsedHeight(document.createElement('div'))).toBe(0);
  });

  // Stubbing offsetHeight is the only way to stage the disagreement here. The case that produces
  // it in a browser, WebKit's space-taking scrollbar, is e2e's "a scrollbar that takes space".
  it('hands back to offsetHeight when the two disagree by a pixel or more', () => {
    document.body.innerHTML = '<div id="el" style="height:100.25px"></div>';

    const el = document.getElementById('el') as HTMLElement;
    const reportOffsetHeight = (value: number) =>
      Object.defineProperty(el, 'offsetHeight', { value, configurable: true });

    // 15px short, the size of the scrollbar WebKit leaves out of the height it reports.
    reportOffsetHeight(115);
    expect(measureUsedHeight(el)).toBe(115);

    // A quarter of a pixel apart is the rounding it should be, so the precise number stands.
    reportOffsetHeight(100);
    expect(measureUsedHeight(el)).toBe(100.25);
  });
});

describe('measureDocumentMaxScroll', () => {
  // jsdom reports scrollHeight as always 0 (no layout engine), so only the floor-at-0 behavior
  // can be verified here. The real "document height minus viewport height" arithmetic needs
  // real layout; that's e2e's job.
  it('floors at 0 when the viewport height exceeds the (jsdom-reported-0) document height', () => {
    expect(measureDocumentMaxScroll(800)).toBe(0);
  });
});
