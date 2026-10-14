// Creating a check trigger (Sentinel phase 2): everything that must hold
// before somora copies the script and starts checking. The sentinel tool
// and the HTTP route both come through here.

import { stat, readFile } from 'node:fs/promises';
import type { Config } from '../config/types.ts';
import { checkBlacklist } from '../tools/exec/blacklist.ts';
import { initialCheckState } from './check-logic.ts';
import { installCheckScript, langOf, removeCheckFiles, saveCheckState } from './check-store.ts';
import { parseInterval } from './schedule.ts';
import type { CheckSource } from './types.ts';

/** A check script is a small program; anything bigger is a mistake. */
export const MAX_SCRIPT_BYTES = 256 * 1024;

export interface CheckSpecInput {
  description: string;
  /** Absolute path of the agent's script (the caller resolved it and
   *  checked the file policy). */
  scriptPath: string;
  mode: 'once' | 'watch';
  interval: string;
  /** `once` only: an ISO time, or a duration from now ("2h", "45m"). */
  deadline?: string;
  timeoutMs?: number;
  notifyOnFirst?: boolean;
}

type Limits = Config['sentinel']['checks'];

/** Why a script must not run as a check, or null. A check that restarts
 *  somora would restart it on every check (Hermes had that loop). */
export function refusedScript(text: string, lang: CheckSource['script']['lang']): string | null {
  if (/\bsomora\s+(?:server\s+)?(?:restart|stop|update)\b/.test(text)) {
    return 'the script restarts, stops or updates somora — a check would do that on every run';
  }
  if (/\bsystemctl\b[^\n]*\bsomora\b/.test(text) || /\blaunchctl\b[^\n]*\bsomora\b/.test(text)) {
    return 'the script controls the somora service — a check would do that on every run';
  }
  if (/\/server\/restart\b/.test(text)) return 'the script calls somora\'s restart route';
  if (lang === 'sh') {
    const hit = checkBlacklist(text);
    if (hit.matched) return `the script contains a command exec refuses too: ${hit.reason}`;
  }
  return null;
}

function parseDeadline(raw: string, now: Date): Date | null {
  if (/^\d+(ms|s|m|h)$/.test(raw.trim())) return new Date(now.getTime() + parseInterval(raw));
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Check the settings without touching any file. */
export function validateCheckSpec(input: CheckSpecInput, limits: Limits, now: Date): { ok: true; deadline?: string; intervalMs: number } | { ok: false; error: string } {
  const description = input.description?.trim() ?? '';
  if (!description) return { ok: false, error: 'description is required — say what the check watches ("the model server answers on glm"), it is shown in every wake' };
  if (description.length > 300) return { ok: false, error: 'description is over 300 characters' };
  if (!langOf(input.scriptPath)) return { ok: false, error: 'the script must be a .sh, .py or .js/.mjs file' };

  let intervalMs: number;
  try {
    intervalMs = parseInterval(input.interval);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const floor = input.mode === 'once' ? limits.minIntervalOnceMs : limits.minIntervalMs;
  if (intervalMs < floor) {
    return { ok: false, error: `interval ${input.interval} is below the ${floor / 1000} s minimum for a ${input.mode} check (config sentinel.checks.${input.mode === 'once' ? 'minIntervalOnceMs' : 'minIntervalMs'})` };
  }

  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000) return { ok: false, error: 'timeoutMs must be at least 1000' };
    if (input.timeoutMs > limits.maxTimeoutMs) return { ok: false, error: `timeoutMs over the ${limits.maxTimeoutMs} ms maximum (config sentinel.checks.maxTimeoutMs)` };
  }

  if (input.mode === 'watch') {
    if (input.deadline !== undefined) return { ok: false, error: 'a deadline is for a once check; a watch check runs until it is paused or deleted' };
    return { ok: true, intervalMs };
  }
  if (input.notifyOnFirst) return { ok: false, error: 'notifyOnFirst is for a watch check; a once check wakes on the first ready anyway' };
  if (!input.deadline) return { ok: false, error: 'a once check needs a deadline: an ISO time or a duration like "2h" — when it is not ready by then, you are woken with the last state' };
  const deadline = parseDeadline(input.deadline, now);
  if (!deadline) return { ok: false, error: `deadline "${input.deadline}" is neither an ISO time nor a duration like "2h"` };
  if (deadline.getTime() <= now.getTime()) return { ok: false, error: 'the deadline is in the past' };
  if (deadline.getTime() - now.getTime() > limits.maxDeadlineMs) {
    return { ok: false, error: `the deadline is more than ${Math.round(limits.maxDeadlineMs / 3_600_000)} h away (config sentinel.checks.maxDeadlineMs) — for longer, use a watch check` };
  }
  return { ok: true, deadline: deadline.toISOString(), intervalMs };
}

/** Validate, read the script, refuse what must not run, copy it and
 *  write the first check state (due now). On any failure nothing is
 *  left behind. */
export async function prepareCheckSource(
  id: string,
  input: CheckSpecInput,
  limits: Limits,
  now: Date = new Date(),
): Promise<{ ok: true; source: CheckSource } | { ok: false; error: string }> {
  const v = validateCheckSpec(input, limits, now);
  if (!v.ok) return v;
  let size: number;
  try {
    const st = await stat(input.scriptPath);
    if (!st.isFile()) return { ok: false, error: `${input.scriptPath} is not a file` };
    size = st.size;
  } catch {
    return { ok: false, error: `script not found: ${input.scriptPath}` };
  }
  if (size === 0) return { ok: false, error: 'the script is empty' };
  if (size > MAX_SCRIPT_BYTES) return { ok: false, error: `the script is over ${MAX_SCRIPT_BYTES / 1024} KB` };
  const lang = langOf(input.scriptPath)!;
  const refused = refusedScript(await readFile(input.scriptPath, 'utf8'), lang);
  if (refused) return { ok: false, error: `refused: ${refused}` };

  try {
    const script = await installCheckScript(id, input.scriptPath);
    const source: CheckSource = {
      type: 'check',
      description: input.description.trim(),
      interval: input.interval.trim(),
      mode: input.mode,
      ...(v.deadline ? { deadline: v.deadline } : {}),
      script,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.notifyOnFirst ? { notifyOnFirst: true } : {}),
    };
    await saveCheckState({ ...initialCheckState(id, now), nextCheckAt: now.toISOString() });
    return { ok: true, source };
  } catch (err) {
    await removeCheckFiles(id).catch(() => {});
    return { ok: false, error: `could not copy the script: ${(err as Error).message}` };
  }
}
