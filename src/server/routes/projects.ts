// Moved unchanged from src/server/index.ts, which calls registerProjectRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `d`.

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { loadPersona } from '../../persona/loader.ts';
import { focusProject } from '../../projects/focus.ts';
import { validatePathRef } from '../../projects/scheme.ts';
import { listProjects, projectExists, readProject, writeProject } from '../../projects/store.ts';
import { PROJECT_SLUG_RE, ProjectFrontmatterSchema } from '../../projects/types.ts';
import { resolveSessionId, sessionMetaStore } from '../../storage/sessions.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import type { Context } from 'hono';

export interface ProjectRoutesDeps {
  publish: typeof Server.publish;
}

export function registerProjectRoutes(app: Hono, d: ProjectRoutesDeps): void {
  const { publish } = d;
  // ─── Projects API (Phase Projects v1) ───────────────────────────────
  // REST-symmetric to the agent-facing tool surface. Web client uses
  // these; TUI slash-commands could also call them (or use the same
  // in-process focusProject helper directly — same behavior either way).
  //
  // All routes return 503 when `config.projects.enabled` is false so the
  // UI can detect the feature is off without a separate capability probe.

  function requireProjectsEnabled(c: Context): Response | null {
    if (!config.projects?.enabled) {
      return c.json(
        { error: 'projects feature is disabled (config.projects.enabled=false)' },
        503,
      );
    }
    return null;
  }

  // Feature-flag probe. ALWAYS returns 200 — clients use this to decide
  // whether to render project UI surfaces (chip, sessions column, slash
  // commands). The other /projects/* routes return 503 when disabled,
  // which is fine for tools but creates ambiguity at the UI layer
  // ("empty entities array? or feature off?"). One dedicated probe
  // removes the doubt.
  app.get('/projects/feature', async (c) => {
    return c.json({
      enabled: Boolean(config.projects?.enabled),
      entityCount: config.projects?.entities?.length ?? 0,
    });
  });

  app.get('/projects/entities', async (c) => {
    const gate = requireProjectsEnabled(c);
    if (gate) return gate;
    return c.json({ entities: config.projects?.entities ?? [] });
  });

  app.get('/projects', async (c) => {
    const gate = requireProjectsEnabled(c);
    if (gate) return gate;
    const entity = c.req.query('entity');
    const tag = c.req.query('tag');
    const includeArchived = c.req.query('includeArchived') === 'true';
    const all = await listProjects();
    const filtered = all.filter((p) => {
      if (!includeArchived && p.archived) return false;
      if (entity && p.entity !== entity) return false;
      if (tag && !p.tags.includes(tag)) return false;
      return true;
    });
    return c.json({ projects: filtered, total: filtered.length });
  });

  app.get('/projects/:slug', async (c) => {
    const gate = requireProjectsEnabled(c);
    if (gate) return gate;
    const slug = c.req.param('slug');
    if (!PROJECT_SLUG_RE.test(slug)) {
      return c.json({ error: `invalid slug '${slug}'` }, 400);
    }
    const project = await readProject(slug);
    if (!project) return c.json({ error: `project '${slug}' not found` }, 404);
    return c.json({ project });
  });

  app.post('/projects', async (c) => {
    const gate = requireProjectsEnabled(c);
    if (gate) return gate;
    type CreateBody = {
      slug?: string;
      name?: string;
      entity?: string;
      description?: string;
      color?: string;
      tags?: string[];
      expires?: string | null;
      paths?: Array<{ ref: string; label?: string }>;
      workdir?: string;
    };
    const body = (await c.req.json().catch(() => ({}))) as CreateBody;
    if (!body.slug || !body.name || !body.entity) {
      return c.json({ error: 'body fields slug, name, entity are required' }, 400);
    }
    if (!PROJECT_SLUG_RE.test(body.slug)) {
      return c.json({ error: `invalid slug '${body.slug}' — must match [a-z0-9_-]+` }, 400);
    }
    const entities = config.projects?.entities ?? [];
    if (!entities.find((e) => e.slug === body.entity)) {
      return c.json(
        {
          error: `unknown entity '${body.entity}' — available: ${entities.map((e) => e.slug).join(', ') || '(none configured)'}`,
        },
        400,
      );
    }
    if (await projectExists(body.slug)) {
      return c.json({ error: `project '${body.slug}' already exists` }, 409);
    }
    // Validate paths.
    const paths = body.paths ?? [];
    for (const p of paths) {
      const r = validatePathRef(p.ref, config);
      if (!r.ok) return c.json({ error: r.error }, 400);
    }
    const now = new Date().toISOString();
    const project = ProjectFrontmatterSchema.parse({
      slug: body.slug,
      name: body.name,
      entity: body.entity,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      tags: body.tags ?? [],
      created: now,
      updated: now,
      ...(body.expires !== undefined ? { expires: body.expires } : {}),
      archived: false,
      paths,
      ...(typeof body.workdir === 'string' && body.workdir.trim() ? { workdir: body.workdir.trim() } : {}),
    });
    await writeProject(project);
    logger.info({
      msg: 'project.created',
      via: 'http',
      slug: project.slug,
      entity: project.entity,
      pathCount: project.paths.length,
    });
    return c.json({ project }, 201);
  });

  app.patch('/projects/:slug', async (c) => {
    const gate = requireProjectsEnabled(c);
    if (gate) return gate;
    const slug = c.req.param('slug');
    if (!PROJECT_SLUG_RE.test(slug)) {
      return c.json({ error: `invalid slug '${slug}'` }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      ops?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      return c.json({ error: 'body field "ops" must be a non-empty array' }, 400);
    }
    // Delegate to the same applyOps logic used by the tool. We re-import
    // here rather than re-implementing — the projects/tools.ts module
    // doesn't currently export applyOps publicly, so we re-validate via
    // the project_update Zod schema directly. Simpler path: just invoke
    // the registry tool. But we don't have ctx here. Build a minimal
    // one — projects logic only needs config.
    try {
      const current = await readProject(slug);
      if (!current) return c.json({ error: `project '${slug}' not found` }, 404);

      // We mirror the tool's applyOps inline since exporting it would
      // create a circular dep (tools → projects → tools). Keeping the
      // logic in two places is a maintenance smell — if it grows past
      // this we should refactor applyOps into src/projects/. For v1,
      // both versions are tight and obvious.
      const next = { ...current, tags: [...current.tags], paths: current.paths.map((p) => ({ ...p })) };
      for (const opRaw of body.ops) {
        const opName = String(opRaw.op);
        switch (opName) {
          case 'set_field': {
            const field = String(opRaw.field);
            const value = opRaw.value as string | null;
            if (!['name', 'description', 'color', 'expires', 'workdir'].includes(field)) {
              return c.json({ error: `set_field: unknown field '${field}'` }, 400);
            }
            if (field === 'name') {
              if (typeof value !== 'string' || value.trim().length === 0) {
                return c.json({ error: 'set_field name: value must be non-empty string' }, 400);
              }
              next.name = value;
            } else if (field === 'workdir') {
              if (value === null || String(value).trim() === '') delete next.workdir;
              else next.workdir = String(value).trim();
            } else if (field === 'description') {
              if (value === null) delete next.description;
              else next.description = String(value);
            } else if (field === 'color') {
              if (value === null) delete next.color;
              else next.color = String(value);
            } else if (field === 'expires') {
              next.expires = value;
            }
            break;
          }
          case 'add_path': {
            const ref = String(opRaw.ref ?? '');
            const label = opRaw.label as string | undefined;
            const result = validatePathRef(ref, config);
            if (!result.ok) return c.json({ error: `add_path '${ref}': ${result.error}` }, 400);
            if (next.paths.some((p) => p.ref === ref)) {
              return c.json({ error: `add_path: ref '${ref}' already in paths` }, 400);
            }
            next.paths.push({ ref, ...(label ? { label } : {}) });
            break;
          }
          case 'remove_path': {
            const ref = String(opRaw.ref ?? '');
            const idx = next.paths.findIndex((p) => p.ref === ref);
            if (idx < 0) return c.json({ error: `remove_path: no path with ref '${ref}'` }, 400);
            next.paths.splice(idx, 1);
            break;
          }
          case 'set_tags': {
            if (!Array.isArray(opRaw.tags)) {
              return c.json({ error: 'set_tags: tags must be an array' }, 400);
            }
            next.tags = (opRaw.tags as unknown[]).map((t) => String(t));
            break;
          }
          case 'archive': {
            next.archived = true;
            next.archivedAt = new Date().toISOString();
            if (opRaw.reason !== undefined) next.archiveReason = String(opRaw.reason);
            break;
          }
          case 'unarchive': {
            next.archived = false;
            delete next.archivedAt;
            delete next.archiveReason;
            break;
          }
          default:
            return c.json({ error: `unknown op '${opName}'` }, 400);
        }
      }
      next.updated = new Date().toISOString();
      await writeProject(next);
      logger.info({
        msg: 'project.updated',
        via: 'http',
        slug,
        opCount: body.ops.length,
        opTypes: body.ops.map((o) => String(o.op)),
      });
      return c.json({ project: next });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Session-focus routes — read/set/clear the currently-pinned project
  // for an (agent, session) pair. Mirrors the tool path's focusProject
  // helper so behavior is identical. Emits an SSE `project` event to
  // every subscriber of (agent, session) so the UI updates live.

  app.get('/agents/:agent/sessions/:session/project', async (c) => {
    const gate = requireProjectsEnabled(c);
    if (gate) return gate;
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const meta = await sessionMetaStore.get(agent, session);
    const slug = typeof meta.projectSlug === 'string' ? meta.projectSlug : null;
    if (!slug) return c.json({ agent, session, slug: null, project: null });
    const project = await readProject(slug);
    if (!project) {
      // Session pin points at a deleted project; surface honestly.
      return c.json({ agent, session, slug, project: null, missing: true });
    }
    return c.json({ agent, session, slug, project });
  });

  app.post('/agents/:agent/sessions/:session/project', async (c) => {
    const gate = requireProjectsEnabled(c);
    if (gate) return gate;
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string | null };
    // We treat both `{slug:null}` and `{slug:""}` as "clear" so casual
    // clients don't have to be precise. Missing field is rejected — too
    // ambiguous (could be a typo).
    if (!('slug' in body)) {
      return c.json({ error: 'body field "slug" required (string or null)' }, 400);
    }
    const slugIn = body.slug;
    const targetSlug = slugIn && typeof slugIn === 'string' && slugIn.length > 0 ? slugIn : null;
    try {
      const result = await focusProject({
        agent,
        session,
        slug: targetSlug,
        via: 'slash_command',
        metaStore: sessionMetaStore,
      });
      // Live broadcast for any subscribed UI.
      await publish(agent, session, {
        event: 'project',
        data: {
          from: result.previousSlug,
          to: result.currentSlug,
          via: 'slash_command',
        },
      });
      return c.json({ agent, session, ...result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete('/agents/:agent/sessions/:session/project', async (c) => {
    const gate = requireProjectsEnabled(c);
    if (gate) return gate;
    const agent = c.req.param('agent');
    const sessionRef = c.req.param('session');
    if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
    const session = await resolveSessionId(agent, sessionRef);
    if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
    try {
      const result = await focusProject({
        agent,
        session,
        slug: null,
        via: 'slash_command',
        metaStore: sessionMetaStore,
      });
      await publish(agent, session, {
        event: 'project',
        data: {
          from: result.previousSlug,
          to: null,
          via: 'slash_command',
        },
      });
      return c.json({ agent, session, cleared: true, previousSlug: result.previousSlug });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
