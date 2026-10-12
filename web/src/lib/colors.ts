// Deterministic per-agent color fallback. Used when the server's
// /agents response doesn't include a `color` field (older somora
// versions). Same name → same color across reloads. Six-color
// palette so visually-distinct agents stay distinct in the dock + on
// window borders.

const PALETTE = [
  '#5cf2d6', // cyan-teal (matches the somora accent — first agent)
  '#9d8cff', // violet
  '#f5b942', // amber
  '#ff6b9d', // rose
  '#7fff95', // mint
  '#69b6ff', // sky
];

export function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/** Build the agent-icon-glyph linear-gradient — replicates the
 *  click-dummy's `accent` field which was a hardcoded 135deg from
 *  the agent color into a darker variant. We compute the darker side
 *  by interpolating to ~50% black. */
export function gradientFor(color: string): string {
  return `linear-gradient(135deg, ${color}, ${darken(color, 0.5)})`;
}

/** Hex → darker hex by mixing toward black. `amount` 0..1 = full
 *  black. Naive RGB lerp; good enough for visual gradients. */
function darken(hex: string, amount: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const f = (v: number) => Math.round(v * (1 - amount));
  const out = (f(r) << 16) | (f(g) << 8) | f(b);
  return '#' + out.toString(16).padStart(6, '0');
}

export function resolveAgentColor(agent: { name: string; color?: string }): string {
  return agent.color ?? colorFor(agent.name);
}

// ── Agent colours as text on the light theme ───────────────────────
// A user picks any colour for an agent. As text on a light surface a
// pale one (mint, yellow) is unreadable. `inkOnLight` darkens a colour
// just enough to reach the WCAG text contrast of 4.5:1 on white,
// keeping its hue; a colour that is dark enough comes back unchanged.
// The dark theme never uses it — there the colour stays as chosen.

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance (WCAG) of a #rrggbb colour, or null. */
export function luminance(hex: string): number | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/** Contrast ratio of two #rrggbb colours (1..21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a) ?? 0;
  const lb = luminance(b) ?? 1;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `color`, darkened until it reads on a light surface. Slightly above
 *  4.5:1 against white, because the chips sit on a faint tint of the
 *  same colour. Anything that is not #rrggbb is returned as given. */
export function inkOnLight(color: string): string {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  const rgb = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  for (let f = 1; f > 0; f -= 0.02) {
    const hex = '#' + rgb.map((v) => Math.round(v * f).toString(16).padStart(2, '0')).join('');
    if (contrast(hex, '#ffffff') >= 4.8) return f === 1 ? color : hex;
  }
  return '#000000';
}

/** CSS variables for an element whose text is in an agent's colour:
 *  `--ink` (the colour as chosen, used by the dark theme) and
 *  `--ink-light` (readable on the light theme). Pair with class
 *  `agent-ink`. */
export function inkVars(color: string): Record<string, string> {
  return { '--ink': color, '--ink-light': inkOnLight(color) };
}
