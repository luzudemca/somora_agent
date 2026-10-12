import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOW_SCRIPTS, allowScriptsArgs, compareVersions, parseNpmView, parseUpdateArgs } from './update-args.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('update args: default is the release channel with reinit', () => {
  assert.deepEqual(parseUpdateArgs([]), { kind: 'opts', channel: 'release', version: undefined, reinit: true, force: false });
});

test('update args: a leading v is dropped from an explicit version', () => {
  const r = parseUpdateArgs(['v2026.930.1', '--no-reinit']);
  assert.deepEqual(r, { kind: 'opts', channel: 'release', version: '2026.930.1', reinit: false, force: false });
});

test('update args: a pre-release version is accepted', () => {
  const r = parseUpdateArgs(['2026.930.1-rc.1']);
  assert.equal(r.kind === 'opts' && r.version, '2026.930.1-rc.1');
});

test('update args: a four-part pre-npm version is refused with an explanation', () => {
  const r = parseUpdateArgs(['2026.09.29.12']);
  assert.equal(r.kind, 'error');
  assert.match(r.kind === 'error' ? r.message : '', /pre-npm version/);
});

test('update args: garbage, unknown flags, edge + version', () => {
  assert.equal(parseUpdateArgs(['latest']).kind, 'error');
  assert.equal(parseUpdateArgs(['--nope']).kind, 'error');
  assert.equal(parseUpdateArgs(['--edge', '2026.930.1']).kind, 'error');
  assert.equal(parseUpdateArgs(['--help']).kind, 'help');
});

test('compareVersions: numeric per part, not by string', () => {
  assert.ok(compareVersions('2026.1005.1', '2026.930.4') > 0);
  assert.ok(compareVersions('2026.930.10', '2026.930.9') > 0);
  assert.ok(compareVersions('2027.101.1', '2026.1231.9') > 0);
  assert.equal(compareVersions('2026.930.1', '2026.930.1'), 0);
});

test('compareVersions: a pre-release sorts below its release', () => {
  assert.ok(compareVersions('2026.930.1-rc.1', '2026.930.1') < 0);
  assert.ok(compareVersions('2026.930.2-rc.1', '2026.930.1') > 0);
});

test('allow-scripts list = somora with its preinstall + every shipped dependency with an install script (package-lock.json), and install.sh agrees', () => {
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { hasInstallScript?: boolean; dev?: boolean }> };
  const withScripts = [...new Set(Object.entries(lock.packages)
    .filter(([k, v]) => k && v.hasInstallScript && !v.dev)
    .map(([k]) => k.split('node_modules/').pop()!))];
  const own = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string> };
  if (own.scripts.preinstall || own.scripts.install || own.scripts.postinstall) withScripts.push(own.name);
  withScripts.sort();
  assert.deepEqual([...ALLOW_SCRIPTS].sort(), withScripts);
  const sh = readFileSync(resolve(root, 'install.sh'), 'utf8').match(/^ALLOW_SCRIPTS="([^"]+)"/m)?.[1];
  assert.equal(sh, ALLOW_SCRIPTS.join(','));
});

test('the flag is only passed to an npm that knows it', () => {
  assert.deepEqual(allowScriptsArgs('undefined\n'), []);
  assert.equal(allowScriptsArgs('\n')[0], `--allow-scripts=${ALLOW_SCRIPTS.join(',')}`);
  assert.equal(allowScriptsArgs('node-pty\n').length, 1);
});

// `npm view somora@latest version engines somora --json`, as npm 11 and npm 12 print it.
const VIEW = { version: '2026.1011.1', engines: { node: '>=22.22.2' }, somora: { glibc: '2.34', lastForOlderGlibc: '2026.1007.2' } };
const TARGET = { version: '2026.1011.1', node: '>=22.22.2', glibc: '2.34', lastForOlderGlibc: '2026.1007.2' };

test('npm view: the object npm 11 prints', () => {
  assert.deepEqual(parseNpmView(JSON.stringify(VIEW, null, 2)), TARGET);
});

test('npm view: the one-element array npm 12 prints', () => {
  assert.deepEqual(parseNpmView(JSON.stringify([VIEW], null, 2)), TARGET);
});

test('npm view: nothing usable is no target', () => {
  assert.equal(parseNpmView(''), null);
  assert.equal(parseNpmView('[]'), null);
  assert.equal(parseNpmView(JSON.stringify([VIEW, VIEW])), null);
  assert.equal(parseNpmView('{"engines":{}}'), null);
  assert.equal(parseNpmView('npm error 404'), null);
  assert.deepEqual(parseNpmView('{"version":"2026.1011.1"}'), { version: '2026.1011.1' });
});
