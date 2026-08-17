/**
 * Structural operations that wrap/unwrap the shared container in nested sticky layers.
 * These don't depend on layout; they only rearrange the DOM and assign layer references.
 */

import { compareDocumentOrder, unwrapCover, wrapCover, wrapScene } from './dom';
import type { Layer } from './types';

// Returns whether layers is out of DOM order. buildStructure always sorts before building, so
// anything out of order means the trigger elements moved since the last build. register and kill
// can't detect a reorder with no additions or removals, so refresh() checks this to decide
// whether to rebuild.
export const isDomOrderStale = (layers: readonly Layer[]): boolean => {
  for (let i = 1; i < layers.length; i += 1) {
    if (compareDocumentOrder(layers[i - 1].trigger, layers[i].trigger) > 0) return true;
  }

  return false;
};

/**
 * Sorts layers into DOM order (earlier = deeper = freezes first) and builds the nesting.
 * Cover layers wrap "the start up to trigger" inside the shared container;
 * Scene layers wrap the entire shared container from the outside.
 * @returns The outermost container of the Scene layer nesting (null if there are no Scene layers)
 */
export const buildStructure = (
  rootElement: HTMLElement,
  layers: Layer[],
): HTMLDivElement | null => {
  layers.sort((a, b) => compareDocumentOrder(a.trigger, b.trigger));

  for (const layer of layers) {
    if (layer.kind !== 'cover') continue;

    layer.wrapper = wrapCover(layer.trigger);
  }

  let inner: HTMLElement = rootElement;
  let outermost: HTMLDivElement | null = null;

  for (const layer of layers) {
    if (layer.kind !== 'scene') continue;

    const wrapped = wrapScene(inner);

    layer.container = wrapped.container;
    layer.wrapper = wrapped.wrapper;
    layer.padding = wrapped.padding;
    inner = wrapped.container;
    outermost = wrapped.container;
  }

  return outermost;
};

// Tears down the nesting, returning the shared container and everything cover layers wrapped to
// their original positions.
export const unbuildStructure = (
  rootElement: HTMLElement,
  layers: readonly Layer[],
  outermostContainer: HTMLDivElement | null,
): void => {
  if (outermostContainer) {
    outermostContainer.parentNode?.insertBefore(rootElement, outermostContainer);
    outermostContainer.remove();
  }

  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];

    if (layer.kind === 'cover' && layer.wrapper) unwrapCover(layer.wrapper);
  }

  layers.forEach((layer) => {
    layer.wrapper = null;

    if (layer.kind === 'scene') {
      layer.container = null;
      layer.padding = null;
    }
  });
};
