// Files of check triggers (Sentinel phase 2), next to triggers.json:
//
//   sentinel/
//     scripts/<id>/check.<ext>   ← somora's copy of the agent's script
//     state/<id>/                ← the script's own folder (SOMORA_SENTINEL_STATE_DIR)
//     check-state/<id>.json      ← counters, last result, next check
//
// The copy is what runs: an agent editing the file in its workspace
// later does not change a running trigger (Hermes ran scripts by path
// and hit exactly that). Every run first compares the copy with the
// fingerprint taken at creation.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { chmod, copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { CheckScriptLang, CheckState } from './types.ts';

function sentinelDir(): string {
  return join(process.env.SOMORA_HOME ?? join(homedir(), '.somora'), 'sentinel');
}
export function checkScriptDir(id: string): string {
  return join(sentinelDir(), 'scripts', id);
}
export function checkStateDir(id: string): string {
  return join(sentinelDir(), 'state', id);
}
function checkStatePath(id: string): string {
  return join(sentinelDir(), 'check-state', `${id}.json`);
}

/** The language by file extension. The first line (shebang) is not
 *  read: which interpreter runs a check is somora's choice (Hermes). */
export function langOf(path: string): CheckScriptLang | null {
  switch (extname(path).toLowerCase()) {
    case '.sh':
    case '.bash':
      return 'sh';
    case '.py':
      return 'python';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'node';
    default:
      return null;
  }
}

const EXT: Record<CheckScriptLang, string> = { sh: 'sh', python: 'py', node: 'mjs' };

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Copy the agent's script into somora's folder; returns what the
 *  trigger records. A JS file keeps its module kind: `.cjs` stays CommonJS. */
export async function installCheckScript(
  id: string,
  sourcePath: string,
): Promise<{ file: string; lang: CheckScriptLang; sha256: string }> {
  const lang = langOf(sourcePath);
  if (!lang) throw new Error(`unsupported script type: ${extname(sourcePath) || 'no extension'} — use .sh, .py or .js/.mjs`);
  const dir = checkScriptDir(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = lang === 'node' && extname(sourcePath).toLowerCase() === '.cjs' ? 'cjs' : EXT[lang];
  const file = `check.${ext}`;
  const target = join(dir, file);
  await copyFile(sourcePath, target);
  await chmod(target, 0o600);
  mkdirSync(checkStateDir(id), { recursive: true, mode: 0o700 });
  return { file, lang, sha256: sha256(await readFile(target)) };
}

/** A new version of a trigger's script: the old copy goes, the state
 *  folder stays (the script may keep what it has seen). */
export async function replaceCheckScript(id: string, sourcePath: string): Promise<{ file: string; lang: CheckScriptLang; sha256: string }> {
  await rm(checkScriptDir(id), { recursive: true, force: true });
  return installCheckScript(id, sourcePath);
}

/** The script's text when it still matches its fingerprint, else why not. */
export async function readCheckScript(id: string, file: string, expected: string): Promise<{ ok: true; path: string; text: string } | { ok: false; error: string }> {
  const path = join(checkScriptDir(id), file);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return { ok: false, error: `script copy missing (${path}) — update or recreate the trigger` };
  }
  if (sha256(bytes) !== expected) return { ok: false, error: 'script copy changed outside somora — update the trigger to run a new version' };
  return { ok: true, path, text: bytes.toString('utf8') };
}

const stateCache = new Map<string, CheckState>();

export async function loadCheckState(id: string): Promise<CheckState | null> {
  const cached = stateCache.get(id);
  if (cached) return cached;
  try {
    const s = JSON.parse(await readFile(checkStatePath(id), 'utf8')) as CheckState;
    stateCache.set(id, s);
    return s;
  } catch {
    return null;
  }
}

/** Synchronous read of what is already loaded (the scheduler's pick). */
export function cachedCheckState(id: string): CheckState | undefined {
  return stateCache.get(id);
}

/** Drop what is in memory, so the next look reads the files — after
 *  triggers.json changed from another process (a tool in an MCP child
 *  may have replaced a trigger's script and reset its state). */
export function forgetCheckStates(): void {
  stateCache.clear();
}

export async function saveCheckState(state: CheckState): Promise<void> {
  stateCache.set(state.triggerId, state);
  const path = checkStatePath(state.triggerId);
  mkdirSync(join(sentinelDir(), 'check-state'), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Everything of a deleted trigger: copy, the script's folder, the state. */
export async function removeCheckFiles(id: string): Promise<void> {
  stateCache.delete(id);
  await rm(checkScriptDir(id), { recursive: true, force: true });
  await rm(checkStateDir(id), { recursive: true, force: true });
  await rm(checkStatePath(id), { force: true });
}

export function checkStateExists(id: string): boolean {
  return stateCache.has(id) || existsSync(checkStatePath(id));
}
