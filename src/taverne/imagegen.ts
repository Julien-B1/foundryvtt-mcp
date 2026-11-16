/**
 * @fileoverview Taverne: generate_image — token, portrait, item icon, prop or map art from an
 * OpenAI-compatible image API (POST {base}/images/generations {model, prompt, n, size} →
 * data[].b64_json | data[].url), uploaded into Foundry and optionally applied to an actor/item.
 *
 * Where the API is: the companion module's world settings (address, port, model — set by the
 * GM in Foundry's game settings) win over FOUNDRY_IMAGE_API_URL / FOUNDRY_IMAGE_MODEL. The key
 * stays in the connector configuration (FOUNDRY_IMAGE_API_KEY): world settings reach players.
 * Works with an OpenAI-compatible proxy in front of ComfyUI, OpenAI, LocalAI, a LiteLLM proxy…
 */

import { config } from '../config/index.js';
import type { FoundryClient } from '../foundry/client.js';
import type { ModuleBridge } from '../foundry/module-bridge.js';
import { isRecord } from '../utils/guards.js';
import { saveSnapshot } from './snapshots.js';
import { fail, type ImageResult, str } from './util.js';

/** House prompts: what each kind of picture must look like on a Foundry table. */
export const IMAGE_KINDS: Record<
  string,
  { template: string; size?: string; dir: string; transparent?: boolean }
> = {
  token: {
    template:
      'Top-down tabletop RPG token of {subject}. Seen from directly above, the whole figure centred and filling a circle, bold readable silhouette, painted fantasy illustration, crisp edges, no text, no frame, plain transparent background.',
    dir: 'tokens',
    transparent: true,
  },
  portrait: {
    template:
      'Character portrait of {subject}. Bust, three-quarter view, expressive face, dramatic lighting, painted fantasy illustration, rich colours, no text.',
    dir: 'portraits',
  },
  item: {
    template:
      'Game inventory icon of {subject}. Single object centred, slight three-quarter angle, painted fantasy style, strong contrast, dark vignette background, no text, square.',
    dir: 'items',
  },
  prop: {
    template:
      'Top-down battlemap asset of {subject}, seen from directly above, painted fantasy battlemap style matching hand-drawn VTT maps, soft drop shadow, no text, isolated on a transparent background.',
    dir: 'props',
    transparent: true,
  },
  map: {
    template:
      'Top-down tabletop RPG battlemap of {subject}. Orthographic view from directly above, no perspective, no grid, no text, painted fantasy battlemap style, clear walkable areas, readable walls and doors.',
    size: '1536x1024',
    dir: 'maps',
  },
  scene: {
    template:
      'Atmospheric illustration of {subject}, cinematic composition, painted fantasy art, no text.',
    size: '1536x1024',
    dir: 'illustrations',
  },
  free: { template: '{subject}', dir: 'misc' },
};

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'image';

export function buildPrompt(kind: string, subject: string, style?: string): string {
  const k =
    IMAGE_KINDS[kind] ??
    fail(`Unknown kind "${kind}". Known: ${Object.keys(IMAGE_KINDS).join(', ')}`);
  return `${k.template.replace('{subject}', subject)}${style ? ` Style: ${style}.` : ''}`;
}

/** The images of an API answer, as base64 or URLs, whichever shape it uses. */
export function extractImages(body: unknown): Array<{ b64?: string; url?: string }> {
  const out: Array<{ b64?: string; url?: string }> = [];
  const fromUrl = (u: string) => {
    const m = /^data:[^;]+;base64,(.*)$/s.exec(u);
    out.push(m ? { b64: m[1] as string } : { url: u });
  };
  if (!isRecord(body)) {
    return out;
  }
  for (const d of Array.isArray(body.data) ? body.data : []) {
    if (isRecord(d) && typeof d.b64_json === 'string') {
      out.push({ b64: d.b64_json });
    } else if (isRecord(d) && typeof d.url === 'string') {
      fromUrl(d.url);
    }
  }
  return out;
}

function mimeOf(buf: Buffer): { mime: string; ext: string } {
  if (buf.subarray(0, 4).toString('hex') === '89504e47') {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return fail('The API returned something that is not a PNG, JPEG or WebP image');
}

const MODULE_ID = 'foundryvtt-mcp-bridge';

/** A world setting of the companion module, parsed; undefined when unset. */
function moduleSetting(client: FoundryClient, key: string): unknown {
  const raw = client
    .getWorldCollection('Setting')
    .find((d) => d.key === `${MODULE_ID}.${key}`)?.value;
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Base URL from an address and a port: `192.168.1.50` + 8189 → `http://192.168.1.50:8189/v1`;
 * an address with a scheme, a port or a path keeps them (a port given separately replaces its port).
 */
export function apiBase(host: string, port?: number): string {
  const withScheme = /^[a-z]+:\/\//i.test(host) ? host : `http://${host}`;
  const u = new URL(withScheme);
  if (port) {
    u.port = String(port);
  }
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${path || '/v1'}`;
}

/** The endpoint and model in use, and where they come from. */
export function imageEndpoint(client: FoundryClient): {
  base: string;
  model?: string;
  from: string;
} {
  const host = moduleSetting(client, 'imageApiHost');
  const port = moduleSetting(client, 'imageApiPort');
  const model = moduleSetting(client, 'imageApiModel');
  const ig = config.imageGen;
  const fromWorld = typeof host === 'string' && host.trim() !== '';
  const base = fromWorld
    ? apiBase(host.trim(), typeof port === 'number' && port > 0 ? port : undefined)
    : ig.apiUrl
      ? ig.apiUrl.replace(/\/+$/, '')
      : fail(
          'Image generation is not configured: set the address and port in Foundry (Game Settings → FoundryVTT MCP Bridge → Image generation), or FOUNDRY_IMAGE_API_URL in the connector configuration.',
        );
  const m = typeof model === 'string' && model.trim() ? model.trim() : ig.model;
  return {
    base,
    ...(m ? { model: m } : {}),
    from: fromWorld ? 'world settings' : 'connector configuration',
  };
}

async function callApi(
  endpoint: { base: string; model?: string },
  prompt: string,
  size: string,
  n: number,
  transparent: boolean,
): Promise<Buffer[]> {
  const ig = config.imageGen;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ig.apiKey) {
    headers.authorization = `Bearer ${ig.apiKey}`;
  }
  const body = {
    ...(endpoint.model ? { model: endpoint.model } : {}),
    prompt,
    n,
    size,
    // Only OpenAI's GPT image models know this field; others might refuse it.
    ...(transparent && /gpt-image/.test(endpoint.model ?? '') ? { background: 'transparent' } : {}),
  };
  const url = `${endpoint.base}/images/generations`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ig.timeoutSeconds * 1000),
    });
  } catch (error) {
    return fail(
      `Image API unreachable at ${url}: ${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)}`,
    );
  }
  const textBody = await res.text();
  if (!res.ok) {
    fail(`Image API answered ${res.status}: ${textBody.slice(0, 400)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBody);
  } catch {
    return fail('Image API answered something that is not JSON');
  }
  const images = extractImages(parsed);
  if (images.length === 0) {
    fail(`Image API returned no image: ${textBody.slice(0, 300)}`);
  }
  const out: Buffer[] = [];
  for (const img of images) {
    if (img.b64) {
      out.push(Buffer.from(img.b64, 'base64'));
    } else if (img.url) {
      const r = await fetch(img.url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) {
        fail(`Could not download the generated image (${r.status})`);
      }
      out.push(Buffer.from(await r.arrayBuffer()));
    }
  }
  return out;
}

export async function handleGenerateImage(
  args: Record<string, unknown>,
  client: FoundryClient,
  bridge: ModuleBridge | null,
): Promise<ImageResult> {
  const kind = str(args.kind) ?? 'free';
  const subject = str(args.prompt) ?? fail('prompt is required (what to draw)');
  const def =
    IMAGE_KINDS[kind] ??
    fail(`Unknown kind "${kind}". Known: ${Object.keys(IMAGE_KINDS).join(', ')}`);
  const prompt = args.raw === true ? subject : buildPrompt(kind, subject, str(args.style));
  const size = str(args.size) ?? def.size ?? config.imageGen.size;
  const n = Math.max(1, Math.min(4, typeof args.n === 'number' ? args.n : 1));
  const up =
    bridge ??
    fail('Uploading the image needs the companion module (FOUNDRY_MODULE_BRIDGE_ENABLED)');

  const endpoint = imageEndpoint(client);
  const images = await callApi(endpoint, prompt, size, n, def.transparent === true);
  const targetDir = str(args.targetDir) ?? `assets/generated/${def.dir}`;
  const base = slug(str(args.filename) ?? subject);
  const paths: string[] = [];
  for (const [i, buf] of images.entries()) {
    const { mime, ext } = mimeOf(buf);
    const filename = `${base}-${Date.now().toString(36)}${images.length > 1 ? `-${i + 1}` : ''}.${ext}`;
    const r = await up.send(
      'upload_asset',
      { targetDir, filename, contentBase64: buf.toString('base64'), mimeType: mime },
      120_000,
    );
    paths.push(isRecord(r) && typeof r.path === 'string' ? r.path : fail('Upload failed'));
  }

  const applied: string[] = [];
  const first = paths[0] as string;
  const actorId = str(args.actorId);
  const itemId = str(args.itemId);
  let undo = '';
  if (actorId || itemId) {
    const documents: Record<string, Record<string, unknown>[]> = {};
    if (actorId) {
      documents.Actor = client.getWorldCollection('Actor').filter((d) => d._id === actorId);
    }
    if (itemId) {
      documents.Item = client.getWorldCollection('Item').filter((d) => d._id === itemId);
    }
    undo = `\nUndo: restore_snapshot id \`${saveSnapshot({ label: 'before generate_image', documents }).id}\`.`;
  }
  if (actorId) {
    client.getRawActor(actorId) ?? fail(`Actor not found: ${actorId}`);
    const update: Record<string, unknown> = { _id: actorId };
    if (kind === 'token') {
      update['prototypeToken.texture.src'] = first;
      applied.push('actor prototype token');
    } else {
      update.img = first;
      applied.push('actor image');
      if (args.alsoToken === true) {
        update['prototypeToken.texture.src'] = first;
        applied.push('actor prototype token');
      }
    }
    await client.modifyWorldDocuments('Actor', 'update', [update]);
  }
  if (itemId) {
    await client.modifyWorldDocuments('Item', 'update', [{ _id: itemId, img: first }]);
    applied.push('item image');
  }

  return {
    content: [
      {
        type: 'text',
        text: `🎨 **${paths.length} image${paths.length > 1 ? 's' : ''} generated** (${kind}, ${size}, ${endpoint.model ?? 'default model'} at ${endpoint.base}, from the ${endpoint.from})\n${paths.map((p) => `- ${p}`).join('\n')}${applied.length ? `\nApplied to: ${applied.join(', ')}${undo}` : ''}\nPrompt: ${prompt}`,
      },
      ...(args.preview === false
        ? []
        : images.slice(0, 1).map((b) => ({
            type: 'image' as const,
            data: b.toString('base64'),
            mimeType: mimeOf(b).mime,
          }))),
    ],
  };
}
