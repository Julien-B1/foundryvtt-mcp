/**
 * @fileoverview Taverne: import_uvtt — a Universal VTT map (.dd2vtt from Dungeondraft, .uvtt from
 * Arkenforge, DungeonFog, Dungeon Alchemist and most generators) becomes a scene in one call:
 * the embedded image is uploaded, the scene is sized to its grid, and its walls, doors and
 * lights are created exactly, with no tracing.
 *
 * Format: `resolution {map_origin, map_size, pixels_per_grid}`, `line_of_sight` and
 * `objects_line_of_sight` (polylines in grid units), `portals` (doors: `bounds` two points,
 * `closed`), `lights` (`position`, `range` in cells, `intensity`, `color` as AARRGGBB hex),
 * `environment {baked_lighting, ambient_light}`, `image` (base64 PNG or WebP).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FoundryClient } from '../foundry/client.js';
import type { ModuleBridge } from '../foundry/module-bridge.js';
import { isRecord } from '../utils/guards.js';
import { buildWalls, lightData, sceneFrame, type WallPath } from './handlers.js';
import { fail, str, text } from './util.js';

/** Bridge payloads can be large; Foundry accepts big uploads. A 30×20 map at 256 px is ~20 MB. */
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;

export interface UvttPoint {
  x: number;
  y: number;
}

export interface UvttFile {
  format?: number;
  resolution: { map_origin?: UvttPoint; map_size: UvttPoint; pixels_per_grid: number };
  line_of_sight?: UvttPoint[][];
  objects_line_of_sight?: UvttPoint[][];
  portals?: Array<{
    position?: UvttPoint;
    bounds: UvttPoint[];
    closed?: boolean;
    freestanding?: boolean;
  }>;
  lights?: Array<{
    position: UvttPoint;
    range?: number;
    intensity?: number;
    color?: string;
    shadows?: boolean;
  }>;
  environment?: { baked_lighting?: boolean; ambient_light?: string };
  image?: string;
}

function isPoint(p: unknown): p is UvttPoint {
  return isRecord(p) && typeof p.x === 'number' && typeof p.y === 'number';
}

export function parseUvtt(raw: string): UvttFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('Not a Universal VTT file: invalid JSON');
  }
  if (!isRecord(data) || !isRecord(data.resolution)) {
    return fail('Not a Universal VTT file: no resolution');
  }
  const r = data.resolution;
  if (!isPoint(r.map_size) || typeof r.pixels_per_grid !== 'number' || r.pixels_per_grid <= 0) {
    return fail('Not a Universal VTT file: resolution needs map_size and pixels_per_grid');
  }
  return data as unknown as UvttFile;
}

/** AARRGGBB (or RRGGBB) → #rrggbb, or undefined for white/none. */
export function uvttColor(c: unknown): string | undefined {
  if (typeof c !== 'string') {
    return undefined;
  }
  const hex = c.replace(/^#/, '');
  const rgb = hex.length === 8 ? hex.slice(2) : hex.length === 6 ? hex : undefined;
  if (!rgb || !/^[0-9a-fA-F]{6}$/.test(rgb) || /^f{6}$/i.test(rgb)) {
    return undefined;
  }
  return `#${rgb.toLowerCase()}`;
}

/** Brightness 0-1 of an AARRGGBB colour (for the ambient light → scene darkness). */
export function uvttBrightness(c: unknown): number | undefined {
  if (typeof c !== 'string') {
    return undefined;
  }
  const hex = c.replace(/^#/, '');
  const rgb = hex.length === 8 ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) {
    return undefined;
  }
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(rgb.slice(i, i + 2), 16) / 255);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** Wall paths (grid units, origin removed) from the file's sight lines, objects and doors. */
export function uvttWallPaths(
  file: UvttFile,
  presets: { wall: string; objects: string; door: string; openDoor?: boolean },
): WallPath[] {
  const o = file.resolution.map_origin ?? { x: 0, y: 0 };
  const pt = (p: UvttPoint): [number, number] => [p.x - o.x, p.y - o.y];
  const lines = (list: unknown, preset: string): WallPath[] =>
    (Array.isArray(list) ? list : [])
      .filter((l): l is UvttPoint[] => Array.isArray(l) && l.every(isPoint) && l.length >= 2)
      .map((l) => ({ points: l.map(pt), preset }));
  const doors: WallPath[] = (file.portals ?? [])
    .filter((p) => Array.isArray(p.bounds) && p.bounds.length >= 2 && p.bounds.every(isPoint))
    .map((p) => ({
      points: [pt(p.bounds[0] as UvttPoint), pt(p.bounds[1] as UvttPoint)],
      preset: presets.door,
      ...(p.closed === false || presets.openDoor ? { fields: { ds: 1 } } : {}),
    }));
  return [
    ...lines(file.line_of_sight, presets.wall),
    ...lines(file.objects_line_of_sight, presets.objects),
    ...doors,
  ];
}

/** Reads the file from the upload folder or the Foundry Data folder (never elsewhere). */
function readSource(p: string, client: FoundryClient): string {
  const roots = [client.uploadSourceDir(), client.dataDir()].filter((r): r is string => !!r);
  if (roots.length === 0) {
    fail('Set FOUNDRY_UPLOAD_SOURCE_DIR or FOUNDRY_DATA_PATH to import a file, or pass content');
  }
  for (const root of roots) {
    const base = path.resolve(root);
    const full = path.resolve(base, p);
    if ((full === base || full.startsWith(base + path.sep)) && fs.existsSync(full)) {
      return fs.readFileSync(full, 'utf8');
    }
  }
  return fail(`File not found under ${roots.join(' or ')}: ${p}`);
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'map';

export async function handleImportUvtt(
  args: Record<string, unknown>,
  client: FoundryClient,
  bridge: ModuleBridge | null,
) {
  const source = str(args.path);
  const file = parseUvtt(
    source
      ? readSource(source, client)
      : (str(args.content) ?? fail('Give path (a .dd2vtt/.uvtt file) or content')),
  );
  const ppg = file.resolution.pixels_per_grid;
  const size = file.resolution.map_size;
  const name =
    str(args.name) ?? (source ? path.basename(source).replace(/\.[^.]+$/, '') : 'Imported map');
  let sceneId = str(args.sceneId);
  const lines: string[] = [];

  if (!sceneId) {
    if (!file.image) {
      fail('The file has no embedded image: create the scene first and pass sceneId');
    }
    if (!bridge) {
      fail('Uploading the map image needs the companion module (FOUNDRY_MODULE_BRIDGE_ENABLED)');
    }
    const bytes = Math.ceil((file.image.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      fail(
        `The embedded image is ${Math.round(bytes / 1048576)} MiB (limit 48 MiB): export at fewer pixels per grid`,
      );
    }
    const head = Buffer.from(file.image.slice(0, 32), 'base64');
    // UVTT images are PNG or WebP; some exporters write JPEG.
    const ext =
      head.subarray(8, 12).toString('ascii') === 'WEBP'
        ? 'webp'
        : head[0] === 0xff && head[1] === 0xd8
          ? 'jpeg'
          : 'png';
    const targetDir = str(args.targetDir) ?? 'assets/maps/uvtt';
    const uploaded = await bridge.send(
      'upload_asset',
      {
        targetDir,
        filename: `${slug(name)}.${ext}`,
        contentBase64: file.image,
        mimeType: `image/${ext}`,
      },
      120_000,
    );
    const src =
      isRecord(uploaded) && typeof uploaded.path === 'string'
        ? uploaded.path
        : fail('Upload failed');
    const created = (await client.createScene(name, src, {
      width: Math.round(size.x * ppg),
      height: Math.round(size.y * ppg),
      gridSize: ppg,
      gridDistance: typeof args.gridDistance === 'number' ? args.gridDistance : 1.5,
      gridUnits: str(args.gridUnits) ?? 'm',
      padding: typeof args.padding === 'number' ? args.padding : 0.1,
    })) as { _id?: string } | undefined;
    sceneId = created?._id ?? fail('Scene creation returned no id');
    lines.push(
      `- scene « ${name} » (${sceneId}), ${size.x}×${size.y} cells at ${ppg} px, image ${src} (${Math.round(bytes / 1024)} KiB)`,
    );
  }

  const scene = client.getSceneOrThrow(sceneId);
  const frame = sceneFrame(scene);
  // File grid units → this scene's canvas pixels (the scene may use another grid size).
  const k = frame.width / size.x;
  const toCanvas = (x: number, y: number): [number, number] => [
    Math.round(frame.sceneX + x * k),
    Math.round(frame.sceneY + y * k),
  ];

  const paths = uvttWallPaths(file, {
    wall: str(args.wallPreset) ?? 'wall',
    objects: str(args.objectsPreset) ?? 'wall',
    door: str(args.doorPreset) ?? 'door',
  });
  const walls = buildWalls(paths, toCanvas, {});
  if (args.replace === true) {
    const old = (scene.walls ?? []).filter(isRecord).map((w) => String(w._id));
    await client.modifySceneEmbedded(sceneId, 'Wall', 'delete', old);
  }
  await client.modifySceneEmbedded(sceneId, 'Wall', 'create', walls);
  const doorCount = (file.portals ?? []).length;
  lines.push(
    `- ${walls.length} walls (${doorCount} doors${file.objects_line_of_sight?.length ? `, ${file.objects_line_of_sight.length} object outlines` : ''})`,
  );

  const lightMode = str(args.lights) ?? 'soft';
  const fileLights = file.lights ?? [];
  if (lightMode !== 'none' && fileLights.length) {
    const distance =
      isRecord(scene.grid) && typeof scene.grid.distance === 'number' ? scene.grid.distance : 1.5;
    const o = file.resolution.map_origin ?? { x: 0, y: 0 };
    const data = fileLights
      .filter((l) => isPoint(l.position))
      .map((l) => {
        const range = (l.range ?? 4) * distance;
        const intensity = Math.max(0.1, Math.min(1, l.intensity ?? 1));
        const color = uvttColor(l.color);
        // House style: wide, soft and faded; the file's range is the dim radius.
        const { config } = lightData({
          dim: Math.round(range * (lightMode === 'soft' ? 1.4 : 1) * 10) / 10,
          bright: Math.round(range * (lightMode === 'soft' ? 0.2 : 0.5) * 10) / 10,
          alpha: Math.round((lightMode === 'soft' ? 0.3 : 0.5) * intensity * 100) / 100,
          attenuation: lightMode === 'soft' ? 0.95 : 0.5,
          ...(color ? { color } : {}),
        });
        const [x, y] = toCanvas(l.position.x - o.x, l.position.y - o.y);
        return { x, y, walls: l.shadows !== false, config };
      });
    await client.modifySceneEmbedded(sceneId, 'AmbientLight', 'create', data);
    lines.push(`- ${data.length} lights (${lightMode})`);
  }

  const env = file.environment;
  const ambient = uvttBrightness(env?.ambient_light);
  if (!str(args.sceneId) && (ambient !== undefined || env?.baked_lighting)) {
    // A map with baked lighting is already lit: keep the scene bright, vision still applies.
    const darkness = env?.baked_lighting ? 0 : Math.round((1 - (ambient ?? 1)) * 100) / 100;
    await client.updateSceneDocument(sceneId, { environment: { darknessLevel: darkness } });
    lines.push(
      `- darkness ${darkness}${env?.baked_lighting ? ' (lighting baked into the image)' : ''}`,
    );
  }
  return text(
    `🗺️ **Universal VTT imported** → ${scene.name} (${sceneId})\n${lines.join('\n')}\nCheck with render_scene; dress further with create_lights / place_tiles.`,
  );
}
