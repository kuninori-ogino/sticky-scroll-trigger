// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildStructure, isDomOrderStale, unbuildStructure } from './structure';
import type { CoverLayer, Layer, SceneLayer } from './types';

// Structural operations don't depend on layout (they never look at height or position),
// so every path can be verified in jsdom.

const sceneLayer = (trigger: HTMLElement): SceneLayer => ({
  kind: 'scene',
  trigger,
  endTrigger: trigger,
  container: null,
  wrapper: null,
  padding: null,
  start: 'center center',
  end: '+100%',
  freezeStart: 0,
  freezeEnd: 0,
});
const coverLayer = (base: HTMLElement, cover: HTMLElement): CoverLayer => ({
  kind: 'cover',
  trigger: base,
  endTrigger: base,
  cover,
  wrapper: null,
  start: 'bottom bottom',
  end: null,
  freezeStart: 0,
  freezeEnd: 0,
});

const setup = (html: string) => {
  document.body.innerHTML = html;

  const root = document.getElementById('root')!;

  return { root, byId: (id: string) => document.getElementById(id)! };
};

const ids = (parent: Element) => Array.from(parent.children).map((el) => el.id);

describe('buildStructure - Scene layers', () => {
  it('wraps the shared container in container{wrapper[root], padding}', () => {
    const { root, byId } = setup('<div id="host"><div id="root"><div id="s1"></div></div></div>');
    const layer = sceneLayer(byId('s1'));
    const outermost = buildStructure(root, [layer]);

    expect(outermost).toBe(layer.container);
    expect(layer.container!.parentElement).toBe(byId('host'));
    expect(Array.from(layer.container!.children)).toEqual([layer.wrapper, layer.padding]);
    expect(layer.wrapper!.firstElementChild).toBe(root);
  });

  it('layers earlier in DOM order end up deeper (= freeze first)', () => {
    const { root, byId } = setup(
      '<div id="host"><div id="root"><div id="s1"></div><div id="s2"></div></div></div>',
    );
    const first = sceneLayer(byId('s1'));
    const second = sceneLayer(byId('s2'));
    const outermost = buildStructure(root, [first, second]);

    // s2's container is outermost, s1's container sits inside it, and root sits inside that
    expect(outermost).toBe(second.container);
    expect(second.wrapper!.firstElementChild).toBe(first.container);
    expect(first.wrapper!.firstElementChild).toBe(root);
  });

  it('registration order does not matter (sorted into DOM order before building)', () => {
    const { root, byId } = setup(
      '<div id="host"><div id="root"><div id="s1"></div><div id="s2"></div></div></div>',
    );
    const second = sceneLayer(byId('s2'));
    const first = sceneLayer(byId('s1'));
    const layers: Layer[] = [second, first]; // deliberately registered out of order
    const outermost = buildStructure(root, layers);

    expect(layers).toEqual([first, second]); // the array itself gets reordered into DOM order
    expect(outermost).toBe(second.container);
    expect(first.wrapper!.firstElementChild).toBe(root);
  });

  it('the outermost container is null when there are no Scene layers', () => {
    const { root, byId } = setup(
      '<div id="root"><div id="base"></div><div id="cover"></div></div>',
    );

    expect(buildStructure(root, [coverLayer(byId('base'), byId('cover'))])).toBeNull();
  });
});

describe('buildStructure - cover layers', () => {
  it('puts only the start through base into wrapper, leaving cover onward outside', () => {
    const { root, byId } = setup(
      '<div id="root"><div id="a"></div><div id="base"></div><div id="cover"></div><div id="tail"></div></div>',
    );
    const layer = coverLayer(byId('base'), byId('cover'));

    buildStructure(root, [layer]);

    expect(ids(layer.wrapper!)).toEqual(['a', 'base']);
    expect(root.children[0]).toBe(layer.wrapper);
    expect(ids(root).slice(1)).toEqual(['cover', 'tail']);
  });

  it('with multiple cover layers, each later one nests by absorbing the earlier one\'s wrapper whole', () => {
    const { root, byId } = setup(
      '<div id="root"><div id="b1"></div><div id="c1"></div><div id="b2"></div><div id="c2"></div></div>',
    );
    const firstCover = coverLayer(byId('b1'), byId('c1'));
    const secondCover = coverLayer(byId('b2'), byId('c2'));

    buildStructure(root, [firstCover, secondCover]);

    // the later layer's (b2's) wrapper ends up holding the earlier wrapper, c1, and b2 all together
    expect(secondCover.wrapper!.children[0]).toBe(firstCover.wrapper);
    expect(ids(firstCover.wrapper!)).toEqual(['b1']);
    expect(ids(secondCover.wrapper!).slice(1)).toEqual(['c1', 'b2']);
    expect(ids(root).slice(1)).toEqual(['c2']);
  });

  it('a cover layer wraps inside the shared container, a Scene layer wraps outside it', () => {
    const { root, byId } = setup(
      '<div id="host"><div id="root"><div id="s1"></div><div id="base"></div><div id="cover"></div></div></div>',
    );
    const scene = sceneLayer(byId('s1'));
    const cover = coverLayer(byId('base'), byId('cover'));
    const outermost = buildStructure(root, [scene, cover]);

    expect(outermost).toBe(scene.container);
    expect(scene.wrapper!.firstElementChild).toBe(root);
    expect(root.contains(cover.wrapper!)).toBe(true);
  });
});

describe('isDomOrderStale', () => {
  const setupThree = () => {
    const { root, byId } = setup(
      '<div id="host"><div id="root"><div id="s1"></div><div id="s2"></div><div id="s3"></div></div></div>',
    );

    return { root, byId, layers: [byId('s1'), byId('s2'), byId('s3')].map(sceneLayer) };
  };

  it('is not stale when in DOM order', () => {
    const { layers } = setupThree();

    expect(isDomOrderStale(layers)).toBe(false);
  });

  it('is never stale with 0 or 1 layers', () => {
    const { byId } = setupThree();

    expect(isDomOrderStale([])).toBe(false);
    expect(isDomOrderStale([sceneLayer(byId('s2'))])).toBe(false);
  });

  it('is stale when registration order differs from DOM order (before building)', () => {
    const { byId } = setupThree();
    const shuffled = [sceneLayer(byId('s3')), sceneLayer(byId('s1'))];

    expect(isDomOrderStale(shuffled)).toBe(true);
  });

  // The main case: with no layers added or removed, dirty never gets set,
  // yet the nesting order still needs rebuilding.
  it('is stale once trigger elements have been reordered in the DOM', () => {
    const { root, byId, layers } = setupThree();

    buildStructure(root, layers);
    expect(isDomOrderStale(layers)).toBe(false);

    // moves s3 before s1 (no elements added or removed)
    root.insertBefore(byId('s3'), byId('s1'));

    expect(isDomOrderStale(layers)).toBe(true);
  });

  it('is no longer stale once rebuilt', () => {
    const { root, byId, layers } = setupThree();
    const outermost = buildStructure(root, layers);

    root.insertBefore(byId('s3'), byId('s1'));

    unbuildStructure(root, layers, outermost);
    buildStructure(root, layers);

    expect(isDomOrderStale(layers)).toBe(false);
    // after reordering, DOM order is s3,s1,s2, so s3 becomes innermost
    expect(layers[0].trigger.id).toBe('s3');
  });
});

describe('unbuildStructure', () => {
  const cases: {
    name: string;
    html: string;
    makeLayers: (byId: (id: string) => HTMLElement) => Layer[];
  }[] = [
    {
      name: 'Scene layers only',
      html: '<div id="host"><div id="root"><div id="s1"></div><div id="s2"></div></div></div>',
      makeLayers: (byId) => [sceneLayer(byId('s1')), sceneLayer(byId('s2'))],
    },
    {
      name: 'cover layers only',
      html: '<div id="root"><div id="b1"></div><div id="c1"></div><div id="b2"></div><div id="c2"></div></div>',
      makeLayers: (byId) => [
        coverLayer(byId('b1'), byId('c1')),
        coverLayer(byId('b2'), byId('c2')),
      ],
    },
    {
      name: 'a mix of Scene and cover layers',
      html: '<div id="host"><div id="root"><div id="s1"></div><div id="base"></div><div id="cover"></div><div id="tail"></div></div></div>',
      makeLayers: (byId) => [sceneLayer(byId('s1')), coverLayer(byId('base'), byId('cover'))],
    },
  ];

  cases.forEach(({ name, html, makeLayers }) => {
    it(`build then unbuild fully restores the DOM (${name})`, () => {
      const { root, byId } = setup(html);
      const before = document.body.innerHTML;
      const layers = makeLayers(byId);
      const outermost = buildStructure(root, layers);

      expect(document.body.innerHTML).not.toBe(before); // confirms it was actually restructured
      unbuildStructure(root, layers, outermost);

      expect(document.body.innerHTML).toBe(before);
    });
  });

  it('resets every reference a layer holds back to null', () => {
    const { root, byId } = setup(
      '<div id="host"><div id="root"><div id="s1"></div><div id="base"></div><div id="cover"></div></div></div>',
    );
    const scene = sceneLayer(byId('s1'));
    const cover = coverLayer(byId('base'), byId('cover'));

    unbuildStructure(root, [scene, cover], buildStructure(root, [scene, cover]));

    expect(scene.wrapper).toBeNull();
    expect(scene.container).toBeNull();
    expect(scene.padding).toBeNull();
    expect(cover.wrapper).toBeNull();
  });

  it('produces the same structure after a rebuild (build → unbuild → build)', () => {
    const { root, byId } = setup(
      '<div id="host"><div id="root"><div id="s1"></div><div id="base"></div><div id="cover"></div></div></div>',
    );
    const layers = () => [sceneLayer(byId('s1')), coverLayer(byId('base'), byId('cover'))];
    const first = layers();
    const firstOutermost = buildStructure(root, first);
    const built = document.body.innerHTML;

    unbuildStructure(root, first, firstOutermost);

    const second = layers();

    buildStructure(root, second);

    expect(document.body.innerHTML).toBe(built);
  });
});
