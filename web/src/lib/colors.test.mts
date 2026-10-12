// Agent colours as text on the light theme: any colour a user picks
// ends up readable on white, keeps its hue, and a dark colour is left
// alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, inkOnLight, inkVars } from './colors';

const picks = ['#5cf2d6', '#7fff95', '#f5b942', '#ffff00', '#ffffff', '#ff6b9d', '#69b6ff', '#9d8cff', '#10b981', '#ff8800', '#00ffff', '#c0c0c0'];

test('every pale colour becomes readable on white (≥ 4.5:1)', () => {
  for (const c of picks) assert.ok(contrast(inkOnLight(c), '#ffffff') >= 4.5, `${c} → ${inkOnLight(c)}`);
});

test('a colour that is already dark enough is left as it is', () => {
  for (const c of ['#1e3a8a', '#7c2d12', '#000000', '#14532d']) assert.equal(inkOnLight(c), c);
});

test('the hue stays: darkening keeps the channel ratios', () => {
  const out = inkOnLight('#ff8800');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(out.slice(i, i + 2), 16));
  assert.equal(b, 0);
  assert.ok(Math.abs(g / r - 0x88 / 0xff) < 0.02);
});

test('the dark theme gets the colour exactly as chosen', () => {
  assert.equal(inkVars('#5cf2d6')['--ink'], '#5cf2d6');
  assert.equal(inkOnLight('var(--accent)'), 'var(--accent)');
});
