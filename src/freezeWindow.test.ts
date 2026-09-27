import { describe, expect, it, vi } from 'vitest';
import { dwellBeforeReach, dwellConsumedAt, planLayers } from './freezeWindow';
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
  triggerHeight: 0,
  wrapperTop: 0,
  coverTop: 0,
  end: { mode: 'dwell', distancePx: 0 },
  endTriggerIsSelf: true,
  endTriggerIndex: null,
  endTriggerHeight: 0,
  endTriggerEnclosedBy: [],
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

  // S1 freezes at 1000, before its own bottom edge (raw 1400) reaches the top, so that edge gets
  // there one S1 dwell late, the same as for any element S1's trigger encloses.
  it('counts a registered endTrigger\'s own dwell when it freezes before the point the end names', () => {
    const { plans } = run([
      scene({ triggerTop: 1000, triggerHeight: 400, end: dwell(500) }),
      scene({
        triggerTop: 1900,
        triggerHeight: 300,
        start: clauseStart(800),
        end: clause('bottom top'),
        endTriggerIsSelf: false,
        endTriggerIndex: 0,
        endTriggerHeight: 400,
        endTriggerEnclosedBy: [0],
      }),
    ]);

    expect(plans[1].freezeStart).toBe(1600); // 1900 + 500 - 800
    expect(plans[1].freezeEnd).toBe(1900); // 1400 + 500, not a collapsed 1600
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

  it('includes a later-processed Scene layer\'s dwell when its trigger ends before the raw endTrigger position', () => {
    // S2's trigger (1000) ends before S1's raw endTrigger position (2000), so S2's dwell counts
    // even though S2 is processed after S1.
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

  // S2 freezes at its bottom edge, long after the endTrigger 200px into its 2000px trigger has
  // reached the top.
  it('leaves out the dwell of a Scene layer that encloses the endTrigger but freezes after it arrives', () => {
    const { plans } = run([
      scene({
        triggerTop: 500,
        end: { mode: 'clause', clause: 'top top', rawTop: 1200, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
        endTriggerEnclosedBy: [1],
      }),
      scene({ triggerTop: 1000, triggerHeight: 2000, start: clauseStart(-1200), end: dwell(500) }),
    ]);

    expect(plans[0].freezeEnd).toBe(1200); // not 1700
    expect(plans[1].freezeStart).toBe(2900); // 1000 + 700 + 1200
  });

  // S2's 'top bottom' freezes it before the endTrigger reaches the top, but its pin spacer would
  // sit after the endTrigger, so GSAP's end wouldn't move.
  // A pin holds what's inside it while engaged: S2 freezes at 1000, before the endTrigger 500px
  // into its trigger reaches the top at 1500.
  it('counts the dwell of a Scene layer that encloses the endTrigger and freezes first', () => {
    const { plans } = run([
      scene({
        triggerTop: 0,
        end: { mode: 'clause', clause: 'top top', rawTop: 1500, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
        endTriggerEnclosedBy: [1],
      }),
      scene({ triggerTop: 1000, triggerHeight: 1000, end: dwell(500) }),
    ]);

    expect(plans[0].freezeEnd).toBe(2000); // 1500 + 500
  });

  // S2's trigger sits inside the 1000px endTrigger, above its bottom edge, so GSAP's spacer for S2
  // would stretch the endTrigger and push that edge down.
  it('counts the dwell of a Scene layer inside the endTrigger, above the point the end names', () => {
    const { plans } = run([
      scene({
        triggerTop: 0,
        end: { mode: 'clause', clause: 'bottom top', rawTop: 1000, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
        endTriggerHeight: 1000,
      }),
      scene({ triggerTop: 1200, triggerHeight: 300, end: dwell(500) }),
    ]);

    expect(plans[0].freezeEnd).toBe(2500); // 1000 + 1000 + 500
  });

  it('leaves out a later-in-DOM Scene layer\'s dwell even when it freezes before the endTrigger arrives', () => {
    const { plans } = run([
      scene({
        triggerTop: 500,
        end: { mode: 'clause', clause: 'top top', rawTop: 1200, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
      scene({ triggerTop: 1400, start: clauseStart(800), end: dwell(500) }),
    ]);

    expect(plans[0].freezeEnd).toBe(1200);
    expect(plans[1].freezeStart).toBe(1300); // 1400 + 700 - 800
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
    // structure.ts guarantees that) to stress-test gapsBeforeEndAnchor's position-based
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

  // measure.ts rejects this upstream, but measured unpadded the reference is well defined.
  it('resolves a Scene layer\'s forward reference from the referenced trigger\'s own position', () => {
    const { plans } = run([
      scene({
        triggerTop: 1000,
        end: clause('top top'),
        endTriggerIsSelf: false,
        endTriggerIndex: 1,
        endTriggerHeight: 100,
        endTriggerEnclosedBy: [1],
      }),
      scene({ triggerTop: 2000, end: dwell(100) }),
    ]);

    expect(plans[0].freezeEnd).toBe(2000);
    expect(plans[1].freezeStart).toBe(3000); // 2000 + 1000
  });

  // Layer 1's endTrigger sits above layer 0's trigger, so layer 0 doesn't count toward it, yet
  // layer 0's dwell moves layer 1's start; layer 0's own end counts layer 1. See planLayers.
  it('throws when two layers\' ends feed each other without cancelling', () => {
    expect(() => run([
      scene({
        triggerTop: 1200,
        triggerHeight: 100,
        start: clauseStart(800),
        end: { mode: 'clause', clause: 'top bottom', rawTop: 1400, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerHeight: 40,
      }),
      scene({
        triggerTop: 1300,
        triggerHeight: 100,
        start: clauseStart(800),
        end: { mode: 'clause', clause: 'bottom top', rawTop: 900, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerHeight: 200,
      }),
    ])).toThrow(/circular structural dependency/);
  });

  it('a Cover layer\'s forward reference resolves from the referenced trigger\'s own position (it creates no padding, so nothing depends on it)', () => {
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

// Every cover point is where its element reaches the anchor with no dwell, plus the dwell of each
// Scene layer that freezes before it gets there, whatever the DOM order.
describe('cover layer freeze window', () => {
  // The scene is a tall section frozen at its bottom edge, and the cover layer sits inside it,
  // near its top: the rise is over long before the scene freezes.
  it('leaves out an earlier-in-DOM Scene layer that freezes after the rise', () => {
    const { plans } = run([
      scene({ triggerTop: 1000, start: clauseStart(-1200), end: dwell(500) }),
      cover({ triggerTop: 1100, start: clauseStart(500), coverTop: 1400, end: { mode: 'auto' } }),
    ]);

    expect(plans[1].freezeStart).toBe(600); // not 1100
    expect(plans[1].freezeEnd).toBe(1400); // not 1900
  });

  // README's "Delaying the rise": the scene and the zero-height marker after it share one anchor,
  // so the scene freezes just as the rise would begin, and the rise waits it out.
  it('counts a Scene layer that freezes just as the rise would begin', () => {
    const { plans } = run([
      scene({ triggerTop: 500, start: clauseStart(120), end: dwell(800) }),
      cover({ triggerTop: 1100, start: clauseStart(720), coverTop: 1100, end: { mode: 'auto' } }),
    ]);

    expect(plans[0].freezeStart).toBe(380);
    expect(plans[1].freezeStart).toBe(1180); // 380 + 800
    expect(plans[1].freezeEnd).toBe(1900); // cover's top at 1100, + 800
  });

  // The rise stands still with the whole container while the scene is frozen.
  it('extends the auto end by a Scene layer that freezes mid-rise, but not one freezing as cover arrives', () => {
    const measure = (sceneAnchorOffset: number) => run([
      cover({ triggerTop: 500, start: clauseStart(420), coverTop: 800, end: { mode: 'auto' } }),
      scene({ triggerTop: 1800, start: clauseStart(sceneAnchorOffset), end: dwell(500) }),
    ]).plans[0];

    expect(measure(1080)).toMatchObject({ freezeStart: 80, freezeEnd: 1300 }); // freezes at 720
    expect(measure(1000)).toMatchObject({ freezeStart: 80, freezeEnd: 800 }); // freezes at 800
  });

  it('counts only the Scene layers that freeze before a registered endTrigger arrives', () => {
    const { plans } = run([
      cover({
        triggerTop: 500,
        start: clauseStart(420),
        end: clause('top bottom'),
        endTriggerIsSelf: false,
        endTriggerIndex: 2,
        endTriggerHeight: 400,
      }),
      scene({ triggerTop: 1800, end: dwell(500) }),
      scene({ triggerTop: 2200, end: dwell(500) }),
    ]);

    // The last scene's top enters the 800px viewport at 2200 - 800, before the one at 1800 freezes.
    expect(plans[0].freezeEnd).toBe(1400); // not 1900
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
  // A pure-dwell measurement set never triggers needsConvergence, so planLayers would call runPass
  // exactly once regardless of where onPlanned sits; "called once per layer" would hold trivially
  // even from inside that single pass. This reuses the shape from "includes a later-processed Scene
  // layer's dwell..." above, which needs 2 runPass calls to settle, so a regression that moved
  // onPlanned inside the convergence loop (doubling every call) would actually be caught here.
  it('is called exactly once per layer, in DOM order, with the finalized values, even once planLayers has converged over more than one pass', () => {
    const { plans, planned } = run([
      scene({
        triggerTop: 0,
        end: { mode: 'clause', clause: 'top top', rawTop: 2000, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
      }),
      scene({ triggerTop: 1000, end: dwell(500) }),
    ]);

    expect(planned.map((entry) => entry.index)).toEqual([0, 1]);
    expect(planned.map((entry) => entry.plan)).toEqual(plans);
  });
});

describe('dwellBeforeReach', () => {
  const freeze = (freezeStart: number, freezeEnd: number) => ({ freezeStart, freezeEnd });

  it('counts the whole dwell of a freeze that starts before the element arrives', () => {
    expect(dwellBeforeReach(300, [freeze(200, 700)])).toBe(500);
  });

  // An element that reaches its anchor as the freeze starts sits there for the whole window, so
  // the earliest scroll position it's there at is the one before the dwell.
  it('counts none of a freeze that starts at or after the element arrives', () => {
    expect(dwellBeforeReach(200, [freeze(200, 700)])).toBe(0);
    expect(dwellBeforeReach(100, [freeze(200, 700)])).toBe(0);
  });

  // planLayers adds the first dwell to the second trigger's top before subtracting its anchor,
  // which lands at 1299.8999999999999 rather than the 1299.9 the element arrives at.
  it('counts none of a Scene trigger\'s own dwell when it resolves its own start', () => {
    const { plans } = run([
      scene({ triggerTop: 0, start: clauseStart(0.1), end: dwell(300.3) }),
      scene({ triggerTop: 1000, start: clauseStart(0.4), end: dwell(500) }),
    ]);

    expect(dwellBeforeReach(1000 - 0.4, plans)).toBeCloseTo(300.3);
  });

  // Each test adds every earlier layer's dwell, counted or not. That can't pull in a later layer
  // once an earlier one is out: the later one opens after the earlier one closes.
  it('counts none of a later freeze once an earlier one doesn\'t count', () => {
    expect(dwellBeforeReach(100, [freeze(200, 700), freeze(750, 950)])).toBe(0);
  });

  it('counts a later freeze the earlier dwell pushes the element past, whatever the input order', () => {
    expect(dwellBeforeReach(300, [freeze(750, 950), freeze(200, 700)])).toBe(700);
  });

  it('counts a freeze that starts as the element arrives when asked to count ties', () => {
    expect(dwellBeforeReach(200, [freeze(200, 700)], { countTies: true })).toBe(500);
    expect(dwellBeforeReach(100, [freeze(200, 700)], { countTies: true })).toBe(0);
  });
});

describe('dwellConsumedAt', () => {
  const freeze = (freezeStart: number, freezeEnd: number) => ({ freezeStart, freezeEnd });

  it('counts nothing before a window, the part gone by inside it, and all of it after', () => {
    const windows = [freeze(200, 700), freeze(900, 1000)];

    expect(dwellConsumedAt(100, windows)).toBe(0);
    expect(dwellConsumedAt(450, windows)).toBe(250);
    expect(dwellConsumedAt(950, windows)).toBe(550);
    expect(dwellConsumedAt(2000, windows)).toBe(600);
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
