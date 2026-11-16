/**
 * @fileoverview Public API of foundryvtt-mcp addons.
 *
 * An addon is an npm package (or a folder) whose default export is an {@link AddonDefinition}.
 * It plugs system-, setting- or table-specific tools into the connector: the rules of a game
 * system, character creation, encounter budgets, a universe's compendiums… The core stays
 * generic; everything specific lives in addons.
 *
 * An addon declares the connector it needs (`requires`, a version range checked at load) and
 * lists `foundryvtt-mcp` as a peer dependency: it is installed with the connector
 * (`foundryvtt-mcp addons add <package or folder>`), never alone.
 *
 * Tool names must start with the addon name and an underscore (`debilus_create_character`),
 * so addons never collide with each other or with core tools.
 */

export interface AddonToolResult {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface AddonTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The tool changes the world: it goes through the write gate and the write queue. */
  write?: boolean;
  /**
   * What it needs (default `socket`): `socket` = the FoundryVTT connection and its cached world,
   * `bridge` = the companion module, `socket+bridge` = both, `local` = nothing.
   */
  needs?: 'socket' | 'bridge' | 'socket+bridge' | 'local';
  handler(args: Record<string, unknown>, ctx: AddonContext): Promise<AddonToolResult>;
}

export interface AddonDefinition {
  /** Lower-case id, also the tool name prefix. */
  name: string;
  version: string;
  description?: string;
  /** Connector versions this addon works with: `>=3.0.0`, `^3.0.0`, `3.x`, `*`. */
  requires?: string;
  /** Game system ids it serves (`debilus`, `dnd5e`…); its tools refuse other worlds. */
  systems?: string[];
  /** Added to the connector's MCP instructions (keep it short: when to use the tools). */
  instructions?: string;
  tools: AddonTool[];
}

/** What an addon's handler can use. Writes need FOUNDRY_WRITE_ENABLED=true. */
export interface AddonContext {
  addon: string;
  /** The world's game system id, when connected. */
  systemId(): string | undefined;
  world: {
    /** Cached raw documents of a type: Actor, Item, Scene, JournalEntry, Combat, Folder, Macro, Playlist, RollTable, Cards. */
    collection(type: string): Record<string, unknown>[];
    get(type: string, id: string): Record<string, unknown> | undefined;
    /** A world setting's value (`system.key`), parsed from JSON; undefined when unset. */
    setting(key: string): unknown;
  };
  documents: {
    create(
      type: string,
      data: Record<string, unknown>[],
      options?: Record<string, unknown>,
    ): Promise<unknown[]>;
    update(type: string, updates: Record<string, unknown>[]): Promise<unknown[]>;
    delete(type: string, ids: string[]): Promise<unknown[]>;
    /** Embedded documents: parentUuid `Actor.<id>`, `JournalEntry.<id>`, `Scene.<id>`… */
    createEmbedded(
      parentUuid: string,
      type: string,
      data: Record<string, unknown>[],
    ): Promise<unknown[]>;
    updateEmbedded(
      parentUuid: string,
      type: string,
      updates: Record<string, unknown>[],
    ): Promise<unknown[]>;
    deleteEmbedded(parentUuid: string, type: string, ids: string[]): Promise<unknown[]>;
  };
  /** Saves world documents (restore_snapshot undoes later changes); returns the snapshot id. */
  snapshot(label: string, documents: Record<string, string[]>): string;
  bridge: {
    available(): boolean;
    /** A companion module command: get_compendium_document, search_compendium_content… */
    send(command: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  };
  /** An addon setting: FOUNDRY_ADDON_<NAME>_<KEY> from the environment or the configuration file. */
  setting(key: string): string | undefined;
  text(t: string): AddonToolResult;
  /** Throws an invalid-params error the AI can act on. */
  fail(message: string): never;
}

/** Identity helper for typed addon definitions. */
export function defineAddon(def: AddonDefinition): AddonDefinition {
  return def;
}
