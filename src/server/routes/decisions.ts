// POST /decisions/evaluate — the configured decision model for scripts,
// skills and other programs (docs/api.md, docs/decisions.md). The same
// core as the decision_evaluate tool (src/decisions/), with images sent
// as base64 instead of file paths. Behind the login key like every route.

import type { Hono } from 'hono';
import { z } from 'zod';
import { activeDecisionModel } from '../../config/types.ts';
import { evaluateDecision, GUIDANCE, type DecisionOutcome, type DecisionRequest, type UnavailableReason } from '../../decisions/client.ts';
import { DecisionEntry, DecisionQuestionsSchema, MAX_IMAGES, prepareDecisionImages } from '../../decisions/input.ts';
import { config } from '../server-state.ts';

/** Request bodies above this are refused before parsing: four images at
 *  the 4 MB limit, base64-encoded, plus the state. */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

const Body = z
  .object({
    state: DecisionEntry,
    questions: DecisionQuestionsSchema,
    /** Base64, with or without a `data:image/…;base64,` prefix. */
    images: z.array(z.string().min(1)).min(1).max(MAX_IMAGES).optional(),
  })
  .strict();

/** The HTTP status an unavailable outcome answers with. The body always
 *  carries `reason` and `guidance`, so a caller need not map codes. */
const STATUS: Record<UnavailableReason, 400 | 413 | 429 | 502 | 503 | 504> = {
  'not-configured': 503,
  'images-unsupported': 400,
  'unsupported-input': 400,
  'too-long': 413,
  truncated: 413,
  'rate-limited': 429,
  authentication: 502,
  'not-ready': 502,
  transport: 502,
  'invalid-response': 502,
  deadline: 504,
};

function answer(outcome: DecisionOutcome): { body: Record<string, unknown>; status: 200 | 400 | 413 | 429 | 502 | 503 | 504 } {
  if (outcome.status === 'ok') return { body: outcome, status: 200 };
  return {
    body: { error: outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason, ...outcome },
    status: STATUS[outcome.reason],
  };
}

export function registerDecisionRoutes(app: Hono): void {
  app.post('/decisions/evaluate', async (c) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) return c.json({ error: `body over ${MAX_BODY_BYTES / 1024 / 1024} MB` }, 413);
    const raw = await c.req.json().catch(() => undefined);
    if (raw === undefined) return c.json({ error: 'body must be JSON: {state, questions, images?}' }, 400);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` }, 400);
    }
    const model = activeDecisionModel(config);
    if (!model) {
      const { body, status } = answer({ status: 'unavailable', reason: 'not-configured', guidance: GUIDANCE['not-configured'] });
      return c.json(body, status);
    }
    let images: DecisionRequest['images'];
    if (parsed.data.images) {
      if (!model.capabilities.includes('image')) {
        const { body, status } = answer({ status: 'unavailable', reason: 'images-unsupported', guidance: GUIDANCE['images-unsupported'] });
        return c.json(body, status);
      }
      const items: Array<{ label: string; bytes: Buffer }> = [];
      for (const [i, s] of parsed.data.images.entries()) {
        const b64 = s.replace(/^data:[^;,]+;base64,/, '');
        if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return c.json({ error: `images.${i}: not base64` }, 400);
        items.push({ label: `#${i + 1}`, bytes: Buffer.from(b64, 'base64') });
      }
      const prepared = await prepareDecisionImages(items, config.attachments?.maxImageEdge ?? 2048);
      if (typeof prepared === 'string') return c.json({ error: prepared }, 400);
      images = prepared;
    }
    const outcome = await evaluateDecision(
      model,
      { state: parsed.data.state, questions: parsed.data.questions as DecisionRequest['questions'], ...(images ? { images } : {}) },
      { signal: c.req.raw.signal, logCtx: { via: 'http' } },
    );
    const { body, status } = answer(outcome);
    return c.json(body, status);
  });
}
