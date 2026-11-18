// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  clearHeightForRead,
  clearStickyForRead,
  commitCarriedMargin,
  commitCssText,
  commitHeight,
  commitHeldMargin,
  commitInert,
  commitOuterPosition,
  commitPinOffsets,
  commitPosition,
  commitSticky,
  holdRelativeForRead,
  isMarginHeld,
} from './commit';
import { captureInlinePosition, liftAboveStickyWrapper, wrapScene } from './dom';

// Only inline styles, which jsdom handles in full.

const element = (style = '') => {
  document.body.innerHTML = `<div id="el" style="${style}"></div>`;

  return document.getElementById('el')!;
};

describe('commitSticky', () => {
  it('writes position:sticky and the top in px, fractional and negative too', () => {
    const el = element();

    commitSticky(el, 39);

    expect(el.style.position).toBe('sticky');
    expect(el.style.top).toBe('39px');

    commitSticky(el, -12.5);

    expect(el.style.top).toBe('-12.5px');
  });
});

describe('commitHeight', () => {
  it('writes the height as given, and an empty one clears it', () => {
    const el = element();

    commitHeight(el, '120px');

    expect(el.style.height).toBe('120px');

    commitHeight(el, '');

    expect(el.style.height).toBe('');
  });
});

describe('clearStickyForRead', () => {
  it('clears position and top only', () => {
    const el = element('position: sticky; top: 10px; z-index: 0; will-change: opacity; height: 5px');

    clearStickyForRead(el);

    expect(el.style.position).toBe('');
    expect(el.style.top).toBe('');
    expect(el.style.zIndex).toBe('0');
    expect(el.style.willChange).toBe('opacity');
    expect(el.style.height).toBe('5px');
  });
});

// What a clear takes off goes back to the neutral value, !important, so a page rule on divs can't
// take its place.
describe('clears on a Scene level', () => {
  const level = () => {
    document.body.innerHTML = '<div><div id="inner"></div></div>';

    return wrapScene(document.getElementById('inner')!, false);
  };

  const inline = (el: HTMLElement, properties: string[]) => properties.map((property) =>
    `${el.style.getPropertyValue(property)} ${el.style.getPropertyPriority(property)}`);

  it('clearStickyForRead leaves the wrapper static', () => {
    const { wrapper } = level();

    commitSticky(wrapper, 10);
    clearStickyForRead(wrapper);

    expect(inline(wrapper, ['position', 'top'])).toEqual(['static important', 'auto important']);
  });

  it('commitCarriedMargin(null) leaves no margin', () => {
    const { padding } = level();

    commitCarriedMargin(padding, 16);
    commitCarriedMargin(padding, null);

    expect(inline(padding, ['margin-top', 'margin-bottom']))
      .toEqual(['0px important', '0px important']);
  });

  it('commitInert leaves the wrapper static', () => {
    const { wrapper, padding } = level();

    commitSticky(wrapper, 10);
    commitInert(wrapper, padding);

    expect(inline(wrapper, ['position', 'top'])).toEqual(['static important', 'auto important']);
  });
});

describe('clearHeightForRead', () => {
  it('clears the height only', () => {
    const el = element('height: 5px; position: sticky; top: 10px');

    clearHeightForRead(el);

    expect(el.style.height).toBe('');
    expect(el.style.position).toBe('sticky');
    expect(el.style.top).toBe('10px');
  });
});

describe('commitCarriedMargin', () => {
  it('cancels the margin above the padding and carries it below', () => {
    const padding = element('height: 200px');

    commitCarriedMargin(padding, 16);

    expect(padding.style.cssText).toBe('height: 200px; margin-top: -16px; margin-bottom: 16px;');

    commitCarriedMargin(padding, -20);

    expect([padding.style.marginTop, padding.style.marginBottom]).toEqual(['20px', '-20px']);
  });

  it('clears both with null, and nothing else', () => {
    const padding = element('height: 200px; margin-top: -16px; margin-bottom: 16px');

    commitCarriedMargin(padding, null);

    expect(padding.style.cssText).toBe('height: 200px;');
  });
});

describe('commitHeldMargin', () => {
  it('makes the sentinel a flow-root while held and lays it out as nothing otherwise', () => {
    const sentinel = element('display: none');

    commitHeldMargin(sentinel, true);

    expect(sentinel.style.cssText).toBe('display: flow-root;');

    commitHeldMargin(sentinel, false);

    expect(sentinel.style.cssText).toBe('display: none;');
  });

  it('is what isMarginHeld reads back', () => {
    const sentinel = element('display: none');

    expect(isMarginHeld(sentinel)).toBe(false);

    commitHeldMargin(sentinel, true);

    expect(isMarginHeld(sentinel)).toBe(true);

    commitHeldMargin(sentinel, false);

    expect(isMarginHeld(sentinel)).toBe(false);
  });
});

describe('commitInert', () => {
  it('takes sticky off the wrapper, the dwell and carried margins off the level, and nothing else', () => {
    document.body.innerHTML = `
      <div id="wrapper" style="position: sticky; top: 10px; z-index: 0; height: 5px"></div>
      <div id="padding" style="height: 200px; width: 1px; margin-top: -16px; margin-bottom: 16px"></div>`;

    const wrapper = document.getElementById('wrapper')!;
    const padding = document.getElementById('padding')!;

    commitInert(wrapper, padding);

    expect(wrapper.style.cssText).toBe('z-index: 0; height: 5px;');
    expect(padding.style.cssText).toBe('height: 0px; width: 1px;');
  });

  it('leaves the padding out when there is none', () => {
    const wrapper = element('position: sticky; top: 10px');

    commitInert(wrapper, null);

    expect(wrapper.style.cssText).toBe('');
  });
});

describe('commitPosition', () => {
  it('puts back the position/top captured before a clear', () => {
    const el = element('position: relative; top: 8px');
    const saved = captureInlinePosition(el);

    clearStickyForRead(el);
    commitPosition(el, saved);

    expect(el.style.position).toBe('relative');
    expect(el.style.top).toBe('8px');
  });

  it('puts an !important value back as one', () => {
    const el = element('position: relative !important; top: 8px !important');
    const saved = captureInlinePosition(el);

    clearStickyForRead(el);
    commitPosition(el, saved);

    expect(el.style.cssText).toBe('position: relative !important; top: 8px !important;');
  });

  it('puts back empty values, leaving no sticky behind', () => {
    const el = element();
    const saved = captureInlinePosition(el);

    commitSticky(el, 39);
    commitPosition(el, saved);

    expect(el.style.position).toBe('');
    expect(el.style.top).toBe('');
  });
});

describe('commitCssText', () => {
  // jsdom applies no Content Security Policy, which would ignore a setAttribute('style') here.
  it('puts the inline style back whole, through CSSOM', () => {
    const el = element('height: 5px; width: 20px');
    const saved = el.style.cssText;
    const setAttribute = vi.spyOn(el, 'setAttribute');

    el.style.cssText = 'display: contents; flex: 0 0 auto';
    commitCssText(el, saved);

    expect(el.style.cssText).toBe('height: 5px; width: 20px;');
    expect(setAttribute).not.toHaveBeenCalled();
  });
});

describe('commitPinOffsets', () => {
  const offsets = (el: HTMLElement) => ['position', 'top', 'right', 'bottom', 'left'].map(
    (property) => `${el.style.getPropertyValue(property)} ${el.style.getPropertyPriority(property)}`,
  );

  it('makes outer relative with the offset in px, all !important', () => {
    const outer = element();

    commitPinOffsets(outer, { top: 40, left: -12.5 });

    expect(offsets(outer)).toEqual([
      'relative important', '40px important', 'auto important', 'auto important',
      '-12.5px important',
    ]);
  });

  it('makes outer static with none, relative where a cover\'s lift raises it', () => {
    document.body.innerHTML = '<div id="cover"></div><div id="outer"></div>';

    const outer = document.getElementById('outer')!;

    commitPinOffsets(outer, null);
    expect(offsets(outer)[0]).toBe('static important');

    const restore = liftAboveStickyWrapper(document.getElementById('cover')!);

    commitPinOffsets(outer, null);
    expect(offsets(outer).slice(0, 2)).toEqual(['relative important', 'auto important']);

    // The lift wrote relative !important too, so its restore finds its own value: static is back.
    restore();
    expect(offsets(outer)[0]).toBe('static important');
  });
});

describe('holdRelativeForRead', () => {
  it('keeps trigger relative with every offset at auto, !important', () => {
    const el = element('position: relative; top: 40px; left: 20px');

    holdRelativeForRead(el);

    expect(el.style.cssText).toBe('position: relative !important; top: auto !important; '
      + 'left: auto !important; bottom: auto !important; right: auto !important;');
  });
});

describe('commitOuterPosition', () => {
  // A lifted outer with no offset is relative, and keeps its !important through the rollback.
  it('rolls back outer\'s offset with its priority', () => {
    document.body.innerHTML = '<div id="cover"></div><div id="outer"></div>';

    const outer = document.getElementById('outer')!;
    const restore = liftAboveStickyWrapper(document.getElementById('cover')!);

    commitPinOffsets(outer, null);

    const saved = captureInlinePosition(outer);

    commitPinOffsets(outer, { top: 40, left: 0 });
    commitOuterPosition(outer, saved);

    const position = [outer.style.position, outer.style.getPropertyPriority('position'),
      outer.style.top];

    restore();
    expect(position).toEqual(['relative', 'important', 'auto']);
  });
});
