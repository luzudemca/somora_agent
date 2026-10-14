// `somora claude` has the shape of `somora codex` and `somora grok`:
// a help screen with the logins, somora's own login/logout/status/sync,
// everything else handed to Claude Code — and `somora auth` keeps
// working under its old name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'somora.mjs');
const home = mkdtempSync(join(tmpdir(), 'somora-claude-cli-'));
mkdirSync(join(home, '.somora'), { recursive: true });
// A fake HOME without a Claude Code of its own: the bundled one is used.
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SOMORA_HOME: join(home, '.somora'), PATH: dirname(process.execPath) + ':/usr/bin:/bin' };
delete env.SOMORA_CLAUDE_BIN;
delete env.CLAUDE_CONFIG_DIR;
const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, timeout: 60_000 });

test('without arguments: which Claude Code, both homes, the login state', () => {
  const r = run('claude');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^somora claude — Claude Code \(bundled Claude Code \d/);
  for (const sub of ['login', 'logout', 'status', 'sync']) assert.match(r.stdout, new RegExp(`somora claude ${sub} `));
  assert.match(r.stdout, new RegExp(`Claude home \\(yours\\):  ${join(home, '.claude')}`));
  assert.match(r.stdout, /Login: +none — run `somora claude login`/);
});

test('anything else goes to Claude Code', () => {
  const r = run('claude', '--version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Claude Code/);
});

test('status is somora\'s own view of the two stores', () => {
  const r = run('claude', 'status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /user +.*\.credentials\.json/);
  assert.match(r.stdout, /somora .*claude-home/);
});

test('somora auth still works and names the new command', () => {
  const r = run('auth', 'status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /`somora auth` is now `somora claude`/);
  assert.match(r.stdout, /somora .*claude-home/);
});

test('the main help lists somora claude, not somora auth', () => {
  const r = run('--help');
  assert.match(r.stdout, /somora claude \[args\.\.\.\]/);
  assert.doesNotMatch(r.stdout, /somora auth/);
});
