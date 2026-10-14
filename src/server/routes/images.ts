// Moved unchanged from src/server/index.ts, which calls registerImageRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import { ImageGenError, generateImage } from '../../imagegen/generate.ts';
import { referenceFromBase64 } from '../../imagegen/references.ts';
import { listCatalogModels as listImageCatalogModels, resolveCapabilities as resolveImageCapabilities } from '../../media/capabilities.ts';
import { deleteRecord as deleteMediaRecord, totalBytes as imageTotalBytes, listRecords as listMediaRecords, readRecord as readMediaRecord } from '../../media/records.ts';
import { expandHome } from '../../tools/file/policy.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { existsSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';

export function registerImageRoutes(app: Hono): void {
  // ─────────────────────────────────────────────────────────────────────
  // Image generation
  //
  // Same core the `image_generate` tool uses (src/imagegen/), so the web
  // app and the agents cannot end up with different capabilities.
  //
  // Files are served by RECORD ID, never by path. The client has no way
  // to ask for an arbitrary file: the id is looked up in the metadata
  // store and the path comes from there. That's what lets the images
  // directory be user-chosen without turning this route into a way to
  // read anything on the disk.
  // ─────────────────────────────────────────────────────────────────────

  function imageGenReady(): { ok: boolean; reason?: string } {
    const cfg = config.imageGen;
    if (!cfg?.enabled) return { ok: false, reason: 'imageGen not enabled in config.yaml' };
    if (cfg.models.length === 0) return { ok: false, reason: 'no models under imageGen.models' };
    return { ok: true };
  }

  /** Drives the desktop tile's visibility, like /wiki/status does for the
   *  wiki. A tile that opens a window which can only say "not configured"
   *  is worse than no tile. */
  app.get('/images/status', (c) => {
    const ready = imageGenReady();
    if (!ready.ok) return c.json({ enabled: false });
    const cfg = config.imageGen!;
    return c.json({
      enabled: true,
      outputDir: expandHome(cfg.outputDir),
      maxImagesPerTurn: cfg.maxImagesPerTurn,
      models: cfg.models.map((m) => ({
        name: m.name,
        label: m.label ?? m.name,
        model: m.model,
        provider: m.provider,
        defaults: m.defaults,
      })),
    });
  });

  /** Per-model spec vocabulary for the form. Fields the catalog doesn't
   *  pin down come back as null, and the UI then offers a free-text input
   *  rather than an empty dropdown — unknown must not read as "nothing
   *  allowed". */
  app.get('/images/models/:name/capabilities', async (c) => {
    const ready = imageGenReady();
    if (!ready.ok) return c.json({ error: ready.reason }, 503);
    const name = c.req.param('name');
    const entry = config.imageGen!.models.find((m) => m.name === name);
    if (!entry) return c.json({ error: `unknown image model '${name}'` }, 404);
    const provider = config.providers[entry.provider];
    if (!provider || provider.engine !== 'openai-compatible') {
      return c.json({ error: `provider '${entry.provider}' is not openai-compatible` }, 500);
    }
    const caps = await resolveImageCapabilities(entry.provider, provider, entry);
    return c.json({
      model: entry.name,
      source: caps.source,
      known: caps.known,
      values: caps.values,
      // Suggestions for fields the model does NOT restrict, kept apart
      // from `values` on purpose: the client renders these as a datalist,
      // so they guide without forbidding anything else.
      recommended: caps.recommended ?? null,
      // null ⇒ unknown, and the client should offer every field as free
      // input. A list ⇒ authoritative, and anything not in it is a field
      // this model does not take.
      supported: caps.supported ?? null,
      maxN: caps.maxN ?? null,
      maxReferences: caps.maxReferences ?? null,
      // Named ratios the endpoint takes in `size` — what the OpenAI-wire
      // aspect_ratio → size translation keys on (imagegen.md).
      sizeAlsoAccepts: caps.sizeAlsoAccepts ?? null,
      defaults: entry.defaults,
    });
  });

  /** What the provider offers, so configuring a new model doesn't mean
   *  hunting for the exact wire id on a website. Read-only: config stays
   *  the source of truth for what somora will actually call. */
  app.get('/images/catalog', async (c) => {
    const ready = imageGenReady();
    if (!ready.ok) return c.json({ error: ready.reason }, 503);
    const providerName = c.req.query('provider') ?? config.imageGen!.models[0]?.provider;
    const provider = providerName ? config.providers[providerName] : undefined;
    if (!provider || provider.engine !== 'openai-compatible') {
      return c.json({ error: `unknown or incompatible provider '${providerName}'` }, 400);
    }
    const endpoint =
      config.imageGen!.models.find((m) => m.provider === providerName)?.capabilitiesEndpoint ??
      '/images/models';
    const models = await listImageCatalogModels(providerName!, provider, endpoint);
    return c.json({ provider: providerName, models });
  });

  app.get('/images', async (c) => {
    const ready = imageGenReady();
    if (!ready.ok) return c.json({ error: ready.reason }, 503);
    const q = c.req.query();
    const limit = Math.min(Number(q.limit) || 60, 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const result = await listMediaRecords({
      ...(q.query ? { query: q.query } : {}),
      ...(q.model ? { model: q.model } : {}),
      ...(q.agent ? { agent: q.agent } : {}),
      ...(q.since ? { since: q.since } : {}),
      ...(q.until ? { until: q.until } : {}),
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

  app.get('/images/:id', async (c) => {
    const record = await readMediaRecord(c.req.param('id'));
    if (!record) return c.json({ error: 'not found' }, 404);
    return c.json(record);
  });

  app.get('/images/:id/file', async (c) => {
    const record = await readMediaRecord(c.req.param('id'));
    if (!record) return c.json({ error: 'not found' }, 404);
    if (!existsSync(record.path)) {
      // The file was moved or deleted outside somora. Say so plainly —
      // a bare 404 reads like a broken gallery.
      return c.json({ error: 'file missing on disk', path: record.path }, 410);
    }
    const bytes = await fsReadFile(record.path);
    // `?download=1` for the gallery's download button. Same route, same
    // record lookup — only the disposition differs, so there is no second
    // way to reach a file and no second place to keep the policy right.
    const asAttachment = c.req.query('download') === '1';
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': record.mime,
        'Content-Disposition': `${asAttachment ? 'attachment' : 'inline'}; filename="${encodeURIComponent(record.filename)}"`,
        // Records are immutable once written; a re-generation gets a new
        // id, so the bytes behind an id never change.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  });

  app.post('/images/generate', async (c) => {
    const ready = imageGenReady();
    if (!ready.ok) return c.json({ error: ready.reason }, 503);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'body must be JSON' }, 400);
    }

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return c.json({ error: 'prompt is required' }, 400);

    const IMAGE_SPEC_KEYS = [
      'resolution',
      'aspect_ratio',
      'size',
      'quality',
      'output_format',
      'background',
      'output_compression',
      'seed',
      'n',
      'steps',
      'cfg',
      'guidance',
    ];
    const specs: Record<string, unknown> = {};
    for (const key of IMAGE_SPEC_KEYS) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== '') specs[key] = body[key];
    }
    // Provider fields somora has no name for travel in `extra`, exactly as
    // the image_generate tool sends them. Anything else at the top level
    // is reported back rather than dropped without a word.
    if (body.extra !== undefined && (body.extra === null || typeof body.extra !== 'object' || Array.isArray(body.extra))) {
      return c.json({ error: 'extra must be an object of provider fields', kind: 'input' }, 400);
    }
    const extra = body.extra as Record<string, unknown> | undefined;
    const known = new Set(['prompt', 'model', 'reference_images', 'session', 'agent', 'extra', ...IMAGE_SPEC_KEYS]);
    const ignored = Object.keys(body)
      .filter((k) => !known.has(k) && body[k] !== undefined)
      .map((k) => (k === 'save_to' ? 'ignored: save_to — images are kept in the image folder only' : `ignored: ${k} — pass provider-specific fields inside extra`));

    // One image, one place (2026-09-10): the second destination is gone
    // from the tool and from this route. A field that is still sent by an
    // older client is ignored rather than rejected.
    const saveTo: string | undefined = undefined;

    try {
      const result = await generateImage(
        {
          prompt,
          ...(typeof body.model === 'string' ? { model: body.model } : {}),
          specs: specs as Parameters<typeof generateImage>[0]['specs'],
          ...(extra && Object.keys(extra).length > 0 ? { extra } : {}),
          ...(saveTo ? { saveTo } : {}),
          // The browser has bytes, not a server path — see
          // src/imagegen/references.ts on why the two entrances differ.
          ...(Array.isArray(body.reference_images)
            ? {
                references: body.reference_images
                  .filter((r): r is string => typeof r === 'string')
                  .map((r, i) => referenceFromBase64(r, i)),
              }
            : {}),
          ...(typeof body.session === 'string' ? { session: body.session } : {}),
        },
        config,
      );
      return c.json({
        images: result.images,
        costUsd: result.costUsd ?? null,
        ...(result.warnings || ignored.length > 0 ? { warnings: [...(result.warnings ?? []), ...ignored] } : {}),
        ...(result.fellBackFrom ? { fellBackFrom: result.fellBackFrom } : {}),
      });
    } catch (err) {
      if (err instanceof ImageGenError) {
        // 400 for anything the caller can fix, 502 for an upstream that
        // misbehaved — the UI shows the message either way, but the
        // status tells it whether to blame the form or the provider.
        const status =
          err.kind === 'unavailable' ? 503 : err.kind === 'upstream' ? 502 : 400;
        return c.json({ error: err.message, kind: err.kind }, status);
      }
      logger.error({ msg: 'images.generate_failed', err: (err as Error).message });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.delete('/images/:id', async (c) => {
    const id = c.req.param('id');
    const record = await readMediaRecord(id);
    if (!record) return c.json({ error: 'not found' }, 404);
    // Only the metadata goes; the file stays. Deleting user files from a
    // gallery button is not something to do on one click, and hardlinks
    // mean somora couldn't reliably reach every name for it anyway.
    const ok = await deleteMediaRecord(id);
    return c.json({ ok, path: record.path, fileKept: true });
  });
}
