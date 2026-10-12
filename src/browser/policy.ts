// Navigation policy for the shared browser: where may an agent send it?
//
// The page an agent reads is untrusted text, and "open this link" is
// the cheapest prompt injection there is. So the boundary is the same
// one web_fetch draws: public hosts yes, private networks only when the
// operator listed them (`browser.allowPrivate`), a deny list on top, and
// only http(s). Checked BEFORE a navigation is issued (open, click on a
// link) and again on every document request the browser makes (route
// interception in the service), which is what catches redirects.
//
// Not a network firewall: subresources (images, scripts, XHR) are not
// checked, and DNS rebinding after the check is out of scope for V1 —
// the same limits OpenClaw documents for its policy.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserConfig } from '../config/types.ts';

export interface PolicyVerdict {
  ok: boolean;
  reason?: string;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Addresses that are not the public internet: loopback, RFC1918,
 *  link-local (cloud metadata), CGNAT/Tailscale, benchmark, multicast
 *  and reserved ranges, IPv6 loopback/ULA/link-local/multicast, and
 *  IPv6 forms that carry an IPv4 address (mapped `::ffff:7f00:1`,
 *  compatible, NAT64 `64:ff9b::`, 6to4 `2002::`) — judged by that
 *  IPv4 address. Shared by web_fetch and the browser policy. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 4) return isPrivateV4(bare.split('.').map(Number));
  if (isIP(bare) === 6) {
    const w = ipv6Words(bare);
    if (!w) return true;
    const v4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
    const zeros = (n: number) => w.slice(0, n).every((x) => x === 0);
    if (zeros(8)) return true; // ::
    if (zeros(7) && w[7] === 1) return true; // ::1
    if (zeros(5) && (w[5] === 0xffff || w[5] === 0)) return isPrivateV4(v4(w[6]!, w[7]!)); // mapped / compatible
    if (w[0] === 0x64 && w[1] === 0xff9b) return isPrivateV4(v4(w[6]!, w[7]!)); // NAT64
    if (w[0] === 0x2002) return isPrivateV4(v4(w[1]!, w[2]!)); // 6to4
    if ((w[0]! & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if ((w[0]! & 0xffc0) === 0xfe80 || (w[0]! & 0xffc0) === 0xfec0) return true; // link-/site-local
    if ((w[0]! & 0xff00) === 0xff00) return true; // multicast
    if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
    if (w[0] === 0x100 && zeros(4)) return true; // discard 100::/64
    return false;
  }
  return false;
}

function isPrivateV4(o: number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, Tailscale
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Eight 16-bit words of an IPv6 address, or null. */
function ipv6Words(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tail: number[] = [];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return null;
    tail.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
    s = s.slice(0, s.length - dotted[0].length);
    if (!s.endsWith('::')) s = s.replace(/:$/, '');
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(':').map((h) => parseInt(h, 16)) : []);
  const head = part(halves[0]!);
  const rest = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - tail.length - head.length - rest.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
  return words.length === 8 && words.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? words : null;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => ((n << 8) + Number(o)) >>> 0, 0);
}

/** `host` matches an allow entry: exact hostname, `*.suffix`, exact IP, or IPv4 CIDR. */
export function matchesEntry(entry: string, host: string, ip: string | null): boolean {
  const e = entry.toLowerCase();
  const h = host.toLowerCase();
  if (e === h) return true;
  if (e.startsWith('*.') && (h === e.slice(2) || h.endsWith(e.slice(1)))) return true;
  if (ip) {
    if (e === ip) return true;
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(e);
    if (m && isIP(ip) === 4) {
      const bits = Number(m[2]);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (ipToInt(ip) & mask) === (ipToInt(m[1]!) & mask);
    }
  }
  return false;
}

/**
 * Decide whether `url` may be navigated to. Resolves the hostname so a
 * public-looking name that points into the LAN is caught. `resolve` is
 * injectable for tests.
 */
export async function checkNavigationAllowed(
  url: string,
  cfg: Pick<BrowserConfig, 'allowPrivate' | 'deny'>,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<PolicyVerdict> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: `not a valid URL: ${url}` };
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    return { ok: false, reason: `scheme '${u.protocol}' is not allowed — only http and https` };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'URL has no host' };
  for (const d of cfg.deny) {
    if (matchesEntry(d, host, isIP(host) ? host : null)) {
      return { ok: false, reason: `host '${host}' is on browser.deny` };
    }
  }
  const literal = isIP(host) ? [host] : null;
  let addrs: string[];
  try {
    addrs = literal ?? (await resolve(host));
  } catch (err) {
    return { ok: false, reason: `host '${host}' does not resolve: ${(err as Error).message}` };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) addrs = ['127.0.0.1', ...addrs];
  const privateAddrs = addrs.filter(isPrivateAddress);
  if (privateAddrs.length === 0) return { ok: true };
  for (const a of cfg.allowPrivate) {
    if (matchesEntry(a, host, null)) return { ok: true };
    if (privateAddrs.some((ip) => matchesEntry(a, host, ip))) return { ok: true };
  }
  return {
    ok: false,
    reason:
      `host '${host}' resolves to a private address (${privateAddrs.join(', ')}) — ` +
      'add it to browser.allowPrivate in config.yaml if agents may use it',
  };
}

async function defaultResolve(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true });
  return rows.map((r) => r.address);
}
