// Moved unchanged from src/server/index.ts, which calls registerInboxRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `d`.

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { getFreshConfig } from '../../config/loader.ts';

export interface InboxRoutesDeps {
  checkInboxState: typeof Server.checkInboxState;
  inbox: typeof Server.inbox;
  refreshSubagentDenyCheck: typeof Server.refreshSubagentDenyCheck;
}

export function registerInboxRoutes(app: Hono, d: InboxRoutesDeps): void {
  const { checkInboxState, inbox, refreshSubagentDenyCheck } = d;
  // GET /inbox — what the inbox shows, and how much is unread.
  app.get('/inbox', async (c) => {
    // A config.yaml broken a moment ago shows up here, not 5 minutes later.
    await getFreshConfig().catch(() => undefined);
    await refreshSubagentDenyCheck();
    checkInboxState();
    return c.json({ entries: inbox.list(), unread: inbox.unread(), muted: inbox.muted() });
  });

  // POST /inbox/read {keys?} — mark these (or all) as read.
  app.post('/inbox/read', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { keys?: unknown };
    const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : undefined;
    inbox.markRead(keys);
    return c.json({ ok: true, unread: inbox.unread() });
  });

  // POST /inbox/mute {key, mode} — "don't report again": until the thing
  // resolved once, or forever. POST /inbox/unmute {key} undoes it.
  app.post('/inbox/mute', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown; mode?: unknown };
    const mode = body.mode === 'forever' ? 'forever' : 'until-resolved';
    if (typeof body.key !== 'string' || !inbox.mute(body.key, mode)) return c.json({ error: 'no such inbox entry' }, 404);
    return c.json({ ok: true, unread: inbox.unread() });
  });
  app.post('/inbox/unmute', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
    if (typeof body.key !== 'string' || !inbox.unmute(body.key)) return c.json({ error: 'no such muted entry' }, 404);
    return c.json({ ok: true, unread: inbox.unread() });
  });
}
