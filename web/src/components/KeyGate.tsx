// The door in front of the web and mobile clients (docs/security.md).
//
// With `server.auth: on` the server wants its login key. A browser
// signs in once — the key typed in here, or a link from
// `somora key link` that carries it after `#key=` — and gets a cookie
// that rides along on every request, stream and WebSocket from then on.
// Until then this page stands in for the app; the app itself does not
// load any data.
//
// Later refusals (a new key after `somora key rotate`, a cookie that
// ran out) bring the page back: every same-origin response with 401
// from the key check sends `somora:key-required`, and the status is
// asked again when the tab comes back into view.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { KOALA_MINT, Koala } from './Koala';

type GateState = 'checking' | 'open' | 'locked' | 'offline';

const KEY_REQUIRED = 'somora:key-required';

/** Pull `key=` out of the address fragment and drop it from the bar. */
function takeKeyFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const key = params.get('key');
  if (!key) return null;
  params.delete('key');
  const rest = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
  return key.trim();
}

async function signIn(key: string): Promise<string | null> {
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `sign-in failed (HTTP ${res.status})`;
  } catch {
    return 'cannot reach the server';
  }
}

async function signedIn(): Promise<GateState> {
  try {
    const res = await fetch('/auth/status', { cache: 'no-store' });
    if (!res.ok) return 'offline';
    const s = (await res.json()) as { auth?: string; signedIn?: boolean };
    return s.signedIn ? 'open' : 'locked';
  } catch {
    return 'offline';
  }
}

// Every 401 from the key check, wherever in the app it happens, raises
// the door again. Wrapped once per page.
let fetchWatched = false;
function watchFetch(): void {
  if (fetchWatched) return;
  fetchWatched = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    if (res.status === 401) {
      const target = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      const sameOrigin = new URL(target, window.location.href).origin === window.location.origin;
      if (sameOrigin && !target.includes('/auth/login')) window.dispatchEvent(new Event(KEY_REQUIRED));
    }
    return res;
  };
}

export function KeyGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const recheck = useCallback(async () => {
    setState(await signedIn());
  }, []);

  useEffect(() => {
    watchFetch();
    void (async () => {
      const fromLink = takeKeyFromHash();
      if (fromLink) {
        const failed = await signIn(fromLink);
        if (failed) setError(failed);
      }
      await recheck();
    })();
    const onRequired = () => void recheck();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void recheck();
    };
    window.addEventListener(KEY_REQUIRED, onRequired);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(KEY_REQUIRED, onRequired);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [recheck]);

  const submit = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    const failed = await signIn(key);
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    setKey('');
    await recheck();
  };

  if (state === 'open') return <>{children}</>;
  if (state === 'checking') return <div style={page} />;

  return (
    <div style={page}>
      <form
        style={card}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Koala size={56} color={KOALA_MINT} />
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: '12px 0 4px' }}>somora</h1>
        {state === 'offline' ? (
          <p style={muted}>The server does not answer. It may be restarting.</p>
        ) : (
          <p style={muted}>This somora wants its key. Enter it once; this browser remembers it.</p>
        )}
        <input
          type="password"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          placeholder="somora_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          style={input}
          aria-label="Key"
        />
        <button type="submit" disabled={busy || !key.trim()} style={button}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {state === 'offline' && (
          <button type="button" onClick={() => void recheck()} style={{ ...button, background: 'transparent', color: 'inherit', border: '1px solid rgba(255,255,255,0.2)' }}>
            Try again
          </button>
        )}
        {error && <p style={{ ...muted, color: '#ff8a8a' }}>{error}</p>}
        <p style={{ ...muted, fontSize: 12.5, marginTop: 14 }}>
          On the machine somora runs on, <code>somora key</code> shows the key and <code>somora key link</code> gives a link and a QR
          code for your phone.
        </p>
      </form>
    </div>
  );
}

/** Sign this browser out (the cookie goes; the key stays valid). */
export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.reload();
}

const page: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#0a0f0c',
  color: '#e6ecf3',
  fontFamily: 'Inter, system-ui, sans-serif',
  padding: 16,
  boxSizing: 'border-box',
};
const card: React.CSSProperties = {
  width: '100%',
  maxWidth: 380,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  gap: 8,
};
const muted: React.CSSProperties = { color: '#9aa4b2', fontSize: 14, lineHeight: 1.45, margin: '4px 0' };
const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.15)',
  background: '#11171f',
  color: 'inherit',
  fontSize: 15,
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  marginTop: 8,
};
const button: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: 'none',
  background: KOALA_MINT,
  color: '#0a0f0c',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};
