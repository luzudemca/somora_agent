// `somora codex` shows whether you are signed in and until when — read
// from Codex's auth.json without printing any token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAuthState } from './codex-home.ts';

const dir = mkdtempSync(join(tmpdir(), 'somora-codex-auth-'));
const file = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
const jwt = (claims: object) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

test('a ChatGPT login: the access token\'s expiry', () => {
  const exp = Math.floor(Date.UTC(2026, 9, 15, 23, 20) / 1000);
  const p = file('chatgpt.json', JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: jwt({ exp }), refresh_token: 'r' } }));
  assert.deepEqual(codexAuthState(p), { kind: 'chatgpt', expiresAt: exp * 1000 });
});

test('an API key, no login, a broken file, a token without expiry', () => {
  assert.deepEqual(codexAuthState(file('key.json', JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null }))), { kind: 'apikey' });
  assert.deepEqual(codexAuthState(join(dir, 'missing.json')), { kind: 'none' });
  assert.deepEqual(codexAuthState(file('broken.json', '{not json')), { kind: 'none' });
  assert.deepEqual(codexAuthState(file('noexp.json', JSON.stringify({ tokens: { access_token: jwt({}) } }))), { kind: 'chatgpt', expiresAt: -1 });
});
