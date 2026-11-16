/**
 * @fileoverview Taverne: deleting documents in bulk and listing prepared encounters.
 *
 * Every deletion is preceded by a snapshot (see snapshots.ts), so restore_snapshot undoes it.
 */

import type { FoundryClient } from '../foundry/client.js';
import { isRecord } from '../utils/guards.js';
import { EMBEDDED_FIELD, saveSnapshot } from './snapshots.js';
import { fail, str, strArray, text } from './util.js';

export const DELETABLE_WORLD_TYPES = [
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
];

/** Ids of every folder under `root`, `root` included. */
function folderTree(client: FoundryClient, root: string): Set<string> {
  const all = client.getWorldCollection('Folder');
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of all) {
      if (typeof f.folder === 'string' && out.has(f.folder) && !out.has(String(f._id))) {
        out.add(String(f._id));
        grew = true;
      }
    }
  }
  return out;
}

const nameOf = (d: Record<string, unknown>) =>
  String(d.name ?? d.text ?? d.label ?? (isRecord(d.texture) ? d.texture.src : undefined) ?? d._id);

/**
 * Selects documents by ids, by folder (recursively) and/or by a name pattern. With a filter
 * and no `confirm`, it only lists what would be deleted.
 */
export async function handleDeleteDocuments(args: Record<string, unknown>, client: FoundryClient) {
  const type = str(args.type) ?? fail('type is required');
  const sceneId = str(args.sceneId);
  const ids = strArray(args.ids, 'ids');
  const folder = str(args.folder);
  const pattern = str(args.name);
  const all = args.all === true;
  if (!ids && !folder && !pattern && !all) {
    fail('Select documents with ids, folder, name (a regular expression) or all: true');
  }
  const regex = pattern ? new RegExp(pattern, 'i') : undefined;

  let pool: Record<string, unknown>[];
  if (sceneId) {
    const field =
      EMBEDDED_FIELD[type] ??
      fail(`type must be one of ${Object.keys(EMBEDDED_FIELD).join(', ')} with sceneId`);
    const scene = client.getSceneOrThrow(sceneId) as unknown as Record<string, unknown>;
    pool = (Array.isArray(scene[field]) ? scene[field] : []).filter(isRecord);
  } else {
    if (!DELETABLE_WORLD_TYPES.includes(type)) {
      fail(
        `type must be one of ${DELETABLE_WORLD_TYPES.join(', ')} (or an embedded type with sceneId)`,
      );
    }
    pool = client.getWorldCollection(type);
  }

  const tree = folder ? folderTree(client, folder) : undefined;
  let chosen = pool.filter(
    (d) =>
      (!ids || ids.includes(String(d._id))) &&
      (!tree || (type === 'Folder' ? tree.has(String(d._id)) : tree.has(String(d.folder)))) &&
      (!regex || regex.test(nameOf(d))),
  );
  if (ids) {
    const found = new Set(chosen.map((d) => String(d._id)));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      fail(`Not found: ${missing.join(', ')}`);
    }
  }
  // Deleting a folder tree deletes its subfolders through the parent.
  if (type === 'Folder' && tree) {
    chosen = chosen.filter((d) => d._id === folder);
  }
  const list = chosen.map((d) => `- ${nameOf(d)} (${String(d._id)})`).join('\n');
  if (chosen.length === 0) {
    return text(`Nothing matches: no ${type} deleted.`);
  }
  if (!ids && args.confirm !== true) {
    let extra = '';
    if (type === 'Folder') {
      const trees = new Set<string>();
      for (const f of chosen) {
        for (const id of folderTree(client, String(f._id))) {
          trees.add(id);
        }
      }
      const inside = DELETABLE_WORLD_TYPES.filter((t) => t !== 'Folder')
        .map(
          (t) =>
            [
              t,
              client.getWorldCollection(t).filter((d) => trees.has(String(d.folder))).length,
            ] as const,
        )
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${n} ${t}`);
      extra = `\nWith ${trees.size - chosen.length} subfolders; inside: ${inside.join(', ') || 'nothing'} (${args.deleteContents === true ? 'deleted too' : 'moved to the parent folder unless deleteContents: true'}).`;
    }
    return text(
      `🔎 **${chosen.length} ${type} would be deleted** — call again with confirm: true to delete them.\n${list}${extra}`,
    );
  }

  const where = sceneId ? ` on scene ${sceneId}` : '';
  let snapId: string;
  if (sceneId) {
    snapId = saveSnapshot({
      label: `before deleting ${chosen.length} ${type}`,
      scene: client.getSceneOrThrow(sceneId) as unknown as Record<string, unknown>,
      documents: {},
    }).id;
  } else {
    const documents: Record<string, Record<string, unknown>[]> = { [type]: chosen };
    const deleteContents = type === 'Folder' && args.deleteContents === true;
    const options: Record<string, unknown> = {};
    if (type === 'Folder') {
      // Subfolders and, on request, their contents go with the folder.
      options.deleteSubfolders = args.deleteSubfolders !== false;
      options.deleteContents = deleteContents;
      const trees = new Set<string>();
      for (const f of chosen) {
        for (const id of folderTree(client, String(f._id))) {
          trees.add(id);
        }
      }
      documents.Folder = client
        .getWorldCollection('Folder')
        .filter((f) => trees.has(String(f._id)));
      if (deleteContents) {
        for (const t of DELETABLE_WORLD_TYPES.filter((t) => t !== 'Folder')) {
          const inside = client.getWorldCollection(t).filter((d) => trees.has(String(d.folder)));
          if (inside.length) {
            documents[t] = inside;
          }
        }
      }
    }
    snapId = saveSnapshot({ label: `before deleting ${chosen.length} ${type}`, documents }).id;
    await client.modifyWorldDocuments(
      type,
      'delete',
      chosen.map((d) => String(d._id)),
      options,
    );
    return text(
      `🗑️ **${chosen.length} ${type} deleted**${where}${deleteContents ? ' (with their contents)' : ''}\n${list}\nUndo with restore_snapshot id \`${snapId}\`.`,
    );
  }
  await client.modifySceneEmbedded(
    sceneId,
    type,
    'delete',
    chosen.map((d) => String(d._id)),
  );
  return text(
    `🗑️ **${chosen.length} ${type} deleted**${where}\n${list}\nUndo with restore_snapshot id \`${snapId}\`.`,
  );
}

/** Every encounter of the world (or of one scene), started or only prepared. */
export function handleListEncounters(args: Record<string, unknown>, client: FoundryClient) {
  const sceneId = str(args.sceneId);
  const scenes = client.getWorldCollection('Scene');
  const sceneById = new Map(scenes.map((s) => [String(s._id), s]));
  const actors = new Map(client.getWorldCollection('Actor').map((a) => [String(a._id), a]));
  const combats = client
    .getWorldCollection('Combat')
    .filter((c) => !sceneId || c.scene === sceneId)
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
  if (combats.length === 0) {
    return text(sceneId ? 'No encounter on this scene.' : 'No encounter in this world.');
  }
  const lines = combats.map((c) => {
    const scene = typeof c.scene === 'string' ? sceneById.get(c.scene) : undefined;
    const round = Number(c.round ?? 0);
    const state = c.active
      ? round > 0
        ? `active, round ${round}`
        : 'active, not started'
      : round > 0
        ? `paused at round ${round}`
        : 'prepared';
    const members = (Array.isArray(c.combatants) ? c.combatants : []).filter(isRecord).map((cb) => {
      const tokenScene = typeof cb.sceneId === 'string' ? sceneById.get(cb.sceneId) : scene;
      const token = (Array.isArray(tokenScene?.tokens) ? tokenScene.tokens : [])
        .filter(isRecord)
        .find((t) => t._id === cb.tokenId);
      const actor = typeof cb.actorId === 'string' ? actors.get(cb.actorId) : undefined;
      const name = String(cb.name || token?.name || actor?.name || '?');
      const flags = [
        cb.hidden ? 'hidden' : '',
        cb.defeated ? 'defeated' : '',
        typeof cb.initiative === 'number' ? `init ${cb.initiative}` : '',
        token ? '' : 'no token',
      ].filter(Boolean);
      return `${name}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    });
    return `- **${String(c.name || 'Unnamed encounter')}** (${String(c._id)}) — ${scene ? String(scene.name) : 'no scene'} — ${state} — ${members.length} combatants: ${members.join(', ') || '—'}`;
  });
  return text(`⚔️ **${combats.length} encounters**\n${lines.join('\n')}`);
}
