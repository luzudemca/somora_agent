// Moved unchanged from src/server/index.ts, which calls registerFilesRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `d`.

import type { Hono } from 'hono';
import { detectMimeFromPath } from '../../multimodal/mime.ts';
import { checkReadAllowed, expandHome, realpathSafeAncestor } from '../../tools/file/policy.ts';
import { readFile as readFileFs, stat as statFs } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

export function registerFilesRoutes(app: Hono): void {
  // FileView: read-only viewer for filesystem artefacts that agents
  // reference by absolute path in chat messages (feedback reports, logs,
  // generated docs, ...). Returns the file contents + a coarse `kind`
  // hint the web client uses to pick a renderer (markdown / text /
  // code). Policy is reused 1:1 from file_read — what the agent can read,
  // the user can view in the FileView window.
  //
  // Web-only concept: TUI users see the raw path in chat output and use
  // `cat`/`less` directly; the link rewrite that opens this endpoint
  // lives in the web client's Markdown renderer.
  const FILEVIEW_HARD_CAP = 200_000; // chars, mirrors file_read
  // Media and everything else are classified from the BYTES (see
  // FILEVIEW media branch below); this table only decides how a TEXT file
  // is highlighted. `.svg` is deliberately listed as code rather than as
  // an image: it is markup that can carry script, and the safe way to
  // show it is as its own source plus a download button.
  const FILEVIEW_EXT_KIND: Record<string, 'markdown' | 'text' | 'code'> = {
    '.svg': 'code',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.txt': 'text',
    '.log': 'text',
    '.json': 'code',
    '.jsonl': 'code',
    '.yaml': 'code',
    '.yml': 'code',
    '.toml': 'code',
  };

  app.get('/files/view', async (c) => {
    const raw = c.req.query('path');
    if (typeof raw !== 'string' || raw.length === 0) {
      return c.json({ error: 'missing path query' }, 400);
    }
    // Web only sends absolute paths emitted by agents (e.g.
    // `/home/<user>/somoraworkspace/...`). Relative paths have no
    // meaning here — there is no agent-context cwd to resolve them
    // against.
    const expanded = expandHome(raw);
    if (!isAbsolute(expanded)) {
      return c.json({ error: 'path must be absolute' }, 400);
    }
    const absolute = normalize(expanded);
    // Two-pass policy check matches file_read: raw path first, then
    // realpath of the closest existing ancestor so a symlink can't
    // escape a blocked root.
    const policy = checkReadAllowed(absolute);
    if (!policy.ok) {
      return c.json({ error: policy.reason }, 403);
    }
    const real = await realpathSafeAncestor(absolute);
    const policyReal = checkReadAllowed(real);
    if (!policyReal.ok) {
      return c.json({ error: policyReal.reason }, 403);
    }
    // Stat first to give a clean 404 before reading; also rejects
    // directories with a meaningful message.
    let st: Awaited<ReturnType<typeof statFs>>;
    try {
      st = await statFs(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'file not found' }, 404);
      }
      throw err;
    }
    if (st.isDirectory()) {
      return c.json({ error: 'path is a directory' }, 400);
    }
    if (!st.isFile()) {
      return c.json({ error: 'path is not a regular file' }, 400);
    }
    const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase();
    let kind = FILEVIEW_EXT_KIND[ext] ?? null;
    if (!kind) {
      // Not a known text extension — ask the bytes what this is. Anything
      // that isn't text gets described rather than returned: the client
      // renders it from /files/raw, which can stream and seek. Nothing is
      // refused outright any more, because "here is the name, the size
      // and a download button" beats a 415 for a file the user can see
      // sitting in their workspace.
      const detected = await detectMimeFromPath(absolute);
      if (detected.kind !== 'text') {
        const mediaKind =
          detected.kind === 'image' || detected.kind === 'video' ||
          detected.kind === 'audio' || detected.kind === 'pdf'
            ? detected.kind
            : 'binary';
        return c.json({
          path: absolute,
          kind: mediaKind,
          ext,
          bytes: st.size,
          mime: detected.mimeType,
          url: `/files/raw?path=${encodeURIComponent(absolute)}`,
          downloadUrl: `/files/raw?download=1&path=${encodeURIComponent(absolute)}`,
        });
      }
      kind = 'text';
    }
    const buf = await readFileFs(absolute);
    let content = buf.toString('utf8');
    let truncated = false;
    let truncatedReason: string | undefined;
    if (content.length > FILEVIEW_HARD_CAP) {
      content = content.slice(0, FILEVIEW_HARD_CAP) + '\n[…content truncated at 200k chars]';
      truncated = true;
      truncatedReason = `byte cap (${FILEVIEW_HARD_CAP} chars)`;
    }
    return c.json({
      path: absolute,
      kind,
      ext,
      bytes: st.size,
      content,
      truncated,
      downloadUrl: `/files/raw?download=1&path=${encodeURIComponent(absolute)}`,
      ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
    });
  });

  // Raw bytes for the FileView. Split from /files/view because the two
  // answer different questions: that route says WHAT a file is, this one
  // hands over the bytes. Same policy, same two passes — what an agent
  // may read, the user may view.
  //
  // Range requests are not optional here. A browser seeking inside a
  // video issues them, and an endpoint that ignores Range makes seeking
  // either fail or re-download the whole file per scrub.
  //
  // Every file type is downloadable, including the ones the viewer cannot
  // render: `?download=1` forces the attachment disposition. Inline
  // display is limited to media types — anything else would let a crafted
  // file execute on somora's own origin.
  const FILEVIEW_INLINE_KINDS = new Set(['image', 'video', 'audio', 'pdf']);

  app.get('/files/raw', async (c) => {
    const raw = c.req.query('path');
    if (typeof raw !== 'string' || raw.length === 0) {
      return c.json({ error: 'missing path query' }, 400);
    }
    const expanded = expandHome(raw);
    if (!isAbsolute(expanded)) {
      return c.json({ error: 'path must be absolute' }, 400);
    }
    const absolute = normalize(expanded);
    const policy = checkReadAllowed(absolute);
    if (!policy.ok) return c.json({ error: policy.reason }, 403);
    const real = await realpathSafeAncestor(absolute);
    const policyReal = checkReadAllowed(real);
    if (!policyReal.ok) return c.json({ error: policyReal.reason }, 403);

    let st: Awaited<ReturnType<typeof statFs>>;
    try {
      st = await statFs(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'file not found' }, 404);
      }
      throw err;
    }
    if (!st.isFile()) return c.json({ error: 'path is not a regular file' }, 400);

    const detected = await detectMimeFromPath(absolute);
    const download = c.req.query('download') === '1';
    const inline = !download && FILEVIEW_INLINE_KINDS.has(detected.kind);
    const filename = absolute.slice(absolute.lastIndexOf('/') + 1);
    const headers: Record<string, string> = {
      'content-type': detected.mimeType,
      // The type is declared from the bytes; never let a browser second-
      // guess it into something executable.
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=60',
    };

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
        // `bytes=-500` means the LAST 500 bytes, not "up to 500".
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
      const stream = Readable.toWeb(createReadStream(absolute, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          ...headers,
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'content-length': String(end - start + 1),
        },
      });
    }

    const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: { ...headers, 'content-length': String(st.size) },
    });
  });
}
