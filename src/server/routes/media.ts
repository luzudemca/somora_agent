// Moved unchanged from src/server/index.ts, which calls registerMediaRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import { deleteRecord as deleteMediaRecord, totalBytes as imageTotalBytes, listRecords as listMediaRecords, readRecord as readMediaRecord } from '../../media/records.ts';
import { ensureVideoStill } from '../../videogen/frame.ts';
import { config } from '../server-state.ts';
import type { Context } from 'hono';
import { existsSync } from 'node:fs';
import { stat as statFs } from 'node:fs/promises';

export function registerMediaRoutes(app: Hono): void {
  // ─────────────────────────────────────────────────────────────────────
  // Media — one surface over generated images and video.
  //
  // `/images/:id/file` above stays mounted for good: that exact string is
  // written into session files by assistant_media events, and a URL
  // already on disk cannot be rewritten. Everything new speaks /media.
  // ─────────────────────────────────────────────────────────────────────

  app.get('/media', async (c) => {
    const kindParam = c.req.query('kind');
    const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : undefined;
    const limit = Math.min(Number(c.req.query('limit') ?? 60) || 60, 200);
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
    const result = await listMediaRecords({
      ...(kind ? { kind } : {}),
      ...(c.req.query('agent') ? { agent: c.req.query('agent')! } : {}),
      ...(c.req.query('query') ? { query: c.req.query('query')! } : {}),
      limit,
      offset,
    });
    return c.json({
      total: result.total,
      offset,
      items: result.items,
      totalBytes: await imageTotalBytes(),
    });
  });

  app.get('/media/:id', async (c) => {
    const record = await readMediaRecord(c.req.param('id'));
    if (!record) return c.json({ error: 'not found' }, 404);
    return c.json(record);
  });

  /** The bytes. `?download=1` forces a save dialog for any type. */
  app.get('/media/:id/file', async (c) => serveMediaFile(c, 'file'));
  /** A video's still, cut on first request when the provider served none. 404 when that fails. */
  app.get('/media/:id/thumb', async (c) => serveMediaFile(c, 'thumb'));

  async function serveMediaFile(c: Context, which: 'file' | 'thumb'): Promise<Response> {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'missing id' }, 400);
    const found = await readMediaRecord(id);
    if (!found) return c.json({ error: 'not found' }, 404);
    // A video without a still gets one cut the first time it is shown.
    const record = which === 'thumb' ? await ensureVideoStill(found, config) : found;
    const path = which === 'thumb' ? record.thumbPath : record.path;
    const mime = which === 'thumb' ? (record.thumbMime ?? 'image/webp') : record.mime;
    if (!path) return c.json({ error: 'no thumbnail for this item' }, 404);
    if (!existsSync(path)) {
      return c.json({ error: 'file missing on disk', path }, 410);
    }
    const st = await statFs(path);
    const asAttachment = c.req.query('download') === '1';
    const filename = which === 'thumb' ? `${record.filename}.thumb` : record.filename;
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Content-Disposition': `${asAttachment ? 'attachment' : 'inline'}; filename="${encodeURIComponent(filename)}"`,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      // Records are immutable once written; a re-render gets a new id.
      'Cache-Control': 'private, max-age=31536000, immutable',
    };

    // Range matters here in a way it never did for images: a browser
    // seeking inside a video sends it, and without support every scrub
    // re-downloads the file.
    const { createReadStream } = await import('node:fs');
    const { Readable } = await import('node:stream');
    const rangeHeader = c.req.header('range');
    const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
    if (match && st.size > 0) {
      const startRaw = match[1];
      const endRaw = match[2];
      let start: number;
      let end: number;
      if (startRaw) {
        start = Number(startRaw);
        end = endRaw ? Number(endRaw) : st.size - 1;
      } else if (endRaw) {
        start = Math.max(0, st.size - Number(endRaw));
        end = st.size - 1;
      } else {
        start = 0;
        end = st.size - 1;
      }
      end = Math.min(end, st.size - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${st.size}`, 'accept-ranges': 'bytes' },
        });
      }
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(st.size) },
    });
  }

  app.delete('/media/:id', async (c) => {
    const ok = await deleteMediaRecord(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });
}
