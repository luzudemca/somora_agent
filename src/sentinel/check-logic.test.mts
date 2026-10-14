// What happens after a check: every rule on its own, no clock, no files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterDecision, afterRun, dataHash, initialCheckState, nextAfterError, stableJson, type CheckLimits } from './check-logic.ts';
import type { CheckSource, CheckState, Evaluator } from './types.ts';
import type { CheckRunOutcome } from './check-runner.ts';

const limits: CheckLimits = { errorStreak: 3, maxWakesPerDay: 24 };
const t0 = new Date('2026-10-14T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const script = { file: 'check.sh', lang: 'sh' as const, sha256: 'x' };
const once: CheckSource = { type: 'check', description: 'd', interval: '30s', mode: 'once', deadline: at(60).toISOString(), script };
const watch: CheckSource = { type: 'check', description: 'd', interval: '1m', mode: 'watch', script };
const ready: Evaluator = { type: 'ready' };
const decision: Evaluator = { type: 'decision', questions: {}, wake: { question: 'q', minProbability: 0.8 } };
const ok = (answer: Record<string, unknown>): CheckRunOutcome => ({ ok: true, answer, ms: 5, stderr: '' });
const err = (errorClass: 'temporary' | 'permanent' = 'temporary'): CheckRunOutcome => ({ ok: false, error: 'boom', errorClass, ms: 5, stderr: '' });
const fresh = () => initialCheckState('t', t0);

function run(source: CheckSource, state: CheckState, r: CheckRunOutcome, now = t0, evaluator = ready) {
  return afterRun({ source, evaluator, state, run: r, now, limits });
}

test('once: not ready keeps waiting, ready wakes and completes', () => {
  const a = run(once, fresh(), ok({ ready: false, summary: 'still loading' }));
  assert.equal(a.wake, undefined);
  assert.equal(a.complete, undefined);
  assert.equal(a.state.checkCount, 1);
  assert.equal(a.state.last?.summary, 'still loading');
  const b = run(once, a.state, ok({ ready: true, data: { p: 'glm' } }), at(1));
  assert.equal(b.wake?.reason, 'ready');
  assert.deepEqual(b.wake?.data, { p: 'glm' });
  assert.ok(b.complete);
  assert.equal(b.state.wakeCount, 1);
});

test('once: past the deadline wakes once with the last state and completes', () => {
  const a = run(once, fresh(), ok({ ready: false, summary: 'never came up' }), at(61));
  assert.equal(a.wake?.reason, 'deadline');
  assert.ok(a.complete);
  assert.equal(a.state.last?.summary, 'never came up');
});

test('final:failed wakes at once and completes, in both modes', () => {
  for (const src of [once, watch]) {
    const a = run(src, fresh(), ok({ final: 'failed', summary: 'switch aborted' }));
    assert.equal(a.wake?.reason, 'final-failed');
    assert.ok(a.complete);
  }
});

test('watch: the first check only takes the starting state', () => {
  const a = run(watch, fresh(), ok({ ready: true }));
  assert.equal(a.wake, undefined);
  assert.equal(a.state.baselineTaken, true);
  assert.equal(a.state.lastReady, true);
  // still ready → no wake; goes false then true → wake
  const b = run(watch, a.state, ok({ ready: true }));
  assert.equal(b.wake, undefined);
  const c = run(watch, b.state, ok({ ready: false }));
  assert.equal(c.wake, undefined);
  const d = run(watch, c.state, ok({ ready: true }));
  assert.equal(d.wake?.reason, 'changed');
  assert.equal(d.complete, undefined, 'watch never completes on a wake');
});

test('watch: notifyOnFirst wakes on a ready first check, not on a not-ready one', () => {
  const src = { ...watch, notifyOnFirst: true };
  assert.equal(run(src, fresh(), ok({ ready: true })).wake?.reason, 'first');
  assert.equal(run(src, fresh(), ok({ ready: false })).wake, undefined);
});

test('errors never count as ready or as no: a temporary one counts, the third pauses', () => {
  const s0 = { ...fresh(), baselineTaken: true, lastReady: false };
  const a = run(watch, s0, err());
  assert.equal(a.wake, undefined);
  assert.equal(a.pause, undefined);
  assert.equal(a.state.errorStreak, 1);
  assert.equal(a.state.lastReady, false, 'an error does not touch the edge');
  const b = run(watch, a.state, err());
  assert.equal(b.pause, undefined);
  const c = run(watch, b.state, err());
  assert.equal(c.pause?.kind, 'error');
  assert.match(c.pause!.reason, /3 check errors in a row/);
});

test('a good answer resets the error streak', () => {
  const a = run(watch, { ...fresh(), errorStreak: 2, baselineTaken: true }, ok({ ready: false }));
  assert.equal(a.state.errorStreak, 0);
});

test('a permanent error pauses at once', () => {
  const a = run(once, fresh(), err('permanent'));
  assert.equal(a.pause?.kind, 'error');
  assert.equal(a.state.last?.errorClass, 'permanent');
});

test('an error past the deadline does not wake (no last good state to report)', () => {
  const a = run(once, fresh(), err(), at(61));
  assert.equal(a.wake, undefined);
});

test('the daily wake cap pauses instead of waking, and counts per UTC day', () => {
  const full: CheckState = { ...fresh(), baselineTaken: true, lastReady: false, wakesToday: { day: '2026-10-14', count: 24 } };
  const a = run(watch, full, ok({ ready: true }));
  assert.equal(a.wake, undefined);
  assert.equal(a.pause?.kind, 'cap');
  assert.equal(a.state.lastReady, true, 'edge moves on so tomorrow does not re-wake on the same change');
  const b = run(watch, full, ok({ ready: true }), new Date('2026-10-15T00:01:00Z'));
  assert.equal(b.wake?.reason, 'changed');
  assert.deepEqual(b.state.wakesToday, { day: '2026-10-15', count: 1 });
});

test('backoff: interval, doubling from 30 s, capped at 15 min (or the interval if longer)', () => {
  assert.equal(nextAfterError(15_000, 1), 30_000);
  assert.equal(nextAfterError(15_000, 3), 120_000);
  assert.equal(nextAfterError(15_000, 10), 900_000);
  assert.equal(nextAfterError(3_600_000, 2), 3_600_000);
});

test('data fingerprint ignores key order', () => {
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(dataHash({ a: 1, b: 2 }), dataHash({ b: 2, a: 1 }));
  assert.notEqual(dataHash({ a: 1 }), dataHash({ a: 2 }));
});

test('Art 2 watch: baseline stores the hash, same data asks nobody, new data goes to the decision model', () => {
  const a = run(watch, fresh(), ok({ data: [{ id: 1 }] }), t0, decision);
  assert.equal(a.needDecision, undefined);
  assert.equal(a.state.lastDataHash, dataHash([{ id: 1 }]));
  const b = run(watch, a.state, ok({ data: [{ id: 1 }] }), t0, decision);
  assert.equal(b.needDecision, undefined);
  assert.equal(b.wake, undefined);
  const c = run(watch, b.state, ok({ data: [{ id: 1 }, { id: 2 }] }), t0, decision);
  assert.ok(c.needDecision);
  assert.equal(c.state.lastDataHash, a.state.lastDataHash, 'hash only moves once the model judged it');
});

test('Art 2: empty data (nothing new) never asks the decision model', () => {
  const s = { ...fresh(), baselineTaken: true, lastDataHash: dataHash([{ id: 1 }]) };
  for (const data of [[], {}, '', null]) {
    const r = run(watch, s, ok({ data }), t0, decision);
    assert.equal(r.needDecision, undefined, JSON.stringify(data));
    assert.equal(r.wake, undefined);
  }
});

test('Art 2: model says wake → wake; says no → hash stored, no wake; fails → error, data judged again', () => {
  const s = { ...fresh(), baselineTaken: true, lastDataHash: 'old' };
  const yes = afterDecision({ source: watch, state: s, hash: 'new', data: [1], outcome: { ok: true, wake: true, question: 'q', value: 0.93 }, now: t0, limits });
  assert.equal(yes.wake?.reason, 'decision');
  assert.equal(yes.state.lastDataHash, 'new');
  assert.equal(yes.state.last?.decision?.value, 0.93);
  assert.equal(yes.state.lastDecision?.value, 0.93);
  assert.equal(yes.state.lastDecision?.at, t0.toISOString());
  const no = afterDecision({ source: watch, state: s, hash: 'new', data: [1], outcome: { ok: true, wake: false, question: 'q', value: 0.1 }, now: t0, limits });
  assert.equal(no.wake, undefined);
  assert.equal(no.state.lastDataHash, 'new');
  const fail = afterDecision({ source: watch, state: s, hash: 'new', data: [1], outcome: { ok: false, error: 'rate-limited' }, now: t0, limits });
  assert.equal(fail.wake, undefined);
  assert.equal(fail.state.lastDataHash, 'old');
  assert.equal(fail.state.errorStreak, 1);
  assert.match(fail.state.last?.error ?? '', /decision model: rate-limited/);
});

test('Art 2 once: model wake completes; a no past the deadline wakes with deadline', () => {
  const s = fresh();
  const yes = afterDecision({ source: once, state: s, hash: 'h', data: 1, outcome: { ok: true, wake: true, question: 'q', value: 'urgent' }, now: t0, limits });
  assert.ok(yes.complete);
  const late = afterDecision({ source: once, state: s, hash: 'h', data: 1, outcome: { ok: true, wake: false, question: 'q', value: 0.2 }, now: at(61), limits });
  assert.equal(late.wake?.reason, 'deadline');
  assert.ok(late.complete);
});
