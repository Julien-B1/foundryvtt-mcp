/**
 * @fileoverview Taverne: wall and light presets for the batch tools.
 *
 * Values checked against FoundryVTT 14.370 (common/constants.mjs, client/config.mjs):
 * EDGE_SENSE_TYPES NONE 0, LIMITED 10, NORMAL 20, PROXIMITY 30, DISTANCE 40;
 * WALL_MOVEMENT_TYPES NONE 0, NORMAL 20; EDGE_DIRECTIONS BOTH 0, LEFT 1, RIGHT 2;
 * WALL_DOOR_TYPES NONE 0, DOOR 1, SECRET 2; WALL_DOOR_STATES CLOSED 0, OPEN 1, LOCKED 2.
 */

export const SENSE = { none: 0, limited: 10, normal: 20, proximity: 30, distance: 40 } as const;
export const MOVE = { none: 0, normal: 20 } as const;
export const DIRECTION = { both: 0, left: 1, right: 2 } as const;
export const DOOR = { none: 0, door: 1, secret: 2 } as const;
export const DOOR_STATE = { closed: 0, open: 1, locked: 2 } as const;

export const DOOR_SOUNDS = [
  'futuristicFast',
  'futuristicHydraulic',
  'futuristicForcefield',
  'industrial',
  'industrialCreaky',
  'jail',
  'jailCreaky',
  'jailHeavy',
  'magicDoor',
  'magicWall',
  'metal',
  'slidingMetal',
  'slidingMetalHeavy',
  'slidingModern',
  'slidingWood',
  'stoneBasic',
  'stoneRocky',
  'stoneSandy',
  'woodBasic',
  'woodCreaky',
  'woodHeavy',
] as const;

export const DOOR_ANIMATIONS = ['ascend', 'descend', 'slide', 'swing', 'swivel'] as const;

export const LIGHT_ANIMATIONS = [
  'flame',
  'torch',
  'revolving',
  'siren',
  'pulse',
  'reactivepulse',
  'chroma',
  'wave',
  'fog',
  'sunburst',
  'dome',
  'emanation',
  'hexa',
  'ghost',
  'energy',
  'vortex',
  'witchwave',
  'rainbowswirl',
  'radialrainbow',
  'fairy',
  'grid',
  'starlight',
  'smokepatch',
] as const;

/** Animations for darkness sources (negative: true). */
export const DARKNESS_ANIMATIONS = ['magicalGloom', 'roiling', 'hole', 'denseSmoke'] as const;

/** AdaptiveLightingShader.SHADER_TECHNIQUES ids (coloration). */
export const COLORATION = {
  legacy: 0,
  luminance: 1,
  internalHalo: 2,
  externalHalo: 3,
  colorBurn: 4,
  internalBurn: 5,
  externalBurn: 6,
  lowAbsorption: 7,
  highAbsorption: 8,
  invertAbsorption: 9,
  naturalLight: 10,
} as const;

export type WallFields = Record<string, unknown>;

/**
 * Wall presets: a starting point, every field can still be overridden.
 * The comment says what each one is for, so the AI picks the right one.
 */
export const WALL_PRESETS: Record<string, { description: string; fields: WallFields }> = {
  wall: { description: 'Solid wall: blocks movement, sight, light and sound.', fields: {} },
  cave: {
    description: 'Natural rock / cave edge: like wall, sound only muffled (limited).',
    fields: { sound: SENSE.limited },
  },
  door: {
    description: 'Wooden door, swings open.',
    fields: {
      door: DOOR.door,
      ds: 0,
      doorSound: 'woodBasic',
      animation: { type: 'swing', duration: 750 },
    },
  },
  doubleDoor: {
    description: 'Double wooden door (gate, hall).',
    fields: {
      door: DOOR.door,
      ds: 0,
      doorSound: 'woodHeavy',
      animation: { type: 'swing', double: true, duration: 900 },
    },
  },
  metalDoor: {
    description: 'Metal door.',
    fields: {
      door: DOOR.door,
      ds: 0,
      doorSound: 'metal',
      animation: { type: 'swing', duration: 900 },
    },
  },
  stoneDoor: {
    description: 'Heavy stone door that slides.',
    fields: {
      door: DOOR.door,
      ds: 0,
      doorSound: 'stoneBasic',
      animation: { type: 'slide', duration: 1500 },
    },
  },
  portcullis: {
    description: 'Portcullis / bars: you see and hear through it, cannot pass; rises.',
    fields: {
      door: DOOR.door,
      ds: 0,
      sight: SENSE.none,
      light: SENSE.none,
      sound: SENSE.none,
      doorSound: 'jailHeavy',
      animation: { type: 'ascend', duration: 1500 },
    },
  },
  magicDoor: {
    description: 'Magical door / force field.',
    fields: {
      door: DOOR.door,
      ds: 0,
      doorSound: 'magicDoor',
      animation: { type: 'descend', duration: 1200 },
    },
  },
  scifiDoor: {
    description: 'Sliding sci-fi door.',
    fields: {
      door: DOOR.door,
      ds: 0,
      doorSound: 'futuristicFast',
      animation: { type: 'slide', duration: 400 },
    },
  },
  secretDoor: {
    description: 'Secret door: a wall for players until revealed.',
    fields: {
      door: DOOR.secret,
      ds: 0,
      doorSound: 'stoneRocky',
      animation: { type: 'swivel', duration: 1200 },
    },
  },
  lockedDoor: {
    description: 'Locked wooden door.',
    fields: {
      door: DOOR.door,
      ds: DOOR_STATE.locked,
      doorSound: 'woodCreaky',
      animation: { type: 'swing', duration: 750 },
    },
  },
  window: {
    description:
      'Window: blocks movement; sight and light pass only when close (proximity 1.5 grid units), sound muffled.',
    fields: {
      sight: SENSE.proximity,
      light: SENSE.proximity,
      sound: SENSE.limited,
      threshold: { sight: 1.5, light: 1.5, attenuation: true },
    },
  },
  terrain: {
    description:
      'Foliage, hedge, thick brush: blocks movement; sight/light/sound block on the second crossing.',
    fields: { sight: SENSE.limited, light: SENSE.limited, sound: SENSE.limited },
  },
  fence: {
    description:
      'Fence, low wall, palisade gaps: blocks movement, sight and light pass, sound passes.',
    fields: { sight: SENSE.none, light: SENSE.none, sound: SENSE.none },
  },
  invisible: {
    description: 'Invisible barrier (furniture, rubble, water edge, chasm): blocks movement only.',
    fields: { sight: SENSE.none, light: SENSE.none, sound: SENSE.none },
  },
  ethereal: {
    description: 'Curtain, illusion, veil of mist: blocks sight and light, not movement.',
    fields: { move: MOVE.none, sound: SENSE.none },
  },
  curtain: {
    description:
      'Heavy curtain / tapestry: blocks sight, lets light leak (limited), no movement block.',
    fields: { move: MOVE.none, light: SENSE.limited, sound: SENSE.limited },
  },
  cliffLeft: {
    description:
      'One-way wall (ledge, cliff edge): blocks only when crossed from its left side (seen from start to end point).',
    fields: { dir: DIRECTION.left },
  },
  cliffRight: {
    description: 'One-way wall, blocking from its right side.',
    fields: { dir: DIRECTION.right },
  },
  lightOnly: {
    description: 'Blocks light only (keeps a lit room from bleeding outside without hiding it).',
    fields: { move: MOVE.none, sight: SENSE.none, sound: SENSE.none },
  },
  soundOnly: {
    description: 'Blocks sound only (thick glass, magical silence boundary).',
    fields: { move: MOVE.none, sight: SENSE.none, light: SENSE.none },
  },
};

export type LightConfig = Record<string, unknown>;

/**
 * Light presets. `dim`/`bright` are in scene distance units (the grid's units).
 * Each preset is bold on purpose: coloration, animation and luminosity tuned for mood.
 */
export const LIGHT_PRESETS: Record<
  string,
  { description: string; config: LightConfig; doc?: Record<string, unknown> }
> = {
  torch: {
    description: 'Wall torch: warm, flickering.',
    config: {
      dim: 6,
      bright: 3,
      color: '#ff9a3c',
      alpha: 0.45,
      coloration: COLORATION.luminance,
      animation: { type: 'torch', speed: 4, intensity: 4 },
      attenuation: 0.6,
    },
  },
  campfire: {
    description: 'Campfire / hearth: big warm flame, strong shadows.',
    config: {
      dim: 10,
      bright: 4,
      color: '#ff7a1a',
      alpha: 0.55,
      coloration: COLORATION.naturalLight,
      shadows: 0.3,
      animation: { type: 'flame', speed: 5, intensity: 5 },
      attenuation: 0.7,
    },
  },
  brazier: {
    description: 'Brazier / forge: red-orange embers.',
    config: {
      dim: 8,
      bright: 3,
      color: '#ff4d1a',
      alpha: 0.6,
      coloration: COLORATION.internalBurn,
      animation: { type: 'flame', speed: 6, intensity: 6 },
      contrast: 0.2,
    },
  },
  candle: {
    description: 'Candle: tiny, soft.',
    config: {
      dim: 2,
      bright: 0.75,
      color: '#ffc46b',
      alpha: 0.35,
      animation: { type: 'torch', speed: 2, intensity: 2 },
      attenuation: 0.8,
    },
  },
  lantern: {
    description: 'Hanging lantern: steady warm pool.',
    config: {
      dim: 7.5,
      bright: 2.5,
      color: '#ffb347',
      alpha: 0.4,
      coloration: COLORATION.luminance,
      animation: { type: 'pulse', speed: 1, intensity: 2 },
      attenuation: 0.6,
    },
  },
  streetLamp: {
    description: 'Street lamp: steady, slightly cold.',
    config: { dim: 9, bright: 3, color: '#ffe2a8', alpha: 0.3, attenuation: 0.5 },
  },
  crystal: {
    description: 'Arcane crystal: cold cyan pulse with an external halo.',
    config: {
      dim: 9,
      bright: 3,
      color: '#6fe8ff',
      alpha: 0.55,
      coloration: COLORATION.externalHalo,
      luminosity: 0.6,
      saturation: 0.3,
      animation: { type: 'pulse', speed: 2, intensity: 4 },
      attenuation: 0.4,
    },
  },
  crystalShard: {
    description: 'Small crystal cluster glow.',
    config: {
      dim: 3,
      bright: 1,
      color: '#8ff0ff',
      alpha: 0.5,
      coloration: COLORATION.internalHalo,
      animation: { type: 'starlight', speed: 3, intensity: 4 },
    },
  },
  arcane: {
    description: 'Magic circle / arcane energy: violet energy field.',
    config: {
      dim: 8,
      bright: 3,
      color: '#a86bff',
      alpha: 0.6,
      coloration: COLORATION.externalHalo,
      luminosity: 0.6,
      animation: { type: 'energy', speed: 4, intensity: 5 },
    },
  },
  runes: {
    description: 'Glowing runes / sigils: hexagonal pattern.',
    config: {
      dim: 4,
      bright: 1.5,
      color: '#7affc8',
      alpha: 0.6,
      coloration: COLORATION.internalHalo,
      animation: { type: 'hexa', speed: 3, intensity: 5 },
    },
  },
  portal: {
    description: 'Portal / vortex.',
    config: {
      dim: 8,
      bright: 3,
      color: '#5a7bff',
      alpha: 0.7,
      coloration: COLORATION.colorBurn,
      luminosity: 0.7,
      animation: { type: 'vortex', speed: 5, intensity: 6 },
    },
  },
  fairy: {
    description: 'Fey lights, will-o-wisps, fireflies.',
    config: {
      dim: 5,
      bright: 1,
      color: '#d6ff7a',
      alpha: 0.5,
      coloration: COLORATION.luminance,
      animation: { type: 'fairy', speed: 4, intensity: 5 },
    },
  },
  bioluminescent: {
    description: 'Bioluminescent water / fungi: teal waves.',
    config: {
      dim: 6,
      bright: 0,
      color: '#3fffd2',
      alpha: 0.28,
      coloration: COLORATION.lowAbsorption,
      animation: { type: 'wave', speed: 2, intensity: 4 },
      saturation: 0.4,
    },
  },
  water: {
    description: 'Shimmer over water / fountain: soft blue waves.',
    config: {
      dim: 6,
      bright: 0,
      color: '#7fd4ff',
      alpha: 0.35,
      coloration: COLORATION.lowAbsorption,
      animation: { type: 'wave', speed: 2, intensity: 3 },
    },
  },
  holy: {
    description: 'Holy / divine light: golden sunburst.',
    config: {
      dim: 10,
      bright: 4,
      color: '#ffe9a3',
      alpha: 0.5,
      coloration: COLORATION.externalHalo,
      luminosity: 0.7,
      animation: { type: 'sunburst', speed: 2, intensity: 4 },
    },
  },
  ghostly: {
    description: 'Ghostly / necrotic glow.',
    config: {
      dim: 6,
      bright: 2,
      color: '#9fffb0',
      alpha: 0.5,
      coloration: COLORATION.invertAbsorption,
      saturation: -0.4,
      animation: { type: 'ghost', speed: 3, intensity: 5 },
    },
  },
  witchfire: {
    description: 'Eldritch witchfire: purple-green waves.',
    config: {
      dim: 7,
      bright: 2,
      color: '#b14dff',
      alpha: 0.6,
      coloration: COLORATION.colorBurn,
      animation: { type: 'witchwave', speed: 4, intensity: 6 },
    },
  },
  lava: {
    description: 'Lava / molten metal: deep red, burning.',
    config: {
      dim: 8,
      bright: 3,
      color: '#ff3300',
      alpha: 0.7,
      coloration: COLORATION.externalBurn,
      contrast: 0.3,
      animation: { type: 'flame', speed: 3, intensity: 7 },
    },
  },
  alarm: {
    description: 'Revolving alarm light (sci-fi, modern).',
    config: {
      dim: 8,
      bright: 3,
      color: '#ff2030',
      alpha: 0.6,
      angle: 90,
      animation: { type: 'siren', speed: 6, intensity: 6 },
    },
  },
  neon: {
    description: 'Neon sign / cyberpunk: saturated, chroma cycling.',
    config: {
      dim: 5,
      bright: 1.5,
      color: '#ff2fd6',
      alpha: 0.6,
      coloration: COLORATION.luminance,
      saturation: 0.6,
      animation: { type: 'chroma', speed: 3, intensity: 4 },
    },
  },
  moonbeam: {
    description: 'Moonlight shaft through a window / canopy gap (cone, use rotation).',
    config: {
      dim: 10,
      bright: 5,
      color: '#a8c8ff',
      alpha: 0.35,
      angle: 60,
      coloration: COLORATION.naturalLight,
      saturation: -0.2,
    },
  },
  sunbeam: {
    description: 'Sunlight shaft (cone, use rotation).',
    config: {
      dim: 10,
      bright: 6,
      color: '#fff1c4',
      alpha: 0.35,
      angle: 50,
      coloration: COLORATION.naturalLight,
    },
  },
  mist: {
    description: 'Glowing mist / fog patch.',
    config: {
      dim: 6,
      bright: 0,
      color: '#cfe8ff',
      alpha: 0.3,
      coloration: COLORATION.lowAbsorption,
      animation: { type: 'fog', speed: 2, intensity: 4 },
    },
  },
  smoke: {
    description: 'Smoke patch over a fire or chimney.',
    config: {
      dim: 4,
      bright: 0,
      color: '#9a8a7a',
      alpha: 0.3,
      animation: { type: 'smokepatch', speed: 2, intensity: 4 },
    },
  },
  nightOnly: {
    description:
      'Any light, but only lit when the scene is dark (darkness >= 0.5): combine with another preset via config.',
    config: { darkness: { min: 0.5, max: 1 } },
  },
  darkness: {
    description: 'Magical darkness zone (negative source): swallows light.',
    config: {
      negative: true,
      dim: 6,
      bright: 3,
      color: '#20002a',
      alpha: 0.6,
      animation: { type: 'magicalGloom', speed: 3, intensity: 5 },
    },
  },
  shadowPool: {
    description: 'Deep shadow pool / pit (negative source, roiling).',
    config: {
      negative: true,
      dim: 4,
      bright: 2,
      alpha: 0.6,
      animation: { type: 'roiling', speed: 2, intensity: 4 },
    },
  },
  voidHole: {
    description: 'Void / black hole (negative source).',
    config: {
      negative: true,
      dim: 5,
      bright: 3,
      alpha: 0.8,
      animation: { type: 'hole', speed: 3, intensity: 6 },
    },
  },
};
