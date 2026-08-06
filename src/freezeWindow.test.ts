import { describe, expect, it, vi } from 'vitest';
import { planLayers } from './freezeWindow';
import type { LayerMeasurement, LayerPlan, PlanDeps } from './freezeWindow';

// planLayers never touches the DOM,
// so every branch of pass 2 can be verified just by feeding it numeric measurements.
// A real browser is only needed for "the part that measures those numbers" (documentTop, etc.).

const clauseStart = (anchorOffset: number): LayerMeasurement['start'] =>
  ({ mode: 'clause', anchorOffset });
const absoluteStart = (value: number): LayerMeasurement['start'] =>
  ({ mode: 'absolute', value });
const absoluteEnd = (value: number): LayerMeasurement['end'] =>
  ({ mode: 'absolute', value });
const scene = (over: Partial<LayerMeasurement> = {}): LayerMeasurement => ({
  kind: 'scene',
  start: clauseStart(0),
  triggerTop: 0,
  wrapperTop: 0,
  coverTop: 0,
  end: { mode: 'dwell', distancePx: 0 },
  endTriggerIsSelf: true,
  endTriggerIndex: null,
  endTriggerHeight: 0,
  ...over,
});
const cover = (over: Partial<LayerMeasurement> = {}): LayerMeasurement =>
  scene({ kind: 'cover', ...over });

const run = (measurements: LayerMeasurement[], deps: Partial<PlanDeps> = {}) => {
  const planned: { index: number; plan: LayerPlan }[] = [];
  const plans = planLayers(measurements, {
    viewportHeight: 800,
    structureTop: 0,
    documentMaxScroll: 0,
    measureLiveEndTriggerTop: () => 0,
    onPlanned: (index, plan) => planned.push({ index, plan }),
    ...deps,
  });

  return { plans, planned };
};

describe('dwell end', () => {
  it('freezeStart is the absolute scroll position obtained by subtracting the start offset from trigger\'s natural position', () => {
    const { plans } = run([scene({ triggerTop: 1000, start: clauseStart(200), end: dwell(500) })], {
      structureTop: 100,
    });

    expect(plans[0]).toEqual<LayerPlan>({
      freezeStart: 800, // 1000 - 200
      freezeEnd: 1300, // 800 + 500
      stickyTop: -700, // structureTop(100) - freezeStart(800)
      paddingHeight: 500,
    });
  });
});

describe('absolute end', () => {
  it('freezeEnd is the fixed value itself, ignoring freezeStart and precedingGaps entirely', () => {
    const { plans } = run([
      scene({ triggerTop: 1000, start: clauseStart(200), end: absoluteEnd(5000) }),
    ]);

    expect(plans[0].freezeStart).toBe(800); // 1000 - 200
    expect(plans[0].freezeEnd).toBe(5000);
  });

  // Matches GSAP's own `end = Math.max(start, ...)` (ScrollTrigger.js:1401): an absolute end
  // below freezeStart collapses to a zero-length window instead of a negative one.
  it('clamps to freezeStart when the absolute value would fall before it', () => {
    const { plans } = run([
      scene({ triggerTop: 1000, start: clauseStart(200), end: absoluteEnd(100) }),
    ]);

    expect(plans[0].freezeStart).toBe(800); // 1000 - 200
    expect(plans[0].freezeEnd).toBe(800); // clamped, not 100
  });
});

describe('absolute start', () => {
  it('freezeStart is the fixed value itself, ignoring triggerTop and precedingGaps entirely', () => {
    const { plans } = run([
      scene({ triggerTop: 0, end: dwell(300) }), // contributes 300 to precedingGaps
      scene({ triggerTop: 9999, start: absoluteStart(500), end: dwell(200) }),
    ]);

    expect(plans[1].freezeStart).toBe(500); // not 9999 - 0, and not shifted by the 300 gap
    expect(plans[1].freezeEnd).toBe(700); // 500 + 200
  });

  it('a cover layer can never carry an absolute start: index.ts rejects it before this runs, and this is the defensive fallback', () => {
    expect(() => run([
      cover({ start: absoluteStart(500), coverTop: 100, end: { mode: 'auto' } }),
    ])).toThrow(/internal error/);

    expect(() => run([
      cover({ start: absoluteStart(500), end: dwell(100) }),
    ])).toThrow(/internal error/);
  });
});

describe('accumulating precedingGaps', () => {
  it('later layers\' natural position drops by exactly the preceding Scene layers\' dwell', () => {
    const { plans } = run([
      scene({ triggerTop: 1000, end: dwell(300) }),
      scene({ triggerTop: 2000, end: dwell(400) }),
      scene({ triggerTop: 3000, end: dwell(0) }),
    ]);

    expect(plans.map((plan) => plan.freezeStart)).toEqual([
      1000,
      2300, // 2000 + 300
      3700, // 3000 + 300 + 400
    ]);
  });

  it('a cover layer never increases document height, so it never shifts later layers', () => {
    const { plans } = run([
      scene({ triggerTop: 0, end: dwell(100) }),
      cover({ triggerTop: 500, wrapperTop: 400, start: clauseStart(300), coverTop: 700 }),
      scene({ triggerTop: 1000, end: dwell(200) }),
    ]);

    expect(plans[1].paddingHeight).toBeNull();
    // the 3rd layer is shifted only by the 1st layer's dwell (100), not by the cover layer
    expect(plans[2].freezeStart).toBe(1100);
  });

  it('a cover layer\'s stickyTop is raised by the base\'s offset within wrapper', () => {
    const { plans } = run([cover({ triggerTop: 500, wrapperTop: 400, start: clauseStart(300) })]);

    // clauseStart(300).anchorOffset - (triggerTop(500) - wrapperTop(400))
    expect(plans[0].stickyTop).toBe(200);
  });
});

describe('auto end (a cover layer\'s auto-computed value)', () => {
  it('freezes for exactly the distance from where the freeze begins until cover\'s top edge reaches the viewport', () => {
    const { plans } = run([
      cover({ triggerTop: 500, start: clauseStart(300), coverTop: 700, end: { mode: 'auto' } }),
    ]);

    // freezeStart = 500 - 300 = 200, distance = 300 + (700 - 500) = 500
    expect(plans[0].freezeStart).toBe(200);
    expect(plans[0].freezeEnd).toBe(700);
  });

  it('collapses to a zero-length window when the computed distance would be negative', () => {
    const { plans } = run([
      cover({ triggerTop: 500, start: clauseStart(-600), coverTop: 600, end: { mode: 'auto' } }),
    ]);

    expect(plans[0].freezeEnd).toBe(plans[0].freezeStart);
  });
});

describe('position-clause end', () => {
  it('uses its own natural position as the reference when endTrigger is trigger itself', () => {
    const { plans } = run([
      scene({
        triggerTop: 1000,
        end: clause('bottom top'),
        endTriggerIsSelf: true,
        endTriggerHeight: 400,
      }),
    ]);

    // resolveAnchorTop('bottom top', 400, 800) = 0 - 400 = -400 → 1000 - (-400)
    expect(plans[0].freezeStart).toBe(1000);
    expect(plans[0].freezeEnd).toBe(1400);
  });

  it('reuses the gap-adjusted natural position when pointing at an already-computed layer', () => {
    const { plans } = run([
      scene({ triggerTop: 500, end: dwell(200) }),
      scene({
        triggerTop: 100,
        end: clause('top top'),
        endTriggerIsSelf: false,
        endTriggerIndex: 0,
        endTriggerHeight: 100,
      }),
    ]);

    // the 1st layer's natural position is 500 (gaps 0).
    // the 2nd layer picks up gaps of 200, giving a natural position of 300.
    expect(plans[1].freezeStart).toBe(300);
    expect(plans[1].freezeEnd).toBe(500);
  });

  it('adds precedingGaps onto the raw position for an unregistered endTrigger inside the shared container', () => {
    const { plans } = run([
      scene({ triggerTop: 0, end: dwell(200) }),
      scene({
        triggerTop: 100,
        end: { mode: 'clause', clause: 'top top', rawTop: 900, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
    ]);

    expect(plans[1].freezeEnd).toBe(1100); // 900 + 200
  });

  it('includes a later-processed Scene layer\'s dwell when its trigger structurally precedes the raw endTrigger position', () => {
    // S1's endTrigger sits at raw position 2000; S2's trigger (1000) sits between S1's own
    // trigger (0) and that raw position, so S2's dwell must be included even though S2 is
    // processed after S1 in this array.
    const { plans } = run([
      scene({
        triggerTop: 0,
        end: { mode: 'clause', clause: 'top top', rawTop: 2000, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
      scene({ triggerTop: 1000, end: dwell(500) }),
    ]);

    expect(plans[0].freezeStart).toBe(0);
    expect(plans[0].freezeEnd).toBe(2500); // 2000 + S2's dwell (500), not 2000
    expect(plans[1].freezeStart).toBe(3500); // 1000 + S1's now-larger dwell (2500)
  });

  it('propagates a look-ahead correction through a chain of unregistered endTriggers (multi-pass convergence)', () => {
    // S1 looks ahead past S2's trigger; S2 in turn looks ahead past S3's trigger. Resolving S1
    // correctly requires S2's dwell to already reflect S3's dwell, which takes more than one pass.
    const { plans } = run([
      scene({
        triggerTop: 0,
        end: { mode: 'clause', clause: 'top top', rawTop: 1000, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
      scene({
        triggerTop: 500,
        end: { mode: 'clause', clause: 'top top', rawTop: 2000, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
      scene({ triggerTop: 1500, end: dwell(100) }),
    ]);

    // S3's dwell (100) is invariant, so S2's own dwell settles at 1500 + 100 = 1600
    // regardless of S1 (S1 precedes S2's own trigger, so its contribution cancels out of the
    // difference). S1's dwell then settles at 1000 + 1600.
    expect(plans[2].paddingHeight).toBe(100);
    expect(plans[1].paddingHeight).toBe(1600);
    expect(plans[0].paddingHeight).toBe(2600);
    expect(plans[0].freezeEnd).toBe(2600);
    expect(plans[1].freezeEnd).toBe(4700); // freezeStart(3100) + paddingHeight(1600)
  });

  it('converges even when DOM order and trigger position disagree, using the full iteration budget without throwing', () => {
    // Array order is deliberately NOT sorted by triggerTop (unlike real usage, where
    // structure.ts guarantees that) to stress-test gapsBeforeRawPosition's position-based
    // lookup against runPass's index-based one. Each layer's endTrigger raw position reaches
    // past the other two, so resolving layer 0 needs layer 1's dwell, which itself needs layer
    // 2's, so this needs exactly 3 runPass calls (the full budget for 3 layers) to settle, verified
    // by hand: layer 2's dwell is a constant 2600 (both other layers cancel out of its own
    // difference), layer 1's settles at 2100 + layer 2's dwell = 4700, and layer 0's at
    // 2200 + layer 1's + layer 2's dwell = 9500.
    const { plans } = run([
      scene({
        triggerTop: 300,
        end: { mode: 'clause', clause: 'top top', rawTop: 2500, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
      scene({
        triggerTop: 100,
        end: { mode: 'clause', clause: 'top top', rawTop: 2200, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
      scene({
        triggerTop: 200,
        end: { mode: 'clause', clause: 'top top', rawTop: 2800, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
    ]);
    // Expressed as the same derivation the comment above walks through by hand, rather than
    // bare literals, so a future edit to any of the three rawTop values above must also update
    // the math that justifies the expectation, not just the numbers.
    const layer2Dwell = 2600; // constant: both other layers cancel out of its own difference
    const layer1Dwell = 2100 + layer2Dwell;
    const layer0Dwell = 2200 + layer1Dwell + layer2Dwell;

    expect(plans.map((plan) => plan.paddingHeight))
      .toEqual([layer0Dwell, layer1Dwell, layer2Dwell]);
  });

  it('re-measures on the spot for an endTrigger outside the shared container, without adding precedingGaps', () => {
    const measureLiveEndTriggerTop = vi.fn(() => 5000);
    const { plans } = run(
      [
        scene({ triggerTop: 0, end: dwell(200) }),
        scene({
          triggerTop: 100,
          end: { mode: 'clause', clause: 'top top', rawTop: null, measureLive: true },
          endTriggerIsSelf: false,
          endTriggerIndex: null,
        }),
      ],
      { measureLiveEndTriggerTop },
    );

    expect(measureLiveEndTriggerTop).toHaveBeenCalledWith(1);
    expect(plans[1].freezeEnd).toBe(5000); // gaps are not added
  });

  it('never calls the live re-measure for a layer that does not need it', () => {
    const measureLiveEndTriggerTop = vi.fn(() => 0);

    run([scene({ end: dwell(100) }), cover({ end: { mode: 'auto' } })], {
      measureLiveEndTriggerTop,
    });

    expect(measureLiveEndTriggerTop).not.toHaveBeenCalled();
  });

  it('calls the live re-measure only once per layer, even when an unrelated unregistered clause forces multiple internal passes', () => {
    const measureLiveEndTriggerTop = vi.fn(() => 5000);

    run(
      [
        scene({
          triggerTop: 0,
          end: { mode: 'clause', clause: 'top top', rawTop: 2000, measureLive: false },
          endTriggerIsSelf: false,
          endTriggerIndex: null,
        }),
        scene({ triggerTop: 1000, end: dwell(500) }),
        scene({
          triggerTop: 3000,
          end: { mode: 'clause', clause: 'top top', rawTop: null, measureLive: true },
          endTriggerIsSelf: false,
          endTriggerIndex: null,
        }),
      ],
      { measureLiveEndTriggerTop },
    );

    // Layer 0's unregistered clause forces the convergence loop to run runPass more than once
    // (see the multi-pass convergence tests above), but nothing in the shared DOM state changes
    // between those internal passes, so layer 2's live remeasurement shouldn't be repeated for
    // each one.
    expect(measureLiveEndTriggerTop).toHaveBeenCalledTimes(1);
  });

  it('clamps to a zero-length window when the end would fall before the start (equivalent to GSAP\'s `Math.max(start, end)`)', () => {
    const { plans } = run([
      scene({
        triggerTop: 1000,
        end: clause('top bottom'),
        endTriggerIsSelf: true,
        endTriggerHeight: 100,
      }),
    ]);

    // resolveAnchorTop('top bottom', 100, 800) = 800 → the end would be 1000-800=200,
    // which falls before the start of 1000
    expect(plans[0].freezeStart).toBe(1000);
    expect(plans[0].freezeEnd).toBe(1000);
    expect(plans[0].paddingHeight).toBe(0);
  });

  it('a Scene layer\'s forward reference never converges: its own dwell precedes (and would depend on) the layer it points at', () => {
    // Scene layer 0's own paddingHeight always contributes to layer 1's naturalTop (it precedes
    // layer 1 in DOM order unconditionally), so "layer 0's end = layer 1's position" cancels its
    // own unknown out of its defining equation, so there's no fixed point to iterate toward. This
    // is the low-level counterpart of index.ts's early rejection for this exact case (a Scene
    // layer's forward reference); freezeWindow.ts has no notion of that upstream check, so
    // constructing this measurement set directly still hits the generic circular-dependency
    // throw.
    expect(() => run([
      scene({
        triggerTop: 1000,
        end: clause('top top'),
        endTriggerIsSelf: false,
        endTriggerIndex: 1, // a layer positioned after this one
        endTriggerHeight: 100,
      }),
      scene({ triggerTop: 2000, end: dwell(100) }),
    ])).toThrow(/circular structural dependency/);
  });

  it('a Cover layer\'s forward reference resolves via the fixed-point iteration (it creates no padding, so it never depends on its own dwell)', () => {
    const { plans } = run([
      cover({
        triggerTop: 1000,
        end: clause('top top'),
        endTriggerIsSelf: false,
        endTriggerIndex: 1, // a Scene layer positioned after this one
      }),
      scene({ triggerTop: 2000, end: dwell(100) }),
    ]);

    expect(plans[0].freezeStart).toBe(1000);
    expect(plans[0].freezeEnd).toBe(2000); // layer 1's naturalTop, not 0
    expect(plans[0].paddingHeight).toBeNull();
    expect(plans[1]).toEqual<LayerPlan>({
      freezeStart: 2000,
      freezeEnd: 2100,
      stickyTop: -2000,
      paddingHeight: 100,
    });
  });
});

describe('max end', () => {
  it('freezes until the document\'s max scroll position, offset applied', () => {
    const { plans } = run(
      [cover({ triggerTop: 500, start: clauseStart(300), end: max(-50) })],
      { documentMaxScroll: 2000 },
    );

    expect(plans[0].freezeStart).toBe(200); // 500 - 300
    expect(plans[0].freezeEnd).toBe(1950); // 2000 - 50
  });

  it('clamps to a zero-length window when documentMaxScroll+offset would fall before the start', () => {
    const { plans } = run(
      [cover({ triggerTop: 5000, start: clauseStart(0), end: max(0) })],
      { documentMaxScroll: 100 },
    );

    expect(plans[0].freezeEnd).toBe(plans[0].freezeStart);
  });

  it('never adds to precedingGaps (a cover layer never creates padding)', () => {
    const { plans } = run(
      [
        cover({ triggerTop: 500, end: max(0) }),
        scene({ triggerTop: 1000, end: dwell(0) }),
      ],
      { documentMaxScroll: 2000 },
    );

    expect(plans[1].freezeStart).toBe(1000); // unaffected by the cover layer's freezeEnd
  });
});

describe('onPlanned', () => {
  it('is called once per layer in DOM order, with the finalized values', () => {
    const { plans, planned } = run([
      scene({ triggerTop: 0, end: dwell(100) }),
      scene({ triggerTop: 500, end: dwell(200) }),
    ]);

    expect(planned.map((entry) => entry.index)).toEqual([0, 1]);
    expect(planned.map((entry) => entry.plan)).toEqual(plans);
  });
});

function dwell(distancePx: number): LayerMeasurement['end'] {
  return { mode: 'dwell', distancePx };
}

function clause(text: string): LayerMeasurement['end'] {
  return { mode: 'clause', clause: text, rawTop: null, measureLive: false };
}

function max(offsetPx: number): LayerMeasurement['end'] {
  return { mode: 'max', offsetPx };
}
