/**
 * @fileoverview Taverne: batch tools for walls, lights and scene configuration.
 *
 * Every write goes through FoundryClient.modifySceneEmbedded / updateSceneDocument,
 * i.e. one `modifyDocument` request per batch (the core write protocol).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../foundry/client.js';
import type { WorldScene } from '../foundry/types.js';
import { isRecord } from '../utils/guards.js';
import {
  COLORATION,
  DARKNESS_ANIMATIONS,
  DOOR_ANIMATIONS,
  DOOR_SOUNDS,
  LIGHT_ANIMATIONS,
  LIGHT_PRESETS,
  WALL_PRESETS,
} from './presets.js';
import { getTrace, type TracedPath } from './vision.js';

type Text = { content: Array<{ type: 'text'; text: string }> };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
function fail(m: string): never {
  throw new McpError(ErrorCode.InvalidParams, m);
}

/* -------------------------------------------- */
/*  Coordinates                                 */
/* -------------------------------------------- */

/** Scene geometry needed to convert coordinates (FoundryVTT v14 square-grid formula). */
export interface SceneFrame {
  gridSize: number;
  sceneX: number;
  sceneY: number;
  width: number;
  height: number;
}

export function sceneFrame(scene: WorldScene): SceneFrame {
  const grid = isRecord(scene.grid) ? scene.grid : {};
  const size = typeof grid.size === 'number' && grid.size > 0 ? grid.size : 100;
  const padding = typeof scene.padding === 'number' ? scene.padding : 0;
  const raw: Record<string, unknown> = { ...scene };
  const shiftX = typeof raw.shiftX === 'number' ? raw.shiftX : 0;
  const shiftY = typeof raw.shiftY === 'number' ? raw.shiftY : 0;
  return {
    gridSize: size,
    sceneX: Math.ceil((padding * scene.width) / size) * size - shiftX,
    sceneY: Math.ceil((padding * scene.height) / size) * size - shiftY,
    width: scene.width,
    height: scene.height,
  };
}

export type Units = 'scene' | 'canvas' | 'grid' | 'image';

/**
 * Builds a converter to canvas pixels.
 * - `canvas`: raw canvas pixels (padding included), what Foundry stores.
 * - `scene`: pixels from the top-left corner of the map (padding excluded).
 * - `grid`: grid vertices from the map's top-left corner (fractions allowed).
 * - `image`: pixels of the source image, scaled to the scene size (needs imageWidth/imageHeight).
 */
export function converter(
  frame: SceneFrame,
  units: Units,
  image?: { width?: number | undefined; height?: number | undefined },
): (x: number, y: number) => [number, number] {
  switch (units) {
    case 'canvas':
      return (x, y) => [Math.round(x), Math.round(y)];
    case 'grid':
      return (x, y) => [
        Math.round(frame.sceneX + x * frame.gridSize),
        Math.round(frame.sceneY + y * frame.gridSize),
      ];
    case 'image': {
      const iw = image?.width ?? fail('units "image" needs imageWidth and imageHeight');
      const ih = image?.height ?? fail('units "image" needs imageWidth and imageHeight');
      const kx = frame.width / iw;
      const ky = frame.height / ih;
      return (x, y) => [Math.round(frame.sceneX + x * kx), Math.round(frame.sceneY + y * ky)];
    }
    default:
      return (x, y) => [Math.round(frame.sceneX + x), Math.round(frame.sceneY + y)];
  }
}

/* -------------------------------------------- */
/*  Walls                                       */
/* -------------------------------------------- */

const WALL_FIELD_KEYS = new Set([
  'move',
  'sight',
  'light',
  'sound',
  'dir',
  'door',
  'ds',
  'doorSound',
  'threshold',
  'animation',
  'flags',
]);

/** Resolves a preset name plus field overrides into Wall fields. */
export function wallFields(preset: unknown, overrides: unknown): Record<string, unknown> {
  const name = typeof preset === 'string' ? preset : 'wall';
  const base =
    WALL_PRESETS[name] ??
    fail(`Unknown wall preset "${name}". Known: ${Object.keys(WALL_PRESETS).join(', ')}`);
  const out: Record<string, unknown> = structuredClone(base.fields);
  if (isRecord(overrides)) {
    for (const [k, v] of Object.entries(overrides)) {
      if (!WALL_FIELD_KEYS.has(k)) {
        fail(`Unknown wall field "${k}". Allowed: ${[...WALL_FIELD_KEYS].join(', ')}`);
      }
      out[k] = isRecord(v) && isRecord(out[k]) ? { ...(out[k] as object), ...v } : v;
    }
  }
  if (
    typeof out.doorSound === 'string' &&
    !(DOOR_SOUNDS as readonly string[]).includes(out.doorSound)
  ) {
    fail(`Unknown doorSound "${out.doorSound}". Known: ${DOOR_SOUNDS.join(', ')}`);
  }
  if (
    isRecord(out.animation) &&
    typeof out.animation.type === 'string' &&
    out.animation.type &&
    !(DOOR_ANIMATIONS as readonly string[]).includes(out.animation.type)
  ) {
    fail(`Unknown door animation "${out.animation.type}". Known: ${DOOR_ANIMATIONS.join(', ')}`);
  }
  return out;
}

type PathPoint = [number, number] | [number, number, string];

interface WallPath {
  points: PathPoint[];
  closed?: boolean;
  preset?: string;
  fields?: Record<string, unknown>;
}

/**
 * Turns paths into Wall data. A point written [x, y, "door"] makes the segment that
 * ENDS at this point use that preset (handy to put a door in a room outline).
 */
export function buildWalls(
  paths: WallPath[],
  toCanvas: (x: number, y: number) => [number, number],
  defaults: { preset?: string | undefined; fields?: Record<string, unknown> | undefined },
): Array<Record<string, unknown>> {
  const walls: Array<Record<string, unknown>> = [];
  for (const [i, path] of paths.entries()) {
    if (!isRecord(path) || !Array.isArray(path.points) || path.points.length < 2) {
      fail(`paths[${i}] needs at least two points`);
    }
    const pts = path.points.map((p, j) => {
      if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        fail(`paths[${i}].points[${j}] must be [x, y] or [x, y, preset]`);
      }
      const [x, y] = toCanvas(p[0], p[1]);
      return { x, y, preset: typeof p[2] === 'string' ? p[2] : undefined };
    });
    const first = pts[0];
    if (path.closed && first) {
      pts.push({ ...first });
    }
    const pathPreset = path.preset ?? defaults.preset;
    const pathFields = { ...(defaults.fields ?? {}), ...(path.fields ?? {}) };
    for (let j = 1; j < pts.length; j++) {
      const a = pts[j - 1];
      const b = pts[j];
      if (!a || !b) {
        continue;
      }
      if (a.x === b.x && a.y === b.y) {
        continue;
      }
      const preset = b.preset ?? pathPreset;
      walls.push({ c: [a.x, a.y, b.x, b.y], ...wallFields(preset, b.preset ? {} : pathFields) });
    }
  }
  return walls;
}

export async function handleCreateWalls(args: Record<string, unknown>, client: FoundryClient) {
  const sceneId = typeof args.sceneId === 'string' ? args.sceneId : fail('sceneId is required');
  const scene = client.getSceneOrThrow(sceneId);
  const frame = sceneFrame(scene);
  const toCanvas = converter(frame, (args.units as Units) ?? 'scene', {
    width: args.imageWidth as number | undefined,
    height: args.imageHeight as number | undefined,
  });
  const defaults = {
    preset: args.preset as string | undefined,
    fields: args.fields as Record<string, unknown> | undefined,
  };
  const walls: Array<Record<string, unknown>> = [];
  if (typeof args.fromTrace === 'string') {
    const trace = getTrace(args.fromTrace);
    let traced = trace.paths;
    if (Array.isArray(args.tracePaths)) {
      traced = (args.tracePaths as number[])
        .map((i) => traced[i])
        .filter((t): t is TracedPath => t !== undefined);
    }
    walls.push(...buildWalls(traced, converter(frame, 'scene'), defaults));
  }
  if (Array.isArray(args.paths)) {
    walls.push(...buildWalls(args.paths as WallPath[], toCanvas, defaults));
  }
  if (!walls.length) {
    fail('Nothing to create: give paths and/or fromTrace');
  }
  if (args.replace === true) {
    const ids = (scene.walls ?? [])
      .map((w) => w._id)
      .filter((id): id is string => typeof id === 'string');
    await client.modifySceneEmbedded(sceneId, 'Wall', 'delete', ids);
  }
  const created = await client.modifySceneEmbedded(sceneId, 'Wall', 'create', walls);
  const byKind = new Map<string, number>();
  for (const w of walls) {
    const kind =
      w.door === 2
        ? 'secret door'
        : w.door === 1
          ? 'door'
          : w.dir
            ? 'one-way'
            : w.move === 0
              ? 'no-move'
              : w.sight === 0
                ? 'see-through'
                : w.sight === 10
                  ? 'terrain'
                  : 'blocking';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const lengths = walls.map((w) => {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = w.c as number[];
    return Math.hypot(x2 - x1, y2 - y1);
  });
  const avg = lengths.reduce((s, l) => s + l, 0) / Math.max(1, lengths.length);
  return text(
    `🧱 **${created.length} walls created** on ${scene.name}${args.replace === true ? ' (previous walls removed)' : ''}\n` +
      `${[...byKind].map(([k, n]) => `${n} ${k}`).join(', ')}\n` +
      `Average segment: ${avg.toFixed(0)} px (${(avg / frame.gridSize).toFixed(2)} grid)`,
  );
}

/* -------------------------------------------- */
/*  Lights                                      */
/* -------------------------------------------- */

const LIGHT_CONFIG_KEYS = new Set([
  'negative',
  'priority',
  'alpha',
  'angle',
  'bright',
  'color',
  'coloration',
  'dim',
  'attenuation',
  'luminosity',
  'saturation',
  'contrast',
  'shadows',
  'animation',
  'darkness',
]);
const LIGHT_DOC_KEYS = new Set([
  'rotation',
  'walls',
  'vision',
  'hidden',
  'elevation',
  'name',
  'locked',
  'flags',
]);

function mergeDeep(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = isRecord(v) && isRecord(out[k]) ? mergeDeep(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/** Resolves presets (one or several, merged in order) and overrides into AmbientLight data. */
export function lightData(spec: Record<string, unknown>): {
  doc: Record<string, unknown>;
  config: Record<string, unknown>;
} {
  const names = Array.isArray(spec.preset) ? spec.preset : spec.preset ? [spec.preset] : [];
  let config: Record<string, unknown> = {};
  let doc: Record<string, unknown> = {};
  for (const n of names) {
    const p = typeof n === 'string' ? LIGHT_PRESETS[n] : undefined;
    if (!p) {
      fail(`Unknown light preset "${String(n)}". Known: ${Object.keys(LIGHT_PRESETS).join(', ')}`);
    }
    config = mergeDeep(config, structuredClone(p.config));
    if (p.doc) {
      doc = { ...doc, ...p.doc };
    }
  }
  if (isRecord(spec.config)) {
    for (const k of Object.keys(spec.config)) {
      if (!LIGHT_CONFIG_KEYS.has(k)) {
        fail(`Unknown light config "${k}". Allowed: ${[...LIGHT_CONFIG_KEYS].join(', ')}`);
      }
    }
    config = mergeDeep(config, spec.config);
  }
  for (const k of LIGHT_DOC_KEYS) {
    if (spec[k] !== undefined) {
      doc[k] = spec[k];
    }
  }
  if (typeof config.coloration === 'string') {
    config.coloration =
      (COLORATION as Record<string, number>)[config.coloration] ??
      fail(
        `Unknown coloration "${config.coloration}". Known: ${Object.keys(COLORATION).join(', ')}`,
      );
  }
  const anim = isRecord(config.animation) ? config.animation : undefined;
  if (anim && typeof anim.type === 'string') {
    const ok = config.negative
      ? (DARKNESS_ANIMATIONS as readonly string[])
      : (LIGHT_ANIMATIONS as readonly string[]);
    if (!ok.includes(anim.type)) {
      fail(
        `Animation "${anim.type}" is not valid for a ${config.negative ? 'darkness' : 'light'} source. Known: ${ok.join(', ')}`,
      );
    }
  }
  if (typeof config.color === 'string' && !/^#[0-9a-fA-F]{6}$/.test(config.color)) {
    fail(`color must be #rrggbb, got ${config.color}`);
  }
  return { doc, config };
}

export async function handleCreateLights(args: Record<string, unknown>, client: FoundryClient) {
  const sceneId = typeof args.sceneId === 'string' ? args.sceneId : fail('sceneId is required');
  const scene = client.getSceneOrThrow(sceneId);
  const toCanvas = converter(sceneFrame(scene), (args.units as Units) ?? 'scene', {
    width: args.imageWidth as number | undefined,
    height: args.imageHeight as number | undefined,
  });
  const lights = Array.isArray(args.lights) ? args.lights : fail('lights is required (array)');
  const data = lights.map((l, i) => {
    if (!isRecord(l) || !Number.isFinite(l.x) || !Number.isFinite(l.y)) {
      fail(`lights[${i}] needs x and y`);
    }
    const spec = l as Record<string, unknown>;
    const [x, y] = toCanvas(spec.x as number, spec.y as number);
    const { doc, config } = lightData(spec);
    return { x, y, walls: true, vision: false, ...doc, config };
  });
  if (args.replace === true) {
    const ids = (scene.lights ?? [])
      .map((w) => w._id)
      .filter((id): id is string => typeof id === 'string');
    await client.modifySceneEmbedded(sceneId, 'AmbientLight', 'delete', ids);
  }
  const created = await client.modifySceneEmbedded(sceneId, 'AmbientLight', 'create', data);
  const summary = lights
    .map((l) =>
      isRecord(l)
        ? Array.isArray(l.preset)
          ? l.preset.join('+')
          : ((l.preset as string) ?? 'custom')
        : '?',
    )
    .reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>());
  return text(
    `💡 **${created.length} lights created** on ${scene.name}${args.replace === true ? ' (previous lights removed)' : ''}\n` +
      [...summary].map(([n, c]) => `${c}× ${n}`).join(', '),
  );
}

export async function handleUpdateLights(args: Record<string, unknown>, client: FoundryClient) {
  const sceneId = typeof args.sceneId === 'string' ? args.sceneId : fail('sceneId is required');
  const scene = client.getSceneOrThrow(sceneId);
  const updates = Array.isArray(args.updates) ? args.updates : fail('updates is required (array)');
  const toCanvas = converter(sceneFrame(scene), (args.units as Units) ?? 'scene', {
    width: args.imageWidth as number | undefined,
    height: args.imageHeight as number | undefined,
  });
  const data = updates.map((u, i) => {
    if (!isRecord(u) || typeof u.id !== 'string') {
      fail(`updates[${i}] needs id`);
    }
    const spec = u as Record<string, unknown>;
    const { doc, config } = lightData(spec);
    const out: Record<string, unknown> = { _id: spec.id, ...doc };
    if (Object.keys(config).length) {
      out.config = config;
    }
    if (Number.isFinite(spec.x) && Number.isFinite(spec.y)) {
      [out.x, out.y] = toCanvas(spec.x as number, spec.y as number);
    }
    return out;
  });
  const updated = await client.modifySceneEmbedded(sceneId, 'AmbientLight', 'update', data);
  return text(`💡 **${updated.length} lights updated** on ${scene.name}`);
}

/* -------------------------------------------- */
/*  Clear / list presets / configure scene      */
/* -------------------------------------------- */

const CLEAR_KINDS: Record<string, { type: string; key: keyof WorldScene }> = {
  walls: { type: 'Wall', key: 'walls' },
  lights: { type: 'AmbientLight', key: 'lights' },
  sounds: { type: 'AmbientSound', key: 'sounds' },
  tiles: { type: 'Tile', key: 'tiles' },
  drawings: { type: 'Drawing', key: 'drawings' },
  notes: { type: 'Note', key: 'notes' },
};

export async function handleClearSceneElements(
  args: Record<string, unknown>,
  client: FoundryClient,
) {
  const sceneId = typeof args.sceneId === 'string' ? args.sceneId : fail('sceneId is required');
  const scene = client.getSceneOrThrow(sceneId);
  const kinds =
    Array.isArray(args.kinds) && args.kinds.length
      ? (args.kinds as string[])
      : fail('kinds is required, e.g. ["walls","lights"]');
  const ids = Array.isArray(args.ids) ? new Set(args.ids as string[]) : null;
  const lines: string[] = [];
  for (const kind of kinds) {
    const k =
      CLEAR_KINDS[kind] ??
      fail(`Unknown kind "${kind}". Known: ${Object.keys(CLEAR_KINDS).join(', ')}`);
    const list = (scene[k.key] as Array<Record<string, unknown>> | undefined) ?? [];
    const target = list
      .map((d) => d._id)
      .filter((id): id is string => typeof id === 'string' && (!ids || ids.has(id)));
    await client.modifySceneEmbedded(sceneId, k.type, 'delete', target);
    lines.push(`${target.length} ${kind}`);
  }
  return text(`🧹 **Removed** from ${scene.name}: ${lines.join(', ')}`);
}

/** House style for dressing a scene, returned by list_scene_presets so any AI client follows it. */
export const DRESSING_GUIDE = `## How to dress a scene (house style)
Walls
- Draw walls like a GM would by hand: compact silhouettes, about 10-20 points per obstacle, segments of 1-2 grid cells. Ignore small spikes (crystal petals, roots tips); never pixel-perfect outlines.
- Trace in separate layers with trace_walls: the cave/rock edge (mode dark + invert, open ~6, epsilon ~16), then bright formations (mode light, close ~10, epsilon ~16). Drop stray little loops (light streaks, logos, frames, docks).
- Towns and villages: do NOT wall every building. Exteriors stay open; at most wall the edge of the map (forest edge as terrain) and the few interiors that will be played.
- Translucent obstacles (crystal, ice, glass) use preset crystal: they must never cut light.
Lights
- Ambient lights are wide, soft and heavily faded: big dim radius, small bright core, attenuation ~0.95, alpha 0.25-0.35. Avoid a scatter of small light points.
- A light inside an obstacle (rune on a stone, glow in a crystal) gets walls: false so its halo spreads.
- Do not light open water or the sea; light the docks, the shore lanterns, not the water.
- No large cone lights (moonbeam/sunbeam) over a whole map: they read as an ugly triangle. Keep cones short and inside rooms or under windows.
- Negative (darkness) sources render as black discs: use them only for real magical darkness, not for shade under trees.
- Check every result with render_scene (walls overlay for precision, effects only for mood) before calling it done.`;

export function handleListScenePresets() {
  const walls = Object.entries(WALL_PRESETS)
    .map(([k, v]) => `- \`${k}\` — ${v.description}`)
    .join('\n');
  const lights = Object.entries(LIGHT_PRESETS)
    .map(([k, v]) => `- \`${k}\` — ${v.description}`)
    .join('\n');
  return text(
    `${DRESSING_GUIDE}\n\n## Wall presets\n${walls}\n\n## Light presets\n${lights}\n\n` +
      `## Light animations\n${LIGHT_ANIMATIONS.join(', ')}\nDarkness (negative) animations: ${DARKNESS_ANIMATIONS.join(', ')}\n\n` +
      `## Coloration techniques\n${Object.keys(COLORATION).join(', ')}\n\n` +
      `## Door sounds\n${DOOR_SOUNDS.join(', ')}\nDoor animations: ${DOOR_ANIMATIONS.join(', ')}`,
  );
}

/** Top-level Scene fields configure_scene may change (dot paths below them are allowed). */
const SCENE_KEYS = new Set([
  'name',
  'navigation',
  'navName',
  'backgroundColor',
  'environment',
  'fog',
  'tokenVision',
  'weather',
  'grid',
  'initial',
  'padding',
  'foreground',
  'foregroundElevation',
  'background',
  'flags',
  'ownership',
  'thumb',
]);

export async function handleConfigureScene(args: Record<string, unknown>, client: FoundryClient) {
  const sceneId = typeof args.sceneId === 'string' ? args.sceneId : fail('sceneId is required');
  const scene = client.getSceneOrThrow(sceneId);
  const changes = isRecord(args.changes)
    ? args.changes
    : fail('changes is required (object, dot paths allowed)');
  for (const key of Object.keys(changes)) {
    const top = key.split('.')[0] ?? '';
    if (!SCENE_KEYS.has(top)) {
      fail(`Scene field "${top}" is not allowed. Allowed: ${[...SCENE_KEYS].join(', ')}`);
    }
  }
  await client.updateSceneDocument(sceneId, changes);
  return text(`🗺️ **Scene updated**: ${scene.name}\n${Object.keys(changes).join(', ')}`);
}

/* -------------------------------------------- */
/*  Update walls                                */
/* -------------------------------------------- */

const WALL_FILTER_KEYS = ['move', 'sight', 'light', 'sound', 'dir', 'door'] as const;

/**
 * Re-dresses existing walls in one call: pick them by ids and/or by field values
 * (e.g. {sight: 10}), and/or inside a rectangle (scene units), then apply a preset and/or fields.
 */
export async function handleUpdateWalls(args: Record<string, unknown>, client: FoundryClient) {
  const sceneId = typeof args.sceneId === 'string' ? args.sceneId : fail('sceneId is required');
  const scene = client.getSceneOrThrow(sceneId);
  const frame = sceneFrame(scene);
  const ids = Array.isArray(args.ids) ? new Set(args.ids as string[]) : null;
  const where = isRecord(args.where) ? args.where : {};
  for (const k of Object.keys(where)) {
    if (!(WALL_FILTER_KEYS as readonly string[]).includes(k)) {
      fail(`where.${k} is not a filter. Allowed: ${WALL_FILTER_KEYS.join(', ')}`);
    }
  }
  const within = isRecord(args.within) ? (args.within as Record<string, number>) : null;
  if (!ids && !Object.keys(where).length && !within) {
    fail('Give ids, where and/or within to choose the walls');
  }
  const defaults: Record<string, number> = {
    move: 20,
    sight: 20,
    light: 20,
    sound: 20,
    dir: 0,
    door: 0,
  };
  const chosen = (scene.walls ?? []).filter((w) => {
    if (typeof w._id !== 'string' || (ids && !ids.has(w._id))) {
      return false;
    }
    for (const [k, v] of Object.entries(where)) {
      if ((w[k] ?? defaults[k]) !== v) {
        return false;
      }
    }
    if (within) {
      const c = (w.c as number[]) ?? [];
      const inside = (x = 0, y = 0) =>
        x - frame.sceneX >= (within.x ?? 0) &&
        x - frame.sceneX <= (within.x ?? 0) + (within.width ?? 0) &&
        y - frame.sceneY >= (within.y ?? 0) &&
        y - frame.sceneY <= (within.y ?? 0) + (within.height ?? 0);
      if (!inside(c[0], c[1]) || !inside(c[2], c[3])) {
        return false;
      }
    }
    return true;
  });
  const patch =
    args.preset !== undefined
      ? wallFields(args.preset, args.fields)
      : wallFields('wall', args.fields);
  if (args.preset !== undefined) {
    // A preset sets every sense explicitly, so switching presets really switches.
    for (const k of ['move', 'sight', 'light', 'sound', 'dir', 'door'] as const) {
      patch[k] ??= defaults[k];
    }
  }
  const updates = chosen.map((w) => ({ _id: w._id, ...patch }));
  const updated = await client.modifySceneEmbedded(sceneId, 'Wall', 'update', updates);
  return text(`🧱 **${updated.length} walls updated** on ${scene.name}: ${JSON.stringify(patch)}`);
}

/* -------------------------------------------- */
/*  Generic documents                           */
/* -------------------------------------------- */

const WORLD_TYPES = new Set([
  'Actor',
  'Item',
  'JournalEntry',
  'RollTable',
  'Folder',
  'Macro',
  'Playlist',
  'Scene',
  'Cards',
  'Combat',
]);
const SCENE_TYPES = new Set([
  'Token',
  'Note',
  'Tile',
  'AmbientSound',
  'Drawing',
  'Region',
  'MeasuredTemplate',
]);

/** The name and id of each created document, for the AI to chain calls (folders, journals, actors). */
function idList(result: unknown[]): string {
  return result
    .map((r) =>
      isRecord(r)
        ? `- ${String(r.name ?? r.text ?? r.type ?? '?')}: ${String(r._id)}`
        : `- ${String(r)}`,
    )
    .join('\n');
}

/**
 * A prepared encounter: `scene` is required, and each combatant may give only a `tokenId` —
 * its actor, scene, name, image and hidden state are filled from that token. The encounter is
 * created inactive and unstarted (round 0) unless the data says otherwise.
 */
export function combatData(
  c: Record<string, unknown>,
  client: FoundryClient,
): Record<string, unknown> {
  const sceneId = typeof c.scene === 'string' ? c.scene : fail('Combat needs scene (a scene id)');
  const scene = client.getSceneOrThrow(sceneId);
  const tokens = (Array.isArray(scene.tokens) ? scene.tokens : []).filter(isRecord);
  const combatants = (Array.isArray(c.combatants) ? c.combatants : [])
    .filter(isRecord)
    .map((cb) => {
      if (typeof cb.tokenId !== 'string') {
        return cb;
      }
      const t =
        tokens.find((tk) => tk._id === cb.tokenId) ??
        fail(`Token ${String(cb.tokenId)} not found on scene ${sceneId}`);
      return {
        sceneId,
        actorId: t.actorId,
        hidden: t.hidden === true,
        ...cb,
      };
    });
  return { active: false, round: 0, turn: null, ...c, combatants };
}

export async function handleCreateDocuments(args: Record<string, unknown>, client: FoundryClient) {
  const type =
    typeof args.type === 'string' && WORLD_TYPES.has(args.type)
      ? args.type
      : fail(`type must be one of ${[...WORLD_TYPES].join(', ')}`);
  const data =
    Array.isArray(args.data) && args.data.every(isRecord)
      ? (args.data as Record<string, unknown>[])
      : fail('data must be an array of document objects');
  const docs = type === 'Combat' ? data.map((c) => combatData(c, client)) : data;
  const created = await client.modifyWorldDocuments(type, 'create', docs);
  return text(`📄 **${created.length} ${type} created**\n${idList(created)}`);
}

export async function handleUpdateDocuments(args: Record<string, unknown>, client: FoundryClient) {
  const type =
    typeof args.type === 'string' && WORLD_TYPES.has(args.type)
      ? args.type
      : fail(`type must be one of ${[...WORLD_TYPES].join(', ')}`);
  const updates =
    Array.isArray(args.updates) &&
    args.updates.every((u) => isRecord(u) && typeof u._id === 'string')
      ? (args.updates as Record<string, unknown>[])
      : fail('updates must be an array of objects with _id');
  const updated = await client.modifyWorldDocuments(type, 'update', updates);
  return text(`📝 **${updated.length} ${type} updated**\n${idList(updated)}`);
}

export async function handleCreateSceneDocuments(
  args: Record<string, unknown>,
  client: FoundryClient,
) {
  const sceneId = typeof args.sceneId === 'string' ? args.sceneId : fail('sceneId is required');
  const type =
    typeof args.type === 'string' && SCENE_TYPES.has(args.type)
      ? args.type
      : fail(`type must be one of ${[...SCENE_TYPES].join(', ')}`);
  const scene = client.getSceneOrThrow(sceneId);
  const toCanvas = converter(sceneFrame(scene), (args.units as Units) ?? 'scene', {
    width: args.imageWidth as number | undefined,
    height: args.imageHeight as number | undefined,
  });
  const data = (Array.isArray(args.data) ? args.data : fail('data must be an array')).map(
    (d, i) => {
      if (!isRecord(d)) {
        fail(`data[${i}] must be an object`);
      }
      let out: Record<string, unknown> = { ...(d as Record<string, unknown>) };
      // A Token starts from its actor's prototype token (image, name, disposition, link, vision,
      // bars), as FoundryVTT's own drag and drop does; the given fields override it.
      if (type === 'Token' && typeof out.actorId === 'string') {
        const actor = client.getRawActor(out.actorId) ?? fail(`Actor not found: ${out.actorId}`);
        const proto: Record<string, unknown> = isRecord(actor.prototypeToken)
          ? { ...actor.prototypeToken }
          : {};
        for (const k of ['_id', 'randomImg', 'appendNumber', 'prependAdjective']) {
          delete proto[k];
        }
        out = { ...proto, name: actor.name, ...out };
      }
      if (Number.isFinite(out.x) && Number.isFinite(out.y)) {
        [out.x, out.y] = toCanvas(out.x as number, out.y as number);
        // Tokens are placed by their top-left corner: centre them on the point given.
        if (type === 'Token' && args.center !== false) {
          const size = sceneFrame(scene).gridSize;
          out.x = (out.x as number) - Math.round(((Number(out.width) || 1) * size) / 2);
          out.y = (out.y as number) - Math.round(((Number(out.height) || 1) * size) / 2);
        }
      }
      return out;
    },
  );
  const created = await client.modifySceneEmbedded(sceneId, type, 'create', data);
  return text(`📍 **${created.length} ${type} created** on ${scene.name}\n${idList(created)}`);
}
