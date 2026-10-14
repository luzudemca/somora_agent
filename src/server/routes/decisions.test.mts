// POST /decisions/evaluate on its own Hono app against a fake System One
// server: the answers, the status codes per failure, validation, images
// as base64, and "not configured".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import sharp from 'sharp';
import { ConfigSchema } from '../../config/types.ts';
import { setConfig } from '../server-state.ts';
import { registerDecisionRoutes } from './decisions.ts';

let reply: (body: Record<string, unknown>, res: ServerResponse) => void = () => {};
let lastBody: Record<string, unknown> = {};
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d)).on('end', () => {
    if (req.url?.endsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'clef', max_input_tokens: 65536 }] }));
      return;
    }
    lastBody = raw ? JSON.parse(raw) : {};
    reply(lastBody, res);
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
after(() => fake.close());
const port = (fake.address() as AddressInfo).port;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function configure(decisions: unknown) {
  setConfig(ConfigSchema.parse({ providers: {}, decisions }));
}
const withModel = (capabilities = ['text', 'image']) =>
  configure({ model: 'clef', models: [{ name: 'clef', baseUrl: `http://127.0.0.1:${port}/clef`, model: 'clef', capabilities, timeoutMs: 5000 }] });

const app = new Hono();
registerDecisionRoutes(app);
const post = async (body: unknown) => {
  const r = await app.request('/decisions/evaluate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const questions = { urgent: { type: 'boolean', instructions: 'Does any of these mails need an answer today?' } };

test('answers come back typed; boolean travels as noul', async () => {
  withModel();
  reply = (_b, res) => json(res, 200, { model: 'clef', answers: { urgent: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 40, output_tokens: 0 } });
  const r = await post({ state: ['Invoice overdue, pay by tonight', 'Newsletter'], questions });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.deepEqual((r.body.answers as Record<string, unknown>).urgent, { type: 'boolean', probabilityTrue: 0.91 });
  assert.equal((lastBody.questions as Record<string, { type: string }>).urgent!.type, 'noul');
});

test('no decision model configured → 503 with reason and guidance', async () => {
  configure({ model: '', models: [] });
  const r = await post({ state: 'x', questions });
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'not-configured');
  assert.match(String(r.body.guidance), /decisions\.model/);
  assert.equal(typeof r.body.error, 'string');
});

test('a bad body is a 400 naming the field; a boolean without text is refused', async () => {
  withModel();
  assert.equal((await post('not json')).status, 400);
  const missing = await post({ state: 'x' });
  assert.equal(missing.status, 400);
  assert.match(String(missing.body.error), /questions/);
  const textless = await post({ state: 'x', questions: { a: { type: 'boolean' } } });
  assert.equal(textless.status, 400);
  assert.match(String(textless.body.error), /question id is not read/);
  assert.equal((await post({ state: 'x', questions, extra: 1 })).status, 400);
});

test('failures of the model map to status codes, the body keeps reason and guidance', async () => {
  withModel();
  reply = (_b, res) => json(res, 401, { error: { message: 'bad key' } });
  let r = await post({ state: 'x', questions });
  assert.equal(r.status, 502);
  assert.equal(r.body.reason, 'authentication');
  reply = (_b, res) => json(res, 413, { error: { type: 'input_too_long', message: 'input is 70000 tokens, limit is 65536' } });
  r = await post({ state: 'x', questions });
  assert.equal(r.status, 413);
  assert.equal(r.body.reason, 'too-long');
  reply = (_b, res) => json(res, 429, {});
  assert.equal((await post({ state: 'x', questions })).status, 429);
  reply = (_b, res) => json(res, 503, {});
  assert.equal((await post({ state: 'x', questions })).body.reason, 'not-ready');
});

test('images: base64 with or without a data: prefix reach the model; junk and text-only models are refused', async () => {
  withModel();
  const png = (await sharp({ create: { width: 64, height: 32, channels: 3, background: '#c00' } }).png().toBuffer()).toString('base64');
  reply = (_b, res) => json(res, 200, { model: 'clef', answers: { urgent: { type: 'noul', noul: 0.2 } }, usage: { input_tokens: 400, output_tokens: 0 } });
  const r = await post({ state: 'a picture', questions, images: [png, `data:image/png;base64,${png}`] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((lastBody.images as string[]).length, 2);
  const junk = await post({ state: 'x', questions, images: ['%%%'] });
  assert.equal(junk.status, 400);
  const notImage = await post({ state: 'x', questions, images: [Buffer.from('hello').toString('base64')] });
  assert.equal(notImage.status, 400);
  assert.match(String(notImage.body.error), /PNG, JPEG or WebP/);
  withModel(['text']);
  const textOnly = await post({ state: 'x', questions, images: [png] });
  assert.equal(textOnly.status, 400);
  assert.equal(textOnly.body.reason, 'images-unsupported');
});
