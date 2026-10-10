// A still from a finished video, for providers that serve none.
//
// The gallery needs a frame to show, and an agent needs an image to look
// at its own result with. Most providers have no thumbnail variant, so
// somora cuts one itself — with ffmpeg when the host has it, the same
// optional dependency spoken replies use. Without ffmpeg the video simply
// has no still; the web client then shows the video's own first frame.

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import type { Config } from '../config/types.ts';
import { storeMedia } from '../media/store.ts';
import { writeRecord } from '../media/records.ts';
import type { MediaRecord } from '../media/types.ts';

let missing = false;

/** A JPEG of the frame at `atSec`, at most 640 px wide. Null when ffmpeg
 *  is not installed or cannot read the file. */
export async function extractFrame(videoPath: string, atSec: number, timeoutMs = 30_000): Promise<Buffer | null> {
  if (missing) return null;
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', atSec.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') missing = true;
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolve(code === 0 && bytes.length > 0 ? bytes : null);
    });
  });
}

const pendingStills = new Map<string, Promise<MediaRecord>>();

/**
 * A video record with a still: the record as it is when it has one,
 * otherwise one cut now, stored beside the video and written into the
 * record. For videos made before somora cut its own stills; asked for by
 * the gallery, so each one is done once, when it is first shown.
 */
export function ensureVideoStill(record: MediaRecord, config: Config): Promise<MediaRecord> {
  if (record.kind !== 'video' || record.thumbPath) return Promise.resolve(record);
  const running = pendingStills.get(record.id);
  if (running) return running;
  const job = (async () => {
    const frame = await extractFrame(record.path, (record.durationSec ?? 0) * 0.1);
    if (!frame) return record;
    const t = await storeMedia({
      bytes: frame,
      prompt: record.prompt,
      config,
      kind: 'video',
      declaredMime: 'image/jpeg',
      filenameStem: record.filename.replace(/\.[^.]+$/, '') + '-thumb',
      now: new Date(record.createdAt),
    });
    const updated: MediaRecord = { ...record, thumbPath: t.path, thumbMime: t.mime };
    await writeRecord(updated);
    return updated;
  })().finally(() => pendingStills.delete(record.id));
  pendingStills.set(record.id, job);
  return job;
}
