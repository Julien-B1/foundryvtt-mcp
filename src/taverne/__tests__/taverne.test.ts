import { describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldScene } from '../../foundry/types.js';
import {
  buildWalls,
  combatData,
  converter,
  lightData,
  sceneFrame,
  wallFields,
} from '../handlers.js';

const scene = {
  _id: 'ssssssssssssssss',
  name: 'S',
  active: false,
  navigation: true,
  width: 1500,
  height: 1000,
  padding: 0.1,
  grid: { size: 50 },
} as WorldScene;

describe('taverne geometry', () => {
  it('computes the padding offset like FoundryVTT (rounded up to the grid)', () => {
    expect(sceneFrame(scene)).toMatchObject({ gridSize: 50, sceneX: 150, sceneY: 100 });
  });

  it('converts scene, grid and image units to canvas pixels', () => {
    const f = sceneFrame(scene);
    expect(converter(f, 'scene')(10, 20)).toEqual([160, 120]);
    expect(converter(f, 'grid')(2, 1)).toEqual([250, 150]);
    expect(converter(f, 'image', { width: 750, height: 500 })(100, 100)).toEqual([350, 300]);
    expect(() => converter(f, 'image')).toThrow(/imageWidth/);
  });
});

describe('taverne walls', () => {
  const id = (x: number, y: number): [number, number] => [x, y];

  it('turns a closed path into segments, with a door where a point names it', () => {
    const walls = buildWalls(
      [
        {
          closed: true,
          points: [
            [0, 0],
            [100, 0, 'door'],
            [100, 100],
            [0, 100],
          ],
        },
      ],
      id,
      { preset: 'cave' },
    );
    expect(walls).toHaveLength(4);
    expect(walls[0]).toMatchObject({ c: [0, 0, 100, 0], door: 1, doorSound: 'woodBasic' });
    expect(walls[1]).toMatchObject({ c: [100, 0, 100, 100], sound: 10 });
    expect(walls[3]).toMatchObject({ c: [0, 100, 0, 0] });
  });

  it('skips zero-length segments and applies field overrides', () => {
    const walls = buildWalls(
      [
        {
          points: [
            [0, 0],
            [0, 0],
            [50, 0],
          ],
          fields: { dir: 1 },
        },
      ],
      id,
      {},
    );
    expect(walls).toEqual([{ c: [0, 0, 50, 0], dir: 1 }]);
  });

  it('refuses unknown presets, fields, door sounds and animations', () => {
    expect(() => wallFields('nope', {})).toThrow(/Unknown wall preset/);
    expect(() => wallFields('wall', { colour: 1 })).toThrow(/Unknown wall field/);
    expect(() => wallFields('door', { doorSound: 'squeak' })).toThrow(/doorSound/);
    expect(() => wallFields('door', { animation: { type: 'spin' } })).toThrow(/door animation/);
  });

  it('merges nested overrides into the preset', () => {
    expect(wallFields('window', { threshold: { sight: 3 } })).toMatchObject({
      sight: 30,
      threshold: { sight: 3, light: 1.5, attenuation: true },
    });
  });
});

describe('taverne lights', () => {
  it('merges presets in order, then config', () => {
    const { config } = lightData({
      preset: ['lantern', 'nightOnly'],
      config: { dim: 12, coloration: 'externalHalo' },
    });
    expect(config).toMatchObject({
      dim: 12,
      bright: 2,
      color: '#ffb347',
      coloration: 3,
      darkness: { min: 0.5, max: 1 },
    });
  });

  it('keeps document fields apart from the light config', () => {
    const { doc, config } = lightData({ preset: 'moonbeam', rotation: 45, hidden: true });
    expect(doc).toEqual({ rotation: 45, hidden: true });
    expect(config.angle).toBe(60);
  });

  it('checks animations against the kind of source', () => {
    expect(() => lightData({ config: { animation: { type: 'magicalGloom' } } })).toThrow(
      /not valid for a light/,
    );
    expect(() => lightData({ config: { negative: true, animation: { type: 'torch' } } })).toThrow(
      /not valid for a darkness/,
    );
    expect(lightData({ preset: 'darkness' }).config.negative).toBe(true);
  });

  it('refuses unknown presets, keys and bad colours', () => {
    expect(() => lightData({ preset: 'laser' })).toThrow(/Unknown light preset/);
    expect(() => lightData({ config: { glow: 1 } })).toThrow(/Unknown light config/);
    expect(() => lightData({ config: { color: 'red' } })).toThrow(/#rrggbb/);
  });
});

describe('taverne encounters', () => {
  const scene = {
    _id: 'AAAAAAAAAAAAAAAA',
    tokens: [{ _id: 'TOKENAAAAAAAAAAA', actorId: 'ACTORAAAAAAAAAAA', hidden: true }],
  };
  const client = { getSceneOrThrow: () => scene } as unknown as FoundryClient;

  it('fills combatants from their token and leaves the encounter unstarted', () => {
    const c = combatData(
      { scene: scene._id, combatants: [{ tokenId: 'TOKENAAAAAAAAAAA', initiative: 12 }] },
      client,
    );
    expect(c).toMatchObject({ active: false, round: 0, scene: scene._id });
    expect(c.combatants).toEqual([
      {
        sceneId: scene._id,
        actorId: 'ACTORAAAAAAAAAAA',
        hidden: true,
        tokenId: 'TOKENAAAAAAAAAAA',
        initiative: 12,
      },
    ]);
  });

  it('refuses an unknown token or a missing scene', () => {
    expect(() =>
      combatData({ scene: scene._id, combatants: [{ tokenId: 'NOPE' }] }, client),
    ).toThrow(/not found/);
    expect(() => combatData({ combatants: [] }, client)).toThrow(/scene/);
  });
});

describe('taverne snapshots', () => {
  it('compares sources ignoring key order and _stats', async () => {
    const { same } = await import('../snapshots.js');
    expect(
      same({ a: 1, b: [{ x: 1, y: 2 }], _stats: { t: 1 } }, { b: [{ y: 2, x: 1 }], a: 1 }),
    ).toBe(true);
    expect(same({ a: 1 }, { a: 2 })).toBe(false);
    expect(same({ a: 1 }, undefined)).toBe(false);
  });
});

describe('taverne light fields', () => {
  it('accepts config fields given flat and refuses unknown ones', () => {
    expect(lightData({ dim: 20, bright: 4 }).config).toMatchObject({ dim: 20, bright: 4 });
    expect(() => lightData({ radius: 20 })).toThrow(/Unknown light field "radius"/);
  });
});

describe('taverne tiles', () => {
  it('builds occlusion masks, a seeded generator and wall distances', async () => {
    const { occlusionModes, rng, segmentDistance } = await import('../tiles.js');
    expect(occlusionModes(['fade', 'radial'])).toBe(5);
    expect(occlusionModes(undefined)).toBe(0);
    expect(() => occlusionModes('roof')).toThrow(/Unknown occlusion/);
    const a = rng(42);
    const b = rng(42);
    expect([a(), a()]).toEqual([b(), b()]);
    expect(segmentDistance(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(segmentDistance(-3, 4, 0, 0, 10, 0)).toBe(5);
  });
});

describe('taverne universal vtt', () => {
  it('reads walls, doors and colours from a UVTT file', async () => {
    const { parseUvtt, uvttColor, uvttBrightness, uvttWallPaths } = await import('../uvtt.js');
    const file = parseUvtt(
      JSON.stringify({
        resolution: { map_origin: { x: 1, y: 1 }, map_size: { x: 10, y: 8 }, pixels_per_grid: 100 },
        line_of_sight: [
          [
            { x: 1, y: 1 },
            { x: 5, y: 1 },
            { x: 5, y: 4 },
          ],
        ],
        objects_line_of_sight: [
          [
            { x: 3, y: 3 },
            { x: 4, y: 3 },
          ],
        ],
        portals: [
          {
            bounds: [
              { x: 2, y: 1 },
              { x: 3, y: 1 },
            ],
            closed: false,
          },
        ],
      }),
    );
    const paths = uvttWallPaths(file, { wall: 'cave', objects: 'invisible', door: 'door' });
    expect(paths).toEqual([
      {
        points: [
          [0, 0],
          [4, 0],
          [4, 3],
        ],
        preset: 'cave',
      },
      {
        points: [
          [2, 2],
          [3, 2],
        ],
        preset: 'invisible',
      },
      {
        points: [
          [1, 0],
          [2, 0],
        ],
        preset: 'door',
        fields: { ds: 1 },
      },
    ]);
    expect(uvttColor('ffeccd8b')).toBe('#eccd8b');
    expect(uvttColor('ffffffff')).toBeUndefined();
    expect(uvttBrightness('ff000000')).toBe(0);
    expect(() => parseUvtt('{"foo":1}')).toThrow(/no resolution/);
  });
});
