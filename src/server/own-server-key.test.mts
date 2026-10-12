// Every call from somora to its own server carries the login key: code
// that builds the server's address (SOMORA_HOST/PORT, the lockfile,
// server.port) and talks HTTP to it must go through loopbackFetch
// (which adds the key) or add it itself. A new call that forgets it
// works with server.auth: off and breaks for everyone else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

const BUILDS_OWN_ADDRESS = /SOMORA_PORT|SOMORA_HOST|server\.lock|config\.server\.port|serverPort\(/;
const TALKS_HTTP = /\bfetch\(|httpRequest\(|httpsRequest\(|new EventSource|new WebSocket/;
const SENDS_KEY = /loopbackFetch|withKeyHeader|clientKey|ensureKeyFile|Authorization/;
// Not clients of the server: the server itself, and code that only
// passes the address on to a child process.
const EXEMPT = new Set(['src/server/index.ts', 'src/server/env.ts', 'src/mcp/config.ts', 'src/cli/systemd-unit.ts', 'src/cli/launchd.ts']);

test('code that calls somora\'s own server sends the key', () => {
  const offenders = files(join(root, 'src'))
    .map((p) => ({ rel: relative(root, p), text: readFileSync(p, 'utf8') }))
    .filter(({ rel, text }) => !EXEMPT.has(rel) && BUILDS_OWN_ADDRESS.test(text) && TALKS_HTTP.test(text) && !SENDS_KEY.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(offenders, [], 'route these calls through loopbackFetch (src/server/loopback-fetch.ts)');
});
