/**
 * @fileoverview Taverne: snapshots of scenes and world documents, and their restoration.
 *
 * A snapshot is the raw source of the documents, written to <state dir>/snapshots/<id>.json
 * and kept 30 days. The taverne tools that delete or rewrite take one automatically first, so
 * any of their changes can be undone with restore_snapshot. Restoring recreates documents
 * with their original ids (`keepId`), so tokens in encounters, @UUID links and notes keep
 * pointing at them.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FoundryClient } from '../foundry/client.js';
import { defaultStateDir } from '../shared/paths.js';
import { isRecord } from '../utils/guards.js';
import { fail, str, strArray, text } from './util.js';

const SNAPSHOT_TTL_MS = 30 * 24 * 3600_000;
const snapshotDir = () => path.join(defaultStateDir(), 'snapshots');

/** Scene field → embedded document type. */
export const SCENE_EMBEDDED: Record<string, string> = {
  tokens: 'Token',
  walls: 'Wall',
  lights: 'AmbientLight',
  sounds: 'AmbientSound',
  tiles: 'Tile',
  drawings: 'Drawing',
  notes: 'Note',
  templates: 'MeasuredTemplate',
  regions: 'Region',
};
export const EMBEDDED_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(SCENE_EMBEDDED).map(([k, v]) => [v, k]),
);

/** Fields of a scene that restoring its settings must not write. */
const SCENE_SKIP = new Set(['_id', '_stats', 'active', ...Object.keys(SCENE_EMBEDDED)]);

export interface Snapshot {
  id: string;
  at: number;
  label: string;
  scene?: Record<string, unknown>;
  documents: Record<string, Record<string, unknown>[]>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Deep equality of two document sources, `_stats` ignored, key order ignored. */
export function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : isRecord(v)
        ? Object.fromEntries(
            Object.keys(v)
              .filter((k) => k !== '_stats')
              .sort()
              .map((k) => [k, norm(v[k])]),
          )
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function newId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
}

function prune(dir: string): void {
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > SNAPSHOT_TTL_MS) {
        fs.rmSync(file);
      }
    } catch {
      /* already gone */
    }
  }
}

export function saveSnapshot(s: Omit<Snapshot, 'id' | 'at'>): Snapshot {
  const snap: Snapshot = { id: newId(), at: Date.now(), ...clone(s) };
  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${snap.id}.json`), JSON.stringify(snap));
  prune(dir);
  return snap;
}

export function loadSnapshot(id: string): Snapshot {
  if (!/^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$/.test(id)) {
    fail(`Invalid snapshot id "${id}"`);
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(snapshotDir(), `${id}.json`), 'utf8')) as Snapshot;
  } catch {
    return fail(`Unknown snapshot "${id}" (snapshots are kept 30 days)`);
  }
}

export function listSnapshots(): Snapshot[] {
  const dir = snapshotDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Snapshot;
      } catch {
        return null;
      }
    })
    .filter((s): s is Snapshot => s !== null)
    .sort((a, b) => b.at - a.at);
}

/** Snapshot of a whole scene (settings and every embedded document), taken before a change. */
export function snapshotScene(client: FoundryClient, sceneId: string, label: string): Snapshot {
  const scene = client.getSceneOrThrow(sceneId) as unknown as Record<string, unknown>;
  return saveSnapshot({ label, scene, documents: {} });
}

/** Snapshot of world documents, taken before a change. */
export function snapshotDocuments(
  client: FoundryClient,
  documents: Record<string, string[]>,
  label: string,
): Snapshot {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [type, ids] of Object.entries(documents)) {
    const set = new Set(ids);
    out[type] = client.getWorldCollection(type).filter((d) => set.has(String(d._id)));
  }
  return saveSnapshot({ label, documents: out });
}

function summary(s: Snapshot): string {
  const parts: string[] = [];
  const scene = s.scene;
  if (scene) {
    const counts = Object.keys(SCENE_EMBEDDED)
      .map((k) => {
        const v = scene[k];
        return [k, Array.isArray(v) ? v.length : 0] as const;
      })
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`);
    parts.push(
      `scene « ${String(scene.name)} » (${String(scene._id)})${counts.length ? `: ${counts.join(', ')}` : ''}`,
    );
  }
  for (const [type, docs] of Object.entries(s.documents)) {
    if (docs.length) {
      parts.push(
        `${docs.length} ${type} (${docs
          .map((d) => String(d.name ?? d._id))
          .slice(0, 6)
          .join(', ')}${docs.length > 6 ? '…' : ''})`,
      );
    }
  }
  return `- \`${s.id}\` ${new Date(s.at).toISOString().replace('T', ' ').slice(0, 19)} — ${s.label} — ${parts.join('; ') || 'empty'}`;
}

export async function handleSnapshot(args: Record<string, unknown>, client: FoundryClient) {
  const label = str(args.label) ?? 'manual snapshot';
  const sceneId = str(args.sceneId);
  const docs = isRecord(args.documents) ? args.documents : undefined;
  if (!sceneId && !docs) {
    fail('Give sceneId and/or documents ({Actor: [ids], JournalEntry: [ids], …})');
  }
  const documents: Record<string, Record<string, unknown>[]> = {};
  if (docs) {
    for (const [type, ids] of Object.entries(docs)) {
      const list = strArray(ids, `documents.${type}`) ?? [];
      const set = new Set(list);
      documents[type] = client.getWorldCollection(type).filter((d) => set.has(String(d._id)));
      if (documents[type].length !== set.size) {
        fail(`Some ${type} ids were not found`);
      }
    }
  }
  const scene = sceneId
    ? (client.getSceneOrThrow(sceneId) as unknown as Record<string, unknown>)
    : undefined;
  const snap = saveSnapshot({ label, ...(scene ? { scene } : {}), documents });
  return text(`📸 **Snapshot saved**\n${summary(snap)}`);
}

export function handleListSnapshots(args: Record<string, unknown>) {
  const sceneId = str(args.sceneId);
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const all = listSnapshots().filter((s) => !sceneId || s.scene?._id === sceneId);
  if (all.length === 0) {
    return text('No snapshot.');
  }
  return text(
    `📸 **${all.length} snapshots** (newest first)\n${all.slice(0, limit).map(summary).join('\n')}`,
  );
}

/**
 * Restores a snapshot. A scene that still exists gets its settings back and, for each restored
 * part, its current embedded documents replaced by the snapshot's ones; a deleted scene is
 * recreated whole. World documents are recreated with their ids (deleted first if they still
 * exist), except folders, which are updated in place so their contents stay in them.
 */
export async function handleRestoreSnapshot(args: Record<string, unknown>, client: FoundryClient) {
  const snap = loadSnapshot(str(args.id) ?? fail('id is required'));
  const parts = strArray(args.parts, 'parts') ?? ['settings', ...Object.keys(SCENE_EMBEDDED)];
  for (const p of parts) {
    if (p !== 'settings' && !(p in SCENE_EMBEDDED)) {
      fail(`Unknown part "${p}" (settings, ${Object.keys(SCENE_EMBEDDED).join(', ')})`);
    }
  }
  const lines: string[] = [];
  // A safety snapshot of the current state, so a restore can itself be undone.
  const before: Record<string, string[]> = {};
  for (const [type, docs] of Object.entries(snap.documents)) {
    const ids = new Set(docs.map((d) => String(d._id)));
    before[type] = client
      .getWorldCollection(type)
      .filter((d) => ids.has(String(d._id)))
      .map((d) => String(d._id));
  }
  const sceneId = snap.scene ? String(snap.scene._id) : undefined;
  const sceneExists = sceneId
    ? client.getWorldCollection('Scene').some((s) => s._id === sceneId)
    : false;
  const undo = saveSnapshot({
    label: `before restoring ${snap.id}`,
    ...(sceneExists && sceneId
      ? { scene: client.getSceneOrThrow(sceneId) as unknown as Record<string, unknown> }
      : {}),
    documents: Object.fromEntries(
      Object.entries(before).map(([type, ids]) => [
        type,
        client.getWorldCollection(type).filter((d) => ids.includes(String(d._id))),
      ]),
    ),
  });

  // Folders first (documents may live in them), then the rest.
  const order = Object.keys(snap.documents).sort((a, b) =>
    a === 'Folder' ? -1 : b === 'Folder' ? 1 : 0,
  );
  for (const type of order) {
    const docs = snap.documents[type] ?? [];
    if (docs.length === 0) {
      continue;
    }
    const existing = new Set(client.getWorldCollection(type).map((d) => String(d._id)));
    if (type === 'Folder') {
      const upd = docs.filter((d) => existing.has(String(d._id))).map(({ _stats, ...d }) => d);
      const add = docs.filter((d) => !existing.has(String(d._id)));
      await client.modifyWorldDocuments('Folder', 'update', upd);
      await client.modifyWorldDocuments('Folder', 'create', add, { keepId: true });
    } else {
      const del = docs.map((d) => String(d._id)).filter((id) => existing.has(id));
      await client.modifyWorldDocuments(type, 'delete', del);
      await client.modifyWorldDocuments(type, 'create', docs, { keepId: true });
    }
    lines.push(`- ${docs.length} ${type} restored`);
  }

  if (snap.scene && sceneId) {
    if (!sceneExists) {
      await client.modifyWorldDocuments('Scene', 'create', [snap.scene], { keepId: true });
      lines.push(`- scene « ${String(snap.scene.name)} » recreated`);
    } else {
      const current = client.getSceneOrThrow(sceneId) as unknown as Record<string, unknown>;
      if (parts.includes('settings')) {
        const changes = Object.fromEntries(
          Object.entries(snap.scene).filter(([k, v]) => !SCENE_SKIP.has(k) && !same(v, current[k])),
        );
        if (Object.keys(changes).length) {
          await client.updateSceneDocument(sceneId, changes);
          lines.push(`- scene settings restored: ${Object.keys(changes).join(', ')}`);
        }
      }
      for (const field of parts.filter((p) => p in SCENE_EMBEDDED)) {
        const type = SCENE_EMBEDDED[field] as string;
        const now = new Map(
          (Array.isArray(current[field]) ? current[field] : [])
            .filter(isRecord)
            .map((d) => [String(d._id), d]),
        );
        const docs = (Array.isArray(snap.scene[field]) ? snap.scene[field] : []).filter(isRecord);
        const kept = new Set(docs.map((d) => String(d._id)));
        // Only what differs: documents added since, changed since, or gone since.
        const changed = docs.filter((d) => !same(d, now.get(String(d._id))));
        const remove = [
          ...[...now.keys()].filter((id) => !kept.has(id)),
          ...changed.map((d) => String(d._id)).filter((id) => now.has(id)),
        ];
        await client.modifySceneEmbedded(sceneId, type, 'delete', remove);
        await client.modifySceneEmbedded(sceneId, type, 'create', changed, { keepId: true });
        if (remove.length || changed.length) {
          lines.push(`- ${field}: ${remove.length} removed, ${changed.length} restored`);
        }
      }
    }
  }
  return text(
    `⏪ **Snapshot ${snap.id} restored** (${snap.label})\n${lines.join('\n') || '- nothing to restore'}\nThe state before this restore was saved as \`${undo.id}\`.`,
  );
}
