/**
 * Theming.
 *
 * Two independent axes:
 *
 *   Station accent  the interface picks up a colour tied to the station being
 *                   analysed, so a Tuticorin run never gets mistaken for a
 *                   Jaipur one at a glance. Each is chosen to carry against
 *                   the near-black ground and to take dark text on top.
 *
 *   Chart style     'notebook' reproduces matplotlib's defaults — white panel,
 *                   the tab10 cycle, #b0b0b0 grid — so a chart here matches the
 *                   same chart in the Colab notebooks. 'dark' keeps the panel
 *                   dark and follows the station accent instead.
 */

/* ------------------------------------------------------------------ *
 * Station accents
 * ------------------------------------------------------------------ */

export const SITE_THEMES = {
  Tuticorin: {
    accent: '#FFC64D', name: 'Amber', slug: 'tuticorin',
    reason: 'Salt pans and hard coastal sun',
    breathe: ['#FFC64D', '#FF9A4D', '#FFE08A'],
    scape: {
      skyTop: '#1a1408', skyMid: '#4a3210', skyLow: '#c8862c', sun: '#FFD98A',
      land: '#120e06', water: '#3a2c10', terrain: 'coast', turbines: 7,
    },
  },
  Calcutta: {
    accent: '#FF6B5B', name: 'Vermilion', slug: 'calcutta',
    reason: 'Delta brick and sindoor red',
    breathe: ['#FF6B5B', '#FF9A4D', '#E8556B'],
    breatheReason: 'brick to sindoor',
    scape: {
      skyTop: '#1b0d0c', skyMid: '#4d1c18', skyLow: '#b8503f', sun: '#FFB39E',
      land: '#140a09', water: '#3d1a14', terrain: 'delta', turbines: 6,
    },
  },
  Ahmedabad: {
    accent: '#FF9A4D', name: 'Ochre', slug: 'ahmedabad',
    reason: 'Semi-arid dust and sandstone',
    breathe: ['#FF9A4D', '#FFC64D', '#E8763B'],
    scape: {
      skyTop: '#1a1209', skyMid: '#4f3316', skyLow: '#c47c34', sun: '#FFCE96',
      land: '#161009', water: null, terrain: 'arid', turbines: 8,
    },
  },
  Jaipur: {
    accent: '#FF7BB0', name: 'Rose', slug: 'jaipur',
    reason: 'The Pink City',
    breathe: ['#FF7BB0', '#FF9A4D', '#C98AE0'],
    scape: {
      skyTop: '#170d15', skyMid: '#4a1f38', skyLow: '#c2648f', sun: '#FFC2DC',
      land: '#150c11', water: null, terrain: 'arid', turbines: 6,
    },
  },
  Madras: {
    accent: '#4FD1E8', name: 'Cyan', slug: 'madras',
    reason: 'The Coromandel shoreline',
    breathe: ['#4FD1E8', '#55D98D', '#6C9CC4'],
    scape: {
      skyTop: '#08161b', skyMid: '#14424f', skyLow: '#3f9fb5', sun: '#BFEEF7',
      land: '#071216', water: '#0f3540', terrain: 'coast', turbines: 7,
    },
  },
  Mormugao: {
    accent: '#55D98D', name: 'Green', slug: 'mormugao',
    reason: 'The Goan coast',
    breathe: ['#55D98D', '#4FD1E8', '#A8D96B'],
    scape: {
      skyTop: '#08170f', skyMid: '#15442a', skyLow: '#46a06a', sun: '#C6F2D6',
      land: '#07140d', water: '#0f3524', terrain: 'headland', turbines: 6,
    },
  },
};

/** Fallback for an unrecognised or custom station. */
export const DEFAULT_THEME = {
  accent: '#5FD3C4', name: 'Sea glass', slug: 'default',
  reason: 'Unassigned station',
  breathe: ['#5FD3C4', '#6C9CC4', '#9D8CE0'],
  scape: {
    skyTop: '#08161a', skyMid: '#123a42', skyLow: '#3a8e93', sun: '#CFF1EE',
    land: '#071214', water: '#0e2f33', terrain: 'coast', turbines: 6,
  },
};

export function themeForSite(site) {
  return SITE_THEMES[site] ?? DEFAULT_THEME;
}

/** Text colour that sits legibly on the accent. All accents are light. */
export const ON_ACCENT = '#08100E';

/* ------------------------------------------------------------------ *
 * Model family colours
 *
 * Fixed regardless of station, so the legend keeps meaning something when
 * you switch sites.
 * ------------------------------------------------------------------ */

export const FAMILY = { tree: '#5FD3C4', neural: '#9D8CE0', hybrid: '#E3A857' };

/** Fixed series colours used by dark mode; notebook mode overrides with tab10. */
export const PALETTE = {
  teal: '#5FD3C4', steel: '#6C9CC4', amber: '#E3A857',
  violet: '#9D8CE0', coral: '#E56C73', ink: '#E6EEF3',
};

/* ------------------------------------------------------------------ *
 * Chart palettes
 * ------------------------------------------------------------------ */

/** matplotlib's tab10 cycle, in order. */
export const TAB10 = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

/**
 * Notebook style — matplotlib's rcParams defaults, which is what the Colab
 * figures were drawn with: white panel, black text and spines, #b0b0b0 grid,
 * observed in C0 blue, predicted in C1 orange, reference lines dashed red.
 */
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

/** Dark style — the workbench's own look, following the station accent. */
export function darkTheme(accent) {
  return {
    key: 'dark',
    panel: 'transparent',
    panelRadius: 0,
    ink: '#e6eef3',
    muted: '#7c8fa0',
    grid: '#1b2731',
    gridWidth: 1,
    spine: '#1e2a34',
    spineWidth: 1,
    showSpines: false,
    observed: '#e6eef3',
    predicted: accent,
    reference: '#e56c73',
    positive: accent,
    negative: '#e56c73',
    bar: accent,
    barMuted: '#2c3b46',
    series: [accent, '#9D8CE0', '#E3A857', '#6C9CC4', '#e56c73', '#7fd1a6', '#d89acf', '#c4b457'],
    density: ['#0d141a', '#173038', '#2c6e76', '#5fd3c4', '#d8f5ee'],
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

/** Stations in the order the backdrop cycles through them. */
export const SCAPE_ORDER = ['Tuticorin', 'Calcutta', 'Ahmedabad', 'Jaipur', 'Madras', 'Mormugao'];

export const SLIDE_MS = 5000;
export const FADE_MS = 1400;

/**
 * Where a real photograph would live, if you have one you are licensed to use.
 * Drop a file at public/backgrounds/<slug>.jpg and it replaces the drawn scene
 * for that station automatically; absent that, the vector scene is used.
 */
export function photoPath(slug) {
  return `/backgrounds/${slug}.jpg`;
}
