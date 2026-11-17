/**
 * Taverne: sets settings of other modules in this (GM) browser through game.settings, whatever
 * their scope (world, user, client), and returns the previous values so the caller can put them
 * back. Lets an addon give one call of a module its own look (Tokenizer's per-user frame tints).
 * Never core.* nor this module's own settings.
 *
 * @param {{ values: Record<string, unknown> }} params  keys « namespace.key »
 */
export async function setSettings(params) {
  const values = params?.values && typeof params.values === 'object' ? params.values : {};
  const previous = {};
  for (const [full, value] of Object.entries(values)) {
    const dot = full.indexOf('.');
    const namespace = full.slice(0, dot);
    const key = full.slice(dot + 1);
    if (dot < 1 || !key) throw new Error(`Invalid setting key ${full}`);
    if (namespace === 'core' || namespace === 'foundryvtt-mcp-bridge') throw new Error(`Refusing to set ${full}`);
    if (!game.settings.settings.has(full)) throw new Error(`Unknown setting ${full}`);
    previous[full] = game.settings.get(namespace, key);
    await game.settings.set(namespace, key, value);
  }
  return { previous };
}
