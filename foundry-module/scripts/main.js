import { BridgeTransport } from './transport.js';
import { captureScene } from './commands/capture-scene.js';
import { getDocumentSchema } from './commands/get-schema.js';
import { searchCompendiumContent } from './commands/search-compendium-content.js';
import { getCompendiumDocument } from './commands/get-compendium-document.js';
import { rollAndPost } from './commands/roll-and-post.js';
import { setTarget } from './commands/set-target.js';
import { getTargets } from './commands/get-targets.js';
import { getActorStats } from './commands/get-actor-stats.js';
import { toggleStatusEffect } from './commands/toggle-status-effect.js';
import { pingCanvas } from './commands/ping-canvas.js';
import { setPause } from './commands/set-pause.js';
import { uploadAsset } from './commands/upload-asset.js';
import { renderScene } from './commands/render-scene.js';
import { traceWalls } from './commands/trace-walls.js';
import { exportAdventure, importAdventure } from './commands/adventure.js';

const MODULE_ID = 'foundryvtt-mcp-bridge';

/** @type {Record<string, (params: Record<string, unknown>) => Promise<unknown>>} */
const COMMANDS = {
  capture_scene: () => captureScene(),
  get_document_schema: (params) => getDocumentSchema(params),
  search_compendium_content: (params) => searchCompendiumContent(params),
  get_compendium_document: (params) => getCompendiumDocument(params),
  roll_and_post: (params) => rollAndPost(params),
  set_target: (params) => setTarget(params),
  get_targets: () => getTargets(),
  get_actor_stats: (params) => getActorStats(params),
  toggle_status_effect: (params) => toggleStatusEffect(params),
  ping_canvas: (params) => pingCanvas(params),
  set_pause: (params) => setPause(params),
  upload_asset: (params) => uploadAsset(params),
  render_scene: (params) => renderScene(params),
  trace_walls: (params) => traceWalls(params),
  export_adventure: (params) => exportAdventure(params),
  import_adventure: (params) => importAdventure(params),
};

/** @type {BridgeTransport | null} */
let transport = null;

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'bridgePort', {
    name: 'MCP Bridge Port',
    hint: 'Fallback only: the foundryvtt-mcp headless GM session tells the module which port to use (FOUNDRY_MODULE_BRIDGE_PORT). This value is used only if it does not.',
    scope: 'world',
    config: true,
    type: Number,
    default: 31415,
  });
  // Taverne: where generate_image sends its requests — an OpenAI-compatible image API
  // (e.g. an OpenAI-compatible proxy in front of ComfyUI). Read by the connector, which
  // keeps the API key in its own configuration: world settings reach every player.
  game.settings.register(MODULE_ID, 'imageApiHost', {
    name: 'Image generation: address',
    hint: 'Address of the OpenAI-compatible image API used by the MCP connector (generate_image), as the connector reaches it: e.g. 192.168.1.50, comfy-proxy or https://images.example.org. Empty: the connector configuration (FOUNDRY_IMAGE_API_URL) is used.',
    scope: 'world',
    config: true,
    restricted: true,
    type: String,
    default: '',
  });
  game.settings.register(MODULE_ID, 'imageApiPort', {
    name: 'Image generation: port',
    hint: 'Port of that API (e.g. 8189). 0: the address\'s own port, or the default one of http/https.',
    scope: 'world',
    config: true,
    restricted: true,
    type: Number,
    default: 0,
  });
  game.settings.register(MODULE_ID, 'imageApiModel', {
    name: 'Image generation: model',
    hint: 'Model name sent to the API (for the ComfyUI proxy: the workflow name, e.g. moss-image-sft). Empty: the connector configuration (FOUNDRY_IMAGE_MODEL).',
    scope: 'world',
    config: true,
    restricted: true,
    type: String,
    default: '',
  });
});

Hooks.once('ready', async () => {
  // GM-only: canvas commands run against this client's own render, and only
  // the GM's client is guaranteed connected/active.
  if (!game.user?.isGM) return;

  // Only the foundryvtt-mcp headless GM session provides this (a Playwright
  // binding backed by the MCP server): a GM tab opened by hand never dials
  // the bridge.
  const credentials = globalThis.foundryMcpBridge;
  if (!credentials) {
    console.info(
      'FoundryVTT MCP Bridge | no foundryvtt-mcp credentials in this browser, bridge disabled',
    );
    return;
  }

  let info = null;
  try {
    info = await credentials.getInfo();
  } catch (error) {
    console.warn('FoundryVTT MCP Bridge | could not read the bridge info', error);
  }
  const port = Number.isInteger(info?.port) ? info.port : game.settings.get(MODULE_ID, 'bridgePort');

  transport = new BridgeTransport(
    `ws://localhost:${port}`,
    async (type, params) => {
      const handler = COMMANDS[type];
      if (!handler) {
        throw new Error(`Unknown command: ${type}`);
      }
      return handler(params);
    },
    credentials,
    // Tells the server which commands this version serves (see transport.js).
    {
      version: game.modules.get(MODULE_ID)?.version ?? 'unknown',
      commands: Object.keys(COMMANDS),
    },
  );
  transport.connect();

  // Pushed unsolicited (no outstanding request) so `watch_events` on the
  // server sees canvas targeting, which never crosses FoundryVTT's own
  // `modifyDocument` Socket.IO channel.
  Hooks.on('targetToken', (user, token, targeted) => {
    transport?.sendEvent('target_token', {
      userId: user?.id,
      userName: user?.name,
      tokenId: token?.id,
      tokenName: token?.document?.name ?? token?.name,
      sceneId: token?.scene?.id ?? canvas?.scene?.id,
      targeted: !!targeted,
    });
  });
});

Hooks.once('closeGame', () => {
  transport?.disconnect();
});
