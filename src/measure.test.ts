// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { measureLayer, resolveEndSpec, resolveStartSpec } from './measure';
import type { EndSpec, LayerMeasurement, StartSpec } from './freezeWindow';
import type { EndValue } from './position';
import type { CoverLayer, Layer, SceneLayer } from './types';

// jsdom answers the one thing these functions ask the DOM, `contains`, so an unregistered
// endTrigger's inside/outside branch is real here. It has no layout, so documentTop reports 0 for
// everything and measureUsedHeight falls back to offsetHeight's own 0, leaving endTriggerHeight
// and the wrapper/cover positions to e2e. The arithmetic survives, since elementHeight and
// viewportHeight arrive as arguments.
//
// This file owns the four rejection messages, the way position.test.ts owns 'unsupported position
// clause'. index.test.ts keeps one public-API test per rejection with a short regex, covering only
// whether refresh() still reaches the throw. What it can't reach at all is the EndSpec/StartSpec a
// call that doesn't throw returns, since refresh() has flattened every layout number to 0 by the
// time it hands one back.

const VIEWPORT = 800;
const query = (sel: string) => document.querySelector<HTMLElement>(sel)!;

beforeEach(() => {
  document.body.innerHTML = `
    <div class="root">
      <section class="a"></section>
      <section class="b"></section>
    </div>
    <section class="outside"></section>
  `;
});

const scene = (over: Partial<SceneLayer> = {}): SceneLayer => ({
  kind: 'scene',
  trigger: query('.a'),
  endTrigger: query('.a'),
  wrapper: null,
  start: 'top top',
  end: '+=500',
  freezeStart: 0,
  freezeEnd: 0,
  container: null,
  padding: null,
  ...over,
});
const cover = (over: Partial<CoverLayer> = {}): CoverLayer => ({
  kind: 'cover',
  trigger: query('.a'),
  endTrigger: query('.a'),
  cover: query('.b'),
  wrapper: null,
  start: 'bottom bottom',
  end: null,
  freezeStart: 0,
  freezeEnd: 0,
  ...over,
});
// ownIndex and endTriggerIndex are the pair the forward-reference check compares, so they're named
// here rather than left as the 5th and 6th positional arguments.
const endSpecFor = (
  layer: Layer,
  endResolved: EndValue | null,
  indices: { ownIndex?: number; endTriggerIndex?: number | null } = {},
): EndSpec => resolveEndSpec(
  query('.root'),
  VIEWPORT,
  layer,
  endResolved,
  indices.ownIndex ?? 0,
  indices.endTriggerIndex ?? null,
);

describe('resolveEndSpec', () => {
  it('reports \'auto\' for an omitted end, the cover layer\'s "until it covers me" mode', () => {
    expect(endSpecFor(cover(), null)).toEqual<EndSpec>({ mode: 'auto' });
  });

  // The distance itself is resolveDwell's. What's left is the reference size this hands it: the
  // viewport, never the element.
  it('scales a percent dwell against the viewport height', () => {
    expect(endSpecFor(scene(), '+=25%')).toEqual<EndSpec>({ mode: 'dwell', distancePx: 200 });
  });

  // A dwell counts from the layer's own freezeStart, so endTrigger goes unread, and the rejections
  // below are all about where endTrigger sits.
  it('ignores endTrigger for a dwell end, wherever it sits', () => {
    expect(endSpecFor(scene({ endTrigger: query('.outside') }), '+=500'))
      .toEqual<EndSpec>({ mode: 'dwell', distancePx: 500 });
  });

  // GSAP reads any value that Number() converts as an absolute scroll position, strings included.
  // Unlike an absolute start, this has no cover-layer restriction: freezeEnd is a scroll position
  // on both kinds of layer.
  it('carries an absolute end as a number whichever way it was written', () => {
    expect(endSpecFor(scene(), 2000)).toEqual<EndSpec>({ mode: 'absolute', value: 2000 });
    expect(endSpecFor(scene(), '2000')).toEqual<EndSpec>({ mode: 'absolute', value: 2000 });
    expect(endSpecFor(cover(), 2000)).toEqual<EndSpec>({ mode: 'absolute', value: 2000 });
  });

  // 'max' is an offset from the document's max scroll position, 0 for the bare keyword, and its
  // '%' scales against the viewport as the dwell above does.
  it('carries a \'max\' end as its offset', () => {
    expect(endSpecFor(cover(), 'max')).toEqual<EndSpec>({ mode: 'max', offsetPx: 0 });
    expect(endSpecFor(cover(), 'max-=100')).toEqual<EndSpec>({ mode: 'max', offsetPx: -100 });
    expect(endSpecFor(cover(), 'max-=25%')).toEqual<EndSpec>({ mode: 'max', offsetPx: -200 });
  });

  // Why the message names the trigger: registering several layers through one querySelectorAll
  // makes "which element" the first thing the caller needs to know.
  it('rejects a \'max\' end on a Scene layer', () => {
    expect(() => endSpecFor(scene(), 'max')).toThrow(
      /createStickyTrigger's trigger <section\.a> has end "max"\. GSAP's 'max' keyword isn't /,
    );
    expect(() => endSpecFor(scene(), 'max')).toThrow(
      /own dwell padding adds to the document's max scroll position.*Use createOverlapScroll/s,
    );
  });

  describe('position-clause end', () => {
    // A registered endTrigger is planLayers' to resolve in pass 2, so pass 1 hands it neither a
    // measured position nor a re-measure request.
    it('leaves a registered endTrigger to pass 2', () => {
      expect(endSpecFor(scene({ endTrigger: query('.b') }), 'top top', {
        ownIndex: 1,
        endTriggerIndex: 0,
      })).toEqual<EndSpec>({
        mode: 'clause',
        clause: 'top top',
        rawTop: null,
        measureLive: false,
      });
    });

    it('measures an unregistered endTrigger inside the shared container right away', () => {
      expect(endSpecFor(scene({ endTrigger: query('.b') }), 'bottom top')).toEqual<EndSpec>({
        mode: 'clause',
        clause: 'bottom top',
        // documentTop, so 0 under jsdom's absent layout. What matters here is that it isn't null.
        rawTop: 0,
        measureLive: false,
      });
    });

    // Only a cover layer reaches this branch; the same endTrigger on a Scene layer is rejected
    // below.
    it('defers an unregistered endTrigger outside the container to a live re-measure', () => {
      expect(endSpecFor(cover({ endTrigger: query('.outside') }), 'top top')).toEqual<EndSpec>({
        mode: 'clause',
        clause: 'top top',
        rawTop: null,
        measureLive: true,
      });
    });

    // Both elements are named for the same reason the 'max' message names one.
    it('rejects an endTrigger outside the container on a Scene layer', () => {
      expect(() => endSpecFor(scene({ endTrigger: query('.outside') }), 'top top')).toThrow(
        /createStickyTrigger's trigger <section\.a> has an endTrigger \(<section\.outside>\) /,
      );
      expect(() => endSpecFor(scene({ endTrigger: query('.outside') }), 'top top')).toThrow(
        /outside the shared container.*own dwell keeps pushing it away/s,
      );
    });

    it('rejects a Scene layer\'s forward reference', () => {
      const forwardRef = () => endSpecFor(scene({ endTrigger: query('.b') }), 'top top', {
        ownIndex: 0,
        endTriggerIndex: 1,
      });

      expect(forwardRef).toThrow(
        /createStickyTrigger's trigger <section\.a>'s endTrigger \(<section\.b>\) refers to a /,
      );
      expect(forwardRef).toThrow(/layer positioned later in DOM order.*its own dwell/s);
    });

    // Both rejections are about dwell padding, which a cover layer never creates, so its forward
    // reference goes to planLayers' fixed-point iteration instead.
    it('accepts a cover layer\'s forward reference', () => {
      expect(endSpecFor(cover({ endTrigger: query('.b') }), 'top top', {
        ownIndex: 0,
        endTriggerIndex: 1,
      })).toEqual<EndSpec>({
        mode: 'clause',
        clause: 'top top',
        rawTop: null,
        measureLive: false,
      });
    });

    // A layer pointing at itself is the default endTrigger, and its index equals ownIndex rather
    // than exceeding it, so the forward-reference check leaves it alone.
    it('accepts a Scene layer pointing at itself', () => {
      expect(endSpecFor(scene(), 'bottom top', { ownIndex: 2, endTriggerIndex: 2 }))
        .toEqual<EndSpec>({
          mode: 'clause',
          clause: 'bottom top',
          rawTop: null,
          measureLive: false,
        });
    });
  });
});

describe('resolveStartSpec', () => {
  // resolveAnchorTop does the arithmetic; the two reference sizes are what this passes it. The
  // clause reads each side differently so that a swap shows up: 800 * 0.25 - 200 * 1 against
  // 200 * 0.25 - 800.
  it('scales the element side against the element and the viewport side against the viewport', () => {
    expect(resolveStartSpec(scene(), 'bottom 25%', 200, VIEWPORT))
      .toEqual<StartSpec>({ mode: 'clause', anchorOffset: 0 });
  });

  // A Scene layer takes either, since its stickyTop is already document-absolute; index.test.ts
  // resolves that side to an exact freezeStart.
  it('rejects an absolute start on a cover layer, in both spellings GSAP accepts', () => {
    expect(() => resolveStartSpec(cover(), 1500, 200, VIEWPORT)).toThrow(
      /createOverlapScroll's trigger <section\.a> has start "1500", an absolute scroll position /,
    );
    expect(() => resolveStartSpec(cover(), '1500', 200, VIEWPORT)).toThrow(
      /a cover layer's sticky position is computed relative to its own wrapper/,
    );
  });

  // The two end notations reaching a start, both deliberately handled by the clause branch.
  it('resolves a dwell start as a clause with an implicit base of 0', () => {
    expect(resolveStartSpec(scene(), '+=100', 200, VIEWPORT))
      .toEqual<StartSpec>({ mode: 'clause', anchorOffset: -100 });
  });

  it('rejects a \'max\' start as position.ts\'s end-only keyword', () => {
    expect(() => resolveStartSpec(scene(), 'max', 200, VIEWPORT))
      .toThrow(/unsupported position clause "max".*end-only keyword/);
  });
});

describe('measureLayer', () => {
  const measure = (
    layer: Layer,
    ownIndex = 0,
    indexByTrigger: ReadonlyMap<HTMLElement, number> = new Map(),
  ): LayerMeasurement => measureLayer(query('.root'), VIEWPORT, layer, ownIndex, indexByTrigger);

  // Under jsdom every position below comes back as documentTop's 0, and every height as
  // measureUsedHeight's; what this pins down is which field each one is read into, and that
  // nothing is left undefined.
  it('assembles the whole measurement for a Scene layer', () => {
    expect(measure(scene({ endTrigger: query('.b'), end: 'top top' })))
      .toEqual<LayerMeasurement>({
        kind: 'scene',
        start: { mode: 'clause', anchorOffset: 0 },
        triggerTop: 0,
        wrapperTop: 0,
        coverTop: 0,
        end: { mode: 'clause', clause: 'top top', rawTop: 0, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
        endTriggerHeight: 0,
      });
  });

  it('reports a cover layer\'s kind and its cover\'s position', () => {
    const measurement = measure(cover());

    expect(measurement.kind).toBe('cover');
    expect(measurement.coverTop).toBe(0);
    expect(measurement.end).toEqual<EndSpec>({ mode: 'auto' });
  });

  it('re-evaluates function-valued start and end on every call', () => {
    let dwell = 500;
    const layer = scene({ start: () => 'center center', end: () => `+=${dwell}` });

    expect(measure(layer).end).toEqual<EndSpec>({ mode: 'dwell', distancePx: 500 });
    expect(measure(layer).start).toEqual<StartSpec>({ mode: 'clause', anchorOffset: 400 });

    dwell = 900;
    expect(measure(layer).end).toEqual<EndSpec>({ mode: 'dwell', distancePx: 900 });
  });

  // What the composed clause resolves to needs real heights, so that half is e2e's (see its
  // "spaced '+=' end" tests). This checks only that measureLayer composes the end at all, rather
  // than reading '+=100 bottom' as a dwell.
  it('composes a spaced \'+=\' end with the start clause\'s element token', () => {
    expect(measure(scene({ start: 'bottom bottom', end: '+=100 bottom' })).end)
      .toEqual<EndSpec>({
        mode: 'clause',
        clause: 'bottom+=100 bottom',
        rawTop: 0,
        measureLive: false,
      });
  });

  it('looks endTrigger up in the registered layers and flags a self-reference', () => {
    const indexByTrigger = new Map([[query('.a'), 0], [query('.b'), 1]]);
    const pointsBack = measure(
      scene({ trigger: query('.b'), endTrigger: query('.a'), end: 'top top' }),
      1,
      indexByTrigger,
    );

    expect(pointsBack.endTriggerIndex).toBe(0);
    expect(pointsBack.endTriggerIsSelf).toBe(false);

    const pointsAtSelf = measure(scene({ end: 'top top' }), 0, indexByTrigger);

    expect(pointsAtSelf.endTriggerIndex).toBe(0);
    expect(pointsAtSelf.endTriggerIsSelf).toBe(true);
  });

  it('reports an unregistered endTrigger as index null', () => {
    const measurement = measure(
      scene({ endTrigger: query('.b'), end: 'top top' }),
      0,
      new Map([[query('.a'), 0]]),
    );

    expect(measurement.endTriggerIndex).toBeNull();
  });
});
