/**
 * Theming.
 *
 * Two independent axes:
 *
 *   Station accent  the interface picks up a colour tied to the station being
 *                   analysed, so a Tuticorin run never gets mistaken for a
 *                   Jaipur one at a glance.
 *
 *   Chart style     'notebook' reproduces matplotlib's defaults so a chart here
 *                   matches the same chart in the Colab notebooks. 'dark' keeps
 *                   the panel dark and follows the station accent instead.
 */

/* ------------------------------------------------------------------ *
 * The palette, sampled off the logo
 *
 * Read down the bar of the I at nine even steps: one continuous ramp from
 * indigo through violet, magenta and pink into coral and amber.
 *
 * It is a ramp, not a colour wheel. There is no green or cyan anywhere in it,
 * so nothing drawn from it can be green or cyan either — which is why the
 * stations below are spread along the ramp rather than keeping the hues they
 * once had.
 * ------------------------------------------------------------------ */

export const SPECTRUM = [
  '#4D62D5',  // 0  indigo
  '#7A40C8',  // 1  violet
  '#B62FC7',  // 2  purple
  '#E634C7',  // 3  magenta
  '#F051B0',  // 4  pink
  '#F5699A',  // 5  rose
  '#F27B75',  // 6  coral
  '#F79262',  // 7  salmon
  '#F5B35E',  // 8  amber
];

/** Sampled from the letter edges. */
export const EDGE_WARM = '#F6A566';
export const OUTLINE_PURPLE = '#4A0257';

/** The frame runs at full strength, so it uses the ramp as sampled. */
export const VIVID = SPECTRUM;

/**
 * Three stops for a station to breathe between, taken two apart rather than
 * adjacent.
 *
 * Adjacent stops on a smooth nine-step ramp differ by about 43 in RGB
 * distance, and once the prose keyframes mix them toward the resting ink that
 * falls to roughly 16 — below the point where the eye reads it as a colour
 * change at all. Two apart doubles the separation to about 82, which is
 * visible, while still keeping the station inside its own region of the ramp.
 */
export const BAND_SPREAD = 2;

export function band(i, spread = BAND_SPREAD) {
  const n = SPECTRUM.length;
  let lo = i - spread;
  let hi = i + spread;
  // At the ends of the ramp one neighbour falls outside it. Reflect that one
  // back past the accent rather than clamping it: clamping lands it on the
  // accent itself, and a station would breathe between a colour and itself.
  if (hi > n - 1) hi = i - spread * 2;
  if (lo < 0) lo = i + spread * 2;
  lo = Math.max(0, Math.min(n - 1, lo));
  hi = Math.max(0, Math.min(n - 1, hi));
  return [SPECTRUM[i], SPECTRUM[lo], SPECTRUM[hi]];
}

/* ------------------------------------------------------------------ *
 * Stations
 *
 * Spread along the ramp so each is distinguishable, warm end to cool end.
 * ------------------------------------------------------------------ */

export const SITE_THEMES = {
  Tuticorin: {
    accent: SPECTRUM[8], name: 'Amber', slug: 'tuticorin',
    reason: 'Salt pans and hard coastal sun',
    breathe: band(8),
    scape: {
      skyTop: '#1a1408', skyMid: '#4a3210', skyLow: '#c8862c', sun: '#FFD98A',
      land: '#120e06', water: '#3a2c10', terrain: 'coast', turbines: 7,
    },
  },
  Calcutta: {
    accent: SPECTRUM[3], name: 'Magenta', slug: 'calcutta',
    reason: 'Delta brick and sindoor',
    breathe: band(3),
    scape: {
      skyTop: '#1b0d0c', skyMid: '#4d1c18', skyLow: '#b8503f', sun: '#FFB39E',
      land: '#140a09', water: '#3d1a14', terrain: 'delta', turbines: 6,
    },
  },
  Ahmedabad: {
    accent: SPECTRUM[6], name: 'Coral', slug: 'ahmedabad',
    reason: 'Semi-arid dust and sandstone',
    breathe: band(6),
    scape: {
      skyTop: '#1a1209', skyMid: '#4f3316', skyLow: '#c47c34', sun: '#FFCE96',
      land: '#161009', water: null, terrain: 'arid', turbines: 8,
    },
  },
  Jaipur: {
    accent: SPECTRUM[4], name: 'Pink', slug: 'jaipur',
    reason: 'The Pink City',
    breathe: band(4),
    scape: {
      skyTop: '#170d15', skyMid: '#4a1f38', skyLow: '#c2648f', sun: '#FFC2DC',
      land: '#150c11', water: null, terrain: 'arid', turbines: 6,
    },
  },
  Madras: {
    accent: SPECTRUM[0], name: 'Indigo', slug: 'madras',
    reason: 'The Coromandel shoreline',
    breathe: band(0),
    scape: {
      skyTop: '#08161b', skyMid: '#14424f', skyLow: '#3f9fb5', sun: '#BFEEF7',
      land: '#071216', water: '#0f3540', terrain: 'coast', turbines: 7,
    },
  },
  Mormugao: {
    accent: SPECTRUM[1], name: 'Violet', slug: 'mormugao',
    reason: 'The Goan coast',
    breathe: band(1),
    scape: {
      skyTop: '#08170f', skyMid: '#15442a', skyLow: '#46a06a', sun: '#C6F2D6',
      land: '#07140d', water: '#0f3524', terrain: 'headland', turbines: 6,
    },
  },
};

/**
 * Before a dataset arrives there is no station, so the page breathes the whole
 * ramp: the three stops are spread end to end rather than adjacent.
 */
export const DEFAULT_THEME = {
  accent: SPECTRUM[4], name: 'Full ramp', slug: 'default',
  reason: 'No station yet — cycling the whole logo ramp',
  breathe: [SPECTRUM[0], SPECTRUM[4], SPECTRUM[8]],
  scape: {
    skyTop: '#120a1a', skyMid: '#3a1a4a', skyLow: '#b8608f', sun: '#F6A566',
    land: '#0b0714', water: '#2a1233', terrain: 'coast', turbines: 6,
  },
};

export function themeForSite(site) {
  return SITE_THEMES[site] ?? DEFAULT_THEME;
}

/** Text colour that sits legibly on any accent from the ramp. */
export const ON_ACCENT = '#160418';

/* ------------------------------------------------------------------ *
 * Model families
 *
 * Fixed regardless of station, so the legend keeps meaning something when you
 * switch sites. Taken from the two ends and the middle of the ramp.
 * ------------------------------------------------------------------ */

export const FAMILY = {
  tree: SPECTRUM[0],    // indigo
  neural: SPECTRUM[3],  // magenta
  hybrid: SPECTRUM[7],  // salmon
};

/** Series colours used by dark chart mode; notebook mode overrides with tab10. */
export const PALETTE = {
  teal: SPECTRUM[0], steel: SPECTRUM[1], amber: SPECTRUM[8],
  violet: SPECTRUM[2], coral: SPECTRUM[6], ink: '#F0ECFA',
};

/* ------------------------------------------------------------------ *
 * Chart palettes
 * ------------------------------------------------------------------ */

/** matplotlib's tab10 cycle, in order. Untouched: notebook mode is meant to
 *  reproduce the notebooks exactly, not the site's palette. */
export const TAB10 = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

export const NOTEBOOK = {
  key: 'notebook',
  panel: '#ffffff',
  panelRadius: 4,
  ink: '#000000',
  muted: '#000000',
  grid: '#b0b0b0',
  gridWidth: 0.8,
  spine: '#000000',
  spineWidth: 0.9,
  showSpines: true,
  observed: TAB10[0],
  predicted: TAB10[1],
  reference: '#d62728',
  positive: TAB10[0],
  negative: '#d62728',
  bar: TAB10[0],
  barMuted: '#c7c7c7',
  series: TAB10,
  density: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
  band: 'rgba(31,119,180,0.20)',
  fontSize: 10,
  family: FAMILY,
};

export function darkTheme(accent) {
  return {
    key: 'dark',
    panel: 'transparent',
    panelRadius: 0,
    ink: '#F0ECFA',
    muted: '#9B8FB8',
    grid: '#241A38',
    gridWidth: 1,
    spine: '#2A2040',
    spineWidth: 1,
    showSpines: false,
    observed: '#F0ECFA',
    predicted: accent,
    reference: SPECTRUM[6],
    positive: accent,
    negative: SPECTRUM[6],
    bar: accent,
    barMuted: '#2C2244',
    series: [accent, ...SPECTRUM.filter((c) => c !== accent)],
    density: ['#0d0a18', '#241541', '#6A2E9E', SPECTRUM[3], SPECTRUM[8]],
    band: hexToRgba(accent, 0.14),
    fontSize: 10,
    family: FAMILY,
  };
}

export function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function chartTheme(style, accent) {
  return style === 'notebook' ? NOTEBOOK : darkTheme(accent);
}

/* ------------------------------------------------------------------ *
 * Backdrop
 * ------------------------------------------------------------------ */

export const SCAPE_ORDER = ['Tuticorin', 'Calcutta', 'Ahmedabad', 'Jaipur', 'Madras', 'Mormugao'];

export const SLIDE_MS = 5000;
export const FADE_MS = 1400;

/**
 * Where a real photograph would live, if you have one you are licensed to use.
 * Drop a file at public/backgrounds/<slug>.jpg, list the slug in
 * public/backgrounds/manifest.json, and it replaces the drawn scene.
 */
export function photoPath(slug) {
  return `/backgrounds/${slug}.jpg`;
}

/* ------------------------------------------------------------------ *
 * The frame
 * ------------------------------------------------------------------ */

/**
 * The ramp, mirrored, then rotated so the station's own colour leads.
 *
 * A conic gradient wraps back on itself, and this palette is a ramp rather than
 * a wheel — indigo at one end, amber at the other. Running it round unmirrored
 * puts a hard amber-to-indigo seam on the frame. Mirroring makes the sequence
 * palindromic, so it closes seamlessly using only sampled colours.
 */
export function frameStops(accent) {
  const mirrored = [...SPECTRUM, ...SPECTRUM.slice(1, -1).reverse()];
  const at = mirrored.findIndex((c) => c.toUpperCase() === String(accent).toUpperCase());
  const rotated = at >= 0
    ? [...mirrored.slice(at), ...mirrored.slice(0, at)]
    : mirrored;
  return [...rotated, rotated[0]];
}

/** The same spectrum as a conic sweep, driven by --frame-angle. */
export function frameConic(accent) {
  const stops = frameStops(accent);
  const placed = stops.map((c, i) => `${c} ${((i / (stops.length - 1)) * 100).toFixed(2)}%`);
  return `conic-gradient(from var(--frame-angle, 0deg) at 50% 50%, ${placed.join(', ')})`;
}
