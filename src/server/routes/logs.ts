// Moved unchanged from src/server/index.ts, which calls registerLogRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import { readLogSince, readLogTail } from '../logs.ts';

export function registerLogRoutes(app: Hono): void {
  // ── Shared browser (src/browser/service.ts) ───────────────────────
  // The MCP child calls /browser/op; Chromium lives in this process.
  // The web client shares /browser/stream across chat, taskbar and list
  // and sends control/input through its identified viewer WebSocket.
  // Everything a viewer addresses is a VIEW — `<browser id>@<agent>`, one
  // window per agent even when several share a Chromium (design §10).

  // ── Server log (src/server/logs.ts) ───────────────────────────────
  // The log window in /web. Reads only the tail of one day's file, never
  // the whole directory: it holds hundreds of megabytes.

  app.get('/logs', async (c) => {
    const num = (v: string | undefined, d: number | undefined): number | undefined => {
      const n = v === undefined ? NaN : Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const snap = await readLogTail({
      ...(c.req.query('day') ? { day: c.req.query('day')! } : {}),
      ...(c.req.query('agent') ? { agent: c.req.query('agent')! } : {}),
      ...(c.req.query('q') ? { q: c.req.query('q')! } : {}),
      ...(num(c.req.query('minLevel'), undefined) !== undefined ? { minLevel: num(c.req.query('minLevel'), 30)! } : {}),
      ...(num(c.req.query('limit'), undefined) !== undefined ? { limit: num(c.req.query('limit'), 300)! } : {}),
    });
    return c.json(snap);
  });

  app.get('/logs/since', async (c) => {
    const offset = Number(c.req.query('offset') ?? '0');
    const result = await readLogSince(Number.isFinite(offset) ? offset : 0, {
      ...(c.req.query('day') ? { day: c.req.query('day')! } : {}),
      ...(c.req.query('agent') ? { agent: c.req.query('agent')! } : {}),
      ...(c.req.query('q') ? { q: c.req.query('q')! } : {}),
      ...(c.req.query('minLevel') ? { minLevel: Number(c.req.query('minLevel')) } : {}),
    });
    return c.json(result);
  });
}
