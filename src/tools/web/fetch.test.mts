// web_fetch refuses internal addresses however they are written: IPv6
// literals (also IPv4-mapped in hex), names that resolve inward (checked
// when connecting), and redirects that point inward (checked per hop,
// before anything is sent).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fetchTestAllow, guardedLookup, webFetch } from './fetch.ts';

let inner = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (url.pathname === '/inward') {
    res.writeHead(302, { location: url.searchParams.get('to')! });
    return res.end();
  }
  if (url.pathname === '/loop') {
    res.writeHead(302, { location: '/loop' });
    return res.end();
  }
  const hop = /^\/hop(\d)$/.exec(url.pathname);
  if (hop && Number(hop[1]) < 3) {
    res.writeHead(302, { location: `/hop${Number(hop[1]) + 1}` });
    return res.end();
  }
  if (url.pathname === '/secret') inner++;
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('secret');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const port = (server.address() as { port: number }).port;
const run = (url: string) => webFetch.handler({ url, extract: 'text', maxChars: 1000 }, {} as never);

test('IPv6 and IPv4 literals of internal addresses are refused', async () => {
  for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '169.254.169.254', '[64:ff9b::7f00:1]', '0.0.0.0', '2130706433']) {
    await assert.rejects(run(`http://${host}:${port}/secret`), /private|reserved|blocked/, host);
  }
  assert.equal(inner, 0);
});

test('a name that resolves to an internal address is refused when connecting', async () => {
  const err = await new Promise<Error | null>((r) => guardedLookup()('localhost', {}, (e) => r(e)));
  assert.match(String(err?.message), /resolves to a private address/);
  await assert.rejects(run(`http://foo.localhost:${port}/secret`), /blocked/);
});

test('a redirect inward is refused before the inner request is sent', async () => {
  // The stand-in plays a public site.
  fetchTestAllow.add(`127.0.0.1:${port}`);
  try {
    for (const to of [`http://[::1]:${port}/secret`, `http://[::ffff:7f00:1]:${port}/secret`, 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'file:///etc/passwd']) {
      await assert.rejects(run(`http://127.0.0.1:${port}/inward?to=${encodeURIComponent(to)}`), /private|reserved|blocked|only http/, to);
    }
    assert.equal(inner, 0);
    await assert.rejects(run(`http://127.0.0.1:${port}/loop`), /more than 5 redirects/);
    const page = await run(`http://127.0.0.1:${port}/hop0`);
    assert.equal(page.content.includes('secret'), true);
    assert.equal(page.finalUrl, `http://127.0.0.1:${port}/hop3`);
  } finally {
    fetchTestAllow.clear();
  }
});

test('web.fetchAllowPrivate lets a listed internal host through, by IP, CIDR or name', async () => {
  const ctx = (allow: string[]) => ({ config: { web: { fetchAllowPrivate: allow } } }) as never;
  const get = (url: string, allow: string[]) => webFetch.handler({ url, extract: 'text', maxChars: 1000 }, ctx(allow));
  assert.equal((await get(`http://127.0.0.1:${port}/plain`, ['127.0.0.1'])).status, 200);
  assert.equal((await get(`http://127.0.0.1:${port}/plain`, ['127.0.0.0/8'])).status, 200);
  await assert.rejects(get(`http://127.0.0.1:${port}/plain`, ['10.0.0.0/8']), /web\.fetchAllowPrivate/);
  const err = await new Promise<Error | null>((r) => guardedLookup(['localhost'])('localhost', {}, (e) => r(e)));
  assert.equal(err, null);
});
