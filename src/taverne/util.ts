/**
 * @fileoverview Taverne: small helpers shared by the taverne tools.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export type Text = { content: Array<{ type: 'text'; text: string }> };
export type ImageResult = {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
};

export const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });

/** Throws an invalid-params error: the AI gets the message and can fix its call. */
export function fail(m: string): never {
  throw new McpError(ErrorCode.InvalidParams, m);
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export const strArray = (v: unknown, name: string): string[] | undefined =>
  v === undefined
    ? undefined
    : Array.isArray(v) && v.every((x) => typeof x === 'string')
      ? (v as string[])
      : fail(`${name} must be an array of strings`);
