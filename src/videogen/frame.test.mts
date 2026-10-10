// A still cut from a finished video when the provider serves none — and
// for an older video, the first time the gallery asks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = join(process.env.SOMORA_HOME!, 'videogen-frame-test');
mkdirSync(process.env.SOMORA_HOME, { recursive: true });
const { ConfigSchema } = await import('../config/types.ts');
const { extractFrame, ensureVideoStill } = await import('./frame.ts');
const { readRecord, writeRecord } = await import('../media/records.ts');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'somora-frame-'));
const clip = join(dir, 'clip.mp4');
if (hasFfmpeg) {
  spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', clip]);
}

test('a frame comes out as a JPEG; a file ffmpeg cannot read gives none', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const jpg = await extractFrame(clip, 0.1);
  assert.ok(jpg && jpg[0] === 0xff && jpg[1] === 0xd8, 'JPEG bytes');
  assert.equal(await extractFrame(join(dir, 'missing.mp4'), 0), null);
});

test('an older video without a still gets one, stored and written into its record', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const config = ConfigSchema.parse({
    providers: { p: { engine: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', models: [{ id: 'chat', contextWindow: 8192, capabilities: ['text'] }] } },
    videoGen: { enabled: true, outputDir: join(dir, 'videos'), models: [{ name: 'm', provider: 'p', model: 'm' }] },
  });
  const record = {
    id: 'vid000000001', kind: 'video', createdAt: new Date().toISOString(), prompt: 'a test', modelName: 'm', modelId: 'm',
    provider: 'p', specs: {}, path: clip, filename: 'clip.mp4', mime: 'video/mp4', bytes: 1, durationSec: 1, linkedTo: [],
  } as never;
  await writeRecord(record);
  const updated = await ensureVideoStill(record, config);
  assert.ok(updated.thumbPath && existsSync(updated.thumbPath));
  assert.equal(updated.thumbMime, 'image/jpeg');
  assert.equal((await readRecord('vid000000001'))!.thumbPath, updated.thumbPath);
  assert.equal(await ensureVideoStill(updated, config), updated, 'one that has a still is left alone');
});
