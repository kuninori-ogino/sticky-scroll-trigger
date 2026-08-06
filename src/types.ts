/**
 * Type definitions for the public options and the internal layer (Layer) representation.
 */

import type { EndInput, PositionInput } from './position';

// ScrollTrigger.Vars minus the fields this module decides for itself.
// Why excluded: (1) this module derives these itself (trigger/start/end/endTrigger);
// (2) the pin family is meaningless since sticky handles pinning;
// (3) these assume vertical, window scrolling,
// so passing them would silently throw things off (horizontal/scroller/containerAnimation).
export type PassThroughVars = Omit<
  ScrollTrigger.Vars,
  | 'trigger'
  | 'start'
  | 'end'
  | 'endTrigger'
  | 'pin'
  | 'pinSpacing'
  | 'anticipatePin'
  | 'pinnedContainer'
  | 'pinReparent'
  | 'pinSpacer'
  | 'pinType'
  | 'horizontal'
  | 'scroller'
  | 'containerAnimation'
>;

// trigger/endTrigger/cover also accept a CSS selector string, resolved via document.querySelector
// (same as GSAP ScrollTrigger's own trigger/endTrigger).
export interface CreateStickyTriggerOptions extends PassThroughVars {
  trigger: string | HTMLElement;
  start?: PositionInput;
  end?: EndInput;
  // Reference element for a position-clause end. Defaults to trigger itself.
  endTrigger?: string | HTMLElement;
}

export interface CreateResolvedTriggerOptions extends PassThroughVars {
  trigger: string | HTMLElement;
  start: PositionInput;
  end: PositionInput;
  // start is relative to trigger, end to this element. Defaults to trigger itself.
  endTrigger?: string | HTMLElement;
}

export interface CreateOverlapScrollOptions extends PassThroughVars {
  // The pinned side that gets covered. Must sit directly inside the shared container.
  trigger: string | HTMLElement;
  // The first element of the covering side. Defaults to trigger.nextElementSibling.
  cover?: string | HTMLElement;
  start?: PositionInput; // trigger's pinned position. Defaults to 'bottom bottom'.
  // When omitted (null), auto-computed as "the distance until cover's top edge arrives".
  end?: EndInput | null;
  endTrigger?: string | HTMLElement; // Defaults to trigger itself.
}

interface LayerBase {
  trigger: HTMLElement;
  endTrigger: HTMLElement;
  wrapper: HTMLDivElement | null;
  start: PositionInput;
  freezeStart: number; // Absolute scroll position (px) of the freeze window, computed by refresh().
  freezeEnd: number; // Invariant: freezeEnd >= freezeStart (clamped for every end mode).
}

export interface SceneLayer extends LayerBase {
  kind: 'scene';
  container: HTMLDivElement | null; // Assigned during build().
  padding: HTMLDivElement | null;
  end: EndInput;
}

export interface CoverLayer extends LayerBase {
  kind: 'cover';
  cover: HTMLElement;
  end: EndInput | null; // null means "auto-compute the distance to fully cover it".
}

export type Layer = SceneLayer | CoverLayer;

export interface CreateStickyPinOptions extends PassThroughVars {
  trigger: string | HTMLElement;
  // Distance (px) from the viewport's top edge to pin at, while pinned. Defaults to 0.
  top?: number | (() => number);
  endTrigger: string | HTMLElement;
  end?: PositionInput; // Which position of endTrigger releases the pin. Defaults to 'top top'.
}

export interface PinLayer {
  trigger: HTMLElement;
  // Nesting assigned during build() (outer: height 0, inner: actual height).
  outer: HTMLDivElement | null;
  inner: HTMLDivElement | null;
  top: number | (() => number);
  endTrigger: HTMLElement;
  end: PositionInput;
}
