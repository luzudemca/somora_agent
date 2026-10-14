// The loaded config.yaml and when it was loaded, shared by index.ts and
// the route modules in src/server/routes/. An exported `let` is a live
// binding: after POST /config/reload every importer reads the new value,
// as the code did when all routes lived in index.ts. Only the setters
// below change it.
import type { Config } from '../config/types.ts';

export let config: Config;
/** Reload bookkeeping for GET /config/status + POST /config/reload. */
export let configLoadedAt = new Date().toISOString();
export let configLoadedMtimeMs = 0;

export function setConfig(next: Config): void {
  config = next;
}
export function setConfigLoadedAt(iso: string): void {
  configLoadedAt = iso;
}
export function setConfigMtime(ms: number): void {
  configLoadedMtimeMs = ms;
}
