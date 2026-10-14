// Moved unchanged from src/server/index.ts, which calls registerBrowserRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`; browserService, screencasts are read from it
// per request (index.ts sets them up later or changes them).

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { watchBrowserSnapshots } from '../../browser/change-stream.ts';
import { type ViewerSocket, applyViewerInput, isBrowserOpError } from '../../browser/screencast.ts';
import { BrowserOpError, getBrowserService, processIdOf } from '../../browser/service.ts';
import { loadPersona } from '../../persona/loader.ts';
import { type BrowserOp, runBrowserOp } from '../../tools/browser/ops.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { streamSSEH2Safe } from '../sse-h2-safe.ts';
import { startSseHeartbeat } from '../sse-liveness.ts';
import { upgradeWebSocket } from '@hono/node-server';

export interface BrowserRoutesDeps {
  TERMINAL_WS_DEAD_MS: typeof Server.TERMINAL_WS_DEAD_MS;
  TERMINAL_WS_PING_MS: typeof Server.TERMINAL_WS_PING_MS;
  readonly browserService: typeof Server.browserService;
  readonly screencasts: typeof Server.screencasts;
}

export function registerBrowserRoutes(app: Hono, routeDeps: BrowserRoutesDeps): void {
  const { TERMINAL_WS_DEAD_MS, TERMINAL_WS_PING_MS } = routeDeps;
  app.post('/browser/op', async (c) => {
    if (!config.browser.enabled) return c.json({ error: 'browser.enabled is false' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { agent?: unknown; session?: unknown; input?: unknown };
    const agent = typeof body.agent === 'string' ? body.agent : '';
    if (!agent || !(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const input = body.input as BrowserOp | undefined;
    if (!input || typeof input !== 'object' || typeof (input as { op?: unknown }).op !== 'string') {
      return c.json({ error: '"input" with an "op" is required' }, 400);
    }
    const session = typeof body.session === 'string' ? body.session : undefined;
    const result = await runBrowserOp({ agent, ...(session ? { session } : {}), config }, input);
    return c.json(result);
  });

  app.get('/browser/status', async (c) => {
    if (!config.browser.enabled) return c.json({ enabled: false, browsers: [], warnings: [] });
    const svc = getBrowserService();
    const browsers = await svc.listAll();
    return c.json({ enabled: true, headed: svc.headedPlan().mode, browsers, warnings: svc.warnings() });
  });

  // Authoritative snapshots restore pending handoffs on every reconnect.
  app.get('/browser/stream', (c) => streamSSEH2Safe(c, async (stream) => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    let stopped = false;
    let unwatch = () => {};
    let stopHeartbeat = () => {};
    const close = () => {
      if (stopped) return;
      stopped = true;
      unwatch();
      stopHeartbeat();
      stream.close();
      finish();
    };
    stream.onAbort(close);
    unwatch = watchBrowserSnapshots({
      subscribe: (changed) => getBrowserService().onChange(changed),
      read: async () => ({ enabled: config.browser.enabled, browsers: config.browser.enabled ? await getBrowserService().listAll() : [], warnings: getBrowserService().warnings() }),
      send: async (snapshot) => {
        // Bound stalled writes independently of the heartbeat.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            stream.writeSSE({ event: 'browsers', data: JSON.stringify(snapshot) }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser stream timed out')), config.sse.publishTimeoutMs); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      },
      failed: close,
    });
    stopHeartbeat = startSseHeartbeat(stream, { intervalMs: config.sse.heartbeatMs, deadAfterMs: config.sse.deadAfterMs, onDead: close });
    await done;
  }));

  app.post('/browser/:id/restart', async (c) => {
    if (!config.browser.enabled) return c.json({ error: 'browser.enabled is false' }, 503);
    try {
      await getBrowserService().restartForViewer(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  // `:id` is a view id (`profile:team@ada`); a process id still works
  // while only one agent has a window on it.
  app.post('/browser/:id/control', async (c) => {
    if (!config.browser.enabled) return c.json({ error: 'browser.enabled is false' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown; by?: unknown; handoffId?: unknown };
    if (body.mode !== 'human' && body.mode !== 'agent') return c.json({ error: '"mode" must be "human" or "agent"' }, 400);
    try {
      const control = await getBrowserService().setControl(c.req.param('id'), body.mode, {
        ...(typeof body.by === 'string' ? { by: body.by } : {}),
        ...(typeof body.handoffId === 'string' ? { handoffId: body.handoffId } : {}),
      });
      return c.json({ ok: true, control });
    } catch (err) {
      if (err instanceof BrowserOpError) return c.json({ error: err.message }, err.code === 'BROWSER_NOT_FOUND' ? 404 : 409);
      throw err;
    }
  });

  // Live picture + input for one browser tab (stage 2). Binary frames out
  // (see src/browser/screencast.ts for the wire format), JSON both ways:
  //   server → viewer: ping, ready {browser, tabId}, tabs {browser}, error, notice
  //   viewer → server: pong, input events (mousemove/click/wheel/text/key/resize/back/forward/reload),
  //                    navigate {url}, tab {tabId} (switch what is streamed), newtab, closetab {tabId},
  //                    control {mode:'human'|'agent'}
  // Input is applied only while THIS viewer holds human control.
  interface BrowserWsBag {
    __closed?: boolean;
    __messages?: Promise<void>;
    __queued?: number;
    __hbTimer?: ReturnType<typeof setInterval>;
    __lastSeenAt?: number;
    __viewer?: ViewerSocket;
    __tabId?: string;
    __unsub?: () => void;
    __changeTimer?: ReturnType<typeof setTimeout>;
  }
  app.get(
    '/browser/attach',
    upgradeWebSocket((c) => {
      // `view` is the current parameter; `browser` stays accepted because
      // it is what the query is called on the wire.
      const viewId = c.req.query('view') || c.req.query('browser') || '';
      const processId = processIdOf(viewId);
      const wantTab = c.req.query('tab') || undefined;
      const viewerId = c.req.query('viewer') || `v-${Date.now().toString(36)}`;
      return {
        async onOpen(_evt, ws) {
          if (!config.browser.enabled) {
            ws.close(1008, 'browser.enabled is false');
            return;
          }
          const raw = ws.raw as (BrowserWsBag & { bufferedAmount?: number; terminate?: () => void }) | undefined;
          if (!raw) {
            ws.close(1011, 'no raw socket');
            return;
          }
          const viewer: ViewerSocket = {
            send: (d) => ws.send(d as never),
            close: (code, reason) => ws.close(code, reason),
            buffered: () => raw.bufferedAmount ?? 0,
          };
          raw.__viewer = viewer;
          try {
            const { tabId } = await routeDeps.screencasts.attach(viewId, wantTab, viewer);
            raw.__tabId = tabId;
            if (raw.__closed) { routeDeps.screencasts.detach(viewId, tabId, viewer); return; }
            const info = await routeDeps.browserService.browserInfo(viewId);
            if (raw.__closed) { routeDeps.screencasts.detach(viewId, tabId, viewer); return; }
            ws.send(JSON.stringify({ type: 'ready', browser: info, tabId, viewerId }));
          } catch (err) {
            ws.close(1008, isBrowserOpError(err) ? err.message : String(err));
            return;
          }
          // Tabs / control changes → push the fresh summary (debounced).
          // onChange carries the PROCESS id: every window on it redraws.
          raw.__unsub = routeDeps.browserService.onChange((id) => {
            if (id !== processId) return;
            if (raw.__changeTimer) clearTimeout(raw.__changeTimer);
            raw.__changeTimer = setTimeout(() => {
              void routeDeps.browserService
                .browserInfo(viewId)
                .then((info) => ws.send(JSON.stringify({ type: 'tabs', browser: info })))
                .catch(() => ws.close(4001, 'browser closed'));
            }, 100);
          });
          raw.__lastSeenAt = Date.now();
          raw.__hbTimer = setInterval(() => {
            const idle = Date.now() - (raw.__lastSeenAt ?? 0);
            if (idle > TERMINAL_WS_DEAD_MS) {
              try {
                ws.close(4000, 'heartbeat timeout');
              } catch {
                /* ignore */
              }
              try {
                raw.terminate?.();
              } catch {
                /* ignore */
              }
              return;
            }
            try {
              ws.send('{"type":"ping"}');
            } catch {
              /* closed */
            }
          }, TERMINAL_WS_PING_MS);
          logger.info({ msg: 'browser.viewer_attached', browser: viewId, tab: raw.__tabId, viewer: viewerId });
        },
        async onMessage(evt, ws) {
          const raw = ws.raw as BrowserWsBag | undefined;
          if (!raw || raw.__closed) return;
          raw.__lastSeenAt = Date.now();
          if (typeof evt.data !== 'string') return;
          if (Buffer.byteLength(evt.data, 'utf8') > 64 * 1024) { ws.close(1009, 'input too large'); return; }
          let msg: { type?: string; [k: string]: unknown };
          try {
            msg = JSON.parse(evt.data) as typeof msg;
          } catch {
            return;
          }
          if (msg.type === 'pong' || typeof msg.type !== 'string') return;
          if ((raw.__queued ?? 0) >= 64) { ws.close(1008, 'too many pending inputs'); return; }
          raw.__queued = (raw.__queued ?? 0) + 1;
          const previous = raw.__messages ?? Promise.resolve();
          const work = previous.catch(() => {}).then(async () => {
            if (raw.__closed) return;
            const reply = (m: Record<string, unknown>) => {
              try {
                ws.send(JSON.stringify(m));
              } catch {
                /* closed */
              }
            };
            try {
              if (msg.type === 'control') {
                if (msg.mode !== 'human' && msg.mode !== 'agent') throw new Error('invalid control mode');
                const mode = msg.mode;
                const control = await routeDeps.browserService.setControl(viewId, mode, { by: viewerId, ...(typeof msg.handoffId === 'string' ? { handoffId: msg.handoffId } : {}) });
                reply({ type: 'control', control });
                return;
              }
              if (msg.type === 'tab' && typeof msg.tabId === 'string') {
                // Switch the streamed tab: detach from the old hub, attach to the new.
                const viewer = raw.__viewer!;
                if (raw.__tabId) routeDeps.screencasts.detach(viewId, raw.__tabId, viewer);
                const { tabId } = await routeDeps.screencasts.attach(viewId, msg.tabId, viewer);
                raw.__tabId = tabId;
                if (raw.__closed) { routeDeps.screencasts.detach(viewId, tabId, viewer); return; }
                reply({ type: 'ready', browser: await routeDeps.browserService.browserInfo(viewId), tabId, viewerId });
                return;
              }
              await routeDeps.browserService.withBrowserLock(viewId, async () => {
                if (raw.__closed) return;
                if (!routeDeps.browserService.humanControls(viewId, viewerId)) {
                  reply({ type: 'notice', text: 'Take over the browser first ("Take over") to click, type or navigate.' });
                  return;
                }
                if (msg.type === 'navigate' && typeof msg.url === 'string' && raw.__tabId) {
                  await routeDeps.browserService.humanNavigate(viewId, raw.__tabId, msg.url);
                  return;
                }
                if (msg.type === 'newtab') {
                  const tabId = await routeDeps.browserService.humanNewTab(viewId, viewerId);
                  const viewer = raw.__viewer!;
                  if (raw.__tabId) routeDeps.screencasts.detach(viewId, raw.__tabId, viewer);
                  await routeDeps.screencasts.attach(viewId, tabId, viewer);
                  raw.__tabId = tabId;
                  if (raw.__closed) { routeDeps.screencasts.detach(viewId, tabId, viewer); return; }
                  reply({ type: 'ready', browser: await routeDeps.browserService.browserInfo(viewId), tabId, viewerId });
                  return;
                }
                if (msg.type === 'closetab' && typeof msg.tabId === 'string') {
                  await routeDeps.browserService.humanCloseTab(viewId, msg.tabId);
                  return;
                }
                if (!raw.__tabId) return;
                const { page, generation } = routeDeps.browserService.viewerPage(viewId, raw.__tabId);
                if (msg.frameTab !== raw.__tabId || msg.generation !== generation) {
                  reply({ type: 'notice', text: 'The page changed — wait for a fresh picture before acting.' });
                  return;
                }
                const hub = await routeDeps.screencasts.attach(viewId, raw.__tabId, raw.__viewer!);
                routeDeps.browserService.markHumanActivity(viewId, msg.type!);
                const notice = await applyViewerInput(page, hub.hub.session, msg as { type: string });
                if (notice) reply({ type: 'notice', text: notice });
              });
            } catch (err) {
              reply({ type: 'error', text: isBrowserOpError(err) ? err.message : (err as Error).message.split('\n')[0] });
            }
          });
          raw.__messages = work;
          try { await work; } finally { raw.__queued = (raw.__queued ?? 1) - 1; }
        },
        onClose(_evt, ws) {
          const raw = ws.raw as BrowserWsBag | undefined;
          if (!raw) return;
          raw.__closed = true;
          if (raw.__hbTimer) clearInterval(raw.__hbTimer);
          if (raw.__changeTimer) clearTimeout(raw.__changeTimer);
          raw.__unsub?.();
          if (raw.__viewer && raw.__tabId) routeDeps.screencasts.detach(viewId, raw.__tabId, raw.__viewer);
          logger.info({ msg: 'browser.viewer_detached', browser: viewId, tab: raw.__tabId ?? null });
        },
      };
    }),
  );
}
