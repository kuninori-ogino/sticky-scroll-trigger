// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  applyStickyPosition,
  captureInlinePosition,
  compareDocumentOrder,
  describeElement,
  liftAboveStickyWrapper,
  measureDocumentMaxScroll,
  measureViewportHeight,
  resetStickyPosition,
  resolveElement,
  restoreInlinePosition,
  resolveEndTrigger,
  resolveRoot,
  unwrapCover,
  unwrapPin,
  wrapCover,
  wrapPin,
  wrapScene,
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

describe('applyStickyPosition/resetStickyPosition', () => {
  it('applyStickyPosition sets position:sticky and the given top offset in px', () => {
    const el = document.createElement('div');

    applyStickyPosition(el, 39);

    expect(el.style.position).toBe('sticky');
    expect(el.style.top).toBe('39px');
  });

  it('resetStickyPosition clears both position and top', () => {
    const el = document.createElement('div');

    applyStickyPosition(el, 39);
    resetStickyPosition(el);

    expect(el.style.position).toBe('');
    expect(el.style.top).toBe('');
  });
});

describe('captureInlinePosition/restoreInlinePosition', () => {
  it('puts back the values applyStickyPosition overwrote', () => {
    const el = document.createElement('div');

    el.style.position = 'relative';
    el.style.top = '8px';

    const saved = captureInlinePosition(el);

    applyStickyPosition(el, 39);
    restoreInlinePosition(el, saved);

    expect(el.style.position).toBe('relative');
    expect(el.style.top).toBe('8px');
  });

  it('leaves an element that had no inline values with none', () => {
    const el = document.createElement('div');
    const saved = captureInlinePosition(el);

    applyStickyPosition(el, 39);
    restoreInlinePosition(el, saved);

    expect(el.style.position).toBe('');
    expect(el.style.top).toBe('');
  });
});

describe('wrapScene', () => {
  it('wraps inner in container{wrapper[inner], padding} and inserts it at the original position', () => {
    document.body.innerHTML
      = '<div id="host"><i id="before"></i><div id="inner"></div><i id="after"></i></div>';

    const host = document.getElementById('host')!;
    const inner = document.getElementById('inner')!;
    const { container, wrapper, padding } = wrapScene(inner);

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

  it('excludes padding from assistive tech and hit testing', () => {
    document.body.innerHTML = '<div><div id="inner"></div></div>';

    const { padding } = wrapScene(document.getElementById('inner')!);

    expect(padding.getAttribute('aria-hidden')).toBe('true');
    expect(padding.style.pointerEvents).toBe('none');
  });

  it('throws for an inner not attached to the document', () => {
    expect(() => wrapScene(document.createElement('div'))).toThrow(/not attached to the document/);
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

    applyStickyPosition(trigger, 39);
    unwrapPin(outer, trigger, { position: 'relative', top: '8px' });

    expect(trigger.style.position).toBe('relative');
    expect(trigger.style.top).toBe('8px');
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

describe('measureDocumentMaxScroll', () => {
  // jsdom reports scrollHeight as always 0 (no layout engine), so only the floor-at-0 behavior
  // can be verified here. The real "document height minus viewport height" arithmetic needs
  // real layout; that's e2e's job.
  it('floors at 0 when the viewport height exceeds the (jsdom-reported-0) document height', () => {
    expect(measureDocumentMaxScroll(800)).toBe(0);
  });
});
