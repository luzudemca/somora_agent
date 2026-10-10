// What a given image model actually accepts.
//
// Allowed spec values are NOT a property of somora — they belong to the
// model. grok-imagine renders 1K and 2K; another model does 512 and 4K;
// next month there's one that does neither. Hardcoding the lists would
// mean a somora release per model, so the truth is fetched from the
// provider's image-model catalog at runtime.
//
// Three sources, in precedence order:
//   1. `imageGen.models[].allow` — operator override, always wins.
//      For providers without a catalog (a local image server) or one
//      that's wrong.
//   2. The provider catalog, cached per process.
//   3. Nothing — and then everything is allowed. A tool that refuses
//      valid input because it couldn't reach a catalog is worse than
//      one that forwards the request and relays the upstream's own
//      complaint.
//
// The catalog payload is provider-specific and not standardized. We
// read the shapes we can identify with confidence and ignore the rest;
// an unrecognized payload degrades to source 3 rather than to an empty
// allow-list. The full entry is logged once at debug level so a real
// payload can be inspected and this parser tightened against it.

import type { ImageModel, OpenAiCompatibleProvider } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import {
  type CatalogMedia,
  ENUMERABLE_SPEC_FIELDS,
  type EnumerableSpecField,
  type ImageJobPaths,
  type ImageSpecs,
  type ParamInfo,
  type ModelCapabilities,
  supportsField,
} from '../imagegen/types.ts';

/** Catalog responses are cached per provider+endpoint, for
 *  CATALOG_TTL_MS when the catalog answered and CATALOG_RETRY_MS when it
 *  did not. A provider adds models and parameters while somora runs; a
 *  cache that never expired rejected valid requests until a restart
 *  (2026-10-10). `POST /config/reload` clears it outright. */
const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_RETRY_MS = 60_000;
const catalogCache = new Map<string, { at: number; pending: Promise<CatalogEntry[] | null>; failed?: boolean }>();

interface CatalogEntry {
  id: string;
  raw: Record<string, unknown>;
}

/**
 * The shape OpenRouter's image-model catalog actually uses, verified
 * against `GET /api/v1/images/models` on 2026-08-26:
 *
 *   supported_parameters: {
 *     resolution:       { type: 'enum',  values: ['1K', '2K'] },
 *     aspect_ratio:     { type: 'enum',  values: ['1:1', '16:9', …] },
 *     n:                { type: 'range', min: 1, max: 1 },
 *     input_references: { type: 'range', min: 0, max: 3 },
 *   }
 *
 * Read first, because it's the one shape we've seen from a real
 * provider. The looser key-guessing below stays as a fallback for
 * catalogs that publish something else.
 */
interface ParamSpec {
  type?: string;
  values?: unknown;
  /** Suggestions, not a restriction — see ModelCapabilities.recommended. */
  recommended?: unknown;
  /** Extra vocabulary the field takes besides its type — for `size`,
   *  named ratios (gpu-box visual-adapter, 2026-09-07). */
  also_accepts?: unknown;
  min?: unknown;
  max?: unknown;
  default?: unknown;
  note?: unknown;
}

/** The catalog's parameter list as somora hands it on: known keys only,
 *  each checked for type, nothing guessed. */
export function paramInfos(params: Record<string, unknown> | null | undefined): Record<string, ParamInfo> | undefined {
  if (!params) return undefined;
  const out: Record<string, ParamInfo> = {};
  for (const [name, raw] of Object.entries(params)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out[name] = {};
      continue;
    }
    const spec = raw as ParamSpec;
    const info: ParamInfo = {};
    if (typeof spec.type === 'string' && spec.type) info.type = spec.type;
    const values = Array.isArray(spec.values)
      ? spec.values.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)).map(String)
      : undefined;
    if (values && values.length > 0) info.values = values;
    if (typeof spec.min === 'number' && Number.isFinite(spec.min)) info.min = spec.min;
    if (typeof spec.max === 'number' && Number.isFinite(spec.max)) info.max = spec.max;
    if (['string', 'number', 'boolean'].includes(typeof spec.default)) info.default = spec.default as string | number | boolean;
    if (typeof spec.note === 'string' && spec.note.trim()) info.note = spec.note.trim().slice(0, 500);
    out[name] = info;
  }
  return out;
}

function supportedParameters(raw: Record<string, unknown>): Record<string, ParamSpec> | null {
  const sp = raw.supported_parameters;
  if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return null;
  return sp as Record<string, ParamSpec>;
}

function enumValues(params: Record<string, ParamSpec> | null, field: string): string[] | undefined {
  const spec = params?.[field];
  if (!spec || spec.type !== 'enum') return undefined;
  return asStringArray(spec.values);
}

/**
 * `allowZero` matters more than it looks. For `n`, a maximum of zero is
 * meaningless and reads as a catalog glitch. For `input_references` it
 * is a real statement — "this model takes no reference images at all" —
 * and dropping it as "unknown" would let a caller send references to a
 * model that cannot use them, which then fails at the endpoint or,
 * worse, silently ignores them.
 */
function rangeMax(
  params: Record<string, ParamSpec> | null,
  field: string,
  allowZero = false,
): number | undefined {
  const spec = params?.[field];
  if (!spec || spec.type !== 'range') return undefined;
  const max = spec.max;
  if (typeof max !== 'number' || !Number.isFinite(max)) return undefined;
  return max > 0 || (allowZero && max === 0) ? max : undefined;
}

/** Field names a catalog might use for each spec, most specific first.
 *  Fallback for providers that don't publish `supported_parameters`. */
const CATALOG_KEYS: Record<EnumerableSpecField, string[]> = {
  resolution: ['resolutions', 'supported_resolutions', 'resolution'],
  aspect_ratio: ['aspect_ratios', 'supported_aspect_ratios', 'aspect_ratio'],
  size: ['sizes', 'supported_sizes', 'size'],
  quality: ['qualities', 'supported_qualities', 'quality'],
  output_format: ['output_formats', 'supported_output_formats', 'output_format'],
  background: ['backgrounds', 'supported_backgrounds', 'background'],
};

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Pull a spec's allowed values out of a catalog entry, looking at the
 *  top level and one nesting level down (catalogs commonly group these
 *  under `parameters` / `capabilities` / `image`). */
function readValues(raw: Record<string, unknown>, field: EnumerableSpecField): string[] | undefined {
  const containers: Record<string, unknown>[] = [raw];
  for (const key of ['parameters', 'capabilities', 'image', 'image_generation']) {
    const nested = raw[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      containers.push(nested as Record<string, unknown>);
    }
  }
  for (const container of containers) {
    for (const key of CATALOG_KEYS[field]) {
      const hit = asStringArray(container[key]);
      if (hit) return hit;
    }
  }
  return undefined;
}

function readNumber(
  raw: Record<string, unknown>,
  keys: string[],
  allowZero = false,
): number | undefined {
  for (const key of keys) {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v > 0 || (allowZero && v === 0)) return v;
  }
  return undefined;
}

async function fetchCatalog(
  provider: OpenAiCompatibleProvider,
  endpoint: string,
  timeoutMs: number,
): Promise<CatalogEntry[] | null> {
  const url = provider.baseUrl.replace(/\/+$/, '') + endpoint;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.debug({ msg: 'imagegen.catalog_http_error', url, status: res.status });
      return null;
    }
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body)
      ? body
      : ((body as { data?: unknown[] })?.data ?? (body as { models?: unknown[] })?.models);
    if (!Array.isArray(rows)) {
      logger.debug({ msg: 'imagegen.catalog_unexpected_shape', url });
      return null;
    }
    const entries: CatalogEntry[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const raw = row as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id : typeof raw.slug === 'string' ? raw.slug : '';
      if (id) entries.push({ id, raw });
    }
    logger.info({ msg: 'imagegen.catalog_loaded', url, models: entries.length });
    return entries;
  } catch (err) {
    logger.debug({ msg: 'imagegen.catalog_unreachable', url, err: (err as Error).message });
    return null;
  }
}

/** Catalog rows for one provider endpoint, cached. */
export async function loadCatalog(
  providerName: string,
  provider: OpenAiCompatibleProvider,
  endpoint: string | null,
  timeoutMs = 15_000,
): Promise<CatalogEntry[] | null> {
  if (!endpoint) return null;
  const key = `${providerName}${endpoint}`;
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < (hit.failed ? CATALOG_RETRY_MS : CATALOG_TTL_MS)) return hit.pending;
  const entry: { at: number; pending: Promise<CatalogEntry[] | null>; failed?: boolean } = {
    at: Date.now(),
    pending: fetchCatalog(provider, endpoint, timeoutMs),
  };
  void entry.pending.then((rows) => {
    if (rows === null) entry.failed = true;
  });
  catalogCache.set(key, entry);
  return entry.pending;
}

/** Forget every cached catalog — on `POST /config/reload`, and between
 *  test cases. */
export function clearCatalogCache(): void {
  catalogCache.clear();
}

/** Forget one provider's catalog, so the next lookup reads it fresh. */
export function forgetCatalog(providerName: string, endpoint: string | null): void {
  if (endpoint) catalogCache.delete(`${providerName}${endpoint}`);
}

/** Every image model the provider offers, for the UI's "what can I
 *  configure?" list. Empty array when no catalog is reachable. */
export async function listCatalogModels(
  providerName: string,
  provider: OpenAiCompatibleProvider,
  endpoint: string | null,
): Promise<Array<{ id: string; name?: string }>> {
  const entries = await loadCatalog(providerName, provider, endpoint);
  if (!entries) return [];
  return entries.map((e) => ({
    id: e.id,
    name: typeof e.raw.name === 'string' ? e.raw.name : undefined,
  }));
}

export async function resolveCapabilities(
  providerName: string,
  provider: OpenAiCompatibleProvider,
  entry: ImageModel,
): Promise<ModelCapabilities> {
  // 1. Operator override wins outright.
  if (entry.allow) {
    const values: Partial<Record<EnumerableSpecField, string[]>> = {};
    for (const field of ENUMERABLE_SPEC_FIELDS) {
      const configured = entry.allow[field as keyof typeof entry.allow];
      if (Array.isArray(configured)) values[field] = configured as string[];
    }
    return {
      known: true,
      source: 'config',
      values,
      // Only when the operator actually declared one. Same rule as the
      // catalog path: a list that exists is exhaustive, no list means
      // we don't know and everything passes.
      ...(entry.allow.supported ? { supported: entry.allow.supported } : {}),
      ...(entry.allow.parameters ? { params: paramInfos(entry.allow.parameters) } : {}),
      maxN: entry.allow.maxN,
      maxReferences: entry.allow.maxReferences,
    };
  }

  // 2. Provider catalog.
  const entries = await loadCatalog(providerName, provider, entry.capabilitiesEndpoint);
  const row = entries?.find((e) => e.id === entry.model);
  if (!row) {
    if (entries) {
      // Catalog answered but doesn't list this model. Not fatal — a
      // brand-new model can be callable before it's indexed, and
      // refusing here would be somora overruling the provider.
      logger.warn({
        msg: 'imagegen.model_not_in_catalog',
        model: entry.model,
        provider: providerName,
      });
    }
    return { known: false, source: 'unknown', values: {} };
  }

  logger.debug({ msg: 'imagegen.catalog_entry', model: entry.model, raw: row.raw });

  const params = supportedParameters(row.raw);
  const values: Partial<Record<EnumerableSpecField, string[]>> = {};
  const recommended: Partial<Record<EnumerableSpecField, string[]>> = {};
  for (const field of ENUMERABLE_SPEC_FIELDS) {
    const hit = enumValues(params, field) ?? readValues(row.raw, field);
    if (hit) values[field] = hit;
    const hint = asStringArray(params?.[field]?.recommended);
    if (hint) recommended[field] = hint;
  }
  const sizeAlsoAccepts = asStringArray(params?.size?.also_accepts);
  const endpointNote = typeof row.raw.note === 'string' && row.raw.note.trim() ? row.raw.note.trim().slice(0, 1500) : undefined;
  const paramNotes: Record<string, string> = {};
  for (const [field, spec] of Object.entries(params ?? {})) {
    if (typeof spec?.note === 'string' && spec.note.trim()) paramNotes[field] = spec.note.trim().slice(0, 500);
  }
  return {
    ...(endpointNote ? { endpointNote } : {}),
    ...(Object.keys(paramNotes).length > 0 ? { paramNotes } : {}),
    known: true,
    source: 'catalog',
    values,
    ...(Object.keys(recommended).length > 0 ? { recommended } : {}),
    ...(sizeAlsoAccepts ? { sizeAlsoAccepts } : {}),
    // Only when the catalog published a parameter list. A catalog entry
    // without one tells us the model exists, not what it takes.
    ...(params ? { supported: Object.keys(params), params: paramInfos(params) } : {}),
    maxN: rangeMax(params, 'n') ?? readNumber(row.raw, ['max_images', 'maxN', 'max_n']),
    maxReferences:
      rangeMax(params, 'input_references', true) ??
      readNumber(row.raw, ['max_input_references', 'max_references'], true),
    // Video input media (`accepted_media`, published beside the
    // parameters because files are not parameters) and the frame rate
    // keyframe times are converted with.
    ...(acceptedMedia(row.raw) ? { media: acceptedMedia(row.raw) } : {}),
    // Image job paths (`async`): the endpoint also takes the request as
    // a job, which is what survives a proxy with a short request limit.
    ...(jobPaths(row.raw) ? { jobs: jobPaths(row.raw) } : {}),
    ...(readNumber(row.raw, ['fps', 'frames_per_second']) !== undefined
      ? { fps: readNumber(row.raw, ['fps', 'frames_per_second']) }
      : {}),
    // Not a request parameter, so it lives beside supported_parameters
    // rather than inside it: variants are options on the CONTENT call.
    ...(asStringArray(row.raw.supported_variants)
      ? { variants: asStringArray(row.raw.supported_variants) }
      : {}),
  };
}

/** Fixed fields of a list entry (`item.const`): plain values only. */
function constFields(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k && (typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)))) out[k] = x;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A catalog's `async` block: `{create, status, content}`, all three
 *  paths or nothing — half a job route cannot be used. */
function jobPaths(raw: Record<string, unknown>): ImageJobPaths | undefined {
  const a = raw.async;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return undefined;
  const { create, status, content } = a as Record<string, unknown>;
  if (typeof create !== 'string' || typeof status !== 'string' || typeof content !== 'string') return undefined;
  if (!create || !status || !content) return undefined;
  return { create, status, content };
}

/** A catalog's `accepted_media`: `{ <type>: {kind, min, max, fields,
 *  max_seconds} }`. Entries that are not objects are skipped; numbers that
 *  are not finite are left out rather than guessed. */
function acceptedMedia(raw: Record<string, unknown>): Record<string, CatalogMedia> | undefined {
  const am = raw.accepted_media;
  if (!am || typeof am !== 'object' || Array.isArray(am)) return undefined;
  const out: Record<string, CatalogMedia> = {};
  for (const [type, spec] of Object.entries(am as Record<string, unknown>)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const r = spec as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    const m: CatalogMedia = {};
    if (typeof r.kind === 'string') m.kind = r.kind;
    if (n(r.min) !== undefined) m.min = n(r.min);
    if (n(r.max) !== undefined) m.max = n(r.max);
    const secs = n(r.max_seconds) ?? n(r.maxSeconds);
    if (secs !== undefined) m.maxSeconds = secs;
    const minSecs = n(r.min_seconds) ?? n(r.minSeconds);
    if (minSecs !== undefined) m.minSeconds = minSecs;
    const fields = asStringArray(r.fields);
    if (fields) m.fields = fields;
    const fps = n(r.anchor_fps) ?? n(r.fps);
    if (fps) m.fps = fps;
    const item = r.item && typeof r.item === 'object' && !Array.isArray(r.item) ? (r.item as Record<string, unknown>) : null;
    const key = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
    if (item && key(item.url)) {
      m.item = {
        url: key(item.url)!,
        ...(key(item.seconds) ? { seconds: key(item.seconds)! } : {}),
        ...(key(item.frame) ? { frame: key(item.frame)! } : {}),
        ...(key(item.strength) ? { strength: key(item.strength)! } : {}),
        ...(constFields(item.const) ? { const: constFields(item.const)! } : {}),
        ...(Array.isArray(item.strength_range) && item.strength_range.length === 2 && item.strength_range.every((x) => typeof x === 'number' && Number.isFinite(x))
          ? { strengthRange: [item.strength_range[0] as number, item.strength_range[1] as number] as [number, number] }
          : {}),
      };
    }
    out[type] = m;
  }
  // An empty object is a statement too: the model takes no input files.
  return out;
}

/**
 * Validate specs against what the model accepts.
 *
 * Rejections name the valid values, because the caller is often a
 * language model: "resolution '4K' is not supported by this model —
 * allowed: 1K, 2K" gets corrected on the next attempt, whereas
 * "invalid resolution" gets retried verbatim three times.
 *
 * Unknown constraints are not constraints. Only a field we positively
 * know the allowed values for can fail here.
 */
export function validateSpecs(
  specs: ImageSpecs,
  caps: ModelCapabilities,
  modelLabel: string,
): string[] {
  const errors: string[] = [];

  // A field the model doesn't take at all. Forwarding it would look
  // like it worked — the provider ignores the parameter and returns an
  // image that quietly disregards what was asked for, which is how you
  // end up wondering why "transparent background" did nothing.
  for (const [field, value] of Object.entries(specs)) {
    if (value === undefined) continue;
    if (!supportsField(caps, field)) {
      errors.push(
        `${modelLabel} does not accept '${field}'` +
          (caps.supported ? ` — it takes: ${caps.supported.join(', ')}` : ''),
      );
    }
  }

  for (const field of ENUMERABLE_SPEC_FIELDS) {
    const value = specs[field];
    const allowed = caps.values[field];
    if (value === undefined || !allowed || allowed.length === 0) continue;
    // Tier names are case-insensitive in practice ("2k" vs "2K").
    const ok = allowed.some((a) => a.toLowerCase() === String(value).toLowerCase());
    if (!ok) {
      errors.push(
        `${field} '${value}' is not supported by ${modelLabel} — allowed: ${allowed.join(', ')}`,
      );
    }
  }

  // Every other parameter the catalog describes: one of its values, or
  // a number within its range. The same rule for a field somora has a
  // name for and for one only the provider knows.
  for (const [field, value] of Object.entries(specs)) {
    if (value === undefined || value === null) continue;
    if ((ENUMERABLE_SPEC_FIELDS as readonly string[]).includes(field) || field === 'n') continue;
    const info = caps.params?.[field];
    if (!info) continue;
    if (info.type === 'enum' && info.values && info.values.length > 0) {
      const ok = info.values.some((a) => a.toLowerCase() === String(value).toLowerCase());
      if (!ok) errors.push(`${field} '${String(value)}' is not supported by ${modelLabel} — allowed: ${info.values.join(', ')}`);
    } else if (info.type === 'range' && (info.min !== undefined || info.max !== undefined)) {
      const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isFinite(num)) {
        errors.push(`${field} must be a number for ${modelLabel}, got '${String(value)}'`);
      } else if ((info.min !== undefined && num < info.min) || (info.max !== undefined && num > info.max)) {
        errors.push(`${field} ${num} is outside what ${modelLabel} takes (${info.min ?? '…'} to ${info.max ?? '…'})`);
      }
    }
  }

  if (specs.n !== undefined) {
    if (!Number.isInteger(specs.n) || specs.n < 1) {
      errors.push(`n must be a positive integer, got '${specs.n}'`);
    } else if (caps.maxN !== undefined && specs.n > caps.maxN) {
      errors.push(`n '${specs.n}' exceeds what ${modelLabel} allows (max ${caps.maxN})`);
    }
  }

  if (specs.output_compression !== undefined) {
    const c = specs.output_compression;
    if (!Number.isInteger(c) || c < 0 || c > 100) {
      errors.push(`output_compression must be an integer 0-100, got '${c}'`);
    }
  }

  return errors;
}

/** Merge configured defaults under caller-supplied specs. Caller wins
 *  field by field, so a default aspect ratio survives a call that only
 *  overrides the resolution. */
export function applyDefaults(
  specs: ImageSpecs,
  entry: ImageModel,
  caps?: ModelCapabilities,
): ImageSpecs {
  const merged: ImageSpecs = { ...specs };
  for (const [key, value] of Object.entries(entry.defaults)) {
    if (value === undefined) continue;
    // Silently skipped rather than applied-and-rejected: defaults are
    // operator convenience, not intent for this particular call. One
    // shared default block across several models shouldn't make every
    // request to the odd one out fail.
    if (caps && !supportsField(caps, key)) continue;
    if (merged[key as keyof ImageSpecs] === undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
