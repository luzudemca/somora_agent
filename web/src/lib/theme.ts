// Light or dark for the web client (docs/web.md, "Theme"). Dark is the
// default for a first visit; the screen menu offers Dark, Light and
// Auto (follows the system). The choice is kept per browser.

export type ThemeChoice = 'dark' | 'light' | 'auto';

const KEY = 'somora.web.theme';

export function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'auto' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

function systemPrefersLight(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** The theme in effect for a choice. */
export function resolveTheme(choice: ThemeChoice, prefersLight = systemPrefersLight()): 'dark' | 'light' {
  if (choice === 'auto') return prefersLight ? 'light' : 'dark';
  return choice;
}

function apply(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice);
}

let mediaListener: (() => void) | null = null;

/** Apply the stored choice; with Auto, follow the system as it changes. */
export function startTheme(): void {
  const choice = readTheme();
  apply(choice);
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
  if (mq && !mediaListener) {
    mediaListener = () => {
      if (readTheme() === 'auto') apply('auto');
    };
    mq.addEventListener?.('change', mediaListener);
  }
}

export function setTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    /* this page only */
  }
  apply(choice);
}
