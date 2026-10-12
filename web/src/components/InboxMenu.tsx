// The inbox in the taskbar (src/server/inbox.ts): a new version, the
// note from somora.ai, and things somora cannot fix by itself. One row
// per thing; a counter for what is new. Plain text — an address
// starting with https:// becomes a link, `backticks` become code.

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Inbox as InboxIcon } from 'lucide-react';
import { api, type InboxEntryDto } from '../lib/api';

const POLL_MS = 60_000;

function richText(text: string) {
  const parts = text.split(/(https:\/\/[^\s)]+|`[^`\n]+`)/g);
  return parts.map((p, i) => {
    if (/^https:\/\//.test(p)) {
      return (
        <a key={i} href={p} target="_blank" rel="noopener noreferrer">
          {p}
        </a>
      );
    }
    if (/^`[^`]+`$/.test(p)) return <code key={i}>{p.slice(1, -1)}</code>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

function when(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function InboxMenu() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<InboxEntryDto[]>([]);
  const [muted, setMuted] = useState<InboxEntryDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [showMuted, setShowMuted] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.inbox();
      setEntries(r.entries);
      setMuted(r.muted);
      setUnread(r.unread);
    } catch {
      /* quiet: the badge just keeps its last value */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      await refresh();
      // Opening the inbox reads what is in it.
      if (unread > 0) {
        await api.inboxRead().catch(() => undefined);
        setUnread(0);
      }
    }
  };

  const mute = async (key: string, mode: 'until-resolved' | 'forever') => {
    await api.inboxMute(key, mode).catch(() => undefined);
    await refresh();
  };
  const unmute = async (key: string) => {
    await api.inboxUnmute(key).catch(() => undefined);
    await refresh();
  };

  const urgent = entries.some((e) => !e.resolvedAt && !e.readAt && e.level === 'important');

  return (
    <div className="taskbar-gear" ref={ref}>
      <button
        className="taskbar-tool"
        type="button"
        title={unread > 0 ? `Inbox — ${unread} new` : 'Inbox'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        <InboxIcon size={14} />
        {unread > 0 && (
          <span className={`taskbar-gear-alert inbox-badge ${urgent ? '' : 'calm'}`} aria-label={`${unread} new`}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="taskbar-menu inbox-menu" role="dialog" aria-label="Inbox">
          <div className="inbox-head">Inbox</div>
          {entries.length === 0 && <div className="inbox-empty">Nothing here. Notices about updates and things that need you appear here.</div>}
          {entries.map((e) => (
            <div key={e.key} className={`inbox-entry level-${e.level} ${e.resolvedAt ? 'resolved' : ''} ${!e.readAt && !e.resolvedAt ? 'unread' : ''}`}>
              <div className="inbox-title">
                <span>{e.title}</span>
                <span className="inbox-when">{e.resolvedAt ? `resolved ${when(e.resolvedAt)}` : when(e.lastSeen)}</span>
              </div>
              <div className="inbox-text">{richText(e.text)}</div>
              {e.url && (
                <a className="inbox-link" href={e.url} target="_blank" rel="noopener noreferrer">
                  {e.url}
                </a>
              )}
              <div className="inbox-meta">
                {!e.resolvedAt && e.kind !== 'update' && e.kind !== 'news' && (
                  <span>
                    since {when(e.firstSeen)}
                    {e.count > 1 ? ` · ${e.count}×` : ''}
                  </span>
                )}
                {!e.resolvedAt && e.kind !== 'update' && e.kind !== 'news' && (
                  <button type="button" onClick={() => void mute(e.key, 'until-resolved')} title="Quiet until this is resolved once; it speaks again if it comes back after that">
                    Don't report again
                  </button>
                )}
                {(e.kind === 'news' || e.kind === 'update') && !e.resolvedAt && (
                  <button type="button" onClick={() => void mute(e.key, 'forever')} title="Hide this one">
                    Hide
                  </button>
                )}
              </div>
            </div>
          ))}
          {muted.length > 0 && (
            <div className="inbox-muted">
              <button type="button" className="inbox-muted-toggle" onClick={() => setShowMuted((v) => !v)}>
                {showMuted ? '▾' : '▸'} Muted ({muted.length})
              </button>
              {showMuted &&
                muted.map((e) => (
                  <div key={e.key} className="inbox-muted-row">
                    <span>{e.title}</span>
                    <button type="button" onClick={() => void unmute(e.key)}>
                      Report again
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
