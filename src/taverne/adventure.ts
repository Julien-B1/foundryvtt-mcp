/**
 * @fileoverview Taverne: export_adventure / import_adventure — a campaign (folders, actors,
 * journals, scenes with their encounters, tables, macros, playlists) packed into an Adventure
 * of a world compendium, and imported back, ids and links kept. Served by the companion module.
 */

import type { ModuleBridge } from '../foundry/module-bridge.js';
import { isRecord } from '../utils/guards.js';
import { fail, str, text } from './util.js';

const TIMEOUT_MS = 180_000;

function needBridge(bridge: ModuleBridge | null): ModuleBridge {
  return bridge ?? fail('This tool needs the companion module (FOUNDRY_MODULE_BRIDGE_ENABLED)');
}

const counts = (c: unknown) =>
  isRecord(c)
    ? Object.entries(c)
        .map(([k, n]) => `${String(n)} ${k}`)
        .join(', ')
    : '';

export async function handleExportAdventure(
  args: Record<string, unknown>,
  bridge: ModuleBridge | null,
) {
  str(args.name) ?? fail('name is required');
  const r = await needBridge(bridge).send('export_adventure', args, TIMEOUT_MS);
  if (!isRecord(r)) {
    fail('Unexpected answer from the module');
  }
  return text(
    `📦 **Adventure « ${String(r.name)} » ${r.replaced ? 'updated' : 'created'}** in compendium ${String(r.packLabel)} (${String(r.pack)}), id ${String(r.id)}\nContents: ${counts(r.counts)}\nImport it in another world with import_adventure (the compendium must be available there: copy the pack or put it in a module).`,
  );
}

export async function handleImportAdventure(
  args: Record<string, unknown>,
  bridge: ModuleBridge | null,
) {
  const r = await needBridge(bridge).send('import_adventure', args, TIMEOUT_MS);
  if (!isRecord(r)) {
    fail('Unexpected answer from the module');
  }
  if (Array.isArray(r.list)) {
    const list = r.list.filter(isRecord);
    return text(
      list.length
        ? `📚 **${list.length} adventures**\n${list.map((a) => `- ${String(a.name)} (${String(a.id)}) — ${String(a.packLabel)} (${String(a.pack)})`).join('\n')}`
        : 'No adventure in the Adventure compendiums.',
    );
  }
  return text(
    `📥 **Adventure « ${String(r.name)} » imported** from ${String(r.pack)}\n${counts(r.summary) || 'nothing new'}`,
  );
}
