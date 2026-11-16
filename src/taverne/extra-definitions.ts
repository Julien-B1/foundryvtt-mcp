/**
 * @fileoverview Taverne: schemas of the management tools (deletion, snapshots, encounters,
 * adventures, document rendering, UVTT import, tile placement, image generation).
 */

const WRITE = ' WRITE: needs FOUNDRY_WRITE_ENABLED=true.';

const UNITS = {
  units: {
    type: 'string',
    enum: ['scene', 'grid', 'image', 'canvas'],
    description:
      'Coordinate units (default "scene"): scene = pixels from the map top-left corner (padding excluded); grid = grid cells; image = pixels of the source image (give imageWidth/imageHeight); canvas = raw Foundry canvas pixels.',
  },
  imageWidth: { type: 'number' },
  imageHeight: { type: 'number' },
};

export const extraTools = [
  {
    name: 'list_addons',
    description:
      'List the loaded addons (system-, setting- or table-specific tool packs plugged into this connector: rules, character creation, encounter budgets, compendium imports…), their tools and any that failed to load.',
    inputSchema: { type: 'object', properties: {} },
  },
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
  {
    name: 'place_tiles',
    description:
      'Place many decor tiles in ONE call: props (tables, barrels, carts), roofs and tree canopies that fade when a token walks under them (overhead: true), and scattered clutter (rocks, bushes, debris, mushrooms) with seeded random scale and rotation, kept off the walls and apart from each other. x/y are the tile CENTRE. Size defaults to the image size; give assetGridSize (pixels per cell the asset pack was drawn at, often 100, 140, 200 or 256) to scale a pack to the scene grid, or width/height in units. Find images with list_scene_assets. Check with render_scene. Dressing: a few well-placed props beat many; scatter clutter along walls and in corners, not in walkways.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        tiles: {
          type: 'array',
          items: { type: 'object' },
          description:
            '{src, x, y, width?, height?, scale?, rotation?, elevation?, alpha?, hidden?, overhead?, occlusion? (none|fade|surface|radial|vision, or a list), occlusionAlpha?, mirrorX?, mirrorY?, tint?, restrictions? {light, weather}, sort?, name?}',
        },
        scatter: {
          type: 'object',
          description:
            '{src: path or list to pick from, count, area {x, y, width, height}, scale? number or [min, max], rotation? false or [min, max] degrees (default 0-360), minDistance? between items, wallMargin? distance kept from walls, avoidWalls? (default true), seed?}',
        },
        assetGridSize: { type: 'number' },
        overhead: {
          type: 'boolean',
          description: 'Every tile is a roof/canopy: at the level top elevation, fading.',
        },
        overheadElevation: { type: 'number', description: 'Default: the scene level top (v14).' },
        occlusion: { description: 'Default occlusion for every tile.' },
        occlusionAlpha: { type: 'number' },
        elevation: { type: 'number' },
        alpha: { type: 'number' },
        hidden: { type: 'boolean' },
        ...UNITS,
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'import_uvtt',
    description:
      'Import a Universal VTT map (.dd2vtt from Dungeondraft, .uvtt from Arkenforge, DungeonFog, Dungeon Alchemist and most map generators): uploads its embedded image, creates the scene at its grid, and creates its exact walls, object outlines, doors and lights in one call — no tracing needed. Prefer it to trace_walls whenever the map comes with a UVTT export. With sceneId, adds the walls/lights to an existing scene instead (scaled to its size). Lights follow the house style by default (soft: wide, faded); lights: "file" keeps their radius, "none" skips them.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The file, relative to (or inside) FOUNDRY_UPLOAD_SOURCE_DIR or the Foundry Data folder.',
        },
        content: { type: 'string', description: 'The file content (JSON text) instead of path.' },
        name: { type: 'string', description: 'Scene name (default: the file name).' },
        sceneId: { type: 'string', description: 'Existing scene to add the walls and lights to.' },
        replace: { type: 'boolean', description: 'With sceneId: delete its walls first.' },
        targetDir: {
          type: 'string',
          description: 'Where the image goes (default assets/maps/uvtt).',
        },
        gridDistance: { type: 'number', description: 'Distance per cell (default 1.5).' },
        gridUnits: { type: 'string', description: 'Default m.' },
        padding: { type: 'number' },
        wallPreset: {
          type: 'string',
          description: 'Preset of the sight lines (default wall; cave for caverns).',
        },
        objectsPreset: {
          type: 'string',
          description:
            'Preset of object outlines: pillars, rocks, furniture (default wall; invisible or terrain for low objects).',
        },
        doorPreset: { type: 'string', description: 'Default door.' },
        lights: { type: 'string', enum: ['soft', 'file', 'none'] },
      },
    },
  },
  {
    name: 'export_adventure',
    description:
      'Pack a campaign into an Adventure of a world compendium, to keep or share it: folders (recursively, with everything inside) and/or documents by type, plus the encounters prepared on the exported scenes. Ids, folders, @UUID links and token links are kept. Exporting again under the same name updates it.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        folders: { type: 'array', items: { type: 'string' }, description: 'Folder ids.' },
        documents: {
          type: 'object',
          description:
            '{"Scene": [ids], "Actor": [ids], …} (Actor, Item, JournalEntry, Scene, RollTable, Macro, Playlist, Cards, Combat)',
        },
        packLabel: {
          type: 'string',
          description: 'Compendium label (default "Aventures", created when missing).',
        },
        packName: { type: 'string' },
        img: { type: 'string' },
        caption: { type: 'string' },
        description: { type: 'string', description: 'HTML shown by the adventure importer.' },
        includeCombats: { type: 'boolean', description: 'Default true.' },
        replace: {
          type: 'boolean',
          description: 'Update an adventure of the same name (default true).',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'import_adventure',
    description: `Import an Adventure from a compendium into the world (documents keep their ids; existing ones are updated). Without id or name, lists the adventures available.${WRITE}`,
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'Compendium id, e.g. world.aventures.' },
        id: { type: 'string' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'generate_image',
    description:
      "Generate art with the image API configured for this world (an OpenAI-compatible /images/generations endpoint: the table's ComfyUI proxy, OpenAI, LocalAI…; address, port and model in Foundry's game settings), upload it into Foundry and optionally apply it. kind picks a house prompt made for the table: token (top-down, transparent, centred — applied to the actor's prototype token), portrait (actor image), item (inventory icon), prop (top-down map asset, for place_tiles), map (top-down battlemap, then import or trace walls), scene (illustration, for journals), free (prompt used as is). prompt is only the subject (\"a murloc oracle with a coral staff\"); style adds a direction. Unavailable until an address is set (game settings) or FOUNDRY_IMAGE_API_URL." +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The subject to draw.' },
        kind: {
          type: 'string',
          enum: ['token', 'portrait', 'item', 'prop', 'map', 'scene', 'free'],
        },
        style: {
          type: 'string',
          description:
            'Art direction added to the house prompt (e.g. "World of Warcraft painterly style").',
        },
        raw: { type: 'boolean', description: 'Send prompt as is, without the house template.' },
        size: {
          type: 'string',
          description:
            'WIDTHxHEIGHT the provider accepts (default per kind, else FOUNDRY_IMAGE_SIZE).',
        },
        n: { type: 'number', description: 'Variants, 1-4 (default 1).' },
        actorId: {
          type: 'string',
          description: 'Apply: token → prototype token, other kinds → actor image.',
        },
        alsoToken: { type: 'boolean', description: 'With a portrait: also use it as the token.' },
        itemId: { type: 'string', description: 'Apply as the item image.' },
        targetDir: { type: 'string', description: 'Default assets/generated/<kind folder>.' },
        filename: { type: 'string' },
        preview: { type: 'boolean', description: 'Return the image (default true).' },
      },
      required: ['prompt'],
    },
  },
];
