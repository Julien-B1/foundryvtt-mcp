/**
 * @fileoverview Taverne: vision tools served by the companion module (render_scene, trace_walls).
 *
 * A trace is kept in memory under an id, so create_walls can use it (`fromTrace`) without
 * the AI copying hundreds of points back.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ModuleBridge } from '../foundry/module-bridge.js';
import { defaultStateDir } from '../shared/paths.js';
import { isRecord } from '../utils/guards.js';

const VISION_TIMEOUT_MS = 120_000;

export interface TracedPath {
  closed: boolean;
  preset?: string;
  points: Array<[number, number]>;
}

/** Traces are written to <state dir>/traces/<id>.json and kept 30 days, so a restart loses nothing. */
const TRACE_TTL_MS = 30 * 24 * 3600_000;
const traceDir = () => path.join(defaultStateDir(), 'traces');

interface StoredTrace {
  sceneId?: string | undefined;
  paths: TracedPath[];
  at: number;
  params?: Record<string, unknown>;
}

export function saveTrace(id: string, trace: StoredTrace): void {
  const dir = traceDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(trace));
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > TRACE_TTL_MS) {
        fs.rmSync(file);
      }
    } catch {
      /* already gone */
    }
  }
}

export function getTrace(id: string): StoredTrace {
  if (!/^[a-f0-9]{8}$/.test(id)) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid trace id "${id}"`);
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(traceDir(), `${id}.json`), 'utf8')) as StoredTrace;
  } catch {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unknown trace "${id}" (traces are kept 30 days in the state directory)`,
    );
  }
}

function requireBridge(bridge: ModuleBridge | null): ModuleBridge {
  if (!bridge) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'The module bridge is disabled: render_scene and trace_walls need the companion module.',
    );
  }
  return bridge;
}

function imageResult(r: Record<string, unknown>) {
  return { type: 'image' as const, data: String(r.image), mimeType: String(r.mimeType) };
}

export async function handleRenderScene(
  args: Record<string, unknown>,
  bridge: ModuleBridge | null,
) {
  const r = await requireBridge(bridge).send('render_scene', args, VISION_TIMEOUT_MS);
  if (!isRecord(r) || typeof r.image !== 'string') {
    throw new McpError(ErrorCode.InternalError, 'Unexpected render_scene answer');
  }
  const region = r.region as Record<string, number>;
  const grid = r.grid as Record<string, unknown>;
  const counts = r.counts as Record<string, number>;
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `🖼️ **${r.sceneName}** (${r.sceneId}) — ${r.width}×${r.height} px image, scale ${Number(r.scale).toFixed(3)}\n` +
          `Region (scene px): x ${region.x}, y ${region.y}, ${region.width}×${region.height}\n` +
          `Grid: ${grid.size} px = ${grid.distance} ${grid.units}. Edge labels are grid cells from the map's top-left corner.\n` +
          `${counts.walls} walls, ${counts.lights} lights. Wall colours: red solid, green door, yellow locked door, violet secret door, cyan window, ` +
          `yellow terrain, white invisible, pink ethereal/curtain, orange one-way (tick = blocking side). Lights: outer ring dim, inner ring bright.`,
      },
      imageResult(r),
    ],
  };
}

export async function handleTraceWalls(args: Record<string, unknown>, bridge: ModuleBridge | null) {
  const r = await requireBridge(bridge).send('trace_walls', args, VISION_TIMEOUT_MS);
  if (!isRecord(r) || !Array.isArray(r.paths)) {
    throw new McpError(ErrorCode.InternalError, 'Unexpected trace_walls answer');
  }
  const id = randomBytes(4).toString('hex');
  const paths = r.paths as TracedPath[];
  saveTrace(id, {
    sceneId: typeof args.sceneId === 'string' ? args.sceneId : undefined,
    paths,
    at: Date.now(),
    params: args,
  });
  const stats = r.stats as Record<string, unknown>;
  const lengths = paths.flatMap((p) =>
    p.points.slice(1).map((pt, i) => {
      const prev = p.points[i] ?? pt;
      return Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
    }),
  );
  const avg = lengths.reduce((s, l) => s + l, 0) / Math.max(1, lengths.length);
  const listing =
    args.returnPoints === true
      ? `\n\n${JSON.stringify(paths)}`
      : `\n\nPaths (points, closed): ${paths.map((p) => `${p.points.length}${p.closed ? 'c' : 'o'}`).join(' ')}`;
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `✏️ **Trace ${id}**: ${paths.length} paths, ${stats.segments} segments (avg ${avg.toFixed(0)} scene px), ` +
          `mask covers ${(Number(stats.coverage) * 100).toFixed(1)}% of the image.\n` +
          `Preview: green = traced area, red = wall paths, yellow = seeds. ` +
          `If it looks right: create_walls { sceneId, fromTrace: "${id}", preset }. Otherwise adjust tolerance/blur/close/epsilon or seeds and trace again.` +
          listing,
      },
      imageResult(r),
    ],
  };
}
