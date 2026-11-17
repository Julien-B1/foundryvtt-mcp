/**
 * Taverne: calls a function of another module's public API (`game.modules.get(id).api`), so a
 * connector addon can drive a module that only works in a browser (Tokenizer, …).
 *
 * Only active modules, only functions reached through own properties of `api` (a dotted path,
 * no prototype walk). Arguments are JSON; `{ "$uuid": "Actor.abc" }` anywhere in them is replaced
 * by the document (`fromUuid`). Calls run one after the other, each with its own result, so a
 * batch stops neither on a failure nor on a slow call.
 */
import { serialize } from '../serialize.js';

const SEGMENT = /^[A-Za-z_$][\w$]*$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

async function resolveArgs(value) {
  if (Array.isArray(value)) return Promise.all(value.map(resolveArgs));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$uuid') {
      const doc = await fromUuid(String(value.$uuid));
      if (!doc) throw new Error(`No document ${value.$uuid}`);
      return doc;
    }
    const out = {};
    for (const k of keys) out[k] = await resolveArgs(value[k]);
    return out;
  }
  return value;
}

function apiFunction(moduleId, path) {
  const mod = game.modules.get(moduleId);
  if (!mod) throw new Error(`Module ${moduleId} is not installed`);
  if (!mod.active) throw new Error(`Module ${moduleId} is not active in this world`);
  let target = mod.api;
  let owner = null;
  if (!target) throw new Error(`Module ${moduleId} has no api`);
  for (const seg of String(path).split('.')) {
    if (!SEGMENT.test(seg) || FORBIDDEN.has(seg)) throw new Error(`Invalid api path ${path}`);
    if (target == null || !Object.hasOwn(Object(target), seg)) throw new Error(`${moduleId}.api has no ${path}`);
    owner = target;
    target = target[seg];
  }
  if (typeof target !== 'function') throw new Error(`${moduleId}.api.${path} is not a function`);
  return { fn: target, owner, version: mod.version };
}

/**
 * @param {{ module: string, fn?: string, calls?: {fn: string, args?: unknown[]}[], args?: unknown[] }} params
 */
export async function callModuleApi(params) {
  const moduleId = String(params.module ?? '');
  const calls = Array.isArray(params.calls) ? params.calls : [{ fn: params.fn, args: params.args }];
  const results = [];
  let version = null;
  for (const call of calls) {
    try {
      const { fn, owner, version: v } = apiFunction(moduleId, call.fn);
      version = v;
      const args = await resolveArgs(Array.isArray(call.args) ? call.args : []);
      const value = await fn.apply(owner, args);
      const out = serialize(value, { maxDepth: 4, maxNodes: 2000 });
      results.push({ fn: call.fn, ok: true, value: out.value, ...(out.truncated ? { truncated: true } : {}) });
    } catch (error) {
      results.push({ fn: call.fn, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { module: moduleId, version, results };
}
