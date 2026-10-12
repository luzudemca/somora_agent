// Argument parsing + version compare for `somora update`. Kept apart
// from somora.ts (which runs main() on import) so it can be tested.

export type UpdateOpts =
  | { kind: 'opts'; channel: 'release' | 'edge'; version?: string; reinit: boolean; force: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export function parseUpdateArgs(args: string[]): UpdateOpts {
  let channel: 'release' | 'edge' = 'release';
  let reinit = true;
  let force = false;
  let version: string | undefined;
  for (const arg of args) {
    if (arg === '--edge') channel = 'edge';
    else if (arg === '--release') channel = 'release';
    else if (arg === '--no-reinit') reinit = false;
    else if (arg === '--force') force = true;
    else if (arg === '--help' || arg === '-h') return { kind: 'help' };
    else if (arg.startsWith('--')) return { kind: 'error', message: `unknown flag: ${arg}` };
    else if (version) return { kind: 'error', message: `multiple version args: ${version}, ${arg}` };
    else version = arg.replace(/^v/, '');
  }
  if (version && channel === 'edge') {
    return { kind: 'error', message: '--edge and an explicit version are mutually exclusive' };
  }
  if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    const old = /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(version);
    return {
      kind: 'error',
      message: old
        ? `${version} is a pre-npm version (four parts) and is not on npm — versions start at 2026.930.1`
        : `not a version: ${version} (expected e.g. 2026.930.1)`,
    };
  }
  return { kind: 'opts', channel, version, reinit, force };
}

/** Numeric compare of two `a.b.c[-pre]` versions; a pre-release sorts
 *  below the same version without one. Enough for the dist-tag pick —
 *  we never compare two different pre-releases of one version. */
export function compareVersions(a: string, b: string): number {
  const [an = '', apre] = a.split('-', 2);
  const [bn = '', bpre] = b.split('-', 2);
  const ap = an.split('.').map(Number);
  const bp = bn.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (d !== 0) return d;
  }
  if (apre === bpre) return 0;
  if (apre === undefined) return 1;
  if (bpre === undefined) return -1;
  return apre < bpre ? -1 : 1;
}

/** Packages with an install script: somora itself (its preinstall
 *  refuses a too old glibc) and the dependencies that build or fetch a
 *  binary. npm from 11.16 on wants them named on a global install
 *  (`--allow-scripts`); npm 12 skips the ones not named. update-args.test.mts
 *  holds this list against package.json, package-lock.json and install.sh. */
export const ALLOW_SCRIPTS = ['cpu-features', 'esbuild', 'fsevents', 'node-pty', 'onnxruntime-node', 'protobufjs', 'somora', 'ssh2'];

/** Extra arguments for `npm install -g`, given what `npm config get
 *  allow-scripts` printed: an npm that does not know the setting says
 *  "undefined" and must not get the flag. */
export function allowScriptsArgs(configGetOutput: string): string[] {
  return configGetOutput.trim() === 'undefined' ? [] : [`--allow-scripts=${ALLOW_SCRIPTS.join(',')}`];
}

export interface NpmTarget { version: string; node?: string; glibc?: string; lastForOlderGlibc?: string }

/** Read `npm view somora@<spec> version engines somora --json`. npm up
 *  to 11 prints one object; npm 12 prints the same object inside a
 *  one-element array. */
export function parseNpmView(stdout: string): NpmTarget | null {
  if (!stdout.trim()) return null;
  try {
    let parsed = JSON.parse(stdout) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.length !== 1) return null;
      parsed = parsed[0];
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const j = parsed as { version?: unknown; engines?: { node?: unknown }; somora?: { glibc?: unknown; lastForOlderGlibc?: unknown } };
    if (typeof j.version !== 'string') return null;
    return {
      version: j.version,
      ...(typeof j.engines?.node === 'string' ? { node: j.engines.node } : {}),
      ...(typeof j.somora?.glibc === 'string' ? { glibc: j.somora.glibc } : {}),
      ...(typeof j.somora?.lastForOlderGlibc === 'string' ? { lastForOlderGlibc: j.somora.lastForOlderGlibc } : {}),
    };
  } catch {
    return null;
  }
}
