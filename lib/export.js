'use client';

/**
 * Taking the figures off the page.
 *
 * The charts are live SVG in the document, which is not the same thing as a
 * file. Two problems have to be solved before one can be saved:
 *
 *   Styling lives outside the element. Fills, strokes and fonts come from the
 *   stylesheet, much of it through custom properties — var(--accent) and the
 *   like. Serialise the node as it stands and you get a file whose colours
 *   resolve to nothing, because the stylesheet is not coming with it.
 *
 *   Fonts are not embedded. A standalone SVG asks the viewer for the family by
 *   name, so a chart opened elsewhere falls back to whatever that machine has.
 *   Generic families are appended so the fallback is at least sane.
 *
 * Both are handled by walking a clone and writing the computed value of every
 * property that matters onto each node.
 *
 * The ZIP writer is here for the same reason the models are: adding a library
 * to produce an archive of a dozen files is a poor trade. Stored, uncompressed
 * — SVG would compress well, but a deflate implementation is a great deal more
 * code than this, and the archive is a convenience rather than a transfer
 * format.
 */

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

/** The properties that actually decide how a chart looks. */
const CARRIED = [
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin',
  'opacity', 'mix-blend-mode',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
  'text-anchor', 'dominant-baseline', 'text-transform',
  'visibility', 'display',
];

const GENERIC_FALLBACK = ', system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Clone an SVG with every computed style written onto it.
 *
 * Walked in lockstep: the original is still in the document, so it can be
 * asked for its computed style, while the clone is what gets written to.
 */
function inlineStyles(source) {
  const clone = source.cloneNode(true);
  const from = [source, ...source.querySelectorAll('*')];
  const to = [clone, ...clone.querySelectorAll('*')];

  for (let i = 0; i < from.length; i++) {
    const computed = window.getComputedStyle(from[i]);
    const node = to[i];
    if (!node.style) continue;
    const parts = [];
    for (const prop of CARRIED) {
      const value = computed.getPropertyValue(prop);
      if (!value || value === 'normal' || value === 'none' && prop !== 'display') continue;
      parts.push(`${prop}:${prop === 'font-family' ? value + GENERIC_FALLBACK : value}`);
    }
    if (parts.length) node.setAttribute('style', parts.join(';'));
  }
  return clone;
}

/** Serialise a live chart into a standalone SVG document. */
export function svgToString(svg, { background = null } = {}) {
  const clone = inlineStyles(svg);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  const rect = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);

  if (background) {
    // A dark-mode chart is transparent, which reads as black in some viewers
    // and white in others. An explicit ground removes the question.
    const box = (clone.getAttribute('viewBox') || `0 0 ${w} ${h}`).split(/[\s,]+/).map(Number);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', box[0]);
    bg.setAttribute('y', box[1]);
    bg.setAttribute('width', box[2]);
    bg.setAttribute('height', box[3]);
    bg.setAttribute('fill', background);
    clone.insertBefore(bg, clone.firstChild);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/**
 * Rasterise a chart.
 *
 * Drawn at a multiple of its on-screen size, because a chart pasted into a
 * document or a slide at 1x looks soft.
 */
export function svgToPng(svg, { scale = 2, background = '#ffffff' } = {}) {
  return new Promise((resolve, reject) => {
    const text = svgToString(svg, { background });
    const rect = svg.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    const img = new Image();
    // A blob URL rather than a data URI: Safari refuses to draw an SVG data
    // URI onto a canvas, and large charts overflow the URI length limit.
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          blob ? resolve(blob) : reject(new Error('The canvas produced nothing.'));
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That chart could not be rasterised.'));
    };
    img.src = url;
  });
}

/* ------------------------------------------------------------------ *
 * Finding the charts on the page
 * ------------------------------------------------------------------ */

/** Turn a heading into something safe to use as a filename. */
export function slugify(text, fallback = 'chart') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

/**
 * Every chart currently rendered, with a name taken from the page.
 *
 * Named from the nearest preceding heading rather than a counter, so an
 * archive of twenty files is readable rather than chart-01 through chart-20.
 * The mark is skipped: it is the site's logo, not a figure.
 */
export function collectCharts(root = document) {
  const svgs = [...root.querySelectorAll('.main svg')]
    .filter((s) => !s.closest('.hero-mark'))
    .filter((s) => {
      const r = s.getBoundingClientRect();
      return r.width > 80 && r.height > 60;   // skip icons and swatches
    });

  const seen = new Map();
  return svgs.map((svg) => {
    const stage = svg.closest('.stage');
    const section = stage?.querySelector('.stage-title')?.textContent?.trim();

    // walk back through previous siblings and up, for the nearest heading
    let label = null;
    let node = svg.closest('.chart-figure') ?? svg;
    while (node && !label) {
      let prev = node.previousElementSibling;
      while (prev && !label) {
        if (prev.classList?.contains('eyebrow') || /^H[1-4]$/.test(prev.tagName)) {
          label = prev.textContent.trim();
        }
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
      if (node?.classList?.contains('stage')) break;
    }

    const base = slugify([section, label].filter(Boolean).join('-'), 'chart');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { svg, name: n > 1 ? `${base}-${n}` : base, section: section ?? '', label: label ?? '' };
  });
}

/* ------------------------------------------------------------------ *
 * ZIP
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosStamp(date = new Date()) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5)
    | (date.getDate() & 31);
  return { time, day };
}

/**
 * Build a ZIP from [{ name, data }], where data is a string or Uint8Array.
 *
 * Stored, not deflated. SVG would compress to a fraction of its size, but a
 * deflate implementation is far more code than the whole of the rest of this
 * file, and the archive exists to save twenty clicks rather than bandwidth.
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const crc = crc32(data);
    const { time, day } = dosStamp(file.date);

    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(time), ...u16(day),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    parts.push(new Uint8Array(local), nameBytes, data);

    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(time), ...u16(day),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]);
    central.push(nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const dirParts = [];
  let dirLength = 0;
  for (const entry of central) {
    const bytes = entry instanceof Uint8Array ? entry : new Uint8Array(entry);
    dirParts.push(bytes);
    dirLength += bytes.length;
  }

  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(dirLength), ...u32(offset), ...u16(0),
  ]);

  return new Blob([...parts, ...dirParts, end], { type: 'application/zip' });
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // revoked on a delay: Firefox cancels the download if the URL goes away
  // before it has started reading from it
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(name, text, type = 'text/plain') {
  downloadBlob(name, new Blob([text], { type }));
}
