/**
 * Builds freezeWindow.ts's `StartSpec` / `EndSpec` / `LayerMeasurement` for one layer: reads its
 * natural position out of the DOM and resolves start/end into the numbers and modes that pass 2
 * plans from. Everything here runs in refresh()'s pass 1, once per active layer.
 *
 * This is the DOM-touching half of that resolution. freezeWindow.ts can't hold it, since that
 * module documents that it neither measures nor writes the DOM; position.ts holds the parsing
 * half, which is pure.
 */

import { describeElement, documentTop, measureUsedHeight } from './dom';
import type { EndSpec, LayerMeasurement, StartSpec } from './freezeWindow';
import {
  classifyPosition,
  prefixSpacedRelativeEnd,
  resolveAnchorTop,
  resolveDwell,
  resolveElementAnchor,
  resolveMaxOffset,
  resolveMaybeFn,
} from './position';
import type { EndValue, PositionValue } from './position';
import type { Layer } from './types';

// Converts a resolved end value into an EndSpec. Only a position-clause end needs a decision
// here: where endTrigger's position comes from.
// - inside the shared container, registered or not: pass 1 measures it, pass 2 adds the dwell of
//   the Scene layers that would delay it (a Scene layer's end by GSAP's pin rule, a cover's by
//   when each scene freezes). A Scene layer's forward reference is rejected outright.
// - unregistered, outside it: padding shifts the measurement, so pass 2 re-measures (measureLive).
export const resolveEndSpec = (
  rootElement: HTMLElement,
  viewportHeight: number,
  layer: Layer,
  endResolved: EndValue | null,
  ownIndex: number,
  endTriggerIndex: number | null,
): EndSpec => {
  if (endResolved === null) return { mode: 'auto' };

  const classified = classifyPosition(endResolved);

  switch (classified.kind) {
    case 'dwell':
      return {
        mode: 'dwell',
        distancePx: Math.max(0, resolveDwell(classified.value, viewportHeight)),
      };

    case 'absolute':
      return { mode: 'absolute', value: classified.value };

    // A Scene layer's own dwell padding adds to the document's max scroll position, so a 'max'
    // end would depend on itself, growing the page a little more on every refresh instead of
    // settling. Cover layers add no padding.
    case 'max':
      if (layer.kind !== 'cover') {
        throw new Error(
          `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)} `
          + `has end "${endResolved}". GSAP's 'max' keyword isn't supported here: the layer's `
          + 'own dwell padding adds to the document\'s max scroll position, so the freeze window '
          + 'would depend on itself. Use createOverlapScroll, which adds no padding, or a dwell '
          + 'distance such as \'+=500\'.',
        );
      }

      return { mode: 'max', offsetPx: resolveMaxOffset(classified.value, viewportHeight) };

    case 'clause': {
      // Rejected for a Scene layer as an API decision: planLayers could resolve it, since the
      // endTrigger is measured unpadded and the layer's own dwell never counts toward its end.
      // Cover layers support it.
      if (layer.kind !== 'cover' && endTriggerIndex !== null && endTriggerIndex > ownIndex) {
        throw new Error(
          `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)}'s `
          + `endTrigger (${describeElement(layer.endTrigger)}) refers to a layer positioned later `
          + 'in DOM order, which isn\'t supported for createStickyTrigger. Point endTrigger at a '
          + 'layer earlier in DOM order, use an unregistered element at the same spot, or use a '
          + 'dwell distance such as \'+=500\'.',
        );
      }

      const unregistered = endTriggerIndex === null;
      const insideRoot = rootElement.contains(layer.endTrigger);

      // A Scene layer stretches the document by its own dwell, pushing an endTrigger outside the
      // shared container down by that same amount, so the equation has no solution. Cover layers
      // add no padding, so they're safe.
      if (unregistered && !insideRoot && layer.kind !== 'cover') {
        throw new Error(
          `StickyScrollTrigger: createStickyTrigger's trigger ${describeElement(layer.trigger)} `
          + `has an endTrigger (${describeElement(layer.endTrigger)}) outside the shared `
          + 'container: the layer\'s own dwell keeps pushing it away, so the freeze window never '
          + 'settles. Point endTrigger at an element inside the container, or use a dwell distance '
          + 'such as \'+=500\'.',
        );
      }

      return {
        mode: 'clause',
        clause: classified.value,
        rawTop: unregistered && insideRoot ? documentTop(layer.endTrigger) : null,
        measureLive: unregistered && !insideRoot,
      };
    }
  }
};

// Converts a resolved start value into a StartSpec. position.ts's isAbsoluteFormat defines which
// values GSAP reads as an absolute scroll position rather than a clause.
// A cover layer's stickyTop is computed relative to its own wrapper's natural position (see
// freezeWindow.ts), so it needs a clause. An absolute scroll position means nothing in that
// local coordinate space, so this throws instead of turning it into a plausible-looking number.
// A Scene layer's stickyTop is already document-absolute and works with either.
export const resolveStartSpec = (
  layer: Layer,
  startResolved: PositionValue,
  elementHeight: number,
  viewportHeight: number,
): StartSpec => {
  const classified = classifyPosition(startResolved);

  switch (classified.kind) {
    case 'absolute':
      if (layer.kind === 'cover') {
        throw new Error(
          `StickyScrollTrigger: createOverlapScroll's trigger ${describeElement(layer.trigger)} `
          + `has start "${startResolved}", an absolute scroll position (GSAP reads any bare `
          + 'number this way). That isn\'t supported here: a cover layer\'s sticky position is '
          + 'computed relative to its own wrapper, so start must be a position clause such as '
          + '\'bottom bottom\'.',
        );
      }

      return { mode: 'absolute', value: classified.value };

    // 'max' and a dwell are end notation, and neither gets its own answer here: both go to
    // resolveAnchorTop as an ordinary clause would, which is where they part. 'max' throws there,
    // out of parseClauseToken's "'max' is GSAP's end-only keyword", while a dwell parses as an
    // offset with an implicit base of 0. Naming both cases keeps that a stated decision instead
    // of an unlabeled fall-through.
    case 'max':
    case 'dwell':
    case 'clause':
      return {
        mode: 'clause',
        anchorOffset: resolveAnchorTop(classified.value, elementHeight, viewportHeight),
        elementAnchor: resolveElementAnchor(classified.value, elementHeight),
      };
  }
};

// Measures one layer's natural absolute position and resolves its start/end, in
// #planLayerPositions' pass 1.
export const measureLayer = (
  rootElement: HTMLElement,
  viewportHeight: number,
  layer: Layer,
  ownIndex: number,
  indexByTrigger: ReadonlyMap<HTMLElement, number>,
): LayerMeasurement => {
  const startResolved = resolveMaybeFn(layer.start);
  const endResolved = layer.end === null
    ? null
    : prefixSpacedRelativeEnd(startResolved, resolveMaybeFn(layer.end));
  const elementHeight = measureUsedHeight(layer.trigger);
  const endTriggerIsSelf = layer.endTrigger === layer.trigger;
  const endTriggerIndex = indexByTrigger.get(layer.endTrigger) ?? null;
  const end = resolveEndSpec(
    rootElement,
    viewportHeight,
    layer,
    endResolved,
    ownIndex,
    endTriggerIndex,
  );
  const start = resolveStartSpec(layer, startResolved, elementHeight, viewportHeight);

  return {
    kind: layer.kind,
    start,
    triggerTop: documentTop(layer.trigger),
    triggerHeight: elementHeight,
    triggerEnclosedBy: [...indexByTrigger]
      .filter(([trigger]) => trigger.contains(layer.trigger))
      .map(([, index]) => index),
    wrapperTop: layer.wrapper ? documentTop(layer.wrapper) : 0,
    coverTop: layer.kind === 'cover' ? documentTop(layer.cover) : 0,
    end,
    endTriggerIsSelf,
    endTriggerIndex,
    endTriggerHeight: end.mode === 'clause' ? measureUsedHeight(layer.endTrigger) : 0,
    // A registered endTrigger counts as enclosing itself: its own pin holds it too.
    endTriggerEnclosedBy: end.mode === 'clause' && !end.measureLive && !endTriggerIsSelf
      ? [...indexByTrigger]
          .filter(([trigger]) => trigger.contains(layer.endTrigger))
          .map(([, index]) => index)
      : [],
  };
};
