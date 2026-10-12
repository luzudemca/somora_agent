// The login key: the file, its form and rights, what counts as
// presenting it, the browser cookie, rotation and the brake on guessing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEY_PATTERN, KeyStore, MissCounter, cookieToken, ensureKeyFile, generateKey, presentedKey, readKeyFile, withKeyHeader, writeKeyFile,
} from './auth-key.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'somora-key-'));

test('a key is somora_ plus 43 base64url characters, and every one is different', () => {
  const a = generateKey();
  assert.match(a, KEY_PATTERN);
  assert.equal(a.length, 50);
  assert.notEqual(a, generateKey());
});

test('the file is made once, owner-only, and kept', () => {
  const path = join(dir(), 'server.key');
  const first = ensureKeyFile(path);
  assert.equal(first.created, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const again = ensureKeyFile(path);
  assert.deepEqual(again, { key: first.key, created: false });
});

test('a garbled file is replaced; loose rights are tightened', () => {
  const path = join(dir(), 'server.key');
  writeFileSync(path, 'not a key\n', { mode: 0o644 });
  assert.equal(readKeyFile(path), null);
  const { key, created } = ensureKeyFile(path);
  assert.equal(created, true);
  assert.match(key, KEY_PATTERN);
  writeFileSync(path, `${key}\n`, { mode: 0o644 });
  ensureKeyFile(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('where a request carries the key', () => {
  assert.deepEqual(presentedKey({ authorization: 'Bearer somora_x' }), { kind: 'key', value: 'somora_x' });
  assert.deepEqual(presentedKey({ authorization: 'bearer   somora_x ' }), { kind: 'key', value: 'somora_x' });
  assert.deepEqual(presentedKey({ xKey: 'somora_y' }), { kind: 'key', value: 'somora_y' });
  assert.deepEqual(presentedKey({ cookie: 'a=1; somora_key=abc%2D; b=2' }), { kind: 'cookie', value: 'abc-' });
  assert.deepEqual(presentedKey({ authorization: 'Basic eDp5' }), { kind: 'none' });
  assert.deepEqual(presentedKey({}), { kind: 'none' });
});

test('the store accepts the key and the cookie derived from it, nothing else', () => {
  const path = join(dir(), 'server.key');
  const store = new KeyStore(path);
  const key = store.current();
  assert.equal(store.accepts({ kind: 'key', value: key }), true);
  assert.equal(store.accepts({ kind: 'cookie', value: cookieToken(key) }), true);
  assert.equal(store.accepts({ kind: 'cookie', value: key }), false, 'the key itself is not a cookie');
  assert.equal(store.accepts({ kind: 'key', value: cookieToken(key) }), false, 'the cookie is not a key');
  assert.equal(store.accepts({ kind: 'key', value: `${key}x` }), false);
  assert.equal(store.accepts({ kind: 'none' }), false);
});

test('a new key in the file is picked up without a restart and signs browsers out', async () => {
  const path = join(dir(), 'server.key');
  const store = new KeyStore(path);
  const old = store.current();
  const oldCookie = store.cookieValue();
  const fresh = generateKey();
  writeKeyFile(fresh, path);
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(store.current(), fresh);
  assert.equal(store.accepts({ kind: 'key', value: old }), false);
  assert.equal(store.accepts({ kind: 'cookie', value: oldCookie }), false);
  assert.equal(store.accepts({ kind: 'cookie', value: cookieToken(fresh) }), true);
});

test('guessing is slowed: ten wrong keys block the address for a minute', () => {
  const m = new MissCounter(10, 300_000, 60_000);
  const t = 1_000_000;
  for (let i = 0; i < 9; i++) m.miss('1.2.3.4', t + i);
  assert.equal(m.blocked('1.2.3.4', t + 10), false);
  m.miss('1.2.3.4', t + 10);
  assert.equal(m.blocked('1.2.3.4', t + 11), true);
  assert.equal(m.blocked('5.6.7.8', t + 11), false);
  assert.equal(m.blocked('1.2.3.4', t + 60_011), false);
});

test('a client sends SOMORA_KEY, and never overrides a key the caller set', () => {
  const before = process.env.SOMORA_KEY;
  process.env.SOMORA_KEY = 'somora_fromenv';
  try {
    assert.equal(withKeyHeader({ 'content-type': 'application/json' }).authorization, 'Bearer somora_fromenv');
    assert.equal(withKeyHeader({ Authorization: 'Bearer mine' }).authorization, 'Bearer mine');
    assert.equal(withKeyHeader({ 'X-Somora-Key': 'mine' }).authorization, undefined);
  } finally {
    if (before === undefined) delete process.env.SOMORA_KEY;
    else process.env.SOMORA_KEY = before;
  }
});
