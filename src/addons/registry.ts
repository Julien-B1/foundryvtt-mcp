/**
 * @fileoverview Loads foundryvtt-mcp addons and serves their tools.
 *
 * FOUNDRY_MCP_ADDONS lists them, comma-separated: a package name (installed in
 * `<state dir>/addons` by `foundryvtt-mcp addons add`, or resolvable from the connector) or a
 * folder path. Both the relay (tool list, instructions) and the shared process (execution) load
 * them at startup. A broken addon is reported and skipped: it never takes the connector down.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { processSettings } from '../config/env-layers.js';
import { configFilePath, readConfigFile, resolveSettings } from '../config/sources.js';
import type { FoundryClient } from '../foundry/client.js';
import type { ModuleBridge } from '../foundry/module-bridge.js';
import { defaultStateDir } from '../shared/paths.js';
import { packageVersion } from '../shared/version.js';
import { saveSnapshot } from '../taverne/snapshots.js';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';
import type { AddonContext, AddonDefinition, AddonTool, AddonToolResult } from './types.js';

export interface LoadedAddon {
  spec: string;
  def: AddonDefinition;
  from: string;
}

const loaded: LoadedAddon[] = [];
const errors: Array<{ spec: string; error: string }> = [];
const toolIndex = new Map<string, { addon: LoadedAddon; tool: AddonTool }>();
let loading: Promise<void> | null = null;

/** Where `foundryvtt-mcp addons add` installs packages. */
export function addonsDir(): string {
  return path.join(defaultStateDir(), 'addons');
}

/** True when `version` (x.y.z) satisfies `range`: *, x.x, x.y.x, >=x.y.z, ^x.y.z, ~x.y.z, x.y.z. */
export function satisfies(version: string, range: string | undefined): boolean {
  if (!range || range === '*') {
    return true;
  }
  const v = version
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0);
  return range.split('||').some((alt) =>
    alt
      .trim()
      .split(/\s+/)
      .every((part) => {
        const m = /^(>=|<=|>|<|\^|~|=)?\s*(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(part);
        if (!m) {
          return false;
        }
        const op = m[1] ?? '=';
        const want = [m[2], m[3], m[4]].map((n) =>
          n === undefined || n === 'x' || n === '*' ? null : Number(n),
        );
        const cmp = () => {
          for (let i = 0; i < 3; i++) {
            const w = want[i];
            if (w === null || w === undefined) {
              return 0;
            }
            const d = (v[i] ?? 0) - w;
            if (d !== 0) {
              return d;
            }
          }
          return 0;
        };
        const c = cmp();
        switch (op) {
          case '>=':
            return c >= 0;
          case '>':
            return c > 0;
          case '<=':
            return c <= 0;
          case '<':
            return c < 0;
          case '^':
            return c >= 0 && v[0] === want[0];
          case '~':
            return c >= 0 && v[0] === want[0] && (want[1] === null || v[1] === want[1]);
          default:
            return c === 0;
        }
      }),
  );
}

/** The entry module of an addon spec: a folder (its package.json main/exports) or a package. */
function resolveEntry(spec: string): string {
  const isPath = spec.startsWith('/') || spec.startsWith('.') || /^[A-Za-z]:[\\/]/.test(spec);
  const dir = isPath ? path.resolve(spec) : path.join(addonsDir(), 'node_modules', spec);
  if (existsSync(path.join(dir, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const exp = pkg.exports;
    const main =
      typeof exp === 'string'
        ? exp
        : isRecord(exp) && typeof exp['.'] === 'string'
          ? exp['.']
          : isRecord(exp) && isRecord(exp['.']) && typeof exp['.'].import === 'string'
            ? exp['.'].import
            : typeof pkg.main === 'string'
              ? pkg.main
              : 'index.js';
    return path.join(dir, main);
  }
  if (isPath) {
    return existsSync(path.join(dir, 'index.js')) ? path.join(dir, 'index.js') : dir;
  }
  // A package installed next to the connector.
  return createRequire(import.meta.url).resolve(spec);
}

function validate(def: unknown, spec: string): AddonDefinition {
  if (!isRecord(def) || typeof def.name !== 'string' || !Array.isArray(def.tools)) {
    throw new Error(`${spec} does not export an addon (default export {name, version, tools})`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) {
    throw new Error(`addon name "${def.name}" must be lower-case letters, digits and dashes`);
  }
  const prefix = `${def.name.replace(/-/g, '_')}_`;
  for (const s of Array.isArray(def.worldSettings) ? def.worldSettings : []) {
    if (!isRecord(s) || typeof s.key !== 'string' || !/^[A-Za-z0-9]+$/.test(s.key)) {
      throw new Error(`${def.name}: world setting keys are letters and digits`);
    }
  }
  for (const t of def.tools) {
    if (!isRecord(t) || typeof t.name !== 'string' || typeof t.handler !== 'function') {
      throw new Error(`${def.name}: every tool needs a name and a handler`);
    }
    if (!t.name.startsWith(prefix)) {
      throw new Error(`${def.name}: tool "${t.name}" must start with "${prefix}"`);
    }
  }
  const core = packageVersion();
  if (!satisfies(core, typeof def.requires === 'string' ? def.requires : undefined)) {
    throw new Error(`${def.name} needs foundryvtt-mcp ${String(def.requires)}, this is ${core}`);
  }
  return def as unknown as AddonDefinition;
}

/** Loads the configured addons once (later calls wait for the same load). */
export function loadAddons(): Promise<void> {
  loading ??= (async () => {
    const list = (resolveSettings().values.FOUNDRY_MCP_ADDONS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const spec of list) {
      try {
        const entry = resolveEntry(spec);
        const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
        const def = validate(mod.default ?? mod, spec);
        if (loaded.some((a) => a.def.name === def.name)) {
          throw new Error(`addon "${def.name}" is listed twice`);
        }
        const addon = { spec, def, from: entry };
        loaded.push(addon);
        for (const tool of def.tools) {
          if (toolIndex.has(tool.name)) {
            throw new Error(`tool ${tool.name} already exists`);
          }
          toolIndex.set(tool.name, { addon, tool });
        }
        logger.info(
          `Addon ${def.name} ${def.version} loaded (${def.tools.length} tools) from ${entry}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ spec, error: message });
        logger.warn(`Addon ${spec} not loaded: ${message}`);
      }
    }
  })();
  return loading;
}

export function loadedAddons(): readonly LoadedAddon[] {
  return loaded;
}

export function addonErrors(): ReadonlyArray<{ spec: string; error: string }> {
  return errors;
}

/** MCP tool definitions of the loaded addons. */
export function addonToolDefinitions() {
  return [...toolIndex.values()].map(({ addon, tool }) => ({
    name: tool.name,
    description: `[${addon.def.name} addon${addon.def.systems?.length ? `, ${addon.def.systems.join('/')}` : ''}] ${tool.description}`,
    inputSchema: tool.inputSchema,
  }));
}

export function isAddonTool(name: string): boolean {
  return toolIndex.has(name);
}

export function isAddonWriteTool(name: string): boolean {
  return toolIndex.get(name)?.tool.write === true;
}

export function addonToolDependency(name: string): AddonTool['needs'] | undefined {
  const t = toolIndex.get(name)?.tool;
  return t ? (t.needs ?? 'socket') : undefined;
}

/** The addons' instructions, appended to the connector's. */
export function addonInstructions(): string {
  return loaded
    .filter((a) => a.def.instructions)
    .map((a) => `## ${a.def.name} addon\n${a.def.instructions}`)
    .join('\n\n');
}

const BRIDGE_ID = 'foundryvtt-mcp-bridge';
/** World setting listing every addon world setting, read by the companion module at init. */
export const ADDON_SETTINGS_KEY = `${BRIDGE_ID}.addonSettings`;

function worldSettingValue(client: FoundryClient, key: string): unknown {
  const raw = client.getWorldCollection('Setting').find((d) => d.key === key)?.value;
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The declarations the companion module registers, from every loaded addon. */
export function addonSettingDeclarations() {
  return loaded.flatMap((a) =>
    (a.def.worldSettings ?? []).map((s) => ({ addon: a.def.name, ...s })),
  );
}

/**
 * Publishes the addons' world settings for the companion module (a world setting it reads at
 * init). Best effort: needs the socket and write access; unchanged declarations are not rewritten.
 */
export async function publishAddonSettings(client: FoundryClient): Promise<void> {
  const decls = addonSettingDeclarations();
  try {
    const current = worldSettingValue(client, ADDON_SETTINGS_KEY);
    if (JSON.stringify(current ?? []) === JSON.stringify(decls)) {
      return;
    }
    await client.setWorldSetting(ADDON_SETTINGS_KEY, decls);
    logger.info(`Published ${decls.length} addon world settings for the companion module`);
  } catch (error) {
    logger.warn(
      `Addon world settings not published: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function addonSetting(addon: string, key: string): string | undefined {
  const name = `FOUNDRY_ADDON_${addon.replace(/-/g, '_').toUpperCase()}_${key.toUpperCase()}`;
  return processSettings()[name] ?? readConfigFile(configFilePath()).values[name];
}

const fail = (m: string): never => {
  throw new McpError(ErrorCode.InvalidParams, m);
};

export function addonContext(
  addon: AddonDefinition,
  client: FoundryClient,
  bridge: ModuleBridge | null,
): AddonContext {
  return {
    addon: addon.name,
    systemId: () => client.worldSystemId(),
    world: {
      collection: (type) => client.getWorldCollection(type),
      get: (type, id) => client.getWorldCollection(type).find((d) => d._id === id),
      setting: (key) => {
        const raw = client.getWorldCollection('Setting').find((d) => d.key === key)?.value;
        if (typeof raw !== 'string') {
          return raw;
        }
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      },
    },
    documents: {
      create: (type, data, options) => client.modifyWorldDocuments(type, 'create', data, options),
      update: (type, updates) => client.modifyWorldDocuments(type, 'update', updates),
      delete: (type, ids) => client.modifyWorldDocuments(type, 'delete', ids),
      createEmbedded: (parent, type, data) => client.modifyEmbedded(parent, type, 'create', data),
      updateEmbedded: (parent, type, updates) =>
        client.modifyEmbedded(parent, type, 'update', updates),
      deleteEmbedded: (parent, type, ids) => client.modifyEmbedded(parent, type, 'delete', ids),
    },
    snapshot: (label, documents) => {
      const docs: Record<string, Record<string, unknown>[]> = {};
      for (const [type, ids] of Object.entries(documents)) {
        docs[type] = client.getWorldCollection(type).filter((d) => ids.includes(String(d._id)));
      }
      return saveSnapshot({ label: `${addon.name}: ${label}`, documents: docs }).id;
    },
    bridge: {
      available: () => bridge !== null,
      send: (command, params, timeoutMs) =>
        (
          bridge ?? fail('This tool needs the companion module (FOUNDRY_MODULE_BRIDGE_ENABLED)')
        ).send(command, params, timeoutMs),
    },
    setting: (key) => addonSetting(addon.name, key),
    worldSetting: (key) => {
      const decl = addon.worldSettings?.find((s) => s.key === key);
      const v = worldSettingValue(client, `${BRIDGE_ID}.${addon.name.replace(/-/g, '_')}_${key}`);
      return v === undefined || v === null ? decl?.default : v;
    },
    text: (t) => ({ content: [{ type: 'text', text: t }] }),
    fail,
  };
}

export async function routeAddonTool(
  name: string,
  args: Record<string, unknown>,
  client: FoundryClient,
  bridge: ModuleBridge | null,
): Promise<AddonToolResult> {
  const entry = toolIndex.get(name) ?? fail(`Unknown addon tool ${name}`);
  const { addon, tool } = entry;
  const systems = addon.def.systems;
  const system = client.worldSystemId();
  if (systems?.length && system && !systems.includes(system)) {
    fail(`${name} serves ${systems.join('/')} worlds; this world runs ${system}`);
  }
  if (tool.write) {
    client.assertCanWrite();
  }
  return tool.handler(args, addonContext(addon.def, client, bridge));
}

/** list_addons: what is loaded, from where, and what failed. */
export function handleListAddons(): AddonToolResult {
  const lines = loaded.map(
    (a) =>
      `- **${a.def.name}** ${a.def.version}${a.def.systems?.length ? ` (${a.def.systems.join(', ')})` : ''} — ${a.def.tools.length} tools: ${a.def.tools.map((t) => t.name).join(', ')}${a.def.description ? `\n  ${a.def.description}` : ''}`,
  );
  const bad = errors.map((e) => `- ❌ ${e.spec}: ${e.error}`);
  return {
    content: [
      {
        type: 'text',
        text:
          loaded.length || bad.length
            ? `🧩 **Addons** (connector ${packageVersion()})\n${[...lines, ...bad].join('\n')}`
            : `🧩 No addon loaded. Install one with \`foundryvtt-mcp addons add <package or folder>\` (it is added to FOUNDRY_MCP_ADDONS).`,
      },
    ],
  };
}
