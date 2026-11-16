/**
 * @fileoverview Taverne: schemas of the management tools (deletion, snapshots, encounters,
 * adventures, document rendering, UVTT import, tile placement, image generation).
 */

const WRITE = ' WRITE: needs FOUNDRY_WRITE_ENABLED=true.';

export const extraTools = [
  {
    name: 'delete_documents',
    description:
      'Delete documents in bulk: world documents (Actor, Item, JournalEntry, RollTable, Folder, Macro, Playlist, Scene, Cards, Combat) or, with sceneId, documents of a scene (Token, Wall, AmbientLight, AmbientSound, Tile, Drawing, Note, MeasuredTemplate, Region). Select by ids, by folder (recursive), by name (case-insensitive regular expression) or all: true. With a filter instead of ids, the first call only lists the matches: call again with confirm: true. A snapshot is taken first: restore_snapshot undoes the deletion, ids included.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        sceneId: { type: 'string', description: 'For documents of a scene.' },
        ids: { type: 'array', items: { type: 'string' } },
        folder: {
          type: 'string',
          description: 'Folder id: the documents in it and its subfolders.',
        },
        name: { type: 'string', description: 'Regular expression on the name.' },
        all: { type: 'boolean' },
        confirm: { type: 'boolean', description: 'Needed to delete when selecting by filter.' },
        deleteContents: {
          type: 'boolean',
          description:
            'Folder only: also delete the documents inside (default false: they move to the parent).',
        },
        deleteSubfolders: { type: 'boolean', description: 'Folder only (default true).' },
      },
      required: ['type'],
    },
  },
  {
    name: 'list_encounters',
    description:
      'List every encounter (Combat) of the world or of one scene, prepared or running: name, scene, state (prepared, active, round), combatants with hidden/defeated/initiative. get_combat_state only shows the active one. Prepare encounters with create_documents type Combat, change them with update_documents, delete them with delete_documents.',
    inputSchema: { type: 'object', properties: { sceneId: { type: 'string' } } },
  },
  {
    name: 'create_snapshot',
    description:
      'Save a snapshot of a scene (settings, walls, lights, tokens, tiles, sounds, notes, drawings, regions, templates) and/or of world documents, to restore later with restore_snapshot. The taverne tools that delete or rewrite (delete_documents, clear_scene_elements, update_walls, update_lights, configure_scene, update_documents, create_walls/create_lights with replace, restore_snapshot) already take one automatically; call this before a risky series of changes. Snapshots are kept 30 days.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        documents: {
          type: 'object',
          description: 'World documents by type: {"Actor": [ids], "JournalEntry": [ids], …}',
        },
        label: { type: 'string' },
      },
    },
  },
  {
    name: 'list_snapshots',
    description: 'List the saved snapshots (newest first), optionally of one scene.',
    inputSchema: {
      type: 'object',
      properties: { sceneId: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'restore_snapshot',
    description:
      'Restore a snapshot: the scene gets back its settings and its embedded documents (replacing the current ones, with their original ids), a deleted scene or deleted documents are recreated with their ids. parts limits a scene restore (settings, tokens, walls, lights, sounds, tiles, drawings, notes, templates, regions). The current state is saved first, so a restore can be undone too.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        parts: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'render_document',
    description:
      "Screenshot of a document as a GM sees it in Foundry: actor or item sheet (optionally a tab), journal entry or one of its pages, roll table, macro, cards. Use it to check what you created (layout, derived values, links, images) before handing it over. uuid is the document UUID (Actor.<id>, JournalEntry.<id>.JournalEntryPage.<id>, Scene.<id>.Token.<id> for a token's actor…), or give type and id.",
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        type: {
          type: 'string',
          description:
            'With id, instead of uuid: Actor, Item, JournalEntry, RollTable, Macro, Cards.',
        },
        id: { type: 'string' },
        pageName: { type: 'string', description: 'Journal: the page to show (part of its name).' },
        pageId: { type: 'string' },
        tab: {
          type: 'string',
          description:
            'Sheet tab to open (system-specific: attributes, items, effects, biography…).',
        },
        tabGroup: { type: 'string', description: 'Tab group (default primary).' },
        width: { type: 'number', description: 'Window width in px.' },
        height: {
          type: 'number',
          description: 'Window height in px (taller to see a long journal page).',
        },
        format: { type: 'string', enum: ['jpeg', 'png'] },
      },
    },
  },
];
