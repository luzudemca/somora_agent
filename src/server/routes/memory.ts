// Moved unchanged from src/server/index.ts, which calls registerMemoryRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `d`.

import type { Hono } from 'hono';
import { injectMemoryContext } from '../../memory/inject.ts';
import { getMemoryManager } from '../../memory/registry.ts';
import { loadPersona } from '../../persona/loader.ts';
import type { NormalizedEvent } from '../../types/events.ts';
import { config } from '../server-state.ts';

export function registerMemoryRoutes(app: Hono): void {
  // Memory inspection endpoints. Strictly read-only, useful for debugging
  // what's actually in a given agent's memory index without having to chat.
  //   GET  /agents/:agent/memory/notes               — list indexed memory notes
  //   GET  /agents/:agent/memory/search?q=…&limit=&minScore=
  //                                                  — run hybrid retrieval, see hits
  app.get('/agents/:agent/memory/notes', async (c) => {
    const agent = c.req.param('agent');
    if (!(await loadPersona(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const mgr = await getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian });
    const notes = await mgr.listNotes();
    return c.json({ agent, count: notes.length, notes });
  });

  // What auto-inject WOULD recall for a message in a given conversation
  // state — the exact code path of a turn (buildRecallQuery + search +
  // block budget), minus the turn. Debug/measurement surface: the recall
  // replay harness feeds real session histories through it to compare
  // ranking changes before/after a retrieval change (2026-09-08).
  // Body: { text, history?: [{ kind: 'user_message'|'assistant_message', text }] }
  app.post('/agents/:agent/memory/recall-preview', async (c) => {
    const agent = c.req.param('agent');
    if (!(await loadPersona(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    let body: { text?: unknown; history?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown; history?: unknown };
    } catch {
      return c.json({ error: 'JSON body required' }, 400);
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return c.json({ error: '"text" required' }, 400);
    const history: NormalizedEvent[] = Array.isArray(body.history)
      ? (body.history as Array<{ kind?: unknown; text?: unknown }>)
          .filter((h) => (h.kind === 'user_message' || h.kind === 'assistant_message') && typeof h.text === 'string')
          .map((h) => ({ kind: h.kind as 'user_message' | 'assistant_message', ts: 0, engine: 'preview', text: h.text as string }) as NormalizedEvent)
      : [];
    const mgr = await getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian });
    // Optional per-call override of the autoInject knobs — lets a
    // measurement sweep weights without touching config.yaml or restarting.
    const override = (body as { autoInject?: unknown }).autoInject;
    const cfg = override && typeof override === 'object'
      ? { ...config.memory.autoInject, ...(override as Record<string, unknown>) } as typeof config.memory.autoInject
      : config.memory.autoInject;
    const inject = await injectMemoryContext({ mgr, history, userMessage: text, cfg });
    return c.json({
      agent,
      text,
      historyTurns: history.length,
      injectedCount: inject.injectedCount,
      hits: inject.hits.map((h) => ({
        slug: h.slug,
        source: h.source,
        score: Number(h.score.toFixed(4)),
        vecScore: Number(h.vecScore.toFixed(4)),
        bm25Score: Number(h.bm25Score.toFixed(4)),
        startLine: h.startLine,
        endLine: h.endLine,
      })),
      ephemeralContextChars: inject.ephemeralContext?.length ?? 0,
    });
  });

  app.get('/agents/:agent/memory/search', async (c) => {
    const agent = c.req.param('agent');
    const q = c.req.query('q') ?? '';
    if (!q.trim()) return c.json({ error: 'query parameter "q" required' }, 400);
    if (!(await loadPersona(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }
    const limit = Math.max(1, Math.min(50, Number(c.req.query('limit') ?? '5')));
    const minScoreRaw = Number(c.req.query('minScore') ?? '0');
    const minScore = Number.isFinite(minScoreRaw) ? Math.max(0, Math.min(1, minScoreRaw)) : 0;
    const mgr = await getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian });
    const hits = await mgr.search(q, { limit, minScore });
    return c.json({
      agent,
      query: q,
      limit,
      minScore,
      count: hits.length,
      hits: hits.map((h) => ({
        slug: h.slug,
        source: h.source,
        score: Number(h.score.toFixed(4)),
        vecScore: Number(h.vecScore.toFixed(4)),
        bm25Score: Number(h.bm25Score.toFixed(4)),
        startLine: h.startLine,
        endLine: h.endLine,
        filePath: h.filePath,
        text: h.text,
      })),
    });
  });
}
