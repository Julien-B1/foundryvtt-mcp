# Addons

The connector stays generic. Everything tied to one game system, setting or table — rules,
character creation, encounter budgets, a universe's compendiums — lives in **addons**: npm
packages (or plain folders) that plug extra tools into the connector.

## Using addons

```bash
foundryvtt-mcp addons add foundryvtt-mcp-debilus      # an npm package, installed in <state dir>/addons
foundryvtt-mcp addons add /path/to/my-addon            # a folder, used where it is
foundryvtt-mcp addons list                             # what is loaded, what failed
foundryvtt-mcp addons remove foundryvtt-mcp-debilus
foundryvtt-mcp stop                                    # then restart the MCP client to load the change
```

`add` and `remove` maintain `FOUNDRY_MCP_ADDONS` (comma-separated) in the configuration file;
you can also set it by hand. The `list_addons` tool shows the same from the AI side.

An addon is installed **with** the connector, never alone: it declares `foundryvtt-mcp` as a
peer dependency and the connector versions it supports (`requires`), checked at load. A broken
or incompatible addon is reported and skipped; the connector keeps running.

Addon settings are `FOUNDRY_ADDON_<NAME>_<KEY>` in the environment or the configuration file
(secrets such as API keys go there). Settings the GM changes **per world** are declared by the
addon (`worldSettings`): the connector publishes them, and the companion module (0.6.4+) shows
them in *Game Settings → FoundryVTT MCP Bridge* after the GM's page is reloaded. World settings
reach every player's browser: never put a secret in one.

## Writing an addon

`package.json`:

```json
{
  "name": "foundryvtt-mcp-mysystem",
  "type": "module",
  "main": "index.js",
  "keywords": ["foundryvtt-mcp-addon"],
  "peerDependencies": { "@g33ks/foundryvtt-mcp": ">=3.0.0" }
}
```

`index.js` (types: `import type { AddonDefinition } from '@g33ks/foundryvtt-mcp/addon'`):

```js
export default {
  name: 'mysystem',                 // also the tool prefix: every tool is mysystem_*
  version: '0.1.0',
  requires: '>=3.0.0',              // connector versions
  systems: ['mysystem'],            // its tools refuse worlds of other systems
  instructions: 'In a MySystem world, call mysystem_rules first…',  // appended to the MCP instructions
  worldSettings: [                  // edited by the GM in Foundry, read with ctx.worldSetting('server')
    { key: 'server', name: 'Rules server', hint: '…', type: 'string', default: '' },
  ],
  tools: [
    {
      name: 'mysystem_rules',
      description: 'The rules of MySystem.',
      needs: 'local',               // socket (default) | bridge | socket+bridge | local
      inputSchema: { type: 'object', properties: {} },
      async handler(args, ctx) {
        return ctx.text('…');
      },
    },
    {
      name: 'mysystem_create_npc',
      description: 'Create an NPC by the rules.',
      write: true,                  // write gate (FOUNDRY_WRITE_ENABLED) and write queue
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async handler(args, ctx) {
        const [actor] = await ctx.documents.create('Actor', [{ name: args.name, type: 'npc' }]);
        return ctx.text(`Created ${actor._id}`);
      },
    },
  ],
};
```

The handler's `ctx`:

| | |
|---|---|
| `ctx.systemId()` | the world's game system id |
| `ctx.world.collection(type)`, `ctx.world.get(type, id)` | cached raw documents (Actor, Item, Scene, JournalEntry, Combat, Folder, Macro, Playlist, RollTable, Cards) |
| `ctx.world.setting('system.key')` | a world setting, parsed |
| `ctx.documents.create/update/delete(type, …)` | batched world writes |
| `ctx.documents.createEmbedded/updateEmbedded/deleteEmbedded(parentUuid, type, …)` | items and effects of `Actor.<id>`, pages of `JournalEntry.<id>`, documents of `Scene.<id>` |
| `ctx.snapshot(label, {Actor: [ids]})` | saves documents first; `restore_snapshot` undoes |
| `ctx.bridge.send(command, params)` | companion module commands (`search_compendium_content`, `get_compendium_document`, …); `call_module_api` `{module, calls: [{fn, args}]}` (module 0.6.5+) calls another active module's `game.modules.get(module).api` in the GM browser, `{"$uuid": "Actor.x"}` in args becomes the document; `set_settings` `{values: {"module.key": v}}` (0.6.6+) sets other modules' settings of any scope in that browser and returns `{previous}` to put back |
| `ctx.setting(key)` | `FOUNDRY_ADDON_<NAME>_<KEY>` (connector configuration) |
| `ctx.worldSetting(key)` | one of the addon's `worldSettings`, as set in this world (else its default) |
| `ctx.text(t)`, `ctx.fail(message)` | a text result; an invalid-params error the AI can act on |

Examples: foundryvtt-mcp-images (image generation: kinds, MOSS-Image prompt rules, per-world
server address) and [foundryvtt-mcp-debilus](https://github.com/Julien-B1/foundryvtt-mcp-debilus) — rules,
characters and NPCs by the rules, sheet checks, encounter weight, compendium imports.
