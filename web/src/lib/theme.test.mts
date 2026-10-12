// Theme choice: Dark by default, Auto follows the system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme } from './theme';

test('dark and light are what they say; auto follows the system', () => {
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
});
