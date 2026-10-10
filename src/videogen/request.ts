// The body of POST /video/generate, read into what startVideoJob takes.
//
// Every way into a video render — the web form, the HTTP API, an agent's
// tool in-process or through the MCP child — has to produce the same
// provider request. The tool builds its specs as `{...extra, ...named
// fields}`; this does the same with the HTTP body, so a field the model
// takes (one somora has no name for, such as which person a replace
// model swaps) arrives on every path. A top-level field this route does
// not know is reported back instead of dropped without a word.

import { Buffer } from 'node:buffer';
import { VideoMediaTypeSchema } from '../config/types.ts';
import { referenceFromBase64 } from '../imagegen/references.ts';
import { mediaItemFromBytes, type MediaItem } from './media.ts';
import type { StartInput } from './generate.ts';

/** The named spec fields, with their own argument on the tool. */
export const NAMED_VIDEO_SPECS = ['seconds', 'size', 'aspect_ratio', 'audio', 'quality', 'seed'] as const;

const ROUTE_FIELDS = new Set<string>([
  'prompt', 'model', 'reference_images', 'media', 'extra', 'agent', 'session', 'save_to',
  ...NAMED_VIDEO_SPECS,
]);

export class VideoRequestError extends Error {}

export interface VideoRequest {
  input: StartInput;
  /** Top-level fields that were not used, one note each. */
  ignored: string[];
}

export function videoRequestFromBody(body: Record<string, unknown>): VideoRequest {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new VideoRequestError('prompt is required');

  if (body.extra !== undefined && (body.extra === null || typeof body.extra !== 'object' || Array.isArray(body.extra))) {
    throw new VideoRequestError('extra must be an object of provider fields');
  }
  // Same order as the tool: provider fields first, the named ones on top.
  const specs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((body.extra as Record<string, unknown> | undefined) ?? {})) {
    if (value !== undefined && value !== null && value !== '') specs[key] = value;
  }
  for (const key of NAMED_VIDEO_SPECS) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') specs[key] = body[key];
  }

  // References arrive as base64 here: the browser has bytes and no
  // server path, and the MCP child hands its already-read files over
  // the same way.
  // Each one a base64 string, or {data, filename} to keep the file's name.
  const references = Array.isArray(body.reference_images)
    ? body.reference_images.map((r: unknown, i: number) => {
        if (typeof r === 'string') return referenceFromBase64(r, i);
        const o = (r ?? {}) as Record<string, unknown>;
        if (typeof o.data !== 'string' || !o.data) throw new VideoRequestError(`reference_images #${i + 1}: data (base64) is required`);
        return referenceFromBase64(o.data, i, typeof o.filename === 'string' ? o.filename : undefined);
      })
    : [];
  // Input files by meaning, as base64 (or data: URIs) for the same reason.
  let media: MediaItem[] = [];
  if (Array.isArray(body.media)) {
    media = body.media.map((m: unknown, i: number) => {
      const r = (m ?? {}) as Record<string, unknown>;
      const type = VideoMediaTypeSchema.safeParse(r.type);
      if (!type.success) throw new VideoRequestError(`media #${i + 1}: unknown type ${JSON.stringify(r.type)}`);
      if (typeof r.data !== 'string' || r.data.length === 0) throw new VideoRequestError(`media #${i + 1}: data (base64) is required`);
      const comma = r.data.indexOf(',');
      const bare = r.data.startsWith('data:') && comma > 0 ? r.data.slice(comma + 1) : r.data;
      return mediaItemFromBytes(type.data, Buffer.from(bare, 'base64'), typeof r.filename === 'string' ? r.filename : `${type.data}-${i + 1}`, {
        ...(typeof r.seconds === 'number' ? { seconds: r.seconds } : {}),
        ...(typeof r.strength === 'number' ? { strength: r.strength } : {}),
      });
    });
  }

  const ignored = Object.keys(body)
    .filter((k) => !ROUTE_FIELDS.has(k) && body[k] !== undefined)
    .map((k) => `ignored: ${k} — pass provider-specific fields inside extra`);

  return {
    input: {
      prompt,
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      specs,
      ...(references.length > 0 ? { references } : {}),
      ...(media.length > 0 ? { media } : {}),
      ...(typeof body.save_to === 'string' && body.save_to ? { saveTo: body.save_to } : {}),
      ...(typeof body.agent === 'string' ? { agent: body.agent } : {}),
      ...(typeof body.session === 'string' ? { session: body.session } : {}),
    },
    ignored,
  };
}
