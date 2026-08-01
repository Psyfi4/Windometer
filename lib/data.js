/**
 * Dataset ingestion and preprocessing.
 *
 * Takes rows already parsed out of a workbook or CSV and normalises them to a
 * continuous hourly series, then applies the study's gap rule and builds the 24
 * causal lag features.
 *
 * Two layouts are recognised:
 *   wide  IMD station files: one row per day, YEAR / MN / DT plus S01..S24
 *   long  one row per reading: a timestamp column and a wind-speed column
 *
 * Feature matrices are column-major Float64Array so the tree builder can scan a
 * feature contiguously.
 */

export const LAG_HOURS = 24;
export const HOUR_MS = 3600 * 1000;

const TIME_HINTS = ['datetime', 'date_time', 'timestamp', 'date', 'time', 'obs_time'];
const SPEED_HINTS = ['windspeed', 'wind_speed', 'wind speed', 'ws', 'speed',
  'wind', 'velocity', 'mws', 'value'];

export class DataFormatError extends Error {}

/* ------------------------------------------------------------------ *
 * Format detection
 * ------------------------------------------------------------------ */

export function detectFormat(headers) {
  const upper = headers.map((h) => String(h).trim().toUpperCase());
  const sCols = upper.filter((h) => /^S\d{1,2}$/.test(h));
  const hasYmd = ['YEAR', 'MN', 'DT'].every((k) => upper.includes(k));
  return sCols.length >= 12 && hasYmd ? 'wide' : 'long';
}

function findColumn(headers, hints) {
  const lower = headers.map((h) => String(h).trim().toLowerCase());
  for (const hint of hints) {
    const i = lower.indexOf(hint);
    if (i >= 0) return headers[i];
  }
  for (const hint of hints) {
    const i = lower.findIndex((h) => h.includes(hint));
    if (i >= 0) return headers[i];
  }
  return null;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/* ------------------------------------------------------------------ *
 * Wide (IMD) layout
 * ------------------------------------------------------------------ */

export function wideToHourly(rows, headers) {
  const upper = {};
  for (const h of headers) upper[String(h).trim().toUpperCase()] = h;
  const sCols = headers
    .filter((h) => /^S\d{1,2}$/.test(String(h).trim().toUpperCase()))
    .sort((a, b) => parseInt(String(a).replace(/\D/g, ''), 10)
      - parseInt(String(b).replace(/\D/g, ''), 10));

  if (!sCols.length) throw new DataFormatError('No hourly S01–S24 columns found.');
  const yc = upper.YEAR, mc = upper.MN, dc = upper.DT;
  if (!yc || !mc || !dc) {
    throw new DataFormatError('Wide layout needs YEAR, MN and DT columns.');
  }

  const points = [];
  for (const row of rows) {
    const y = num(row[yc]), m = num(row[mc]), d = num(row[dc]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) continue;
    if (m < 1 || m > 12 || d < 1 || d > 31) continue;
    for (let h = 0; h < sCols.length; h++) {
      const t = Date.UTC(y, m - 1, d, h);
      // Date.UTC rolls invalid days over into the next month; drop those
      const check = new Date(t);
      if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) continue;
      points.push([t, num(row[sCols[h]])]);
    }
  }
  return dedupeSort(points);
}

/* ------------------------------------------------------------------ *
 * Long layout
 * ------------------------------------------------------------------ */

export function longToHourly(rows, headers) {
  const tcol = findColumn(headers, TIME_HINTS);
  if (!tcol) {
    throw new DataFormatError(
      "Couldn't find a date column. Name one of your columns 'datetime', 'timestamp' or 'date'."
    );
  }
  let scol = findColumn(headers, SPEED_HINTS);
  if (!scol || scol === tcol) {
    scol = headers.find((h) => h !== tcol && Number.isFinite(num(rows[0]?.[h])));
  }
  if (!scol) {
    throw new DataFormatError(
      "Couldn't find a wind-speed column. Name one 'wind_speed' or 'ws'."
    );
  }

  const dayFirst = inferDayFirst(rows, tcol);

  const points = [];
  for (const row of rows) {
    const t = toEpoch(row[tcol], dayFirst);
    if (!Number.isFinite(t)) continue;
    // round rather than floor: Excel serial dates carry float error that can
    // otherwise drop a reading into the previous hour
    points.push([Math.round(t / HOUR_MS) * HOUR_MS, num(row[scol])]);
  }
  return averageDuplicates(points);
}

/**
 * Decide whether slash/dash dates are dd/mm or mm/dd by looking for a first
 * component above 12. Defaults to day-first, which is the common convention
 * outside the United States and matches IMD records.
 */
export function inferDayFirst(rows, tcol) {
  let sawDayFirst = false, sawMonthFirst = false;
  const limit = Math.min(rows.length, 4000);
  for (let i = 0; i < limit; i++) {
    const v = rows[i]?.[tcol];
    if (typeof v !== 'string') continue;
    const m = v.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (!m) continue;
    if (+m[1] > 12) sawDayFirst = true;
    if (+m[2] > 12) sawMonthFirst = true;
  }
  if (sawDayFirst && !sawMonthFirst) return true;
  if (sawMonthFirst && !sawDayFirst) return false;
  return true;
}

export function toEpoch(v, dayFirst = true) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') {
    // Excel serial dates: days since 1899-12-30
    if (v > 20000 && v < 80000) return (v - 25569) * 86400 * 1000;
    return v;
  }
  const s = String(v).trim();

  // Try the ambiguous numeric form first: Date.parse would silently read
  // dd/mm/yyyy as mm/dd/yyyy and shift most of the record.
  const m = s.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?(?::(\d{2}))?/
  );
  if (m) {
    const a = +m[1], b = +m[2];
    const day = dayFirst ? a : b;
    const month = dayFirst ? b : a;
    return Date.UTC(+m[3], month - 1, day, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }

  // ISO and other unambiguous forms. Treat a bare 'YYYY-MM-DD hh:mm:ss' as UTC
  // so a viewer's timezone can't shift the series.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (iso) {
    return Date.UTC(+iso[1], +iso[2] - 1, +iso[3],
      iso[4] ? +iso[4] : 0, iso[5] ? +iso[5] : 0, iso[6] ? +iso[6] : 0);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function dedupeSort(points) {
  points.sort((a, b) => a[0] - b[0]);
  const times = [], values = [];
  for (const [t, v] of points) {
    if (times.length && times[times.length - 1] === t) continue;
    times.push(t); values.push(v);
  }
  return expandToHourlyGrid(times, values);
}

function averageDuplicates(points) {
  points.sort((a, b) => a[0] - b[0]);
  const times = [], values = [];
  let i = 0;
  while (i < points.length) {
    const t = points[i][0];
    let sum = 0, n = 0;
    while (i < points.length && points[i][0] === t) {
      if (Number.isFinite(points[i][1])) { sum += points[i][1]; n++; }
      i++;
    }
    times.push(t);
    values.push(n ? sum / n : NaN);
  }
  return expandToHourlyGrid(times, values);
}

/** Fill the calendar so every hour between first and last exists, NaN if absent. */
function expandToHourlyGrid(times, values) {
  if (!times.length) throw new DataFormatError('No usable rows found.');
  const start = times[0], end = times[times.length - 1];
  const n = Math.floor((end - start) / HOUR_MS) + 1;
  if (n > 5_000_000) throw new DataFormatError('That span is too large to process.');

  const gridTimes = new Float64Array(n);
  const gridValues = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) gridTimes[i] = start + i * HOUR_MS;
  for (let i = 0; i < times.length; i++) {
    const slot = Math.round((times[i] - start) / HOUR_MS);
    if (slot >= 0 && slot < n) gridValues[slot] = values[i];
  }
  return { times: gridTimes, values: gridValues };
}

/* ------------------------------------------------------------------ *
 * Gap handling
 *
 * The paper's rule: gaps under six hours by linear interpolation, longer gaps
 * by the monthly median for that calendar month.
 * ------------------------------------------------------------------ */

export function fillGaps(times, values, maxShortGap = 6) {
  const n = values.length;
  const out = Float64Array.from(values);
  let missingBefore = 0;
  for (let i = 0; i < n; i++) if (!Number.isFinite(out[i])) missingBefore++;

  let filledInterp = 0, filledMonthly = 0, filledGlobal = 0;

  // pass 1: short interior gaps
  let i = 0;
  while (i < n) {
    if (Number.isFinite(out[i])) { i++; continue; }
    let j = i;
    while (j < n && !Number.isFinite(out[j])) j++;
    const len = j - i;
    const hasLeft = i > 0 && Number.isFinite(out[i - 1]);
    const hasRight = j < n && Number.isFinite(out[j]);
    if (len <= maxShortGap && hasLeft && hasRight) {
      const a = out[i - 1], b = out[j];
      for (let k = i; k < j; k++) out[k] = a + (b - a) * ((k - i + 1) / (len + 1));
      filledInterp += len;
    }
    i = j;
  }

  // pass 2: monthly medians
  const months = new Int8Array(n);
  for (let k = 0; k < n; k++) months[k] = new Date(times[k]).getUTCMonth();
  const byMonth = Array.from({ length: 12 }, () => []);
  for (let k = 0; k < n; k++) if (Number.isFinite(out[k])) byMonth[months[k]].push(out[k]);
  const monthlyMedian = byMonth.map((arr) => {
    if (!arr.length) return NaN;
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  });

  const present = [];
  for (let k = 0; k < n; k++) if (Number.isFinite(out[k])) present.push(out[k]);
  present.sort((a, b) => a - b);
  const globalMedian = present.length ? present[Math.floor(present.length / 2)] : 0;

  for (let k = 0; k < n; k++) {
    if (Number.isFinite(out[k])) continue;
    const med = monthlyMedian[months[k]];
    if (Number.isFinite(med)) { out[k] = med; filledMonthly++; }
    else { out[k] = globalMedian; filledGlobal++; }
  }

  return {
    values: out,
    report: {
      totalHours: n,
      missingBefore,
      missingPct: n ? (missingBefore / n) * 100 : 0,
      filledInterpolation: filledInterp,
      filledMonthlyMedian: filledMonthly,
      filledGlobalMedian: filledGlobal,
      missingAfter: 0,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Units
 * ------------------------------------------------------------------ */

export function toMetresPerSecond(values, unit) {
  if (unit !== 'kmh') return values;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] / 3.6;
  return out;
}

/* ------------------------------------------------------------------ *
 * Features: 24 strictly causal lags predicting t+1
 * ------------------------------------------------------------------ */

export function makeFeatures(values, times, nLags = LAG_HOURS) {
  const n = values.length;
  const rows = n - nLags - 1;
  if (rows < 100) throw new DataFormatError('Not enough hours to build lag features.');

  const X = new Float64Array(rows * nLags);
  const y = new Float64Array(rows);
  const idx = new Float64Array(rows);

  for (let i = 0; i < rows; i++) {
    const t = i + nLags;
    for (let f = 0; f < nLags; f++) X[f * rows + i] = values[t - 1 - f]; // Lag_1..Lag_n
    y[i] = values[t];
    idx[i] = times[t];
  }
  return { X, y, times: idx, nRows: rows, nCols: nLags };
}

export function chronologicalSplit(fx, testSize = 0.2, trainCap = null) {
  const { X, y, times, nRows, nCols } = fx;
  const splitAt = Math.floor(nRows * (1 - testSize));
  const trainStart = trainCap && splitAt > trainCap ? splitAt - trainCap : 0;

  const cut = (from, to) => {
    const m = to - from;
    const Xs = new Float64Array(m * nCols);
    const ys = new Float64Array(m);
    const ts = new Float64Array(m);
    for (let f = 0; f < nCols; f++) {
      for (let i = 0; i < m; i++) Xs[f * m + i] = X[f * nRows + from + i];
    }
    for (let i = 0; i < m; i++) { ys[i] = y[from + i]; ts[i] = times[from + i]; }
    return { X: Xs, y: ys, times: ts, nRows: m, nCols };
  };

  return { train: cut(trainStart, splitAt), test: cut(splitAt, nRows), splitAt };
}

/**
 * Reverse column order, so Lag_1..Lag_n becomes Lag_n..Lag_1.
 * Sequence models need timesteps oldest first; the lag matrix is built
 * newest first because that is the natural order for the tree learners.
 */
export function reverseColumns(block) {
  const cols = Array.from({ length: block.nCols }, (_, i) => block.nCols - 1 - i);
  return selectColumns(block, cols);
}

/** Keep only selected feature columns, preserving column-major layout. */
export function selectColumns(block, cols) {
  const { X, nRows } = block;
  const Xs = new Float64Array(nRows * cols.length);
  cols.forEach((c, j) => {
    for (let i = 0; i < nRows; i++) Xs[j * nRows + i] = X[c * nRows + i];
  });
  return { ...block, X: Xs, nCols: cols.length };
}

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

export function summarise(values, times) {
  const n = values.length;
  let sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (values[i] - mean) ** 2;
  const sorted = Float64Array.from(values).sort();
  const q = (p) => sorted[Math.min(n - 1, Math.floor((n - 1) * p))];

  const startYear = new Date(times[0]).getUTCFullYear();
  const endYear = new Date(times[n - 1]).getUTCFullYear();
  return {
    start: times[0], end: times[n - 1], startYear, endYear,
    nHours: n, nYears: endYear - startYear + 1,
    mean, median: q(0.5), std: Math.sqrt(varSum / n),
    min, max, p95: q(0.95),
  };
}

export function calendarParts(times) {
  const n = times.length;
  const months = new Int8Array(n), years = new Int16Array(n), hours = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const d = new Date(times[i]);
    months[i] = d.getUTCMonth() + 1;
    years[i] = d.getUTCFullYear();
    hours[i] = d.getUTCHours();
  }
  return { months, years, hours };
}

export function diurnalProfile(values, hours) {
  const sum = new Float64Array(24), cnt = new Int32Array(24), sq = new Float64Array(24);
  for (let i = 0; i < values.length; i++) { sum[hours[i]] += values[i]; cnt[hours[i]]++; }
  const mean = new Float64Array(24);
  for (let h = 0; h < 24; h++) mean[h] = cnt[h] ? sum[h] / cnt[h] : NaN;
  for (let i = 0; i < values.length; i++) sq[hours[i]] += (values[i] - mean[hours[i]]) ** 2;
  return Array.from({ length: 24 }, (_, h) => ({
    hour: h, mean: mean[h], sd: cnt[h] ? Math.sqrt(sq[h] / cnt[h]) : NaN,
  }));
}

/** Histogram of observed speeds, for the Weibull overlay. */
export function histogram(values, bins = 60) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  const width = (max - min) / bins || 1;
  const counts = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((values[i] - min) / width)));
    counts[b]++;
  }
  return Array.from({ length: bins }, (_, b) => ({
    centre: min + width * (b + 0.5),
    density: counts[b] / (values.length * width),
  }));
}

/** Monthly means of observed and predicted, for the Fig. 7 regression. */
export function monthlyPairs(yTrue, yPred, times) {
  const map = new Map();
  for (let i = 0; i < yTrue.length; i++) {
    const d = new Date(times[i]);
    const key = d.getUTCFullYear() * 100 + d.getUTCMonth();
    if (!map.has(key)) map.set(key, { a: 0, p: 0, n: 0 });
    const e = map.get(key);
    e.a += yTrue[i]; e.p += yPred[i]; e.n++;
  }
  return Array.from(map.entries()).sort((x, y2) => x[0] - y2[0]).map(([key, e]) => ({
    key, actual: e.a / e.n, predicted: e.p / e.n, n: e.n,
  }));
}
