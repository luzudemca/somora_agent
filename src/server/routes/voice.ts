// Moved unchanged from src/server/index.ts, which calls registerVoiceRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`; voiceCalls, voiceStateWatchers, voiceWatchers are read from it
// per request (index.ts sets them up later or changes them).

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { listAgents, loadPersona } from '../../persona/loader.ts';
import { appendEvent, createSession, resolveSessionId } from '../../storage/sessions.ts';
import { prepareForTts } from '../../tts/prepare-for-tts.ts';
import { cacheFileStat, negotiateFormat, synthesize } from '../../tts/service.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { startTurn } from '../start-turn.ts';
import { upgradeWebSocket } from '@hono/node-server';
import { randomUUID } from 'node:crypto';

export interface VoiceRoutesDeps {
  defaultAgentFallback: typeof Server.defaultAgentFallback;
  publish: typeof Server.publish;
  readonly voiceCalls: typeof Server.voiceCalls;
  readonly voiceStateWatchers: typeof Server.voiceStateWatchers;
  readonly voiceWatchers: typeof Server.voiceWatchers;
}

export function registerVoiceRoutes(app: Hono, routeDeps: VoiceRoutesDeps): void {
  const { defaultAgentFallback, publish } = routeDeps;
  // ─── Realtime voice ──────────────────────────────────────────────────
  // Three gates for an opt-in feature: the route says 503 when it is off,
  // the tile is not rendered, and an agent without `voice.enabled` never
  // appears in the picker.
  app.get('/voice/status', async (c) => {
    const cfg = config.realtimeVoice;
    if (!cfg?.enabled) return c.json({ enabled: false, agents: [] }, 200);
    const names = (await listAgents()).map((a) => a.name);
    const agents = await routeDeps.voiceCalls.callableAgents(names);
    return c.json({
      enabled: true,
      provider: cfg.provider,
      model: cfg.model,
      maxCallMinutes: cfg.maxCallMinutes,
      agents,
      calls: routeDeps.voiceCalls.list(),
    });
  });

  // What the voice self is actually told. The derived instructions live
  // only in memory, so this is the only way to read them.
  app.get('/voice/instructions', async (c) => {
    const agent = c.req.query('agent') ?? '';
    const session = c.req.query('session') ?? 'main';
    if (!config.realtimeVoice?.enabled) return c.json({ error: 'realtime voice is off' }, 503);
    const preview = await routeDeps.voiceCalls.previewInstructions(agent, session);
    if (!preview) return c.json({ error: `agent '${agent}' has no voice` }, 404);
    return c.json({ agent, session, ...preview });
  });

  // The audio channel. Binary frames are microphone PCM16 going up and
  // the model's PCM16 coming down; JSON frames carry control and state.
  // The browser holds no provider knowledge, no key, and never sees a
  // tool call.
  app.get(
    '/voice/attach',
    upgradeWebSocket((c) => {
      const agent = c.req.query('agent') ?? '';
      const sessionRef = c.req.query('session') ?? 'main';
      let callId: string | undefined;
      let closed = false;
      return {
        async onOpen(_evt, ws) {
          if (!config.realtimeVoice?.enabled) {
            ws.close(1008, 'realtimeVoice.enabled is false');
            return;
          }
          try {
            const active = await routeDeps.voiceCalls.start({ agent, session: sessionRef });
            callId = active.call.id;
            ws.send(JSON.stringify({ type: 'ready', call: active.call.snapshot(), rateHz: 24000 }));
            // ONE consumer drives the call; the browser watches through
            // its onEvent hook. Reading the provider stream a second time
            // here would not mirror it, it would steal half of it — the
            // call machine got the tool call and the browser got neither
            // transcript nor audio (measured 2026-09-11).
            routeDeps.voiceStateWatchers.set(active.call.id, (snap) => {
              if (!closed) ws.send(JSON.stringify({ type: 'state', call: snap }));
            });
            routeDeps.voiceWatchers.set(active.call.id, (ev, snap) => {
              if (closed) return;
              if (ev.kind === 'audio') {
                ws.send(JSON.stringify({ type: 'audio', base64: ev.base64, rateHz: ev.rateHz }));
                return;
              }
              ws.send(JSON.stringify({ type: 'event', event: ev, call: snap }));
            });
            void (async () => {
              try {
                for await (const _snap of active.call.run()) {
                  /* state travels through the watcher above */
                }
              } catch (err) {
                logger.warn({ msg: 'voice.stream_failed', err: (err as Error).message });
              } finally {
                routeDeps.voiceWatchers.delete(active.call.id);
                routeDeps.voiceStateWatchers.delete(active.call.id);
                if (!closed) ws.close(1000, 'call ended');
              }
            })();
          } catch (err) {
            ws.close(1008, (err as Error).message.slice(0, 120));
          }
        },
        async onMessage(evt, ws) {
          const active = callId ? routeDeps.voiceCalls.get(callId) : undefined;
          if (!active) return;
          const data = evt.data;
          if (typeof data !== 'string') return;
          let msg: { type?: string; base64?: string };
          try {
            msg = JSON.parse(data) as typeof msg;
          } catch {
            return;
          }
          if (msg.type === 'audio' && typeof msg.base64 === 'string') {
            // Through the call, not the session it started with: after a
            // handover that first session is closed (2026-09-12).
            await active.call.sendAudio({ base64: msg.base64, rateHz: 24000 });
            return;
          }
          if (msg.type === 'interrupt') {
            await active.call.interrupt();
            return;
          }
          if (msg.type === 'hangup') {
            await routeDeps.voiceCalls.stop(active.call.id, 'user hung up');
            ws.close(1000, 'hung up');
          }
        },
        async onClose() {
          closed = true;
          // Closing the tab ends the CALL — a standing audio connection
          // is billed by the minute, so an orphan is a standing bill.
          // Work the agent already accepted keeps running: hanging up and
          // cancelling are two different things.
          if (callId) await routeDeps.voiceCalls.stop(callId, 'client disconnected');
        },
      };
    }),
  );

  // Speech-to-Text. Web mic button POSTs multipart with `file` (audio
  // blob); we forward to the configured OpenAI-compatible STT endpoint
  // (oMLX `/v1/audio/transcriptions`, faster-whisper-server, OpenAI, …)
  // and return `{text}`. Standalone surface so the STT model never leaks
  // into chat-model registries.
  app.get('/stt/config', (c) => {
    const stt = config.stt;
    if (!stt?.enabled) return c.json({ enabled: false });
    const provider = config.providers[stt.provider];
    const ok = provider?.engine === 'openai-compatible';
    return c.json({
      enabled: ok,
      language: stt.language ?? null,
    });
  });

  app.post('/stt/transcribe', async (c) => {
    const stt = config.stt;
    if (!stt?.enabled) {
      return c.json({ error: 'stt not enabled in config.yaml' }, 503);
    }
    const provider = config.providers[stt.provider];
    if (!provider) {
      return c.json({ error: `stt.provider '${stt.provider}' not found in providers` }, 500);
    }
    if (provider.engine !== 'openai-compatible') {
      return c.json({ error: `stt.provider '${stt.provider}' is engine '${provider.engine}', needs openai-compatible` }, 500);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'expected multipart/form-data with a `file` field' }, 400);
    }
    const audio = form.get('file');
    if (!(audio instanceof Blob)) {
      return c.json({ error: "missing or invalid `file` field" }, 400);
    }
    const language = (form.get('language') as string | null) || stt.language;

    // Re-encode multipart for the upstream so we don't depend on Hono's
    // boundary surviving the proxy. The audio Blob is re-attached with a
    // sensible filename (upstream sniffs format from bytes, not name —
    // but mlx-audio routes some video containers via the extension).
    const fwd = new FormData();
    const filename = audio instanceof File && audio.name ? audio.name : guessAudioFilename(audio.type);
    fwd.append('file', audio, filename);
    fwd.append('model', stt.model);
    if (language) fwd.append('language', language);

    const url = provider.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
    const headers: Record<string, string> = {};
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

    const startedAt = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(url, { method: 'POST', headers, body: fwd });
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn({ msg: 'stt.upstream_unreachable', url, err: msg });
      return c.json({ error: `STT upstream unreachable: ${msg}` }, 502);
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      logger.warn({ msg: 'stt.upstream_error', status: upstream.status, body: text.slice(0, 500) });
      return c.json({ error: `STT upstream returned ${upstream.status}` }, 502);
    }
    let data: { text?: string };
    try {
      data = (await upstream.json()) as { text?: string };
    } catch (err) {
      return c.json({ error: `STT upstream returned non-JSON: ${(err as Error).message}` }, 502);
    }
    if (typeof data.text !== 'string') {
      return c.json({ error: 'STT upstream JSON missing `text` field' }, 502);
    }
    logger.info({
      msg: 'stt.transcribed',
      provider: stt.provider,
      model: stt.model,
      language: language ?? null,
      audioBytes: audio.size,
      chars: data.text.length,
      ms: Date.now() - startedAt,
    });
    return c.json({ text: data.text });
  });

  function guessAudioFilename(mime: string): string {
    if (mime.includes('webm')) return 'recording.webm';
    if (mime.includes('ogg')) return 'recording.ogg';
    if (mime.includes('mp4') || mime.includes('m4a')) return 'recording.m4a';
    if (mime.includes('wav')) return 'recording.wav';
    if (mime.includes('mpeg')) return 'recording.mp3';
    return 'recording.bin';
  }

  // ─────────────────────────────────────────────────────────────────────
  // TTS — text → audio synthesis. Mirrors the /stt/* surface: proxy +
  // content-addressed cache. See docs/voice.md.
  // ─────────────────────────────────────────────────────────────────────

  app.get('/tts/config', (c) => {
    const tts = config.tts;
    if (!tts?.enabled) return c.json({ enabled: false });
    const provider = config.providers[tts.provider];
    const ok = provider?.engine === 'openai-compatible';
    if (!ok) return c.json({ enabled: false });
    // Match what /tts/synthesize will actually deliver. If reencode is
    // off, only WAV is advertised; otherwise the negotiator can produce
    // opus and mp4.
    const formats = ['audio/wav'];
    if (tts.reencode.enabled) {
      formats.push('audio/opus', 'audio/mp4');
    }
    return c.json({
      enabled: true,
      formats,
      language: tts.language ?? null,
      voice: tts.voice ?? null,
      clients: {
        web: tts.clients.web,
        mobile: tts.clients.mobile,
      },
    });
  });

  app.post('/tts/synthesize', async (c) => {
    const tts = config.tts;
    if (!tts?.enabled) {
      return c.json({ error: 'tts not enabled in config.yaml' }, 503);
    }
    let body: { text?: string; voice?: string; language?: string; agent?: string };
    try {
      body = (await c.req.json()) as {
        text?: string;
        voice?: string;
        language?: string;
        agent?: string;
      };
    } catch {
      return c.json({ error: 'expected JSON body with `text`' }, 400);
    }
    if (!body.text || typeof body.text !== 'string' || body.text.trim().length === 0) {
      return c.json({ error: 'missing or empty `text`' }, 400);
    }
    if (body.text.length > 4000) {
      return c.json({ error: 'text exceeds 4000-char hard cap' }, 400);
    }

    const accept = c.req.header('accept');
    const spec = negotiateFormat(accept, tts.reencode.enabled);

    try {
      const result = await synthesize(
        {
          text: body.text,
          ...(body.voice ? { voice: body.voice } : {}),
          ...(body.language ? { language: body.language } : {}),
          ...(body.agent ? { agent: body.agent } : {}),
          format: spec.fmt,
        },
        config,
      );
      return c.body(new Uint8Array(result.bytes), 200, {
        'content-type': result.mime,
        'content-length': String(result.bytes.length),
        'x-tts-cache': result.cacheHit ? 'hit' : 'miss',
        'x-tts-cache-key': result.cacheKey,
        ...(result.durationMs !== undefined ? { 'x-tts-duration-ms': String(result.durationMs) } : {}),
      });
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn({ msg: 'tts.synthesize_failed', err: msg, chars: body.text.length });
      return c.json({ error: msg }, 502);
    }
  });

  app.get('/tts/cache/:filename', async (c) => {
    const filename = c.req.param('filename');
    // Strict filename validation: must be `<64-hex>.<ext>` where ext is
    // one of the known formats. Prevents `..` traversal + arbitrary
    // path reads via the cache route.
    const match = /^([0-9a-f]{64})\.(wav|opus|m4a)$/.exec(filename);
    if (!match) {
      return c.json({ error: 'invalid cache filename' }, 400);
    }
    const cacheKey = match[1]!;
    const ext = match[2]!;
    const fmt: 'wav' | 'opus' | 'mp4' = ext === 'm4a' ? 'mp4' : (ext as 'wav' | 'opus');
    const stat = cacheFileStat(cacheKey, fmt);
    if (!stat) {
      return c.json({ error: 'cache miss' }, 404);
    }
    // Stream the file with the right content-type. Hono's c.body
    // accepts a ReadableStream; node:fs createReadStream works.
    const { createReadStream } = await import('node:fs');
    const mime = fmt === 'wav' ? 'audio/wav' : fmt === 'opus' ? 'audio/opus' : 'audio/mp4';
    // Range support — basic single-range parser for mobile <audio>
    // seek/scrub. Returns full 200 when no Range header, 206 when
    // valid range, 416 on parse error.
    const range = c.req.header('range');
    if (range && range.startsWith('bytes=')) {
      const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (m) {
        const start = parseInt(m[1]!, 10);
        const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start <= end && end < stat.size) {
          const stream = createReadStream(stat.path, { start, end });
          return c.body(stream as unknown as ReadableStream, 206, {
            'content-type': mime,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${stat.size}`,
            'accept-ranges': 'bytes',
          });
        }
        return c.body(null, 416, { 'content-range': `bytes */${stat.size}` });
      }
    }
    const stream = createReadStream(stat.path);
    return c.body(stream as unknown as ReadableStream, 200, {
      'content-type': mime,
      'content-length': String(stat.size),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // /voice/turn — audio in → STT → run turn → TTS → audio out.
  // Independent of the chat-window auto-play toggle: this endpoint
  // always synthesizes audio for display-less / integration clients
  // (panels, voice satellites, bridges). See docs/voice.md.
  // ─────────────────────────────────────────────────────────────────────

  app.post('/voice/turn', async (c) => {
    const stt = config.stt;
    const tts = config.tts;
    if (!stt?.enabled) {
      return c.json({ error: 'stt not enabled in config.yaml' }, 503);
    }
    if (!tts?.enabled) {
      return c.json({ error: 'tts not enabled in config.yaml' }, 503);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'expected multipart/form-data' }, 400);
    }

    const agent = (form.get('agent') as string | null) ?? (await defaultAgentFallback());
    if (!agent) {
      return c.json({ error: 'agent required (and no fallback configured)' }, 400);
    }
    if (!(await loadPersona(agent))) {
      return c.json({ error: `agent '${agent}' not found` }, 404);
    }

    const sessionRef = (form.get('session') as string | null) ?? 'main';
    const audio = form.get('audio');
    if (!(audio instanceof Blob)) {
      return c.json({ error: 'missing or invalid `audio` field' }, 400);
    }
    const voice = (form.get('voice') as string | null) || tts.voice || undefined;
    const language = (form.get('language') as string | null) || tts.language || undefined;
    const acceptHeader = c.req.header('accept');

    // ── Session resolver (same shape as /spawn-async fix) ──
    let session = await resolveSessionId(agent, sessionRef);
    if (!session) {
      const isExactId = /^\d{8}-\d{6}_[A-Za-z0-9_-]+$/.test(sessionRef);
      if (isExactId) {
        return c.json({ error: `session '${sessionRef}' not found` }, 404);
      }
      if (sessionRef === 'main') {
        session = 'main';
      } else {
        try {
          session = await createSession(agent, sessionRef);
        } catch (err) {
          return c.json({ error: `session create failed: ${(err as Error).message}` }, 400);
        }
      }
    }

    const turnId = randomUUID();
    const startedAt = Date.now();
    logger.info({
      msg: 'voice.turn.start',
      turnId,
      agent,
      session,
      audioBytes: audio.size,
      audioType: audio.type,
    });

    // ── 1. STT via existing upstream ──
    const sttProvider = config.providers[stt.provider];
    if (!sttProvider || sttProvider.engine !== 'openai-compatible') {
      return c.json({ error: 'stt provider misconfigured' }, 500);
    }
    const sttFwd = new FormData();
    const sttName = audio instanceof File && audio.name ? audio.name : guessAudioFilename(audio.type);
    sttFwd.append('file', audio, sttName);
    sttFwd.append('model', stt.model);
    if (stt.language) sttFwd.append('language', stt.language);
    const sttUrl = sttProvider.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
    const sttHeaders: Record<string, string> = {};
    if (sttProvider.apiKey) sttHeaders.Authorization = `Bearer ${sttProvider.apiKey}`;
    let transcript: string;
    try {
      const r = await fetch(sttUrl, { method: 'POST', headers: sttHeaders, body: sttFwd });
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        logger.warn({ msg: 'voice.turn.stt_failed', status: r.status, body: errBody.slice(0, 300) });
        return c.json({ error: `stt upstream returned ${r.status}` }, 502);
      }
      const j = (await r.json()) as { text?: string };
      if (typeof j.text !== 'string' || j.text.trim().length === 0) {
        return c.json({ error: 'stt produced empty transcript' }, 502);
      }
      transcript = j.text;
    } catch (err) {
      return c.json({ error: `stt unreachable: ${(err as Error).message}` }, 502);
    }
    logger.info({ msg: 'voice.turn.stt_done', turnId, chars: transcript.length });

    // ── 2. Run normal agent turn (lock, abort, SSE: startTurn) ──
    const collected: string[] = [];
    await startTurn({
      agent,
      session,
      text: transcript,
      turnId,
      origin: { kind: 'human', via: 'voice-stt' },
      inputModality: 'voice',
      sttProvider: stt.provider,
      // autoPlayRequested intentionally OFF — /voice/turn synthesizes
      // synchronously below; we don't want the run-turn hook to fire
      // a duplicate background TTS too.
      // The sink collects the final text; startTurn still broadcasts
      // every event so open web/mobile clients see the turn live.
      publish: (event) => {
        if (event.event === 'chat' && event.data.state === 'final') {
          collected.push(event.data.text);
        }
      },
    });
    const assistantText = collected.join('').trim();

    if (!assistantText) {
      return c.json({ error: 'agent produced empty reply' }, 502);
    }

    // ── 3. Sanitize + synthesize ──
    const prepared = prepareForTts(assistantText);
    if (prepared.skipped) {
      // Voice clients still want SOMETHING. Fall back to a brief
      // spoken summary marker so the panel/bridge knows it was
      // intentional, not silence.
      prepared.text =
        'The reply contains structured content and will not be read aloud. Please check the chat history.';
      prepared.skipped = false;
    }

    const spec = negotiateFormat(acceptHeader, tts.reencode.enabled);
    let synth;
    try {
      synth = await synthesize(
        {
          text: prepared.text,
          ...(voice ? { voice } : {}),
          ...(language ? { language } : {}),
          format: spec.fmt,
          agent,
        },
        config,
      );
    } catch (err) {
      return c.json({ error: `tts failed: ${(err as Error).message}` }, 502);
    }
    const audioUrl = `/tts/cache/${synth.cacheKey}.${synth.ext}`;

    // ── 4. Append assistant_audio + SSE broadcast (for live watchers) ──
    await appendEvent(agent, session, {
      kind: 'assistant_audio',
      ts: Date.now(),
      engine: 'voice-turn',
      turnId,
      audio: {
        url: audioUrl,
        mime: synth.mime,
        ...(synth.durationMs !== undefined ? { durationMs: synth.durationMs } : {}),
        cacheKey: synth.cacheKey,
      },
    });
    await publish(agent, session, {
      event: 'assistant_audio',
      data: {
        turnId,
        url: audioUrl,
        mime: synth.mime,
        ...(synth.durationMs !== undefined ? { durationMs: synth.durationMs } : {}),
        cacheKey: synth.cacheKey,
      },
    });

    logger.info({
      msg: 'voice.turn.done',
      turnId,
      agent,
      session,
      transcriptChars: transcript.length,
      replyChars: assistantText.length,
      audioBytes: synth.bytes.length,
      cacheHit: synth.cacheHit,
      totalMs: Date.now() - startedAt,
    });

    return c.json({
      ok: true,
      agent,
      session,
      transcript,
      text: assistantText,
      audio: {
        url: audioUrl,
        mime: synth.mime,
        ...(synth.durationMs !== undefined ? { durationMs: synth.durationMs } : {}),
        cacheKey: synth.cacheKey,
      },
    });
  });
}
