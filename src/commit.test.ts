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
  commitPosition,
  commitSticky,
} from './commit';
import { captureInlinePosition } from './dom';

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
