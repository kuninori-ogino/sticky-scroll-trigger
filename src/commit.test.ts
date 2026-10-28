// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  clearHeightForRead,
  clearStickyForRead,
  commitHeight,
  commitInert,
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

describe('commitInert', () => {
  it('takes sticky off the wrapper and the dwell off the padding, and nothing else', () => {
    document.body.innerHTML = `
      <div id="wrapper" style="position: sticky; top: 10px; z-index: 0; height: 5px"></div>
      <div id="padding" style="height: 200px; width: 1px"></div>`;

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

  it('puts back empty values, leaving no sticky behind', () => {
    const el = element();
    const saved = captureInlinePosition(el);

    commitSticky(el, 39);
    commitPosition(el, saved);

    expect(el.style.position).toBe('');
    expect(el.style.top).toBe('');
  });
});
