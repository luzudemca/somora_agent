// Secrets out of check output before it reaches the decision model or
// an agent (Hermes redacts script output the same way). Two passes:
// the actual values somora knows to be secret, wherever they appear,
// then the common credential shapes.

import type { Config } from '../config/types.ts';
import { scrubCredentials } from '../mcp/hub/normalize.ts';

/** Values worth hiding: provider and decision-model keys, the login
 *  key, and every env var a skill declares (its value from the server's
 *  environment). Short values are skipped — "1234" would hit everything. */
export function secretValues(config: Config, skillVars: readonly string[] = []): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length >= 8) out.add(v);
  };
  for (const p of Object.values(config.providers ?? {})) add((p as { apiKey?: unknown }).apiKey);
  for (const m of config.decisions?.models ?? []) add(m.apiKey);
  add(process.env.SOMORA_KEY);
  for (const name of skillVars) add(process.env[name]);
  // Longest first, so a key that contains another is replaced whole.
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) if (out.includes(v)) out = out.split(v).join('[redacted]');
  return scrubCredentials(out);
}
