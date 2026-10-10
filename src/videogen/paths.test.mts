// Every way into a video render sends the provider the same request: the
// tool in-process, the tool in the MCP child (which goes through
// POST /video/generate), and a client calling that route directly. A
// model's own field — one somora has no name for — arrives on each.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../tools/types.ts';

process.env.SOMORA_HOME = join(process.env.SOMORA_HOME!, 'videogen-paths-test');
const home = process.env.SOMORA_HOME;
mkdirSync(home, { recursive: true });
const { ConfigSchema } = await import('../config/types.ts');
const { clearCatalogCache } = await import('../media/capabilities.ts');
const { startVideoJob } = await import('./generate.ts');
const { videoRequestFromBody } = await import('./request.ts');
const { videoGenerate } = await import('../tools/video/tools.ts');
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');

// The provider: a catalog that describes a model's own parameter, and a
// create route that records what it was sent.
let sent: Array<{ url: string; body: string }> = [];
const provider = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && req.url!.endsWith('/video/models')) {
      res.end(JSON.stringify({ data: [{ id: 'swap', supported_parameters: {
        seed: { type: 'range', min: 0, max: 100 },
        subject: { type: 'enum', values: ['largest', 'left', 'right'], default: 'largest', note: 'which person' },
      } }] }));
      return;
    }
    sent.push({ url: req.url!, body: Buffer.concat(chunks).toString('latin1') });
    res.end(JSON.stringify({ id: `job-${sent.length}`, status: 'queued' }));
  });
});
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const config = ConfigSchema.parse({
  providers: { p: { engine: 'openai-compatible', baseUrl: base, apiKey: 'k', models: [{ id: 'chat', contextWindow: 8192, capabilities: ['text'] }] } },
  videoGen: { enabled: true, maxConcurrent: 32, models: [{ name: 'swap', provider: 'p', model: 'swap', wire: 'passthrough', capabilitiesEndpoint: '/video/models' }] },
});

// The main server's half of the MCP path: what POST /video/generate does.
let routeWarnings: string[] = [];
const main = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)).on('end', async () => {
    const { input, ignored } = videoRequestFromBody(JSON.parse(Buffer.concat(chunks).toString()));
    routeWarnings = ignored;
    try {
      const { job } = await startVideoJob(input, config);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job }));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
});
await new Promise<void>((r) => main.listen(0, '127.0.0.1', r));
after(() => {
  provider.close();
  main.close();
});

beforeEach(() => {
  sent = [];
  routeWarnings = [];
  clearCatalogCache();
  rmSync(join(home, 'video-jobs'), { recursive: true, force: true });
});

const ctx = { agent: 'ada', session: 'main', config } as unknown as ToolContext;
const dir = mkdtempSync(join(tmpdir(), 'somora-paths-'));
const png = join(dir, 'who.png');
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

async function viaMcpChild(args: Parameters<typeof videoGenerate.handler>[0]) {
  process.env.SOMORA_AGENT = 'ada';
  process.env.SOMORA_HOST = '127.0.0.1';
  process.env.SOMORA_PORT = String((main.address() as { port: number }).port);
  try {
    return await videoGenerate.handler(args, ctx);
  } finally {
    delete process.env.SOMORA_AGENT;
  }
}

test('in-process tool, MCP-child tool and the HTTP route send the provider the same body', async () => {
  const args = { prompt: 'swap the person', model: 'swap', seed: 7, extra: { subject: 'right' } };
  await videoGenerate.handler(args, ctx);
  await viaMcpChild(args);
  const { input } = videoRequestFromBody({ prompt: 'swap the person', model: 'swap', seed: 7, extra: { subject: 'right' } });
  await startVideoJob(input, config);
  assert.equal(sent.length, 3);
  assert.equal(sent[0]!.body, sent[1]!.body, 'MCP child = in-process');
  assert.equal(sent[0]!.body, sent[2]!.body, 'HTTP route = in-process');
  assert.deepEqual(JSON.parse(sent[0]!.body), { model: 'swap', prompt: 'swap the person', subject: 'right', seed: 7 });
});

test('with input files too, all paths agree', async () => {
  const args = { prompt: 'p', model: 'swap', extra: { subject: 'left' }, reference_images: [png] };
  await videoGenerate.handler(args, ctx);
  await viaMcpChild(args);
  const norm = (b: string) => b.replace(/-{2,}[\w-]+/g, 'B');
  assert.equal(sent.length, 2);
  assert.equal(norm(sent[0]!.body), norm(sent[1]!.body));
  assert.ok(sent[0]!.body.includes('name="subject"\r\n\r\nleft'));
});

test('a value the catalog does not list is refused the same way on every path', async () => {
  const args = { prompt: 'p', model: 'swap', extra: { subject: 'middle' } };
  await assert.rejects(videoGenerate.handler(args, ctx), /subject 'middle' is not supported .* allowed: largest, left, right/);
  await assert.rejects(viaMcpChild(args), /subject 'middle' is not supported/);
  await assert.rejects(viaMcpChild({ prompt: 'p', model: 'swap', seed: 500 }), /seed 500 is outside/);
  assert.equal(sent.length, 0);
});

test('a top-level field the route does not know comes back as a warning, never silently', async () => {
  const { input, ignored } = videoRequestFromBody({ prompt: 'p', model: 'swap', subject: 'right' });
  assert.deepEqual(ignored, ['ignored: subject — pass provider-specific fields inside extra']);
  assert.equal((input.specs as Record<string, unknown>).subject, undefined);
  assert.throws(() => videoRequestFromBody({ prompt: 'p', extra: 'subject=right' }), /extra must be an object/);
  assert.equal(routeWarnings.length, 0);
});
