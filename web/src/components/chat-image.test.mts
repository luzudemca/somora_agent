// Pictures in agent replies: somora's own load at once, other websites'
// wait for a click (or "Always show").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { ChatImage, chatImageUrl, foreignImageHost } from './ChatImage';

const own = 'https://box.tailnet.ts.net:18737';

test('somora\'s own pictures are not foreign', () => {
  for (const u of ['/media/abc/file', '/files/raw?path=%2Fhome%2Fx.png', `${own}/media/abc/file`, 'data:image/png;base64,AAAA', 'blob:https://box/123']) {
    assert.equal(foreignImageHost(u, own), null, u);
  }
  assert.equal(chatImageUrl('/home/me/pic.png'), '/files/raw?path=%2Fhome%2Fme%2Fpic.png');
});

test('another website is foreign, also with a protocol-relative or other-port address', () => {
  assert.equal(foreignImageHost('https://evil.example/p?d=secret', own), 'evil.example');
  assert.equal(foreignImageHost('//evil.example/p.png', own), 'evil.example');
  assert.equal(foreignImageHost('https://box.tailnet.ts.net:9999/p.png', own), 'box.tailnet.ts.net:9999');
});

test('a foreign picture renders as a held placeholder without an <img>', () => {
  const g = globalThis as unknown as { window?: unknown };
  g.window = { location: { origin: own }, localStorage: { getItem: () => null, setItem: () => {} } };
  try {
    const held = renderToString(React.createElement(ChatImage, { src: 'https://evil.example/p?d=secret', maxHeight: 100 }));
    assert.match(held, /Image from evil\.example/);
    assert.doesNotMatch(held, /<img/);
    const local = renderToString(React.createElement(ChatImage, { src: '/media/abc/file', maxHeight: 100 }));
    assert.match(local, /<img[^>]+src="\/media\/abc\/file"/);
    (g.window as { localStorage: { getItem: () => string } }).localStorage.getItem = () => '1';
    assert.match(renderToString(React.createElement(ChatImage, { src: 'https://evil.example/p.png', maxHeight: 100 })), /<img/);
  } finally {
    delete g.window;
  }
});
