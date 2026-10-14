// Moved unchanged from src/server/index.ts, which calls registerAgentRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `d`; nextTurnPrompt are read from it
// per request (index.ts sets them up later or changes them).

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { readPersonaFiles, writePersonaFile } from '../../persona/files.ts';
import { listAgents, loadPersona } from '../../persona/loader.ts';
import { resolveSessionId, sessionMetaStore } from '../../storage/sessions.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';

export interface AgentRoutesDeps {
  readonly nextTurnPrompt: typeof Server.nextTurnPrompt;
}

export function registerAgentRoutes(app: Hono, d: AgentRoutesDeps): void {
  // Verbose-mode helper: returns the persona's compiled system prompt.
  // Used by /verbose system in the TUI to surface what the model is
  // actually seeing as instructions. Static per agent (does not change
  // per turn — ephemeralContext is per-turn and rides on the memory SSE).
  app.get('/agents/:agent/system-prompt', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    return c.json({ agent, systemPrompt: persona.systemPrompt });
  });

  app.get('/agents', async (c) => c.json(await listAgents()));

  // ── Persona files + prompt preview (web Agent window) ───────────────
  // Read the three persona files (+ agent.yaml read-only) with hashes and
  // sizes against config.promptBudgets; write one under an optimistic
  // lock (baseHash) because the agents self-edit these files.
  app.get('/agents/:agent/persona', async (c) => {
    const agent = c.req.param('agent');
    if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const files = await readPersonaFiles(agent);
    const personaChars = files.filter((f) => !f.readOnly).reduce((n, f) => n + f.chars, 0);
    const kind = (await loadPersona(agent))?.kind ?? 'chat';
    return c.json({
      agent,
      kind,
      files,
      budgets: config.promptBudgets,
      totals: { personaChars },
    });
  });

  app.put('/agents/:agent/persona/:file', async (c) => {
    const agent = c.req.param('agent');
    const file = c.req.param('file');
    const body = (await c.req.json().catch(() => null)) as { content?: unknown; baseHash?: unknown } | null;
    if (!body || typeof body.content !== 'string' || typeof body.baseHash !== 'string') {
      return c.json({ error: 'body {content: string, baseHash: string} required' }, 400);
    }
    let r;
    try {
      r = await writePersonaFile(agent, file, body.content, body.baseHash);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (!r.ok) {
      return c.json(
        { error: r.error, ...(r.currentHash ? { currentHash: r.currentHash, currentContent: r.currentContent } : {}) },
        r.status,
      );
    }
    logger.info({ msg: 'persona.saved', agent, file, chars: body.content.length, backup: r.backup });
    return c.json({ ok: true, hash: r.hash, backup: r.backup, chars: body.content.length });
  });

  // The system prompt exactly as the next turn on `session` would send it,
  // split into its parts, plus the tool schemas the agent can see (they
  // travel on the API tool channel, not in this text — but they cost
  // context all the same). Read-only: the wiki snapshot is not persisted.
  app.get('/agents/:agent/prompt-preview', async (c) => {
    const agent = c.req.param('agent');
    const persona = await loadPersona(agent);
    if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
    const sessionRef = c.req.query('session') || 'main';
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const sessionMeta = await sessionMetaStore.get(agent, session);
    const { assembled, available } = await d.nextTurnPrompt(agent, session, persona, sessionMeta);
    const toolSchemaChars = available.reduce(
      (n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.jsonSchema }).length,
      0,
    );
    return c.json({
      agent,
      session,
      text: assembled.text,
      chars: assembled.text.length,
      parts: assembled.parts.map((p) => ({ key: p.key, label: p.label, chars: p.text.length })),
      tools: { count: available.length, schemaChars: toolSchemaChars, names: available.map((t) => t.name) },
      budgets: config.promptBudgets,
      notIncluded: [
        'tool schemas (sent on the API tool channel; counted above, engines load them direct or deferred)',
        'memory recall injected per turn',
        'the conversation history',
        "the engine's own built-in instructions (Claude Code, Codex)",
      ],
    });
  });
}
