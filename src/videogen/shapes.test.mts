// Public providers' input shapes, described in config only: OpenRouter's
// lists of image_url objects (several types in one list, told apart by a
// constant) and fal's plain URL fields. Plus what a provider's refusal
// turns into, and a catalog that changes while somora runs.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.SOMORA_HOME = join(process.env.SOMORA_HOME!, 'videogen-shapes-test');
mkdirSync(process.env.SOMORA_HOME, { recursive: true });
const { ConfigSchema } = await import('../config/types.ts');
const { clearCatalogCache } = await import('../media/capabilities.ts');
const { startVideoJob } = await import('./generate.ts');
const { mediaItemFromBytes } = await import('./media.ts');

let seen: Array<{ contentType: string; json?: Record<string, unknown> }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: { id: 'job-1', status: 'queued' } };
let catalog: unknown = null;
let catalogReads = 0;
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    if (req.method === 'GET') {
      catalogReads++;
      res.writeHead(catalog ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(catalog ?? {}));
      return;
    }
    const ct = String(req.headers['content-type'] ?? '');
    seen.push({ contentType: ct, ...(ct.includes('json') ? { json: JSON.parse(Buffer.concat(chunks).toString()) } : {}) });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

beforeEach(() => {
  seen = [];
  reply = { status: 200, body: { id: 'job-1', status: 'queued' } };
  catalog = null;
  catalogReads = 0;
  clearCatalogCache();
  rmSync(join(process.env.SOMORA_HOME!, 'video-jobs'), { recursive: true, force: true });
});

function config(model: Record<string, unknown>) {
  return ConfigSchema.parse({
    providers: { p: { engine: 'openai-compatible', baseUrl: base, apiKey: 'k', models: [{ id: 'chat', contextWindow: 8192, capabilities: ['text'] }] } },
    videoGen: { enabled: true, maxConcurrent: 32, models: [{ name: 'm', provider: 'p', model: 'mod-x', ...model }] },
  });
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const uri = (b: Buffer, mime: string) => `data:${mime};base64,${b.toString('base64')}`;

// OpenRouter's video API (POST /api/v1/videos): frames in one list,
// told apart by frame_type; references in another.
const openrouter = {
  wire: 'openai',
  media: {
    first_frame: { field: 'frame_images', max: 1, item: { url: 'image_url.url', const: { type: 'image_url', frame_type: 'first_frame' } } },
    last_frame: { field: 'frame_images', max: 1, item: { url: 'image_url.url', const: { type: 'image_url', frame_type: 'last_frame' } } },
    reference_image: { field: 'input_references', max: 3, item: { url: 'image_url.url', const: { type: 'image_url' } } },
  },
};

test('OpenRouter: frames share one list in their own form, references in another, sent as JSON on its own', async () => {
  await startVideoJob({
    prompt: 'a boat',
    model: 'm',
    specs: { duration: 4, resolution: '720p' },
    media: [
      mediaItemFromBytes('last_frame', JPG, 'end.jpg'),
      mediaItemFromBytes('first_frame', PNG, 'start.png'),
      mediaItemFromBytes('reference_image', PNG, 'look.png'),
    ],
  }, config(openrouter));
  assert.equal(seen[0]!.contentType, 'application/json');
  assert.deepEqual(seen[0]!.json, {
    model: 'mod-x',
    prompt: 'a boat',
    duration: 4,
    resolution: '720p',
    frame_images: [
      { type: 'image_url', frame_type: 'first_frame', image_url: { url: uri(PNG, 'image/png') } },
      { type: 'image_url', frame_type: 'last_frame', image_url: { url: uri(JPG, 'image/jpeg') } },
    ],
    input_references: [{ type: 'image_url', image_url: { url: uri(PNG, 'image/png') } }],
  });
});

test('fal: plain URL fields, a data URI each, as JSON', async () => {
  await startVideoJob({
    prompt: 'p',
    model: 'm',
    media: [mediaItemFromBytes('first_frame', PNG, 'a.png'), mediaItemFromBytes('last_frame', JPG, 'b.jpg')],
  }, config({ wire: 'passthrough', transport: 'json', media: { first_frame: { field: 'image_url' }, last_frame: { field: 'end_image_url' } } }));
  assert.deepEqual(seen[0]!.json, { model: 'mod-x', prompt: 'p', image_url: uri(PNG, 'image/png'), end_image_url: uri(JPG, 'image/jpeg') });
});

test('the same constants and paths can come from the catalog', async () => {
  catalog = { data: [{ id: 'mod-x', accepted_media: {
    first_frame: { kind: 'image', max: 1, fields: ['frame_images'], item: { url: 'image_url.url', const: { type: 'image_url', frame_type: 'first_frame' } } },
  } }] };
  await startVideoJob({ prompt: 'p', model: 'm', media: [mediaItemFromBytes('first_frame', PNG, 'a.png')] },
    config({ wire: 'openai', capabilitiesEndpoint: '/video/models' }));
  assert.deepEqual(seen[0]!.json!.frame_images, [{ type: 'image_url', frame_type: 'first_frame', image_url: { url: uri(PNG, 'image/png') } }]);
});

test('a provider 4xx is an input error with its own words; auth and rate limits stay upstream trouble', async () => {
  reply = { status: 400, body: { error: { code: 'keyframe_out_of_range', message: 'keyframe at 9 s is past the end' } } };
  await assert.rejects(startVideoJob({ prompt: 'p', model: 'm' }, config({ wire: 'passthrough' })), (e: Error & { kind?: string }) =>
    e.kind === 'input' && /provider refused the request 400: .*keyframe_out_of_range/.test(e.message));
  reply = { status: 429, body: { error: 'slow down' } };
  await assert.rejects(startVideoJob({ prompt: 'p', model: 'm' }, config({ wire: 'passthrough' })), (e: Error & { kind?: string }) => e.kind === 'upstream');
});

test('a provider that wants JSON after multipart gets the operator a one-line hint', async () => {
  reply = { status: 400, body: { error: 'Content-Type must be application/json' } };
  await assert.rejects(
    startVideoJob({ prompt: 'p', model: 'm', media: [mediaItemFromBytes('first_frame', PNG, 'a.png')] }, config({ wire: 'openai' })),
    /set transport: json on videoGen.models 'm'/,
  );
  reply = { status: 400, body: { error: 'Content-Type must be application/json' } };
  await assert.rejects(startVideoJob({ prompt: 'p', model: 'm' }, config({ wire: 'openai' })), (e: Error) => !e.message.includes('transport: json'));
});

test('a parameter the catalog adds while somora runs is accepted without a restart', async () => {
  catalog = { data: [{ id: 'mod-x', supported_parameters: { seed: { type: 'range', min: 0, max: 9 } } }] };
  const cfg = config({ wire: 'passthrough', capabilitiesEndpoint: '/video/models' });
  await assert.rejects(startVideoJob({ prompt: 'p', model: 'm', specs: { subject: 'left' } }, cfg), /does not accept 'subject'/);
  assert.equal(catalogReads, 2, 'refused only after reading the catalog once more');
  catalog = { data: [{ id: 'mod-x', supported_parameters: { seed: {}, subject: { type: 'enum', values: ['left', 'right'] } } }] };
  await startVideoJob({ prompt: 'p', model: 'm', specs: { subject: 'left' } }, cfg);
  assert.equal(seen.length, 1);
});
