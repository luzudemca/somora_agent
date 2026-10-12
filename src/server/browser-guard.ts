// Requests a browser makes on behalf of another website.
//
// somora has no login: whoever reaches the port may use it. A browser
// is a bridge to that port for every website the user opens — a page
// can open `ws://127.0.0.1:18737/terminal/attach` or POST to
// `/chat/send`, and with DNS rebinding (a name of the attacker's that
// later resolves to 127.0.0.1) even read the answers. This guard turns
// those away and changes nothing else:
//
//   - Programs that are not browsers (the TUI, curl, scripts, MCP
//     children, agents' tools) send neither `Origin` nor `Sec-Fetch-*`
//     and pass untouched, whatever host name they use.
//   - A browser request passes when the address it was sent to (Host)
//     is one of this machine's names, and — when it says where it
//     comes from (Origin) — that page is somora itself: the same
//     address, or one of this machine's own addresses and names.
//   - A link from another website still opens somora (a top-level
//     navigation); a request a foreign page makes in the background
//     does not.
//
// For Host, "this machine's names" are generous: any IP address (DNS
// rebinding needs a name), localhost, the host name and `<host>.local`,
// Tailscale names (*.ts.net), `server.tls.publicHost` and
// `server.allowedHosts`. For Origin they are strict, because a page on
// someone else's IP or tailnet must not count: the request's own
// address, loopback and this machine's interface addresses, localhost,
// the host name, publicHost and allowedHosts.

import { hostname as osHostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

export interface BrowserRequest {
  method: string;
  /** Host the request was sent to (`host` header or HTTP/2 :authority). */
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  secFetchMode: string | undefined;
}

export interface GuardOptions {
  publicHost?: string;
  allowedHosts?: readonly string[];
  /** For tests; defaults to os.hostname(). */
  machineName?: string;
  /** For tests; defaults to the addresses of this machine's interfaces. */
  localAddresses?: readonly string[];
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** `name` without port and brackets, lower case. */
export function bareHost(value: string): string {
  let h = value.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h;
  }
  const colon = h.lastIndexOf(':');
  if (colon > 0 && h.indexOf(':') === colon) h = h.slice(0, colon);
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

export function isOwnHost(host: string, opts: GuardOptions): boolean {
  const h = bareHost(host);
  if (!h) return false;
  if (isIP(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.ts.net')) return true;
  if (machineNames(opts).includes(h)) return true;
  if (opts.publicHost && h === bareHost(opts.publicHost)) return true;
  return (opts.allowedHosts ?? []).some((a) => bareHost(a) === h);
}

function machineNames(opts: GuardOptions): string[] {
  const machine = (opts.machineName ?? osHostname()).toLowerCase();
  const short = machine.split('.')[0]!;
  return [machine, short, `${short}.local`];
}

let cachedAddresses: { at: number; list: string[] } | undefined;
function localAddresses(opts: GuardOptions): readonly string[] {
  if (opts.localAddresses) return opts.localAddresses;
  if (!cachedAddresses || Date.now() - cachedAddresses.at > 60_000) {
    const list = Object.values(networkInterfaces()).flatMap((rows) => (rows ?? []).map((r) => r.address.toLowerCase()));
    cachedAddresses = { at: Date.now(), list };
  }
  return cachedAddresses.list;
}

/** An address of this machine: loopback or one of its interfaces. */
export function isThisMachine(ip: string, opts: GuardOptions = {}): boolean {
  const h = bareHost(ip).replace(/^::ffff:/, '');
  return h.startsWith('127.') || h === '::1' || localAddresses(opts).includes(h);
}

/** The page a request comes from is somora itself. */
export function isOwnOrigin(originHost: string, requestHost: string | undefined, opts: GuardOptions): boolean {
  if (requestHost && originHost.toLowerCase() === requestHost.toLowerCase()) return true;
  const h = bareHost(originHost);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h)) return h.startsWith('127.') || h === '::1' || localAddresses(opts).includes(h);
  if (machineNames(opts).includes(h)) return true;
  if (opts.publicHost && h === bareHost(opts.publicHost)) return true;
  return (opts.allowedHosts ?? []).some((a) => bareHost(a) === h);
}

export function checkBrowserRequest(req: BrowserRequest, opts: GuardOptions): GuardVerdict {
  const fromBrowser = req.origin !== undefined || req.secFetchSite !== undefined;
  if (!fromBrowser) return { ok: true };

  if (req.host && !isOwnHost(req.host, opts)) {
    return { ok: false, reason: `host '${bareHost(req.host)}' is not one of this server's names` };
  }
  if (req.origin !== undefined) {
    let originHost: string | undefined;
    try {
      originHost = new URL(req.origin).host;
    } catch {
      originHost = undefined;
    }
    if (!originHost || !isOwnOrigin(originHost, req.host, opts)) {
      // A link followed from another website is fine; anything it
      // does in the background is not.
      if (isNavigation(req)) return { ok: true };
      return { ok: false, reason: `request from another website (${req.origin})` };
    }
    return { ok: true };
  }
  if (req.secFetchSite === 'cross-site' && !isNavigation(req)) {
    return { ok: false, reason: 'request from another website' };
  }
  return { ok: true };
}

function isNavigation(req: BrowserRequest): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && req.secFetchMode === 'navigate';
}
