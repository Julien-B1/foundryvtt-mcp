/**
 * @fileoverview Taverne: MCP schemas of the batch scene tools and the vision tools.
 */

import type { FoundryClient } from '../foundry/client.js';
import type { ModuleBridge } from '../foundry/module-bridge.js';
import {
  handleClearSceneElements,
  handleConfigureScene,
  handleCreateDocuments,
  handleCreateLights,
  handleCreateSceneDocuments,
  handleCreateWalls,
  handleListScenePresets,
  handleUpdateDocuments,
  handleUpdateLights,
  handleUpdateWalls,
} from './handlers.js';
import { handleRenderScene, handleTraceWalls } from './vision.js';

const WRITE = ' WRITE: one batched request; needs FOUNDRY_WRITE_ENABLED=true.';

const UNITS = {
  units: {
    type: 'string',
    enum: ['scene', 'grid', 'image', 'canvas'],
    description:
      'Coordinate units (default "scene"): scene = pixels from the map\'s top-left corner (padding excluded, what render_scene and trace_walls use); grid = grid vertices from that corner (fractions allowed); image = pixels of the source image (give imageWidth/imageHeight; scaled to the scene size); canvas = raw Foundry canvas pixels.',
  },
  imageWidth: { type: 'number', description: 'Source image width, for units "image".' },
  imageHeight: { type: 'number', description: 'Source image height, for units "image".' },
};

const WALL_FIELDS = {
  type: 'object',
  description:
    'Raw Wall fields overriding the preset: move (0 none, 20 normal), sight/light/sound (0 none, 10 limited, 20 normal, 30 proximity, 40 distance), dir (0 both, 1 left, 2 right), door (0 none, 1 door, 2 secret), ds (0 closed, 1 open, 2 locked), doorSound, threshold {light, sight, sound, attenuation} in grid distance units, animation {type: ascend|descend|slide|swing|swivel, direction 1|-1, double, duration ms, flip, strength 0-2}.',
};

export const taverneTools = [
  {
    name: 'list_scene_presets',
    description:
      'List the wall presets (cave, door, doubleDoor, stoneDoor, portcullis, secretDoor, window, terrain, fence, invisible, ethereal, curtain, cliffLeft/Right…), the light presets (torch, campfire, crystal, arcane, runes, portal, fairy, bioluminescent, holy, ghostly, lava, neon, moonbeam, darkness…), every light animation, coloration technique, door sound and door animation of FoundryVTT 14. Call it before dressing a scene: its first section is the house style to follow (wall detail level, towns left open, soft wide lights, no lit water).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_walls',
    description:
      'Create many walls in ONE call from polylines/polygons, with every Wall field available. Prefer it to create_wall. Precision matters: follow the drawn edge closely with many short segments (typically 0.5-1.5 grid cells on organic shapes like caves, rocks, trees), straight long runs only on built walls. Use the right preset per edge: cave/wall for rock, door/doubleDoor/stoneDoor/portcullis/secretDoor for openings, window for windows, terrain for hedges and brush, fence for low walls, invisible for water edges/chasms/furniture, ethereal/curtain for veils, cliffLeft/Right for ledges. A point written [x, y, "door"] makes the segment ENDING at it a door (preset name), so a room outline with its door is one path. fromTrace uses a trace_walls result. Check the result with render_scene.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        paths: {
          type: 'array',
          description:
            'Polylines: {points: [[x,y] | [x,y,"preset"], …], closed?: boolean, preset?: string, fields?: object}',
          items: { type: 'object' },
        },
        fromTrace: {
          type: 'string',
          description: 'Id of a trace_walls result to turn into walls (scene units).',
        },
        tracePaths: {
          type: 'array',
          items: { type: 'number' },
          description: 'Only these path indices of the trace.',
        },
        preset: {
          type: 'string',
          description: 'Default preset for paths without one (default "wall").',
        },
        fields: WALL_FIELDS,
        replace: { type: 'boolean', description: 'Delete every existing wall of the scene first.' },
        ...UNITS,
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'create_documents',
    description:
      'Create many world documents of one type in ONE call, with every field FoundryVTT accepts: Actor (name, type, img, system, flags, folder, prototypeToken {texture.src, disposition, sight, light, bar1…}, items [embedded Item data]), Item, JournalEntry (pages [{name, type: text|image, text: {content: html}, src}]), RollTable (formula, results [{type, text|documentUuid, range, weight}]), Folder (type, color, folder = parent id), Combat (a prepared encounter, created unstarted: name, scene = scene id, combatants [{tokenId}] — actor, hidden state are filled from the token; add initiative to preset it), Macro, Playlist (sounds [{name, path, volume, repeat}]), Cards. Use get_document_schema for system fields. Returns the ids to chain calls (folder ids, journal ids for notes, actor ids for tokens).' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
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
          ],
        },
        data: { type: 'array', items: { type: 'object' } },
      },
      required: ['type', 'data'],
    },
  },
  {
    name: 'update_documents',
    description:
      'Update many world documents of one type in ONE call: [{_id, …fields, dot paths allowed}] (e.g. ownership, flags, img, system.*).' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
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
          ],
        },
        updates: { type: 'array', items: { type: 'object' } },
      },
      required: ['type', 'updates'],
    },
  },
  {
    name: 'create_scene_documents',
    description:
      'Create many embedded documents on a scene in ONE call, with every field: Token (actorId, x, y centred on the point, width, height, name, hidden, disposition -1 hostile/0 neutral/1 friendly, sight, light, actorLink…), Note (entryId, pageId, text, icon, iconSize, fontSize, global), Tile (texture.src, width, height), AmbientSound (path, radius, volume, walls, easing), Drawing, Region, MeasuredTemplate. x/y use units (default "scene" = pixels from the map top-left).' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        type: {
          type: 'string',
          enum: ['Token', 'Note', 'Tile', 'AmbientSound', 'Drawing', 'Region', 'MeasuredTemplate'],
        },
        data: { type: 'array', items: { type: 'object' } },
        center: { type: 'boolean', description: 'Tokens: x/y is the centre (default true).' },
        ...UNITS,
      },
      required: ['sceneId', 'type', 'data'],
    },
  },
  {
    name: 'update_walls',
    description:
      'Re-dress existing walls in one call: choose them by ids, by field values (where: {sight: 10, door: 0…}; unset fields count as Foundry defaults: 20 for senses/move, 0 for dir/door) and/or by a rectangle (within: {x, y, width, height} in scene px, both ends inside), then apply a preset (every sense reset to it) and/or raw fields. Example: make crystal formations let light through: {where: {sight: 10}, preset: "crystal"}.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' } },
        where: { type: 'object' },
        within: { type: 'object' },
        preset: { type: 'string' },
        fields: WALL_FIELDS,
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'create_lights',
    description:
      'Create many ambient lights in ONE call, with every LightData parameter: dim/bright (grid distance units), color, alpha (intensity of the colour), coloration (technique name or id), luminosity, saturation, contrast, shadows, attenuation, angle + rotation (cones), animation {type, speed 0-10, intensity 1-10, reverse}, darkness {min,max} (only lit within that scene-darkness range: lamps that turn on at night), negative (darkness source), priority, walls, vision, hidden, elevation. preset can be a name or a list merged in order (e.g. ["lantern","nightOnly"]), config overrides it. Be bold: layer a strong key light with small accent lights, colour the mood (cold crystal vs warm fire), animate, use cones for shafts of light and negative sources for unnatural darkness.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        lights: {
          type: 'array',
          description:
            '{x, y, preset?, config?, rotation?, walls?, vision?, hidden?, elevation?, name?}',
          items: { type: 'object' },
        },
        replace: {
          type: 'boolean',
          description: 'Delete every existing light of the scene first.',
        },
        ...UNITS,
      },
      required: ['sceneId', 'lights'],
    },
  },
  {
    name: 'update_lights',
    description:
      'Update many existing lights in one call (ids from list_lights): same fields as create_lights, partial.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        updates: {
          type: 'array',
          items: { type: 'object' },
          description: '{id, x?, y?, preset?, config?, rotation?, hidden?…}',
        },
        ...UNITS,
      },
      required: ['sceneId', 'updates'],
    },
  },
  {
    name: 'clear_scene_elements',
    description:
      'Delete all (or the listed ids of) walls, lights, sounds, tiles, drawings or notes of a scene in one call, to redo a layout.' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        kinds: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['walls', 'lights', 'sounds', 'tiles', 'drawings', 'notes'],
          },
        },
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['sceneId', 'kinds'],
    },
  },
  {
    name: 'configure_scene',
    description:
      'Change Scene settings, dot paths allowed. Useful: environment.darknessLevel (0-1), environment.globalLight {enabled, alpha, bright, color, coloration, luminosity, saturation, contrast, shadows, darkness {min,max}}, environment.base / environment.dark {hue 0-1, intensity, luminosity -1..1, saturation -1..1, shadows} (ambient tint of day and night), environment.cycle (blend day/night with darkness), fog.exploration, fog.overlay, fog.colors {explored, unexplored}, tokenVision, weather (e.g. rain, rainStorm, snow, fog, leaves, blizzard…), backgroundColor, grid {size, type, color, alpha, distance, units, thickness}, background {offsetX, offsetY, scaleX, scaleY}, foreground, initial {x,y,scale}, navigation, name, flags (e.g. flags.fxmaster for particle effects).' +
      WRITE,
    inputSchema: {
      type: 'object',
      properties: { sceneId: { type: 'string' }, changes: { type: 'object' } },
      required: ['sceneId', 'changes'],
    },
  },
  {
    name: 'render_scene',
    description:
      'See a scene: renders the whole map (or a zoomed region) as an image, tile by tile at real resolution, with overlays: walls coloured by kind with their endpoints, light radii, grid cell numbers along the edges. Works on any scene (not only the active one) without moving players. Use it to check walls against the drawn edges (zoom with region + scale ~1 for precision work) and to judge the lighting mood (effects: true, walls/lights/grid false).',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        region: {
          type: 'object',
          description: '{x, y, width, height} in scene px (map top-left origin).',
        },
        maxSize: {
          type: 'number',
          description: 'Longest side of the image (default 2048, max 4096).',
        },
        scale: {
          type: 'number',
          description: 'Explicit output pixels per scene pixel (overrides maxSize).',
        },
        walls: { type: 'boolean', description: 'Draw walls (default true).' },
        lights: { type: 'boolean', description: 'Draw light radii (default true).' },
        grid: { type: 'boolean', description: 'Draw grid labels (default true).' },
        gridLabelEvery: { type: 'number', description: 'Label every N cells (default 2).' },
        effects: {
          type: 'boolean',
          description: 'false hides lighting/darkness to see the bare map.',
        },
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'trace_walls',
    description:
      'Vision: trace wall paths from the map image. mode "flood" fills from seed points (scene px) over pixels close in colour to the seed (tolerance 0-441, e.g. 30-60) — seed the walkable floor of a cave and its outline becomes the walls; "edge" grows while neighbours differ by less than tolerance (stops at drawn edges); "dark"/"light" thresholds luminance (black-walled dungeons: dark, threshold ~50-80); "colors" keeps pixels near the given hex colours. Cleanup: blur, close (fills cracks), open (removes specks), minArea, maxHole (fills small holes: pillars/rocks smaller than that disappear, set 0 to keep them as wall loops). epsilon = simplification in scene px (smaller = more, shorter, more precise segments; 4-8 for caves). Border runs are left open (map edge). For interiors with thick walls use centerline + bridge: doors and windows come out as their own paths. Returns a preview and a trace id; then create_walls {fromTrace}. Iterate on the parameters until the preview hugs the edges.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        src: { type: 'string', description: 'Image path (default: scene background).' },
        mode: { type: 'string', enum: ['flood', 'edge', 'dark', 'light', 'colors'] },
        seeds: {
          type: 'array',
          items: { type: 'array', items: { type: 'number' } },
          description: '[[x,y], …] in scene px.',
        },
        tolerance: { type: 'number' },
        threshold: { type: 'number' },
        colors: { type: 'array', items: { type: 'string' } },
        workSize: {
          type: 'number',
          description: 'Working resolution, longest side (default 1024, max 2048).',
        },
        blur: { type: 'number' },
        close: { type: 'number' },
        open: { type: 'number' },
        minArea: { type: 'number', description: 'Fraction of the image (default 0.0005).' },
        maxHole: { type: 'number', description: 'Fraction of the image (default 0.002).' },
        epsilon: { type: 'number', description: 'Scene px (default 6).' },
        maxSegment: { type: 'number', description: 'Split longer segments (scene px).' },
        skipBorder: { type: 'boolean' },
        invert: { type: 'boolean' },
        centerline: {
          type: 'boolean',
          description:
            'Interiors with thick drawn walls: thin the wall mask to its centre line (one wall per drawn wall, not two faces). Use with mode colors/dark on the wall colour.',
        },
        bridge: {
          type: 'number',
          description:
            'With centerline: close gaps up to this length (scene px, e.g. 1.5 grid cells) between wall ends facing each other; each gap becomes a door, or a window when its middle pixel is bluish. Check them on render_scene.',
        },
        minGap: { type: 'number', description: 'Smallest gap bridged (scene px, default 8).' },
        within: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Keep only walls inside these rectangles [{x, y, width, height}] in scene px (drop map frames, shadows, titles, insets).',
        },
        minLength: {
          type: 'number',
          description: 'With centerline: drop wall runs shorter than this (scene px, default 20).',
        },
        doorPreset: { type: 'string', description: 'Preset for bridged doors (default door).' },
        windowPreset: {
          type: 'string',
          description: 'Preset for bridged windows (default window).',
        },
        returnPoints: { type: 'boolean', description: 'Also return the paths as JSON (large).' },
      },
      required: ['sceneId'],
    },
  },
];

export const TAVERNE_WRITE_TOOLS = [
  'create_documents',
  'update_documents',
  'create_scene_documents',
  'update_walls',
  'create_walls',
  'create_lights',
  'update_lights',
  'clear_scene_elements',
  'configure_scene',
];
export const TAVERNE_BRIDGE_TOOLS = ['render_scene', 'trace_walls'];
const NAMES = new Set(taverneTools.map((t) => t.name));

export function isTaverneTool(name: string): boolean {
  return NAMES.has(name);
}

export async function routeTaverneTool(
  name: string,
  args: Record<string, unknown>,
  client: FoundryClient,
  bridge: ModuleBridge | null,
) {
  switch (name) {
    case 'list_scene_presets':
      return handleListScenePresets();
    case 'create_walls':
      return handleCreateWalls(args, client);
    case 'create_documents':
      return handleCreateDocuments(args, client);
    case 'update_documents':
      return handleUpdateDocuments(args, client);
    case 'create_scene_documents':
      return handleCreateSceneDocuments(args, client);
    case 'update_walls':
      return handleUpdateWalls(args, client);
    case 'create_lights':
      return handleCreateLights(args, client);
    case 'update_lights':
      return handleUpdateLights(args, client);
    case 'clear_scene_elements':
      return handleClearSceneElements(args, client);
    case 'configure_scene':
      return handleConfigureScene(args, client);
    case 'render_scene':
      return handleRenderScene(args, bridge);
    case 'trace_walls':
      return handleTraceWalls(args, bridge);
    default:
      throw new Error(`Unknown taverne tool ${name}`);
  }
}
