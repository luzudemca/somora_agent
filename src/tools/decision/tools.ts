// decision_evaluate — ask the configured decision model typed questions
// (docs/decisions.md). The wire, limits and error mapping live in
// src/decisions/client.ts; this file adds what only a tool has: the
// agent's file access for images, and the model-facing description.

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { activeDecisionModel, type DecisionModel } from '../../config/types.ts';
import { cachedServerInputLimit, effectiveInputLimit, evaluateDecision, GUIDANCE, type DecisionOutcome, type DecisionRequest } from '../../decisions/client.ts';
import { DecisionEntry, DecisionQuestionsSchema, MAX_IMAGES, prepareDecisionImages } from '../../decisions/input.ts';
import { checkReadAllowed, realpathSafeAncestor, resolveLocalPath } from '../file/policy.ts';
import type { ToolContext, ToolDefinition } from '../types.ts';

const EvaluateInput = z
  .object({
    state: DecisionEntry,
    questions: DecisionQuestionsSchema,
    images: z.array(z.string().min(1)).min(1).max(MAX_IMAGES).optional(),
  })
  .strict();
type EvaluateInputT = z.infer<typeof EvaluateInput>;

const ENTRY_SCHEMA = {
  description: 'Text, a JSON object or array, or null.',
  anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }, { type: 'null' }],
} as const;

function jsonSchema(withImages: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'questions'],
    properties: {
      state: { ...ENTRY_SCHEMA, description: 'Everything the questions are about. Only what you put here is evaluated — no conversation, no files.' },
      questions: {
        type: 'object',
        minProperties: 1,
        description: 'Question id → question. Ids only label the answers; put the whole meaning into instructions and criteria. Questions are independent.',
        additionalProperties: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['type'],
              properties: {
                type: { const: 'boolean' },
                instructions: { ...ENTRY_SCHEMA, description: 'The yes/no question. Required unless criteria.true/false say it.' },
                criteria: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { true: ENTRY_SCHEMA, false: ENTRY_SCHEMA } }], description: 'Optional: what counts as true and as false.' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'criteria'],
              properties: {
                type: { const: 'choice' },
                instructions: ENTRY_SCHEMA,
                criteria: { type: 'object', minProperties: 2, maxProperties: 255, additionalProperties: ENTRY_SCHEMA, description: 'Competing labels → descriptions (null leaves a label undescribed). Add a "none"/"unclear" label when that outcome matters.' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'criteria'],
              properties: {
                type: { const: 'score' },
                instructions: ENTRY_SCHEMA,
                criteria: { type: 'array', minItems: 2, maxItems: 10, items: ENTRY_SCHEMA, description: 'Ordered levels, lowest first. The answer is a fractional position from 0 to the last index.' },
              },
            },
          ],
        },
      },
      ...(withImages
        ? {
            images: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_IMAGES,
              items: { type: 'string' },
              description: 'Up to 4 image FILE PATHS (PNG, JPEG, WebP), read before the state. The tool reads and scales them itself; for a chat attachment use the original path from its [Image attachment …] line.',
            },
          }
        : {}),
    },
  };
}

function description(model: DecisionModel | null): string {
  // The limit that is enforced: the lower of the config's and the server's.
  const limit = model ? effectiveInputLimit(model.maxInputTokens, cachedServerInputLimit(model)) : null;
  const images = model?.capabilities.includes('image') ?? false;
  return (
    'Ask the configured decision model typed questions about state you supply. It returns probabilities, not prose: ' +
    'boolean → probabilityTrue (0–1, a probability, not a verdict); choice → the chosen label with the full distribution and confidence; ' +
    'score → a fractional position from 0 to max on your ordered levels (2.7 of max 3 is near the top level). ' +
    'Use it to classify, route, triage or check a condition. Prefer it to your own judgement when: you sort or check more than a handful of similar items ' +
    '(mails, messages, feed entries — one call takes many questions); the same check comes back (a recurring task, a watch) and should give comparable ' +
    'answers each time; or you need a probability to compare against a threshold rather than a yes or no. For a single decision inside the ' +
    'conversation your own judgement is usually enough. ' +
    'It sees ONLY what you send: no conversation, no files' + (images ? ' except the images you name' : '') + '. ' +
    'Questions are independent and answered in one pass; one that depends on another\'s answer needs a second call. ' +
    'Every question carries its own text (instructions or criteria): the question id is only a label. ' +
    'Confidence is the model\'s estimate, not proven accuracy, and a result never authorises an action by itself. ' +
    `Send only the part of a long text the questions need: the limit is ${limit ? `${limit} tokens` : 'the server\'s token limit'}` +
    (images ? ', images included (about 3 000 tokens each)' : '') +
    ', and long inputs take seconds and queue. ' +
    (images ? 'Images: give file paths in the top-level `images` field, never inside `state` (a path in the state is just text to the model); the tool scales them like any image shown to a model. ' : 'This decision model reads text only. ') +
    'When the result is "unavailable", follow its guidance — a failure is not a "no".'
  );
}

/** Read the named images (the agent's file access rules apply), then
 *  check and scale them like every decision image (src/decisions/input.ts). */
async function loadImages(paths: string[], ctx: ToolContext): Promise<NonNullable<DecisionRequest['images']> | string> {
  const items: Array<{ label: string; bytes: Buffer }> = [];
  for (const p of paths) {
    const { absolute } = await resolveLocalPath(p, ctx.agent, ctx.config, ctx.session);
    for (const candidate of [absolute, await realpathSafeAncestor(absolute)]) {
      const verdict = checkReadAllowed(candidate);
      if (!verdict.ok) return `images: ${p}: ${verdict.reason}`;
    }
    try {
      items.push({ label: p, bytes: await readFile(absolute) });
    } catch (err) {
      return `images: could not read ${p}: ${(err as Error).message}`;
    }
  }
  return prepareDecisionImages(items, ctx.config.attachments?.maxImageEdge ?? 2048);
}

/** `images`/`image` inside an object state holding path-like strings. */
function misplacedImagePaths(state: unknown): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  for (const key of ['images', 'image', 'image_paths', 'files']) {
    const v = (state as Record<string, unknown>)[key];
    const list = Array.isArray(v) ? v : [v];
    if (list.some((x) => typeof x === 'string' && /\.(png|jpe?g|webp|gif)$/i.test(x) && /[\\/]/.test(x))) return key;
  }
  return null;
}

export const decisionEvaluate: ToolDefinition<EvaluateInputT, DecisionOutcome> = {
  name: 'decision_evaluate',
  description: description(null),
  inputSchema: EvaluateInput,
  jsonSchema: jsonSchema(true),
  toolset: 'decision',
  // The client enforces decisions.models[].timeoutMs (≤ 10 min); the
  // engine race must not cut a long evaluation short before that.
  defaultTimeoutMs: 610_000,
  available: (ctx) => activeDecisionModel(ctx.config) !== null,
  forContext: (ctx) => {
    const model = activeDecisionModel(ctx.config);
    return { description: description(model), jsonSchema: jsonSchema(model?.capabilities.includes('image') ?? false) };
  },
  async handler(input, ctx) {
    const model = activeDecisionModel(ctx.config);
    if (!model) return { status: 'unavailable', reason: 'not-configured', guidance: GUIDANCE['not-configured'] };
    // Image paths put INSIDE the state reach the model as text, not as
    // pictures — it then judges an image it never saw (seen live: an
    // agent sent state.images). Refuse with the fix instead.
    const nested = misplacedImagePaths(input.state);
    if (!input.images && nested && model.capabilities.includes('image')) {
      return {
        status: 'unavailable',
        reason: 'unsupported-input',
        guidance: GUIDANCE['unsupported-input'],
        detail: `state.${nested} holds file paths; images go into the top-level \`images\` field (the model cannot open a path in the state). Nothing was sent.`,
      };
    }
    let images: DecisionRequest['images'];
    if (input.images) {
      if (!model.capabilities.includes('image')) return { status: 'unavailable', reason: 'images-unsupported', guidance: GUIDANCE['images-unsupported'] };
      const loaded = await loadImages(input.images, ctx);
      if (typeof loaded === 'string') return { status: 'unavailable', reason: 'unsupported-input', guidance: GUIDANCE['unsupported-input'], detail: loaded };
      images = loaded;
    }
    return evaluateDecision(
      model,
      { state: input.state, questions: input.questions as DecisionRequest['questions'], ...(images ? { images } : {}) },
      { ...(ctx.signal ? { signal: ctx.signal } : {}), logCtx: { agent: ctx.agent, session: ctx.session } },
    );
  },
};

export function decisionTools(): ToolDefinition[] {
  return [decisionEvaluate as ToolDefinition];
}
