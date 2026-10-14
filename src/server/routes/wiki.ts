// Moved unchanged from src/server/index.ts, which calls registerWikiRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`.

import type { Hono } from 'hono';
import { resolveAnyRef } from '../../config/types.ts';
import { getSharedIndex, resolveObsidianSource } from '../../memory/registry.ts';
import { expandHome } from '../../tools/file/policy.ts';
import { buildTree, extractLinkTargets, getPage, getWikiIndex, globalGraph, invalidateWikiIndex, localGraph, readPageContent, resolveLinkTargets } from '../../wiki/explorer.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import type { Context } from 'hono';
import { join as joinPath, resolve as resolvePath } from 'node:path';

export function registerWikiRoutes(app: Hono): void {
  // ─── Wiki explorer (read-only) ───────────────────────────────────────
  //
  // Slug-addressed, never path-addressed. A request can only name pages
  // the index already found under the configured wiki root, so `../`,
  // symlink escapes and non-markdown files are rejected by construction
  // rather than by a filter someone has to keep correct.
  //
  // All routes 503 when the wiki is off — the same gate the dock tile
  // uses to hide itself (opt-in features need every gate, not one).

  /** Absolute wiki root, or null when wiki/vault aren't both configured. */
  function wikiRootOrNull(): string | null {
    if (!config.wiki.enabled) return null;
    const vault = config.obsidian?.vault;
    if (typeof vault !== 'string' || vault.length === 0) return null;
    return resolvePath(expandHome(vault), config.wiki.vaultSubfolder);
  }

  function wikiDisabled(c: Context) {
    return c.json(
      {
        error:
          'wiki is not enabled — set wiki.enabled and obsidian.vault in ~/.somora/config.yaml',
      },
      503,
    );
  }

  app.get('/wiki/status', (c) => {
    const root = wikiRootOrNull();
    return c.json({ enabled: root !== null, ...(root ? { root } : {}) });
  });

  app.get('/wiki/tree', async (c) => {
    const root = wikiRootOrNull();
    if (!root) return wikiDisabled(c);
    const index = await getWikiIndex(root);
    return c.json({
      root,
      pages: index.pages.size,
      builtAt: index.builtAt,
      nodes: buildTree(index),
    });
  });

  app.post('/wiki/refresh', async (c) => {
    const root = wikiRootOrNull();
    if (!root) return wikiDisabled(c);
    invalidateWikiIndex();
    const index = await getWikiIndex(root);
    return c.json({ pages: index.pages.size, builtAt: index.builtAt });
  });

  app.get('/wiki/page', async (c) => {
    const root = wikiRootOrNull();
    if (!root) return wikiDisabled(c);
    const slug = c.req.query('slug');
    if (typeof slug !== 'string' || slug.length === 0) {
      return c.json({ error: 'missing slug query' }, 400);
    }
    const index = await getWikiIndex(root);
    const hit = getPage(index, slug);
    if (!hit) return c.json({ error: `no wiki page '${slug}'` }, 404);
    let content: Awaited<ReturnType<typeof readPageContent>>;
    try {
      content = await readPageContent(hit.meta);
    } catch (err) {
      return c.json({ error: `read failed: ${(err as Error).message}` }, 500);
    }
    const { markdown, frontmatter } = content;
    // Resolve every wikilink in the body so the reader can turn them into
    // in-window navigation without reimplementing Obsidian's matching.
    const targets = extractLinkTargets(markdown);
    return c.json({
      slug: hit.meta.slug,
      title: hit.meta.title,
      folder: hit.meta.folder,
      mtimeMs: hit.meta.mtimeMs,
      markdown,
      frontmatter,
      links: hit.meta.links.map((s) => ({ slug: s, title: index.pages.get(s)?.title ?? s })),
      unresolved: hit.meta.unresolved,
      backlinks: hit.backlinks.map((p) => ({ slug: p.slug, title: p.title })),
      linkTargets: resolveLinkTargets(index, targets),
    });
  });

  app.get('/wiki/graph', async (c) => {
    const root = wikiRootOrNull();
    if (!root) return wikiDisabled(c);
    const index = await getWikiIndex(root);
    const scope = c.req.query('scope') === 'global' ? 'global' : 'local';
    if (scope === 'global') return c.json({ scope, ...globalGraph(index) });
    const slug = c.req.query('slug');
    if (typeof slug !== 'string' || slug.length === 0) {
      return c.json({ error: 'local scope needs a slug' }, 400);
    }
    const g = localGraph(index, slug);
    if (!g) return c.json({ error: `no wiki page '${slug}'` }, 404);
    return c.json({ scope, ...g });
  });

  // Wiki migration, step one: the plan. Reads the whole wiki, writes what
  // the migration WOULD do under ~/.somora/wiki-migration/<id>/ and
  // returns the summary. No file in the wiki is touched.
  app.post('/wiki/migration/plan', async (c) => {
    if (!config.wiki.enabled) {
      return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
    }
    const obs = resolveObsidianSource(config.obsidian);
    if (!obs?.vaultPath) return c.json({ error: 'no vault configured' }, 400);
    const wikiAbs = joinPath(obs.vaultPath, config.wiki.vaultSubfolder);
    const language = config.wiki.language ?? 'de';
    const { loadStructureFile } = await import('../../wiki/structure-file.ts');
    const { analyzeWiki } = await import('../../wiki/migration/analyze.ts');
    const { writePlan } = await import('../../wiki/migration/store.ts');
    const t0 = Date.now();
    const structure = await loadStructureFile(wikiAbs, language);
    const plan = await analyzeWiki({ wikiAbs, language, structure });
    const written = await writePlan(plan);
    logger.info({ msg: 'wiki.migration.plan_written', id: written.id, pages: plan.pagesTotal, folders: plan.foldersTotal, summary: plan.summary, ms: Date.now() - t0 });
    return c.json({ id: written.id, plan: written.markdown, pagesTotal: plan.pagesTotal, foldersTotal: plan.foldersTotal, summary: plan.summary, durationMs: Date.now() - t0 });
  });

  // Step two: the model judges every page the plan is unsure about (and
  // every page a rule would move). Runs in the background — 20 to 40
  // calls to the Lucid model — and writes refined.md next to the plan.
  const migrationRefineRuns = new Map<string, { started: string; done: number; total: number; finished?: string; error?: string }>();
  app.post('/wiki/migration/refine', async (c) => {
    if (!config.wiki.enabled) return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; wait?: unknown; batchSize?: unknown };
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id || !/^[0-9]{8}-[0-9]{6}$/.test(id)) return c.json({ error: 'id (a plan id from POST /wiki/migration/plan) is required' }, 400);
    const { readPlan, writeRefinedPlan } = await import('../../wiki/migration/store.ts');
    const plan = await readPlan(id);
    if (!plan) return c.json({ error: `no plan ${id}` }, 404);
    if (migrationRefineRuns.get(id) && !migrationRefineRuns.get(id)!.finished) return c.json({ error: `refine for ${id} is already running`, progress: migrationRefineRuns.get(id) }, 409);
    const ref = config.wiki.lucid.model ?? config.wiki.deep.model;
    const model = ref ? resolveAnyRef(config, ref) : null;
    if (!model) return c.json({ error: `no model: wiki.lucid.model / wiki.deep.model unresolved (${ref ?? 'unset'})` }, 400);
    const obs = resolveObsidianSource(config.obsidian);
    if (!obs?.vaultPath) return c.json({ error: 'no vault configured' }, 400);
    const wikiAbs = joinPath(obs.vaultPath, config.wiki.vaultSubfolder);
    const language = config.wiki.language ?? 'de';
    const progress: { started: string; done: number; total: number; finished?: string; error?: string } = { started: new Date().toISOString(), done: 0, total: 0 };
    migrationRefineRuns.set(id, progress);
    const run = (async () => {
      const { loadStructureFile } = await import('../../wiki/structure-file.ts');
      const { buildWikiMap } = await import('../../wiki/map.ts');
      const { refinePlan } = await import('../../wiki/migration/refine.ts');
      const structure = await loadStructureFile(wikiAbs, language);
      const map = await buildWikiMap({ wikiAbs, language, structure });
      const refined = await refinePlan({
        plan,
        planId: id,
        wikiAbs,
        language,
        map,
        model,
        ...(config.wiki.lucid.thinking ? { thinking: config.wiki.lucid.thinking } : {}),
        ...(typeof body.batchSize === 'number' ? { batchSize: body.batchSize } : {}),
        onProgress: (done, total) => {
          progress.done = done;
          progress.total = total;
        },
      });
      const w = await writeRefinedPlan(id, refined, language);
      progress.finished = new Date().toISOString();
      return { refined, markdown: w.markdown };
    })();
    run.catch((err) => {
      progress.error = (err as Error).message;
      progress.finished = new Date().toISOString();
      logger.error({ msg: 'wiki.migration.refine_failed', id, err: (err as Error).message });
    });
    if (!body.wait) return c.json({ id, started: true, message: 'Refine started in background. GET /wiki/migration/plans/:id for progress.' });
    const r = await run;
    return c.json({ id, refined: r.markdown, pagesJudged: r.refined.pagesJudged, batchesTotal: r.refined.batchesTotal, batchesFailed: r.refined.batchesFailed, groups: r.refined.groups.map((g) => ({ action: g.action, target: g.target, pages: g.pages.length })) });
  });

  // Approvals: a group (move:<folder> / fold:<page>) or a twin, or every
  // group of one action at once. Nothing moves until execute is called.
  app.post('/wiki/migration/plans/:id/approve', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9]{8}-[0-9]{6}$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { groups?: unknown; twins?: unknown; action?: unknown; status?: unknown };
    const status = body.status === 'dismissed' ? 'dismissed' : body.status === 'pending' ? 'pending' : 'approved';
    const { readRefinedPlan, readApprovals, writeApprovals } = await import('../../wiki/migration/store.ts');
    const refined = await readRefinedPlan(id);
    if (!refined) return c.json({ error: `plan ${id} has no refined result yet — POST /wiki/migration/refine first` }, 404);
    const a = await readApprovals(id);
    const at = new Date().toISOString();
    const keys = new Set<string>();
    if (Array.isArray(body.groups)) for (const k of body.groups) if (typeof k === 'string') keys.add(k);
    if (typeof body.action === 'string') for (const g of refined.groups) if (g.action === body.action) keys.add(g.key);
    let touched = 0;
    for (const k of keys) {
      if (!refined.groups.some((g) => g.key === k)) continue;
      a.groups[k] = { status, at };
      touched++;
    }
    const twins = new Set<string>();
    if (Array.isArray(body.twins)) for (const t of body.twins) if (typeof t === 'string') twins.add(t);
    if (body.twins === 'all') for (const t of refined.twins) twins.add(t.name);
    for (const t of twins) {
      if (!refined.twins.some((x) => x.name === t)) continue;
      a.twins[t] = { status, at };
      touched++;
    }
    await writeApprovals(id, a);
    const approved = refined.groups.filter((g) => a.groups[g.key]?.status === 'approved');
    return c.json({ id, status, touched, approvedGroups: approved.length, approvedPages: approved.reduce((n, g) => n + g.pages.length, 0), approvedTwins: refined.twins.filter((t) => a.twins[t.name]?.status === 'approved').length });
  });

  // Execute the approved part. `dryRun: true` (the default) writes a
  // report of what would happen; a real run takes a full copy of the wiki
  // first and refuses to start without it.
  const migrationExecRuns = new Map<string, { started: string; dryRun: boolean; done: number; total: number; finished?: string; error?: string; last?: string }>();
  app.post('/wiki/migration/plans/:id/execute', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9]{8}-[0-9]{6}$/.test(id)) return c.json({ error: 'bad id' }, 400);
    if (!config.wiki.enabled) return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { dryRun?: unknown; wait?: unknown; confirm?: unknown };
    const dryRun = body.dryRun !== false;
    if (!dryRun && body.confirm !== 'move my wiki') return c.json({ error: 'a real run needs {"dryRun": false, "confirm": "move my wiki"}' }, 400);
    const running = migrationExecRuns.get(id);
    if (running && !running.finished) return c.json({ error: `execute for ${id} is already running`, progress: running }, 409);
    const { readRefinedPlan, readApprovals, writeExecution, backupDirFor } = await import('../../wiki/migration/store.ts');
    const refined = await readRefinedPlan(id);
    if (!refined) return c.json({ error: `plan ${id} has no refined result yet` }, 404);
    const approvals = await readApprovals(id);
    const ref = config.wiki.lucid.model ?? config.wiki.deep.model;
    const model = ref ? resolveAnyRef(config, ref) : null;
    if (!model) return c.json({ error: `no model: wiki.lucid.model / wiki.deep.model unresolved (${ref ?? 'unset'})` }, 400);
    const obs = resolveObsidianSource(config.obsidian);
    if (!obs?.vaultPath) return c.json({ error: 'no vault configured' }, 400);
    const wikiAbs = joinPath(obs.vaultPath, config.wiki.vaultSubfolder);
    const language = config.wiki.language ?? 'de';
    const progress: { started: string; dryRun: boolean; done: number; total: number; finished?: string; error?: string; last?: string } = { started: new Date().toISOString(), dryRun, done: 0, total: 0 };
    migrationExecRuns.set(id, progress);
    const run = (async () => {
      const { executeMigration } = await import('../../wiki/migration/execute.ts');
      const result = await executeMigration({
        planId: id,
        wikiAbs,
        language,
        refined,
        approvals,
        model,
        backupDir: dryRun ? null : backupDirFor(id),
        dryRun,
        ...(config.wiki.lucid.thinking ? { thinking: config.wiki.lucid.thinking } : {}),
        reindex: () => getSharedIndex({ config: config.memory, obsidian: config.obsidian, wiki: config.wiki }).sweepNow(),
        onProgress: (done, total, item) => {
          progress.done = done;
          progress.total = total;
          progress.last = `${item.kind} ${item.page} → ${item.target} (${item.status})`;
        },
      });
      const w = await writeExecution(id, result, language);
      progress.finished = new Date().toISOString();
      return { result, markdown: w.markdown };
    })();
    run.catch((err) => {
      progress.error = (err as Error).message;
      progress.finished = new Date().toISOString();
      logger.error({ msg: 'wiki.migration.execute_failed', id, dryRun, err: (err as Error).message });
    });
    if (!body.wait) return c.json({ id, dryRun, started: true, message: 'Execute started in background. GET /wiki/migration/plans/:id for progress.' });
    const r = await run;
    return c.json({ id, dryRun, report: r.markdown, steps: r.result.items.length, counts: r.result.counts, linksRewritten: r.result.linksRewritten, foldersRemoved: r.result.foldersRemoved.length, backupDir: r.result.backupDir, reindex: r.result.reindex ?? null });
  });

  // One sweep of the search index now — after `somora wiki migrate undo`
  // put a backup back, so nobody waits for the 10-minute rescan.
  app.post('/wiki/migration/reindex', async (c) => {
    if (!config.wiki.enabled) return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
    try {
      const r = await getSharedIndex({ config: config.memory, obsidian: config.obsidian, wiki: config.wiki }).sweepNow();
      return c.json(r);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
  });

  // A second pass over links and `related:` with the renames a finished
  // run recorded — for wikis migrated before the frontmatter was covered.
  app.post('/wiki/migration/plans/:id/relink', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9]{8}-[0-9]{6}$/.test(id)) return c.json({ error: 'bad id' }, 400);
    if (!config.wiki.enabled) return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { dryRun?: unknown };
    const obs = resolveObsidianSource(config.obsidian);
    if (!obs?.vaultPath) return c.json({ error: 'no vault configured' }, 400);
    const wikiAbs = joinPath(obs.vaultPath, config.wiki.vaultSubfolder);
    const { readExecutions } = await import('../../wiki/migration/store.ts');
    const { renamesFromExecution, relinkWiki } = await import('../../wiki/migration/execute.ts');
    const runs = await readExecutions(id);
    if (runs.length === 0) return c.json({ error: `plan ${id} has no finished run` }, 404);
    const renames = new Map<string, string>();
    const vanished = new Map<string, string>();
    for (const r of runs) {
      const x = renamesFromExecution(r);
      for (const [k, v] of x.renames) renames.set(k, v);
      for (const [k, v] of x.vanished) vanished.set(k, v);
    }
    const res = await relinkWiki(wikiAbs, renames, vanished, body.dryRun === true);
    logger.info({ msg: 'wiki.migration.relink', id, dryRun: body.dryRun === true, renames: renames.size, ...res });
    return c.json({ id, dryRun: body.dryRun === true, renames: renames.size, refsRewritten: res.refs, pagesTouched: res.pages });
  });

  app.get('/wiki/migration/plans/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9]{8}-[0-9]{6}$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const { readPlan, readRefinedPlan, MIGRATION_ROOT } = await import('../../wiki/migration/store.ts');
    const plan = await readPlan(id);
    if (!plan) return c.json({ error: `no plan ${id}` }, 404);
    const refined = await readRefinedPlan(id);
    return c.json({
      id,
      dir: joinPath(MIGRATION_ROOT, id),
      plan: { pagesTotal: plan.pagesTotal, foldersTotal: plan.foldersTotal, summary: plan.summary, createdAt: plan.createdAt },
      refine: migrationRefineRuns.get(id) ?? null,
      execute: migrationExecRuns.get(id) ?? null,
      approvals: await (await import('../../wiki/migration/store.ts')).readApprovals(id),
      refined: refined ? { model: refined.model, pagesJudged: refined.pagesJudged, batchesTotal: refined.batchesTotal, batchesFailed: refined.batchesFailed, createdAt: refined.createdAt, groups: refined.groups.map((g) => ({ action: g.action, target: g.target, pages: g.pages.length })) } : null,
    });
  });
}
