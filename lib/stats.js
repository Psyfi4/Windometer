/**
 * Evaluation statistics, matching the protocol in Yadav et al. (2025).
 *
 * RMSE / MAE / R^2 / MAPE, 95% moving-block bootstrap confidence intervals,
 * pairwise Diebold-Mariano tests with a Newey-West correction, P95 tail
 * behaviour, Bland-Altman agreement, and bias across deciles of observed speed.
 *
 * Pure functions over typed arrays. No dependencies, runs in Node or a browser.
 */

export const BLOCK_HOURS = 24;
export const NEWEY_WEST_LAG = 23;

/* ------------------------------------------------------------------ *
 * Min-max scaling
 *
 * Table 1 of the paper reports RMSE near 0.086 while its figures run on
 * axes of 0.0-0.8, which corresponds to a min-max scaled target rather
 * than raw m/s. Fitted on training values only so the test block leaks
 * nothing.
 * ------------------------------------------------------------------ */
export function makeScaler(yTrain) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < yTrain.length; i++) {
    const v = yTrain[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi > lo ? hi - lo : 1;
  return {
    lo, hi, span,
    transform(arr) {
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = (arr[i] - lo) / span;
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Point metrics
 * ------------------------------------------------------------------ */
export function rmse(yTrue, yPred) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const d = yTrue[i] - yPred[i];
    s += d * d;
  }
  return Math.sqrt(s / yTrue.length);
}

export function mae(yTrue, yPred) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) s += Math.abs(yTrue[i] - yPred[i]);
  return s / yTrue.length;
}

export function r2(yTrue, yPred) {
  let mean = 0;
  for (let i = 0; i < yTrue.length; i++) mean += yTrue[i];
  mean /= yTrue.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const d = yTrue[i] - yPred[i];
    const t = yTrue[i] - mean;
    ssRes += d * d;
    ssTot += t * t;
  }
  return ssTot === 0 ? NaN : 1 - ssRes / ssTot;
}

/** Mean absolute percentage error, skipping zero denominators. */
export function mape(yTrue, yPred) {
  let s = 0, n = 0;
  for (let i = 0; i < yTrue.length; i++) {
    if (yTrue[i] === 0) continue;
    s += Math.abs((yTrue[i] - yPred[i]) / yTrue[i]);
    n++;
  }
  return n === 0 ? NaN : (s / n) * 100;
}

export function allMetrics(yTrue, yPred) {
  return {
    rmse: rmse(yTrue, yPred),
    mae: mae(yTrue, yPred),
    r2: r2(yTrue, yPred),
    mape: mape(yTrue, yPred),
  };
}

/* ------------------------------------------------------------------ *
 * Deterministic RNG so a rerun reproduces the same intervals
 * ------------------------------------------------------------------ */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Moving-block bootstrap
 *
 * Resamples contiguous 24-hour blocks so temporal dependence survives the
 * resampling; an i.i.d. bootstrap would produce intervals that are far too
 * narrow on hourly wind data.
 * ------------------------------------------------------------------ */
export function movingBlockCI(yTrue, yPred, metric = 'rmse', block = BLOCK_HOURS, nBoot = 1000, seed = 42) {
  const fn = metric === 'rmse' ? rmse : mae;
  const point = fn(yTrue, yPred);
  const n = yTrue.length;
  if (n <= block) return { point, lo: NaN, hi: NaN };

  const rand = mulberry32(seed);
  const nBlocks = Math.ceil(n / block);
  const maxStart = n - block;
  const bt = new Float64Array(nNormalise(nBoot));
  const sampleTrue = new Float64Array(n);
  const samplePred = new Float64Array(n);

  for (let b = 0; b < bt.length; b++) {
    let k = 0;
    for (let blk = 0; blk < nBlocks && k < n; blk++) {
      const start = Math.floor(rand() * maxStart);
      for (let j = 0; j < block && k < n; j++, k++) {
        sampleTrue[k] = yTrue[start + j];
        samplePred[k] = yPred[start + j];
      }
    }
    bt[b] = fn(sampleTrue, samplePred);
  }

  const sorted = Array.from(bt).sort((a, b) => a - b);
  return {
    point,
    lo: quantileSorted(sorted, 0.025),
    hi: quantileSorted(sorted, 0.975),
  };
}

function nNormalise(n) {
  return Math.max(50, Math.min(5000, n | 0));
}

export function quantileSorted(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function quantile(values, q) {
  return quantileSorted(Array.from(values).sort((a, b) => a - b), q);
}

/* ------------------------------------------------------------------ *
 * Normal CDF, for DM p-values
 * ------------------------------------------------------------------ */
export function normalCdf(x) {
  // Abramowitz & Stegun 7.1.26 applied to erf
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/* ------------------------------------------------------------------ *
 * Diebold-Mariano
 *
 * Two-sided, Newey-West HAC variance at lag 23. A negative statistic
 * favours model A.
 * ------------------------------------------------------------------ */
export function dieboldMariano(yTrue, predA, predB, loss = 'squared', lag = NEWEY_WEST_LAG) {
  const T = yTrue.length;
  const d = new Float64Array(T);
  for (let i = 0; i < T; i++) {
    const ea = yTrue[i] - predA[i];
    const eb = yTrue[i] - predB[i];
    d[i] = loss === 'squared' ? ea * ea - eb * eb : Math.abs(ea) - Math.abs(eb);
  }
  let dBar = 0;
  for (let i = 0; i < T; i++) dBar += d[i];
  dBar /= T;

  const dev = new Float64Array(T);
  for (let i = 0; i < T; i++) dev[i] = d[i] - dBar;

  let s = 0;
  for (let i = 0; i < T; i++) s += dev[i] * dev[i];
  s /= T;

  const maxLag = Math.min(lag, T - 1);
  for (let j = 1; j <= maxLag; j++) {
    let g = 0;
    for (let i = j; i < T; i++) g += dev[i] * dev[i - j];
    g /= T;
    s += 2 * (1 - j / (lag + 1)) * g;
  }

  if (!(s > 0) || T === 0) return { stat: NaN, p: NaN, meanDiff: dBar };
  const stat = dBar / Math.sqrt(s / T);
  return { stat, p: 2 * (1 - normalCdf(Math.abs(stat))), meanDiff: dBar };
}

/** Pairwise DM p-values across a map of name -> predictions. */
export function dmMatrix(yTrue, predictions, loss = 'squared') {
  const names = Object.keys(predictions);
  const rows = {};
  for (const a of names) {
    rows[a] = {};
    for (const b of names) {
      rows[a][b] = a === b ? NaN : dieboldMariano(yTrue, predictions[a], predictions[b], loss).p;
    }
  }
  return { names, rows };
}

/* ------------------------------------------------------------------ *
 * Tail robustness at P95
 * ------------------------------------------------------------------ */
export function tailAnalysis(yTrue, yPred, q = 0.95) {
  const threshold = quantile(yTrue, q);
  const t = [], p = [];
  let hits = 0;
  for (let i = 0; i < yTrue.length; i++) {
    if (yTrue[i] >= threshold) {
      t.push(yTrue[i]);
      p.push(yPred[i]);
      if (yPred[i] >= threshold) hits++;
    }
  }
  if (!t.length) {
    return { threshold, nTail: 0, tailRmse: NaN, tailMae: NaN, exceedanceRecall: NaN };
  }
  return {
    threshold,
    nTail: t.length,
    tailRmse: rmse(t, p),
    tailMae: mae(t, p),
    exceedanceRecall: hits / t.length,
  };
}

/* ------------------------------------------------------------------ *
 * Agreement and bias structure
 * ------------------------------------------------------------------ */
export function blandAltman(yTrue, yPred) {
  const n = yTrue.length;
  const diff = new Float64Array(n);
  const meanPair = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    diff[i] = yTrue[i] - yPred[i];
    meanPair[i] = (yTrue[i] + yPred[i]) / 2;
    sum += diff[i];
  }
  const bias = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (diff[i] - bias) ** 2;
  const sd = Math.sqrt(varSum / (n - 1));
  const loaLower = bias - 1.96 * sd;
  const loaUpper = bias + 1.96 * sd;
  let inside = 0;
  for (let i = 0; i < n; i++) if (diff[i] >= loaLower && diff[i] <= loaUpper) inside++;
  return { bias, sd, loaLower, loaUpper, diff, meanPair, withinPct: (inside / n) * 100 };
}

/** Mean error by decile of observed speed. Reveals under-calling of strong wind. */
export function biasByDecile(yTrue, yPred, bins = 10) {
  const idx = Array.from({ length: yTrue.length }, (_, i) => i)
    .sort((a, b) => yTrue[a] - yTrue[b]);
  const per = Math.floor(idx.length / bins);
  const out = [];
  for (let b = 0; b < bins; b++) {
    const start = b * per;
    const end = b === bins - 1 ? idx.length : (b + 1) * per;
    if (end <= start) continue;
    let obs = 0, err = 0, abs = 0;
    for (let i = start; i < end; i++) {
      const j = idx[i];
      obs += yTrue[j];
      err += yPred[j] - yTrue[j];
      abs += Math.abs(yPred[j] - yTrue[j]);
    }
    const n = end - start;
    out.push({ decile: b, obsCentre: obs / n, meanError: err / n, absError: abs / n, n });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Full bundle for one model
 * ------------------------------------------------------------------ */
export function evaluateModel(yTrue, yPred, scaler, nBoot = 1000) {
  const raw = allMetrics(yTrue, yPred);
  const out = { raw, scaled: null, rmseCI: null, maeCI: null, tail: tailAnalysis(yTrue, yPred) };
  if (scaler) {
    const ys = scaler.transform(yTrue);
    const ps = scaler.transform(yPred);
    out.scaled = allMetrics(ys, ps);
    out.rmseCI = movingBlockCI(ys, ps, 'rmse', BLOCK_HOURS, nBoot);
    out.maeCI = movingBlockCI(ys, ps, 'mae', BLOCK_HOURS, nBoot);
  }
  return out;
}
