// Run one check script (Sentinel phase 2) and read its answer.
//
// The contract (docs/sentinel.md): one file, run by the interpreter its
// extension names, prints ONE JSON object on stdout —
//   Art 1: {"ready": true|false, "summary"?, "data"?, "final"?: "failed"}
//   Art 2: {"data": …, "summary"?, "final"?: "failed"}
// Exit 0 means "the check ran", not "the condition holds". A non-zero
// exit, broken JSON or a timeout is a check error, never "ready" and
// never "no".
//
// What the research of 2026-10-14 put in here: the whole process tree
// dies on a timeout, descendants that left the group included (Hermes,
// Claude Code had survivors holding the pipes open); the run resolves at
// its deadline even if a pipe stays open; output is capped and secrets
// are blacked out before anyone reads it.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Config } from '../config/types.ts';
import { loadPersona } from '../persona/loader.ts';
import { effectiveWorkspace } from '../server/workspace.ts';
import { skillEnvScopeForCommand } from '../skills/env-scope.ts';
import { buildSpawnEnv } from '../tools/exec/local.ts';
import { checkStateDir, readCheckScript } from './check-store.ts';
import { redactSecrets, secretValues } from './redact.ts';
import type { CheckScriptLang } from './types.ts';

export interface CheckRunInput {
  triggerId: string;
  agent: string;
  script: { file: string; lang: CheckScriptLang; sha256: string };
  /** 1: `ready` decides. 2: `data` goes to the decision model. */
  art: 1 | 2;
  timeoutMs: number;
  maxOutputBytes: number;
  config: Config;
  lastFiredAt?: string;
}

export interface CheckAnswer {
  ready?: boolean;
  summary?: string;
  data?: unknown;
  final?: 'failed';
}

export type CheckRunOutcome =
  | { ok: true; answer: CheckAnswer; ms: number; stderr: string }
  | { ok: false; error: string; errorClass: 'temporary' | 'permanent'; ms: number; stderr: string };

const STDERR_CAP = 8 * 1024;
const SUMMARY_CAP = 500;

const interpreterCache = new Map<CheckScriptLang, string | null>();

/** Absolute path of the interpreter; resolved once (Hermes refuses bare
 *  names: PATH can change under a long-running server). */
export function interpreterFor(lang: CheckScriptLang): string | null {
  if (lang === 'node') return process.execPath;
  if (interpreterCache.has(lang)) return interpreterCache.get(lang)!;
  const name = lang === 'sh' ? 'bash' : 'python3';
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  let path = r.status === 0 ? r.stdout.trim() : '';
  if (!path && lang === 'sh' && existsSync('/bin/sh')) path = '/bin/sh';
  const resolved = path && path.startsWith('/') ? path : null;
  interpreterCache.set(lang, resolved);
  return resolved;
}

/** Every process below `root`, from `ps` (works on Linux and macOS). */
function descendantsOf(root: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of children.get(p) ?? []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

/** Linux: every process whose environment carries this run's marker —
 *  also one that left both the group and the parentage (setsid, then
 *  the script exited). Other systems: none (the parentage scan remains). */
function pidsWithMarker(marker: string): number[] {
  if (process.platform !== 'linux') return [];
  const out: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const needle = `SOMORA_SENTINEL_RUN=${marker}`;
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      if (readFileSync(`/proc/${e}/environ`, 'latin1').split('\0').includes(needle)) out.push(Number(e));
    } catch {
      /* gone, or not ours */
    }
  }
  return out;
}

/** Kill the tree: the group first, then every descendant by pid (a
 *  `setsid` child has left the group). `seen` adds descendants noticed
 *  earlier: once the script has exited, its orphans hang under init and
 *  cannot be found by parentage any more. */
function killTree(child: ChildProcess, signal: NodeJS.Signals, seen: ReadonlySet<number> = new Set(), marker = ''): void {
  if (!child.pid) return;
  const others = new Set([...descendantsOf(child.pid), ...seen, ...(marker ? pidsWithMarker(marker) : [])]);
  others.delete(process.pid);
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
  for (const pid of others) {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}

/** The JSON object the script printed: the whole output, or else its
 *  last non-empty line (a debug line before it is forgiven). */
export function parseCheckOutput(stdout: string, art: 1 | 2): { ok: true; answer: CheckAnswer } | { ok: false; error: string } {
  const text = stdout.trim();
  if (!text) return { ok: false, error: 'the script printed nothing — it must print one JSON object' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    try {
      value = JSON.parse(last);
    } catch {
      return { ok: false, error: `output is not JSON: ${text.slice(0, 160)}` };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'output must be one JSON object, not a list or a value' };
  const o = value as Record<string, unknown>;
  const answer: CheckAnswer = {};
  if (o.final !== undefined) {
    if (o.final !== 'failed') return { ok: false, error: `"final" can only be "failed", got ${JSON.stringify(o.final).slice(0, 40)}` };
    answer.final = 'failed';
  }
  if (o.summary !== undefined) {
    if (typeof o.summary !== 'string') return { ok: false, error: '"summary" must be text' };
    answer.summary = o.summary.slice(0, SUMMARY_CAP);
  }
  if ('data' in o) answer.data = o.data;
  if (o.ready !== undefined) {
    if (typeof o.ready !== 'boolean') return { ok: false, error: '"ready" must be true or false' };
    answer.ready = o.ready;
  }
  if (!answer.final) {
    if (art === 1 && answer.ready === undefined) return { ok: false, error: 'missing "ready": true or false' };
    if (art === 2 && !('data' in o)) return { ok: false, error: 'missing "data": what the decision model should judge' };
  }
  return { ok: true, answer };
}

export async function runCheck(input: CheckRunInput): Promise<CheckRunOutcome> {
  const t0 = Date.now();
  const fail = (error: string, errorClass: 'temporary' | 'permanent', stderr = ''): CheckRunOutcome => ({ ok: false, error, errorClass, ms: Date.now() - t0, stderr });

  const script = await readCheckScript(input.triggerId, input.script.file, input.script.sha256);
  if (!script.ok) return fail(script.error, 'permanent');
  const interpreter = interpreterFor(input.script.lang);
  if (!interpreter) return fail(`no interpreter for ${input.script.lang} on this machine`, 'permanent');

  const marker = randomUUID();
  const persona = await loadPersona(input.agent);
  if (!persona) return fail(`agent '${input.agent}' not found`, 'permanent');
  const cwd = effectiveWorkspace(persona, input.config);
  const scope = await skillEnvScopeForCommand(script.text, input.config);
  const env = buildSpawnEnv(
    {
      SOMORA_AGENT: input.agent,
      SOMORA_SENTINEL_ID: input.triggerId,
      SOMORA_SENTINEL_STATE_DIR: checkStateDir(input.triggerId),
      SOMORA_SENTINEL_LAST_FIRED: input.lastFiredAt ?? '',
      SOMORA_SENTINEL_RUN: marker,
    },
    { stripSomoraInternal: true, ...(scope ? { skillEnvScope: scope } : {}) },
  );
  const secrets = secretValues(input.config, scope?.stripVars ?? []);

  return new Promise<CheckRunOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(interpreter, [script.path], { cwd: existsSync(cwd) ? cwd : checkStateDir(input.triggerId), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve(fail(`could not start the script: ${(err as Error).message}`, 'temporary'));
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    // Descendants seen while the script runs (see killTree).
    const seen = new Set<number>();
    const watch = setInterval(() => {
      if (child.pid) for (const pid of descendantsOf(child.pid)) seen.add(pid);
    }, 1000);
    watch.unref();

    child.stdout?.on('data', (c: Buffer) => {
      if (overflow) return;
      outBytes += c.length;
      if (outBytes > input.maxOutputBytes) {
        overflow = true;
        killTree(child, 'SIGKILL', seen, marker);
        return;
      }
      out.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (errBytes >= STDERR_CAP) return;
      errChunks.push(c.subarray(0, STDERR_CAP - errBytes));
      errBytes += c.length;
    });

    const finish = (exitCode: number | null, how: 'exit' | 'deadline') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      clearInterval(watch);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // Lenient decode: one bad byte must not throw the whole answer away (Hermes #105582).
      const stdout = redactSecrets(Buffer.concat(out).toString('utf8'), secrets);
      const stderr = redactSecrets(Buffer.concat(errChunks).toString('utf8'), secrets).trim();
      if (overflow) return resolve(fail(`output over ${input.maxOutputBytes} bytes — print only what the check needs`, 'temporary', stderr));
      if (timedOut || how === 'deadline') return resolve(fail(`timed out after ${Math.round(input.timeoutMs / 1000)} s`, 'temporary', stderr));
      if (exitCode !== 0) {
        return resolve(fail(`exit code ${exitCode}${stderr ? `: ${stderr.split('\n').slice(-3).join(' | ').slice(0, 300)}` : ''}`, 'temporary', stderr));
      }
      const parsed = parseCheckOutput(stdout, input.art);
      if (!parsed.ok) return resolve(fail(parsed.error, 'temporary', stderr));
      resolve({ ok: true, answer: parsed.answer, ms: Date.now() - t0, stderr });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM', seen, marker);
      setTimeout(() => killTree(child, 'SIGKILL', seen, marker), 2000).unref();
    }, input.timeoutMs);
    // Resolve at the deadline even if a pipe stays open.
    const hardStop = setTimeout(() => {
      killTree(child, 'SIGKILL', seen, marker);
      finish(null, 'deadline');
    }, input.timeoutMs + 5000);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      clearInterval(watch);
      resolve(fail(`could not start the script: ${err.message}`, 'temporary'));
    });
    // 'exit' fires when the process ends even if a descendant still holds
    // a pipe; give the streams a moment to drain, then read what came.
    child.on('exit', (code) => {
      // Whatever the script left running dies with it.
      killTree(child, 'SIGKILL', seen, marker);
      setTimeout(() => finish(code, 'exit'), 50);
    });
  });
}
