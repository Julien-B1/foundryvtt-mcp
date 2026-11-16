import { describe, expect, it } from 'vitest';
import type { WorldScene } from '../../foundry/types.js';
import { buildWalls, converter, lightData, sceneFrame, wallFields } from '../handlers.js';

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
