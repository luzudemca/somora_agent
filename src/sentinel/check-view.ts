// What clients see of a check trigger beyond triggers.json: its counts,
// last check and next check (the check state), and its script, read only.
// The web client's Sentinel window and GET /sentinel/triggers use this.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config/types.ts';
import { checkScriptDir, loadCheckState, sha256 } from './check-store.ts';
import { parseInterval } from './schedule.ts';
import type { CheckResult, CheckState, Trigger } from './types.ts';

export interface CheckView {
  checks: number;
  wakes: number;
  errorsInARow: number;
  nextCheckAt?: string;
  last?: CheckResult;
  lastDecision?: CheckState['lastDecision'];
  /** Set when config raised the interval floor above what the trigger
   *  asked for: the interval it actually runs with. */
  effectiveInterval?: string;
}

export async function checkView(t: Trigger, config: Config | undefined): Promise<CheckView | null> {
  if (t.source.type !== 'check') return null;
  const s = await loadCheckState(t.id);
  const view: CheckView = { checks: s?.checkCount ?? 0, wakes: s?.wakeCount ?? 0, errorsInARow: s?.errorStreak ?? 0 };
  if (s?.nextCheckAt && t.status === 'active') view.nextCheckAt = s.nextCheckAt;
  if (s?.last) view.last = s.last;
  if (s?.lastDecision) view.lastDecision = s.lastDecision;
  const limits = config?.sentinel?.checks;
  if (limits) {
    try {
      const asked = parseInterval(t.source.interval);
      const floor = t.source.mode === 'once' ? limits.minIntervalOnceMs : limits.minIntervalMs;
      if (floor > asked) view.effectiveInterval = floor % 1000 === 0 ? `${floor / 1000}s` : `${floor}ms`;
    } catch {
      // A broken interval shows as asked.
    }
  }
  return view;
}

/** The copy's text and whether it still matches the fingerprint taken
 *  at creation. A changed copy is shown anyway, flagged. */
export async function checkScriptView(t: Trigger): Promise<{ file: string; lang: string; sha256: string; text?: string; matches: boolean; error?: string }> {
  if (t.source.type !== 'check') return { file: '', lang: '', sha256: '', matches: false, error: 'not a check trigger' };
  const { file, lang, sha256: expected } = t.source.script;
  try {
    const bytes = await readFile(join(checkScriptDir(t.id), file));
    return { file, lang, sha256: expected, text: bytes.toString('utf8'), matches: sha256(bytes) === expected };
  } catch {
    return { file, lang, sha256: expected, matches: false, error: 'the script copy is missing' };
  }
}
