/**
 * Type definitions for the public options and the internal layer (Layer) representation.
 */

import type { EndInput, PositionInput } from './position';
import type { EXCLUDED_VAR_KEYS } from './vars';

// ScrollTrigger.Vars keys this module decides for itself. See vars.ts for the full list and why
// each is excluded; index.ts's #assertNoExcludedVars enforces the same list at runtime, since
// PassThroughVars only stops a TypeScript caller.
export type PassThroughVars = Omit<ScrollTrigger.Vars, typeof EXCLUDED_VAR_KEYS[number]>;

export interface StickyScrollTriggerOptions {
  // Which elements inside the shared container get their scroll-margin-top kept in sync, so the
  // browser's own scroll-into-view accounts for Scene layer dwell (see scrollMargin.ts).
  // Defaults to '[id]', the set that same-page fragment links and ':target' can actually reach.
  // Pass null to leave scroll-margin-top alone entirely.
  scrollMarginTargets?: string | null;
}

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
  // Where trigger lands in the viewport while pinned, in the same position syntax as the other
  // methods' start (e.g. 'top top', 'bottom bottom', 'top 20%'). Defaults to 'top top'.
  // A bare number means GSAP's absolute scroll position here, and passing one throws: a pin
  // engages when position:sticky engages, so it has nothing to set on the scroll axis. Use `top`
  // for a px distance instead.
  start?: PositionInput;
  // A px distance from the viewport's top edge, i.e. sticky's own CSS `top`, as a plain number:
  // the one thing the syntax above can't spell. top: 20 is start: 'top 20px'. Defaults to 0.
  // Passing both start and top is an error.
  top?: number | (() => number);
  endTrigger: string | HTMLElement;
  end?: PositionInput; // Which position of endTrigger releases the pin. Defaults to 'top top'.
}

export interface PinLayer {
  trigger: HTMLElement;
  // Nesting assigned during build() (outer: height 0, inner: actual height).
  outer: HTMLDivElement | null;
  inner: HTMLDivElement | null;
  // Always a position clause: createStickyPin normalizes a `top` option into one at registration
  // (see its topToStartClause).
  start: PositionInput;
  endTrigger: HTMLElement;
  end: PositionInput;
}
