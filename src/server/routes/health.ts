// Moved unchanged from src/server/index.ts, which calls registerHealthRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { getEmbedderStatus } from '../../memory/embeddings.ts';
import { sharedIndexStatus } from '../../memory/registry.ts';
import { credentialSyncStatus } from '../claude-credential-sync.ts';
import { readLockfile } from '../lockfile.ts';
import { listAllSessionLockStates, listSessionWaiters } from '../session-queue.ts';
import { getWork } from '../work-ledger.ts';

export interface HealthRoutesDeps {
  lastEngineEventAt: typeof Server.lastEngineEventAt;
  lastPublishOkAt: typeof Server.lastPublishOkAt;
  streamKey: typeof Server.streamKey;
  streams: typeof Server.streams;
}

export function registerHealthRoutes(app: Hono, routeDeps: HealthRoutesDeps): void {
  const { lastEngineEventAt, lastPublishOkAt, streamKey, streams } = routeDeps;
  app.get('/healthz', (c) => c.text('ok'));

  // Server startup wall-clock — used by /health to compute uptime.
  const SERVER_BOOTED_AT = Date.now();

  // Diagnostic endpoint. Read-only snapshot of per-session lock state +
  // queue depth + last SSE/engine event timestamp. Designed for the
  // "morning incident" scenario where a single session has wedged: a
  // curl against /health shows which (agent,session) is busy, for how
  // long, when its last engine event arrived, and how many turns are
  // queued behind it — no restart needed to diagnose.
  app.get('/health', (c) => {
    const now = Date.now();
    const lockfile = readLockfile();
    const sessions = listAllSessionLockStates().map((s) => {
      const key = streamKey(s.agent, s.session);
      const lastEvent = lastEngineEventAt.get(key);
      const lastOk = lastPublishOkAt.get(key);
      const subCount = streams.get(key)?.size ?? 0;
      return {
        agent: s.agent,
        session: s.session,
        busy: s.busy,
        activePriority: s.activePriority,
        activeSince: s.activeSince,
        activeAgeMs: s.activeSince ? now - s.activeSince : null,
        activeCallId: s.activeCallId ?? null,
        activeTurnId: s.activeTurnId ?? null,
        queueLength: s.queueLength,
        userWaiting: s.userWaiting,
        agentWaiting: s.agentWaiting,
        // Phase 2: the waiters by name — id, origin kind, a text preview.
        queued: listSessionWaiters(s.agent, s.session).map((w) => {
          const it = w.workId ? getWork(w.workId) : undefined;
          return {
            id: w.workId ?? w.turnId ?? null,
            kind: it?.origin.kind ?? (w.priority === 'user' ? 'human' : 'agent'),
            preview: it?.preview ?? '',
            enqueuedAt: w.enqueuedAt,
            position: w.position,
          };
        }),
        lastEngineEventAt: lastEvent ?? null,
        lastEngineEventAgoMs: lastEvent ? now - lastEvent : null,
        // SSE-broadcast diagnostics (added 2026-05-19). Helps spot a wedged
        // subscriber pattern at a glance: subscriberCount > 0 but
        // lastPublishOkAgoMs growing without bound = at least one stuck
        // client. After the publish() timeout fix, this auto-heals; the
        // counters are the canary that signals it's happening.
        subscriberCount: subCount,
        lastPublishOkAt: lastOk ?? null,
        lastPublishOkAgoMs: lastOk ? now - lastOk : null,
      };
    });
    const busySessions = sessions.filter((s) => s.busy);
    return c.json({
      ok: true,
      serverPid: process.pid,
      serverBootedAt: SERVER_BOOTED_AT,
      serverUptimeMs: now - SERVER_BOOTED_AT,
      lockfilePid: lockfile?.pid ?? null,
      lockfileStartedAt: lockfile?.startedAt ?? null,
      activeSessions: busySessions.length,
      totalKnownSessions: sessions.length,
      // Shared-login credential sync (claude-cli). `identical: false` with
      // both sides present means the stores have diverged and the watcher
      // hasn't caught up — if that state persists, auth is about to break.
      // Expiry values only, never token material.
      claudeAuth: credentialSyncStatus(),
      // Embedding model health. `state: "failed"` means every agent's memory
      // retrieval is FTS-only (BM25 without vectors) — the server keeps
      // running, but semantic recall and REM dedup are silently degraded.
      memoryEmbedder: getEmbedderStatus(),
      // Shared vault/wiki index (one per instance). `state: "building"`
      // right after an update means agents still read vault/wiki from
      // their own DB; `ready` means they read from index/shared.db.
      sharedIndex: sharedIndexStatus(),
      sessions,
    });
  });
}
