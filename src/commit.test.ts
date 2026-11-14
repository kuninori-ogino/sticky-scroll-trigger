// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  clearHeightForRead,
  clearStickyForRead,
  commitCarriedMargin,
  commitContainerMargin,
  commitCssText,
  commitHeight,
  commitHeldMargin,
  commitInert,
  commitMarginProbe,
  captureOuterPosition,
  commitOuterPosition,
  commitPinOffsets,
  commitPosition,
  commitSticky,
  holdRelativeForRead,
} from './commit';
import { captureInlinePosition, liftAboveStickyWrapper } from './dom';

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
});

describe('commitContainerMargin', () => {
  it('sets the container\'s bottom margin, and clears it with null', () => {
    const container = element('height: 300px');

    commitContainerMargin(container, -10);

    expect(container.style.cssText).toBe('height: 300px; margin-bottom: -10px;');

    commitContainerMargin(container, null);

    expect(container.style.cssText).toBe('height: 300px;');
  });
});

describe('commitMarginProbe', () => {
  it('sets only the padding\'s top margin', () => {
    const padding = element('height: 200px; margin-top: -30px; margin-bottom: 30px');

    commitMarginProbe(padding, 1e6);

    expect([padding.style.height, padding.style.marginTop, padding.style.marginBottom])
      .toEqual(['200px', '1000000px', '30px']);
  });
});

describe('commitInert', () => {
  it('takes sticky off the wrapper, the dwell and carried margins off the level, and nothing else', () => {
    document.body.innerHTML = `
      <div id="container" style="width: 2px; margin-bottom: -10px">
        <div id="wrapper" style="position: sticky; top: 10px; z-index: 0; height: 5px"></div>
        <div id="padding" style="height: 200px; width: 1px; margin-top: -16px; margin-bottom: 16px"></div>
      </div>`;

    const container = document.getElementById('container')!;
    const wrapper = document.getElementById('wrapper')!;
    const padding = document.getElementById('padding')!;

    commitInert(wrapper, padding, container);

    expect(wrapper.style.cssText).toBe('z-index: 0; height: 5px;');
    expect(padding.style.cssText).toBe('height: 0px; width: 1px;');
    expect(container.style.cssText).toBe('width: 2px;');
  });

  it('leaves the padding and container out when there are none', () => {
    const wrapper = element('position: sticky; top: 10px');

    commitInert(wrapper, null, null);

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

  // The lift's restore gives outer what the last commit would without the lift, whichever of the
  // two wrote position first.
  it.each([
    ['an offset carried since the lift', 'position: static !important', { top: 40, left: 0 }, 'relative'],
    ['none, over a lift made before outer had a position', '', null, 'static'],
  ])('leaves outer as unlifted on the lift\'s restore: %s', (_, style, carried, position) => {
    document.body.innerHTML = `<div id="cover"></div><div id="outer" style="${style}"></div>`;

    const outer = document.getElementById('outer')!;
    const restore = liftAboveStickyWrapper(document.getElementById('cover')!);

    commitPinOffsets(outer, carried);
    restore();

    expect(offsets(outer).slice(0, 2))
      .toEqual([`${position} important`, carried ? '40px important' : 'auto important']);
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
  // A rollback puts the lift's record back with outer's offset, so a lift coming off later leaves
  // outer as the last successful refresh() did.
  it('rolls back outer\'s offset and the position handed to the lift', () => {
    document.body.innerHTML = '<div id="cover"></div><div id="outer"></div>';

    const outer = document.getElementById('outer')!;
    const restore = liftAboveStickyWrapper(document.getElementById('cover')!);

    commitPinOffsets(outer, { top: 40, left: 0 });

    const saved = captureOuterPosition(outer);

    commitPinOffsets(outer, null);
    commitOuterPosition(outer, saved);
    restore();

    expect([outer.style.position, outer.style.top]).toEqual(['relative', '40px']);
  });
});
