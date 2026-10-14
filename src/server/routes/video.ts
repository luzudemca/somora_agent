// Moved unchanged from src/server/index.ts, which calls registerVideoRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import { ImageGenError } from '../../imagegen/generate.ts';
import { VideoGenError, startVideoJob, videoModelCapabilities, videoModelMedia } from '../../videogen/generate.ts';
import { checkSlot as checkVideoSlot, listJobs as listVideoJobs } from '../../videogen/jobs.ts';
import { VideoRequestError, videoRequestFromBody } from '../../videogen/request.ts';
import { config } from '../server-state.ts';

export function registerVideoRoutes(app: Hono): void {
  // ─────────────────────────────────────────────────────────────────────
  // Video jobs. The loop lives here in the main server, so an MCP child
  // reaches it over HTTP rather than starting a loop that would die with
  // the child.
  // ─────────────────────────────────────────────────────────────────────

  function videoGenReady(): { ok: boolean; reason?: string } {
    if (!config.videoGen?.enabled) return { ok: false, reason: 'video generation is not enabled' };
    if ((config.videoGen.models?.length ?? 0) === 0) {
      return { ok: false, reason: 'no video models configured' };
    }
    return { ok: true };
  }

  app.get('/video/status', async (c) => {
    const ready = videoGenReady();
    if (!ready.ok) return c.json({ enabled: false, reason: ready.reason });
    const agent = c.req.query('agent');
    const jobs = await listVideoJobs(agent ? { agent } : {});
    const slot = await checkVideoSlot(config);
    return c.json({
      enabled: true,
      active: slot.active,
      limit: slot.limit,
      models: await Promise.all(
        config.videoGen!.models.map(async (m) => ({
          name: m.name,
          label: m.label ?? m.name,
          model: m.model,
          provider: m.provider,
          wire: m.wire,
          // The input files it takes, so a form can offer the right pickers.
          media: await videoModelMedia(config, m.name),
          // Its parameters as the catalog (or allow.parameters) describes
          // them, so a form can offer a control for each — including a
          // model's own ones somora has no name for.
          params: (await videoModelCapabilities(config, m.name)).params ?? {},
        })),
      ),
      jobs,
    });
  });

  app.post('/video/generate', async (c) => {
    const ready = videoGenReady();
    if (!ready.ok) return c.json({ error: ready.reason }, 503);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let request: ReturnType<typeof videoRequestFromBody>;
    try {
      request = videoRequestFromBody(body);
    } catch (err) {
      if (err instanceof VideoRequestError || err instanceof ImageGenError) {
        return c.json({ error: err.message, kind: 'input' }, 400);
      }
      throw err;
    }

    try {
      const { job: started } = await startVideoJob(request.input, config);
      // Fields this route did not use travel back with the job, the same
      // place the provider's own warnings go.
      const job = request.ignored.length > 0
        ? { ...started, warnings: [...(started.warnings ?? []), ...request.ignored] }
        : started;
      return c.json({ job });
    } catch (err) {
      if (err instanceof VideoGenError) {
        const status =
          err.kind === 'busy' ? 429 : err.kind === 'unavailable' ? 503 : err.kind === 'upstream' ? 502 : 400;
        return c.json({ error: err.message, kind: err.kind }, status);
      }
      throw err;
    }
  });
}
