import { describe, expect, it, vi } from 'vitest';
import { dwellBeforeReach, dwellConsumedAt, planLayers } from './freezeWindow';
import type { LayerMeasurement, LayerPlan, PlanDeps } from './freezeWindow';

// planLayers never touches the DOM,
// so every branch of pass 2 can be verified just by feeding it numeric measurements.
// A real browser is only needed for "the part that measures those numbers" (documentTop, etc.).

const clauseStart = (anchorOffset: number, elementAnchor = 0): LayerMeasurement['start'] =>
  ({ mode: 'clause', anchorOffset, elementAnchor });
const absoluteStart = (value: number): LayerMeasurement['start'] =>
  ({ mode: 'absolute', value });
const absoluteEnd = (value: number): LayerMeasurement['end'] =>
  ({ mode: 'absolute', value });
const scene = (over: Partial<LayerMeasurement> = {}): LayerMeasurement => ({
  kind: 'scene',
  start: clauseStart(0),
  triggerTop: 0,
  triggerHeight: 0,
  triggerEnclosedBy: [],
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
  it('freezeEnd is the fixed value itself, ignoring freezeStart and every other layer\'s dwell', () => {
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
  it('freezeStart is the fixed value itself, ignoring triggerTop and every other layer\'s dwell', () => {
    const { plans } = run([
      scene({ triggerTop: 0, end: dwell(300) }), // freezes first, for 300
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

describe('dwell before a layer\'s start', () => {
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

  // S's trigger sits 200px into T's 2000px one. T freezes at its bottom edge, long after S freezes
  // at its top. S's wrapper is the outer one, so T's sticky top makes up for S's dwell.
  it('counts only the layers that freeze first, whatever the DOM order, and offsets sticky tops to match', () => {
    const { plans } = run([
      scene({ triggerTop: 500, triggerHeight: 2000, start: clauseStart(-1280), end: dwell(500) }),
      scene({ triggerTop: 700, triggerHeight: 300, end: dwell(500) }),
    ]);

    expect(plans).toEqual<LayerPlan[]>([
      { freezeStart: 2280, freezeEnd: 2780, stickyTop: -1780, paddingHeight: 500 },
      { freezeStart: 700, freezeEnd: 1200, stickyTop: -700, paddingHeight: 500 },
    ]);
  });

  // K's 'top bottom' freezes it as it enters the viewport, before J (above K) reaches the top.
  it('keeps windows apart when a later layer freezes before an earlier one reaches its anchor', () => {
    const { plans } = run([
      scene({ triggerTop: 1000, triggerHeight: 200, end: dwell(500) }),
      scene({ triggerTop: 1300, start: clauseStart(720), end: dwell(500) }),
    ]);

    expect(plans.map(({ freezeStart, freezeEnd }) => [freezeStart, freezeEnd]))
      .toEqual([[1500, 2000], [580, 1080]]);
  });

  // J ends where an element between J and K reaches the top. K freezes first and holds J back by
  // K's dwell, start and end alike, so J keeps the length GSAP's pins would give it.
  it('moves a clause end along with the start a later-in-DOM freeze delays', () => {
    const { plans } = run([
      scene({
        triggerTop: 1000,
        triggerHeight: 200,
        triggerEnclosedBy: [0],
        end: { mode: 'clause', clause: 'top top', rawTop: 1200, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerHeight: 100,
      }),
      scene({ triggerTop: 1300, start: clauseStart(720), end: dwell(500) }),
    ]);

    expect(plans[0]).toMatchObject({ freezeStart: 1500, freezeEnd: 1700 }); // not collapsed at 1500
  });

  // No window closes before layer 1's absolute start (300), so that is its unpadded position too,
  // after layer 2's endTrigger inside it arrives (100), and layer 1 doesn't count. Subtracting the
  // dwell of every earlier layer in DOM order (500) made it look as if it froze first.
  it('places an enclosing layer\'s absolute start by the windows that close before it', () => {
    const { plans } = run([
      scene({ triggerTop: 100, triggerHeight: 100, start: clauseStart(-900), end: dwell(500) }),
      scene({ triggerTop: 300, triggerHeight: 1000, start: absoluteStart(300), end: dwell(400) }),
      scene({
        triggerTop: 1400,
        start: absoluteStart(0),
        end: { mode: 'clause', clause: 'top 250', rawTop: 350, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerIndex: null,
        endTriggerEnclosedBy: [1],
      }),
    ]);

    // 350 - 250, plus layer 0's dwell (its trigger ends above the endTrigger), not layer 1's
    expect(plans[2].paddingHeight).toBe(600);
  });

  // A scene frozen at its bottom edge, and one starting right below it at 'top bottom': the second
  // arrives just as the first freezes, and waits it out instead of freezing alongside.
  it('counts a freeze that starts just as trigger arrives', () => {
    const { plans } = run([
      scene({ triggerTop: 500, triggerHeight: 600, start: clauseStart(120), end: dwell(800) }),
      scene({ triggerTop: 1100, start: clauseStart(720), end: dwell(500) }),
    ]);

    expect(plans.map(({ freezeStart }) => freezeStart)).toEqual([380, 1180]);
  });

  // Layer 2 sits inside layer 1 and freezes first. Counted the way GSAP's pins would, each default
  // end took in the other's dwell, and both windows grew on every pass until refresh() threw.
  it('keeps a default end as long as its own geometry when nested layers freeze around it', () => {
    const { plans } = run([
      scene({ triggerTop: 154, triggerHeight: 82, start: clauseStart(800), end: clause('bottom top'), endTriggerHeight: 82 }),
      scene({
        triggerTop: 685,
        triggerHeight: 772,
        triggerEnclosedBy: [1],
        end: clause('bottom top'),
        endTriggerHeight: 772,
        endTriggerEnclosedBy: [1],
      }),
      scene({
        triggerTop: 911,
        start: clauseStart(800),
        triggerEnclosedBy: [1, 2],
        end: clause('bottom top'),
        endTriggerEnclosedBy: [1, 2],
      }),
    ]);

    expect(plans.map(({ freezeStart, freezeEnd }) => [freezeStart, freezeEnd]))
      .toEqual([[-646, 236], [2367, 3139], [993, 1793]]);
  });

  // Layers 1 to 3 sit inside layer 0. Read from the previous pass's windows, layers 1 and 2 each
  // counted the other as freezing first on alternate passes, and refresh() threw.
  it('orders nested layers by where their triggers reach their anchors', () => {
    const { plans } = run([
      scene({ triggerTop: 173, triggerHeight: 1436, end: clause('bottom top'), endTriggerHeight: 1436 }),
      scene({ triggerTop: 230, triggerHeight: 67, triggerEnclosedBy: [0, 1], end: clause('bottom top'), endTriggerHeight: 67 }),
      scene({
        triggerTop: 500,
        triggerHeight: 304,
        start: clauseStart(248, 152),
        triggerEnclosedBy: [0, 2],
        end: clause('bottom top'),
        endTriggerHeight: 304,
      }),
      scene({
        triggerTop: 1031,
        start: clauseStart(800),
        triggerEnclosedBy: [0, 3],
        end: dwell(132),
      }),
    ]);

    expect(plans.map(({ freezeStart, freezeEnd }) => [freezeStart, freezeEnd]))
      .toEqual([[173, 1609], [1666, 1733], [1887, 2439], [1734, 1866]]);
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
  // Layer 0's trigger ends above layer 1's, so its spacer would push layer 1's end down under GSAP,
  // however late layer 0 freezes here.
  it('counts a layer above trigger for an absolute start ending at trigger itself', () => {
    const { plans } = run([
      scene({ triggerTop: 150, end: dwell(300) }),
      scene({ triggerTop: 500, start: absoluteStart(100), end: clause('top top') }),
    ]);

    expect(plans.map(({ freezeStart, freezeEnd }) => [freezeStart, freezeEnd]))
      .toEqual([[850, 1150], [100, 800]]);
  });

  // Layer 1 sits inside layer 0. Counted the way GSAP's pins would, each end took in the other's
  // dwell, and both windows grew on every pass until refresh() threw.
  it('leaves nested layers out of an absolute start\'s end at trigger itself', () => {
    const { plans } = run([
      scene({ triggerHeight: 3000, start: absoluteStart(100), end: clause('bottom top'), endTriggerHeight: 3000 }),
      scene({
        triggerTop: 1000,
        triggerHeight: 500,
        triggerEnclosedBy: [0, 1],
        start: absoluteStart(200),
        end: clause('bottom top'),
        endTriggerHeight: 500,
      }),
    ]);

    expect(plans.map(({ freezeStart, freezeEnd }) => [freezeStart, freezeEnd]))
      .toEqual([[100, 3000], [200, 1500]]);
  });

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

  it('adds an earlier layer\'s dwell onto the raw position for an unregistered endTrigger inside the shared container', () => {
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

  it('converges even when DOM order and trigger position disagree, within the iteration budget', () => {
    // Array order is deliberately NOT sorted by triggerTop (unlike real usage, where
    // structure.ts guarantees that) to stress-test the position-based lookups against runPass's
    // index-based one. The layers freeze in the order 1, 2, 0, and each endTrigger sits past the
    // other two triggers, so each end counts both other dwells and each start the dwell of the
    // layers freezing before it. Verified by hand: layer 0's dwell is a constant 2200 (both other
    // layers cancel out), layer 2's is 2600 + layer 0's, and layer 1's is 2100 + the other two.
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
    const layer0Dwell = 2200; // constant: both other layers cancel out of its own difference
    const layer2Dwell = 2600 + layer0Dwell;
    const layer1Dwell = 2100 + layer0Dwell + layer2Dwell;

    expect(plans.map((plan) => plan.paddingHeight))
      .toEqual([layer0Dwell, layer1Dwell, layer2Dwell]);
  });

  it('re-measures on the spot for an endTrigger outside the shared container, without adding any dwell', () => {
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
  // layer 0's dwell moves layer 1's start; layer 0's own end counts layer 1. Undamped, each pass
  // flips between (200, 400) and (600, 0); the shared answer is p0 = 200 + p1, p1 = 600 - p0.
  it('settles two layers whose ends feed each other without cancelling on the answer they share', () => {
    const { plans } = run([
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
    ]);

    expect(plans.map(({ freezeStart, freezeEnd }) => [freezeStart, freezeEnd]))
      .toEqual([[400, 800], [900, 1100]]);
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

// Fallback results are raw GSAP 3.15.0's, with pins created in the fallback order, measured on
// chromium, webkit and firefox at a 720px viewport.
describe('endTriggers that never settle', () => {
  const nestedPair = (tEnd: number, tEndEnclosedBy: number[], sEnd: LayerMeasurement['end']) => [
    scene({
      triggerTop: 1000,
      triggerHeight: 1000,
      triggerEnclosedBy: [0],
      end: { mode: 'clause', clause: 'top top', rawTop: tEnd, measureLive: false },
      endTriggerIsSelf: false,
      endTriggerEnclosedBy: tEndEnclosedBy,
    }),
    scene({
      triggerTop: 1200,
      triggerHeight: 100,
      triggerEnclosedBy: [0, 1],
      start: clauseStart(360),
      end: sEnd,
      endTriggerIsSelf: sEnd.mode === 'dwell',
    }),
  ];
  const markerAt2500: LayerMeasurement['end']
    = { mode: 'clause', clause: 'top top', rawTop: 2500, measureLive: false };
  const paddings = (measurements: LayerMeasurement[]) =>
    run(measurements, { viewportHeight: 720 }).plans.map(({ paddingHeight }) => paddingHeight);

  // S sits inside T, and each end's marker lies past the other's trigger, so each end counts the
  // other's dwell. Refreshed with T first, T's end doesn't count S.
  it('resolves two nested layers whose ends count each other in the order GSAP would refresh them', () => {
    expect(paddings(nestedPair(2300, [], markerAt2500))).toEqual([1300, 2960]);
    expect(paddings(nestedPair(1800, [0], markerAt2500))).toEqual([800, 2460]);
  });

  it('leaves a pair that settles as it was', () => {
    expect(paddings(nestedPair(1800, [0], dwell(500)))).toEqual([1300, 500]);
  });

  // S1 and S2 sit inside T. T was refreshed first, so S2's spacer grows T but stops short of T's
  // end marker. Counting it would make S2's padding 4670.
  it('keeps a spacer inside an earlier-refreshed layer from reaching an end outside it', () => {
    const { plans } = run([
      scene({
        triggerTop: 2252,
        triggerHeight: 548,
        triggerEnclosedBy: [0],
        end: { mode: 'clause', clause: 'top bottom', rawTop: 5063, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerHeight: 205,
      }),
      scene({ triggerTop: 2555, triggerHeight: 50, triggerEnclosedBy: [0, 1], end: dwell(293) }),
      scene({
        triggerTop: 2631,
        triggerHeight: 128,
        triggerEnclosedBy: [0, 2],
        start: clauseStart(592, 128),
        end: { mode: 'clause', clause: 'top top', rawTop: 4618, measureLive: false },
        endTriggerIsSelf: false,
      }),
    ], { viewportHeight: 720 });

    expect(plans.map(({ freezeStart, freezeEnd }) => [freezeStart, freezeEnd]))
      .toEqual([[6629, 8720], [9023, 9316], [2039, 6416]]);
  });

  // The fallback order is 3, 0, 1, 2, not DOM order. Layers 1 and 2 sit inside layer 0, which is
  // refreshed before them; counting them toward layer 2's marker outside it would make layer 2's
  // padding 2673.
  it('refreshes layers after the ones they count, whatever the DOM order', () => {
    const { plans } = run([
      scene({
        triggerTop: 1883,
        triggerHeight: 311,
        triggerEnclosedBy: [0],
        end: { mode: 'clause', clause: 'top bottom', rawTop: 2717, measureLive: false },
        endTriggerIsSelf: false,
        endTriggerHeight: 186,
        endTriggerEnclosedBy: [3],
      }),
      scene({
        triggerTop: 1974,
        triggerHeight: 171,
        triggerEnclosedBy: [0, 1],
        end: clause('bottom top'),
        endTriggerHeight: 171,
      }),
      scene({
        triggerTop: 1993,
        triggerHeight: 149,
        triggerEnclosedBy: [0, 1, 2],
        start: clauseStart(720),
        end: { mode: 'clause', clause: 'bottom bottom', rawTop: 3692, measureLive: false },
        endTriggerIsSelf: false,
      }),
      scene({
        triggerTop: 2457,
        triggerHeight: 576,
        triggerEnclosedBy: [3],
        start: clauseStart(360),
        end: dwell(689),
      }),
    ], { viewportHeight: 720 });

    expect(plans.map(({ freezeStart, freezeEnd }) => [freezeStart, freezeEnd]))
      .toEqual([[4385, 4499], [4590, 4761], [1273, 3775], [4884, 5573]]);
  });

  // Layer 1's end counts layer 0 only while layer 0's absolute start, less layer 1's window
  // before it, comes before 1100. Counting it moves layer 1's window past 1500, which stops it
  // counting, whatever the refresh order.
  it('throws when an absolute start keeps flipping what an end counts', () => {
    expect(() => run([
      scene({ triggerTop: 500, triggerHeight: 2000, start: absoluteStart(1500), end: dwell(1000) }),
      scene({
        triggerTop: 3000,
        triggerHeight: 500,
        start: absoluteStart(100),
        end: clause('center center'),
        endTriggerIsSelf: false,
        endTriggerIndex: 0,
        endTriggerHeight: 2000,
        endTriggerEnclosedBy: [0],
      }),
    ])).toThrow(/circular structural dependency/);
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

  it('never adds dwell to later layers (a cover layer never creates padding)', () => {
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
