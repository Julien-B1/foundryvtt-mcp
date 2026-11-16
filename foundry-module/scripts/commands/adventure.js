/**
 * Taverne: packs world documents into an Adventure of a world compendium (export_adventure),
 * lists the adventures of a pack and imports one into the world (import_adventure).
 * An Adventure keeps the documents' ids, folders and links, so a campaign moves whole.
 */

/** Adventure field → world collection and document name. */
const FIELDS = {
  folders: ['folders', 'Folder'],
  actors: ['actors', 'Actor'],
  items: ['items', 'Item'],
  journal: ['journal', 'JournalEntry'],
  scenes: ['scenes', 'Scene'],
  tables: ['tables', 'RollTable'],
  macros: ['macros', 'Macro'],
  playlists: ['playlists', 'Playlist'],
  cards: ['cards', 'Cards'],
  combats: ['combats', 'Combat'],
};

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

function compendiumClass() {
  return foundry.documents?.collections?.CompendiumCollection ?? CompendiumCollection;
}

async function adventurePack(label, name) {
  const id = `world.${name}`;
  const existing = game.packs.get(id);
  if (existing) {
    if (existing.documentName !== 'Adventure') throw new Error(`${id} is a ${existing.documentName} compendium, not an Adventure one`);
    return existing;
  }
  return compendiumClass().createCompendium({ label, name, type: 'Adventure' });
}

/**
 * @param {{name: string, folders?: string[], documents?: Record<string, string[]>, packLabel?: string,
 *   packName?: string, img?: string, caption?: string, description?: string,
 *   includeCombats?: boolean, replace?: boolean}} params
 */
export async function exportAdventure(params) {
  const { name } = params;
  if (!name) throw new Error('name is required');
  const picked = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, new Map()]));

  // Folders, recursively, with everything inside them.
  const folderIds = new Set();
  const addFolder = (f) => {
    if (!f || folderIds.has(f.id)) return;
    folderIds.add(f.id);
    for (const sub of f.getSubfolders?.(true) ?? f.children?.map((c) => c.folder) ?? []) addFolder(sub);
  };
  for (const id of params.folders ?? []) {
    const f = game.folders.get(id);
    if (!f) throw new Error(`Folder not found: ${id}`);
    addFolder(f);
  }
  for (const id of folderIds) {
    const f = game.folders.get(id);
    picked.folders.set(f.id, f);
    for (const d of f.contents) {
      const field = Object.keys(FIELDS).find((k) => FIELDS[k][1] === d.documentName);
      if (field) picked[field].set(d.id, d);
    }
  }
  // Documents named one by one, and the folders holding them.
  for (const [type, ids] of Object.entries(params.documents ?? {})) {
    const field = Object.keys(FIELDS).find((k) => FIELDS[k][1] === type);
    if (!field) throw new Error(`An Adventure cannot hold ${type}`);
    for (const id of ids) {
      const d = game[FIELDS[field][0]].get(id);
      if (!d) throw new Error(`${type} not found: ${id}`);
      picked[field].set(d.id, d);
      for (let f = d.folder; f; f = f.folder) picked.folders.set(f.id, f);
    }
  }
  // Encounters prepared on the exported scenes.
  if (params.includeCombats !== false) {
    for (const c of game.combats) {
      if (c.scene && picked.scenes.has(c.scene.id)) picked.combats.set(c.id, c);
    }
  }

  const data = {
    name,
    img: params.img ?? 'icons/sundries/books/book-embossed-gold-red.webp',
    caption: params.caption ?? '',
    description: params.description ?? '',
  };
  const counts = {};
  for (const [field, map] of Object.entries(picked)) {
    data[field] = [...map.values()].map((d) => d.toCompendium ? d.toCompendium(null, { keepId: true, keepFolder: true, clearOwnership: false, clearSort: false, clearState: false }) : d.toObject());
    if (map.size) counts[field] = map.size;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) throw new Error('Nothing to export: give folders and/or documents');

  const packLabel = params.packLabel ?? 'Aventures';
  const pack = await adventurePack(packLabel, params.packName ?? slug(packLabel));
  const Adventure = getDocumentClass('Adventure');
  await pack.getIndex();
  const existing = pack.index.find((e) => e.name === name);
  let adventure;
  if (existing && params.replace !== false) {
    adventure = await pack.getDocument(existing._id);
    await adventure.update(data, { diff: false, recursive: false });
  } else {
    adventure = await Adventure.create(data, { pack: pack.collection });
  }
  return { pack: pack.collection, packLabel: pack.metadata.label, id: adventure.id, name: adventure.name, replaced: !!existing, counts };
}

/**
 * @param {{pack: string, id?: string, name?: string}} params — without id or name, lists the
 *   adventures of the pack (or of every Adventure pack when pack is omitted).
 */
export async function importAdventure(params) {
  const packs = params.pack ? [game.packs.get(params.pack)] : game.packs.filter((p) => p.documentName === 'Adventure');
  if (params.pack && !packs[0]) throw new Error(`Compendium not found: ${params.pack}`);
  if (!params.id && !params.name) {
    const list = [];
    for (const p of packs) {
      await p.getIndex();
      for (const e of p.index) list.push({ pack: p.collection, packLabel: p.metadata.label, id: e._id, name: e.name });
    }
    return { list };
  }
  const pack = packs.find((p) => p) ?? null;
  if (!pack) throw new Error('No Adventure compendium found');
  await pack.getIndex();
  const entry = params.id ? pack.index.get(params.id) : pack.index.find((e) => e.name === params.name);
  if (!entry) throw new Error(`Adventure not found in ${pack.collection}: ${params.id ?? params.name}`);
  const adventure = await pack.getDocument(entry._id);
  let result;
  if (typeof adventure.import === 'function') {
    result = await adventure.import({ dialog: false });
  } else {
    const prepared = await adventure.prepareImport();
    result = await adventure.importContent(prepared);
  }
  const summary = {};
  for (const [type, docs] of Object.entries(result?.created ?? {})) summary[`created ${type}`] = docs.length;
  for (const [type, docs] of Object.entries(result?.updated ?? {})) summary[`updated ${type}`] = docs.length;
  return { pack: pack.collection, id: adventure.id, name: adventure.name, summary };
}
