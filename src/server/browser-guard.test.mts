import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bareHost, checkBrowserRequest, isOwnHost, type BrowserRequest } from './browser-guard.ts';

const opts = { machineName: 'box', publicHost: 'box.tailnet.ts.net', allowedHosts: ['somora.example.lan'], localAddresses: ['127.0.0.1', '::1', '10.0.0.5', '100.64.0.7'] };
const req = (r: Partial<BrowserRequest>): BrowserRequest => ({
  method: 'GET', host: '127.0.0.1:18737', origin: undefined, secFetchSite: undefined, secFetchMode: undefined, ...r,
});
const ok = (r: Partial<BrowserRequest>) => assert.equal(checkBrowserRequest(req(r), opts).ok, true, JSON.stringify(r));
const refused = (r: Partial<BrowserRequest>) => assert.equal(checkBrowserRequest(req(r), opts).ok, false, JSON.stringify(r));

test('programs that are not browsers pass under any name', () => {
  ok({});
  ok({ method: 'POST', host: 'box.example.com:18737' });
  ok({ method: 'POST', host: undefined });
});

test('the web client on its own address passes', () => {
  for (const host of ['127.0.0.1:18737', 'localhost:18737', '[::1]:18737', '10.0.0.5:18737', 'box:18737', 'box.local:18737', 'box.tailnet.ts.net:18737', 'somora.example.lan']) {
    ok({ method: 'POST', host, origin: `https://${host}`, secFetchSite: 'same-origin', secFetchMode: 'cors' });
    ok({ host, secFetchSite: 'same-origin', secFetchMode: 'websocket', origin: `https://${host}` });
    ok({ host, secFetchSite: 'none', secFetchMode: 'navigate' });
  }
});

test('a foreign website cannot open the terminal or send a turn', () => {
  refused({ host: '127.0.0.1:18737', origin: 'https://evil.example', secFetchSite: 'cross-site', secFetchMode: 'websocket' });
  // Firefox before Sec-Fetch-Site on WebSockets: the Origin alone decides.
  refused({ host: '127.0.0.1:18737', origin: 'https://evil.example' });
  refused({ method: 'POST', host: '127.0.0.1:18737', origin: 'https://evil.example', secFetchSite: 'cross-site', secFetchMode: 'no-cors' });
  refused({ method: 'POST', host: 'localhost:18737', origin: 'null' });
  refused({ host: '127.0.0.1:18737', secFetchSite: 'cross-site', secFetchMode: 'no-cors' });
});

test('a page on someone else\'s IP or tailnet name does not count as somora', () => {
  refused({ host: '127.0.0.1:18737', origin: 'http://127.0.0.2:28800'.replace('127.0.0.2', '203.0.113.9'), secFetchSite: 'cross-site', secFetchMode: 'websocket' });
  refused({ host: 'box.tailnet.ts.net:18737', origin: 'https://evil.other-tailnet.ts.net', secFetchSite: 'cross-site', secFetchMode: 'cors' });
  refused({ method: 'POST', host: '127.0.0.1:18737', origin: 'http://10.9.9.9:8080', secFetchSite: 'cross-site', secFetchMode: 'no-cors' });
  // The machine's own LAN and tailnet addresses are somora's.
  ok({ method: 'POST', host: '127.0.0.1:18737', origin: 'http://10.0.0.5:18737', secFetchSite: 'cross-site', secFetchMode: 'cors' });
  ok({ method: 'POST', host: '100.64.0.7:18737', origin: 'http://100.64.0.7:18737', secFetchSite: 'same-origin', secFetchMode: 'cors' });
  ok({ method: 'POST', host: '127.0.0.1:18737', origin: 'http://127.0.0.2:28800', secFetchSite: 'cross-site', secFetchMode: 'cors' });
});

test('DNS rebinding: a page on a name that now points here is refused', () => {
  refused({ host: 'rebind.evil.example:18737', secFetchSite: 'same-origin', secFetchMode: 'cors' });
  refused({ method: 'POST', host: 'rebind.evil.example:18737', origin: 'http://rebind.evil.example:18737', secFetchSite: 'same-origin', secFetchMode: 'cors' });
  refused({ host: 'rebind.evil.example:18737', secFetchSite: 'cross-site', secFetchMode: 'navigate' });
});

test('a link from another website still opens somora', () => {
  ok({ host: 'box.tailnet.ts.net:18737', secFetchSite: 'cross-site', secFetchMode: 'navigate' });
  refused({ method: 'POST', host: 'box.tailnet.ts.net:18737', origin: 'https://evil.example', secFetchSite: 'cross-site', secFetchMode: 'navigate' });
});

test('host names: port, brackets and a trailing dot do not matter', () => {
  assert.equal(bareHost('[::1]:18737'), '::1');
  assert.equal(bareHost('Box.Local.:80'), 'box.local');
  assert.equal(bareHost('::1'), '::1');
  assert.equal(isOwnHost('box.tailnet.ts.net.', opts), true);
  assert.equal(isOwnHost('other', opts), false);
});
