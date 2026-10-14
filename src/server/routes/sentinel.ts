// Moved unchanged from src/server/index.ts, which calls registerSentinelRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import * as sentinelSchedule from '../../sentinel/schedule.ts';
import * as sentinelScheduler from '../../sentinel/scheduler.ts';
import * as sentinelStore from '../../sentinel/store.ts';
import { dryRunCheck } from '../../sentinel/check-dry-run.ts';
import { config } from '../server-state.ts';

export function registerSentinelRoutes(app: Hono): void {
  // ─────────────────────────────────────────────────────────────────────
  // Sentinel — proactive trigger management for the web-UI sentinel tab.
  // All actions reuse the in-process sentinel store + scheduler (no extra
  // HTTP roundtrip). The same surface is also exposed through the
  // `sentinel` tool that agents can call.
  // ─────────────────────────────────────────────────────────────────────

  app.get('/sentinel/triggers', async (c) => {
    await sentinelStore.loadTriggers();
    const owner = c.req.query('owner');
    const status = c.req.query('status');
    let triggers = sentinelStore.listTriggers();
    if (owner) triggers = triggers.filter((t) => t.ownerAgent === owner);
    if (status) triggers = triggers.filter((t) => t.status === status);
    triggers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c.json({ count: triggers.length, triggers });
  });

  app.get('/sentinel/triggers/:id', async (c) => {
    await sentinelStore.loadTriggers();
    const t = sentinelStore.getTrigger(c.req.param('id'));
    if (!t) return c.json({ error: `trigger '${c.req.param('id')}' not found` }, 404);
    return c.json({ trigger: t });
  });

  app.get('/sentinel/triggers/:id/history', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
    await sentinelStore.loadTriggers();
    if (!sentinelStore.getTrigger(c.req.param('id'))) return c.json({ error: 'trigger not found' }, 404);
    const entries = await sentinelStore.getHistory(c.req.param('id'), limit);
    return c.json({ count: entries.length, entries });
  });

  app.post('/sentinel/triggers/:id/pause', async (c) => {
    await sentinelStore.loadTriggers();
    const t = sentinelStore.getTrigger(c.req.param('id'));
    if (!t) return c.json({ error: `trigger '${c.req.param('id')}' not found` }, 404);
    await sentinelStore.saveTrigger({ ...t, status: 'paused', statusReason: 'paused via web-UI' });
    sentinelScheduler.reschedule();
    return c.json({ ok: true });
  });

  app.post('/sentinel/triggers/:id/resume', async (c) => {
    await sentinelStore.loadTriggers();
    const t = sentinelStore.getTrigger(c.req.param('id'));
    if (!t) return c.json({ error: `trigger '${c.req.param('id')}' not found` }, 404);
    // Recompute nextFireAt; old one may have drifted past while paused.
    let nextFireAt: string | undefined;
    if (t.source.type === 'time') {
      try {
        const next = sentinelSchedule.computeNextFire(t.source.spec);
        if (next) nextFireAt = next.toISOString();
      } catch (err) {
        return c.json({ error: `cannot resume: ${(err as Error).message}` }, 400);
      }
    }
    const updated = {
      ...t,
      status: 'active' as const,
      errorStreak: 0,
      ...(nextFireAt ? { nextFireAt } : {}),
    };
    delete updated.statusReason;
    await sentinelStore.saveTrigger(updated);
    sentinelScheduler.reschedule();
    return c.json({ ok: true });
  });

  app.delete('/sentinel/triggers/:id', async (c) => {
    const removed = await sentinelStore.deleteTrigger(c.req.param('id'));
    if (removed) sentinelScheduler.reschedule();
    return removed ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.post('/sentinel/triggers/:id/test', async (c) => {
    await sentinelStore.loadTriggers();
    const t = sentinelStore.getTrigger(c.req.param('id'));
    if (!t) return c.json({ error: `trigger '${c.req.param('id')}' not found` }, 404);
    if (t.source.type === 'check') {
      // A check trigger's test runs its script once (a dry run): nothing
      // saved, nobody woken, its state folder untouched.
      const { sha: _sha, ...report } = await dryRunCheck({ agent: t.dispatch.agent, source: t.source, evaluator: t.evaluator ?? { type: 'ready' }, config, installed: t });
      return c.json({ ok: report.ok, dryRun: report });
    }
    await sentinelScheduler.fireTrigger(t, { catchUp: false, testMode: true });
    return c.json({ ok: true, hint: `Test-fire dispatched. See history + the target agent's session '${t.dispatch.session}'.` });
  });

  app.get('/sentinel/status', (c) => {
    return c.json(sentinelScheduler.schedulerStatus());
  });
}
