/**
 * @fileoverview Taverne: place_tiles — many decor tiles in one call: props, roofs and canopies
 * that fade, scattered clutter (rocks, bushes, barrels) with seeded random size and rotation,
 * kept off the walls.
 */

import type { FoundryClient } from '../foundry/client.js';
import { isRecord } from '../utils/guards.js';
import { converter, sceneFrame, type Units } from './handlers.js';
import { fail, str, text } from './util.js';

/** FoundryVTT 14 CONST.OCCLUSION_MODES (a bit mask). */
export const OCCLUSION = { none: 0, fade: 1, surface: 2, radial: 4, vision: 8 } as const;

export function occlusionModes(v: unknown): number {
  const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
  let mask = 0;
  for (const m of list) {
    const bit = typeof m === 'string' ? OCCLUSION[m as keyof typeof OCCLUSION] : undefined;
    if (bit === undefined) {
      fail(`Unknown occlusion "${String(m)}". Known: ${Object.keys(OCCLUSION).join(', ')}`);
    }
    mask |= bit;
  }
  return mask;
}

/** Small seeded PRNG (mulberry32), so a scatter can be reproduced. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance from point (px, py) to segment (x1, y1)-(x2, y2). */
export function segmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const range = (v: unknown, name: string): [number, number] | undefined => {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v === 'number') {
    return [v, v];
  }
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) {
    return [v[0] as number, v[1] as number];
  }
  return fail(`${name} must be a number or [min, max]`);
};

interface TileSpec {
  src: string;
  /** Centre, canvas px. */
  cx: number;
  cy: number;
  scale: number;
  rotation: number;
  spec: Record<string, unknown>;
}

export async function handlePlaceTiles(args: Record<string, unknown>, client: FoundryClient) {
  const sceneId = str(args.sceneId) ?? fail('sceneId is required');
  const scene = client.getSceneOrThrow(sceneId);
  const frame = sceneFrame(scene);
  const units = (str(args.units) ?? 'scene') as Units;
  const image = { width: num(args.imageWidth), height: num(args.imageHeight) };
  const toCanvas = converter(frame, units, image);
  // Length of one unit in canvas px.
  const unit =
    units === 'grid'
      ? frame.gridSize
      : units === 'image'
        ? frame.width / (image.width ?? fail('units "image" needs imageWidth'))
        : 1;
  const assetGrid = num(args.assetGridSize);
  const raw = scene as unknown as Record<string, unknown>;
  const level = (Array.isArray(raw.levels) ? raw.levels : []).filter(isRecord)[0];
  const top = isRecord(level?.elevation) ? num(level.elevation.top) : undefined;
  const overheadElevation = num(args.overheadElevation) ?? top ?? 20;

  const specs: TileSpec[] = [];
  for (const [i, t] of (Array.isArray(args.tiles) ? args.tiles : []).entries()) {
    if (!isRecord(t) || typeof t.src !== 'string') {
      fail(`tiles[${i}] needs src`);
    }
    const x = num(t.x) ?? fail(`tiles[${i}] needs x and y (the centre)`);
    const y = num(t.y) ?? fail(`tiles[${i}] needs x and y (the centre)`);
    const [cx, cy] = toCanvas(x, y);
    specs.push({
      src: t.src,
      cx,
      cy,
      scale: num(t.scale) ?? 1,
      rotation: num(t.rotation) ?? 0,
      spec: t,
    });
  }

  let scatterNote = '';
  if (isRecord(args.scatter)) {
    const sc = args.scatter;
    const srcs =
      typeof sc.src === 'string'
        ? [sc.src]
        : Array.isArray(sc.src)
          ? sc.src.filter((s): s is string => typeof s === 'string')
          : [];
    if (srcs.length === 0) {
      fail('scatter.src is required (an image path or a list to pick from)');
    }
    const count = num(sc.count) ?? fail('scatter.count is required');
    const area = isRecord(sc.area)
      ? sc.area
      : fail('scatter.area {x, y, width, height} is required');
    const [ax, ay] = toCanvas(num(area.x) ?? 0, num(area.y) ?? 0);
    const aw = (num(area.width) ?? fail('scatter.area.width')) * unit;
    const ah = (num(area.height) ?? fail('scatter.area.height')) * unit;
    const [smin, smax] = range(sc.scale, 'scatter.scale') ?? [1, 1];
    const [rmin, rmax]: [number, number] =
      sc.rotation === false ? [0, 0] : (range(sc.rotation, 'scatter.rotation') ?? [0, 360]);
    const minDist = (num(sc.minDistance) ?? 0) * unit;
    const wallMargin = (num(sc.wallMargin) ?? 0) * unit;
    const seed = num(sc.seed) ?? Math.floor(Math.random() * 1e9);
    const rand = rng(seed);
    const walls =
      sc.avoidWalls === false
        ? []
        : (Array.isArray(raw.walls) ? raw.walls : []).filter(isRecord).filter((w) => w.move !== 0);
    const placed: Array<[number, number]> = specs.map((s) => [s.cx, s.cy]);
    let tries = 0;
    let made = 0;
    while (made < count && tries < count * 200) {
      tries++;
      const cx = ax + rand() * aw;
      const cy = ay + rand() * ah;
      if (placed.some(([px, py]) => Math.hypot(px - cx, py - cy) < minDist)) {
        continue;
      }
      if (
        walls.some((w) => {
          const c = Array.isArray(w.c) ? (w.c as number[]) : [];
          return (
            segmentDistance(cx, cy, c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0) < wallMargin + 1
          );
        })
      ) {
        continue;
      }
      placed.push([cx, cy]);
      specs.push({
        src: srcs[Math.floor(rand() * srcs.length)] as string,
        cx,
        cy,
        scale: smin + rand() * (smax - smin),
        rotation: rmin + rand() * (rmax - rmin),
        spec: sc,
      });
      made++;
    }
    scatterNote = `\nscatter: ${made}/${count} placed (seed ${seed} to reproduce)${made < count ? ' — no more room: lower minDistance or widen the area' : ''}`;
  }
  if (specs.length === 0) {
    fail('Give tiles and/or scatter');
  }

  const sizes = new Map<string, { width: number; height: number }>();
  const data = specs.map(({ src, cx, cy, scale, rotation, spec }) => {
    let w = num(spec.width) !== undefined ? (num(spec.width) as number) * unit : undefined;
    let h = num(spec.height) !== undefined ? (num(spec.height) as number) * unit : undefined;
    if (w === undefined || h === undefined) {
      let natural = sizes.get(src);
      if (!natural) {
        natural = client.imageSizeOf(src);
        sizes.set(src, natural);
      }
      // An asset pack drawn at assetGridSize px per cell is scaled to the scene's grid.
      const k = assetGrid ? frame.gridSize / assetGrid : 1;
      w ??= natural.width * k * (h !== undefined ? h / (natural.height * k) : 1);
      h ??= natural.height * k * (w / (natural.width * k));
    }
    w *= scale;
    h *= scale;
    const overhead = spec.overhead === true || args.overhead === true;
    const occ = spec.occlusion ?? args.occlusion ?? (overhead ? 'fade' : undefined);
    const tile: Record<string, unknown> = {
      texture: {
        src,
        ...(spec.mirrorX === true ? { scaleX: -1 } : {}),
        ...(spec.mirrorY === true ? { scaleY: -1 } : {}),
        ...(typeof spec.tint === 'string' ? { tint: spec.tint } : {}),
      },
      // FoundryVTT 14: a tile's x/y is its centre (texture anchor 0.5).
      x: Math.round(cx),
      y: Math.round(cy),
      width: Math.round(w),
      height: Math.round(h),
      rotation: Math.round(rotation * 10) / 10,
      elevation: num(spec.elevation) ?? num(args.elevation) ?? (overhead ? overheadElevation : 0),
      alpha: num(spec.alpha) ?? num(args.alpha) ?? 1,
      hidden: spec.hidden === true || args.hidden === true,
      occlusion: {
        modes: occlusionModes(occ),
        alpha: num(spec.occlusionAlpha) ?? num(args.occlusionAlpha) ?? 0,
      },
      ...(isRecord(spec.restrictions) ? { restrictions: spec.restrictions } : {}),
      ...(num(spec.sort) !== undefined ? { sort: spec.sort } : {}),
      ...(typeof spec.name === 'string' ? { name: spec.name } : {}),
    };
    return tile;
  });
  const created = await client.modifySceneEmbedded(sceneId, 'Tile', 'create', data);
  return text(
    `🪨 **${created.length} tiles placed** on ${scene.name}${scatterNote}\n${created
      .slice(0, 40)
      .map((c) =>
        isRecord(c) ? `- ${String(c._id)} ${String(isRecord(c.texture) ? c.texture.src : '')}` : '',
      )
      .join('\n')}${created.length > 40 ? '\n…' : ''}`,
  );
}
