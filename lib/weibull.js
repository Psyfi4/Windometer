/**
 * Weibull statistics via the Modified Energy Pattern Factor method.
 *
 * Implements Eqs. (3)-(11) of Yadav et al. (2025):
 *   Epf  = mean(v^3) / mean(v)^3
 *   k    = polyA(Epf) / polyB(Epf)        with the paper's fitted coefficients
 *   s    = vBar / Gamma(1 + 1/k)
 *   alpha= (0.65 - 0.19 log10 s_a) / (1 - 0.19 log10(z_a/z_ref))
 *   k_z  = k_a [1 - 0.19 log10(z_a/z_ref)] / [1 - 0.19 log10(z/z_ref)]
 *   s_z  = s_a (z/z_a)^alpha
 *   WPD  = 0.5 rho s^3 Gamma(1 + 3/k)
 *   MWS  = s Gamma(1 + 1/k)
 *
 * All speeds must be in m/s.
 */

export const A_COEFFS = [-0.2204, 3.2753, -5.7896, 2.1514, 0.5904];
export const B_COEFFS = [-1.2728, 3.6912, -2.6097, -0.8005, 0.9920];

export const AIR_DENSITY = 1.225;
export const ANEMOMETER_HEIGHT = 10;
export const REFERENCE_HEIGHT = 18;
export const DEFAULT_HUB_HEIGHTS = [100, 120, 150];
export const DEFAULT_ALPHA = 0.14;

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------------------ *
 * Lanczos approximation to the gamma function
 * ------------------------------------------------------------------ */
const G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function gamma(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < G + 2; i++) x += LANCZOS[i] / (z + i);
  const t = z + G + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/* ------------------------------------------------------------------ *
 * Parameter estimation
 * ------------------------------------------------------------------ */
export function energyPatternFactor(values) {
  let sum = 0, sumCube = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || v <= 0) continue;
    sum += v;
    sumCube += v * v * v;
    n++;
  }
  if (n === 0) return NaN;
  const mean = sum / n;
  if (mean <= 0) return NaN;
  return (sumCube / n) / (mean * mean * mean);
}

export function shapeFromEpf(epf) {
  if (!Number.isFinite(epf)) return NaN;
  let num = 0, den = 0;
  for (let i = 0; i < A_COEFFS.length; i++) {
    num += A_COEFFS[i] * Math.pow(epf, i);
    den += B_COEFFS[i] * Math.pow(epf, i);
  }
  if (den === 0) return NaN;
  const k = num / den;
  // the rational fit can stray outside a physical range on odd samples
  if (!Number.isFinite(k) || k <= 0.05 || k > 30) return NaN;
  return k;
}

export function scaleFromMean(meanSpeed, k) {
  if (!Number.isFinite(k) || k <= 0 || !Number.isFinite(meanSpeed)) return NaN;
  return meanSpeed / gamma(1 + 1 / k);
}

export function fitWeibull(values) {
  let sum = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) { sum += values[i]; n++; }
  }
  if (n === 0) return { k: NaN, s: NaN, epf: NaN, mean: NaN, n: 0 };
  const mean = sum / n;
  const epf = energyPatternFactor(values);
  const k = shapeFromEpf(epf);
  return { k, s: scaleFromMean(mean, k), epf, mean, n };
}

export function windPowerDensity(k, s, rho = AIR_DENSITY) {
  if (!Number.isFinite(k) || !Number.isFinite(s) || k <= 0) return NaN;
  return 0.5 * rho * s * s * s * gamma(1 + 3 / k);
}

export function meanWindSpeed(k, s) {
  if (!Number.isFinite(k) || !Number.isFinite(s) || k <= 0) return NaN;
  return s * gamma(1 + 1 / k);
}

export function hellmannExponent(sA, zA = ANEMOMETER_HEIGHT, zRef = REFERENCE_HEIGHT) {
  if (!Number.isFinite(sA) || sA <= 0) return NaN;
  const den = 1 - 0.19 * Math.log10(zA / zRef);
  if (den === 0) return NaN;
  return (0.65 - 0.19 * Math.log10(sA)) / den;
}

/** Project Weibull parameters and MWS from anemometer height up to hub height. */
export function extrapolate(kA, sA, vA, z, alpha = DEFAULT_ALPHA,
  zA = ANEMOMETER_HEIGHT, zRef = REFERENCE_HEIGHT) {
  const a = alpha == null ? hellmannExponent(sA, zA, zRef) : alpha;
  const num = 1 - 0.19 * Math.log10(zA / zRef);
  const den = 1 - 0.19 * Math.log10(z / zRef);
  const kZ = den !== 0 ? kA * num / den : NaN;
  const ratio = Math.pow(z / zA, a);
  const sZ = sA * ratio;
  return {
    height: z, alpha: a, k: kZ, s: sZ, v: vA * ratio,
    wpd: windPowerDensity(kZ, sZ), mws: meanWindSpeed(kZ, sZ),
  };
}

/* ------------------------------------------------------------------ *
 * Aggregations
 * ------------------------------------------------------------------ */

/**
 * Per-calendar-month fit at anemometer height plus hub-height projections.
 * @param {Float64Array|number[]} values hourly speeds in m/s
 * @param {Int8Array|number[]} months    calendar month 1-12, aligned to values
 */
export function monthlyTable(values, months, heights = DEFAULT_HUB_HEIGHTS, alpha = DEFAULT_ALPHA) {
  const buckets = Array.from({ length: 12 }, () => []);
  for (let i = 0; i < values.length; i++) {
    const m = months[i];
    if (m >= 1 && m <= 12) buckets[m - 1].push(values[i]);
  }
  return buckets.map((sample, i) => {
    const fit = fitWeibull(sample);
    const row = {
      monthNum: i + 1,
      month: MONTH_NAMES[i],
      n: fit.n,
      epf: fit.epf,
      k: fit.k,
      s: fit.s,
      mwsObserved: fit.mean,
      mwsWeibull: meanWindSpeed(fit.k, fit.s),
      wpd10: windPowerDensity(fit.k, fit.s),
      heights: {},
    };
    for (const z of heights) {
      row.heights[z] = extrapolate(fit.k, fit.s, fit.mean, z, alpha);
    }
    return row;
  });
}

export function annualSummary(values, heights = DEFAULT_HUB_HEIGHTS, alpha = DEFAULT_ALPHA) {
  const fit = fitWeibull(values);
  const out = {
    k: fit.k, s: fit.s, epf: fit.epf,
    meanObserved: fit.mean,
    mwsWeibull: meanWindSpeed(fit.k, fit.s),
    wpd10: windPowerDensity(fit.k, fit.s),
    alpha: alpha == null ? hellmannExponent(fit.s) : alpha,
    heights: {},
  };
  for (const z of heights) out.heights[z] = extrapolate(fit.k, fit.s, fit.mean, z, alpha);
  return out;
}

/** Per-year observed mean against the Weibull estimate, for the Fig. 7 fit. */
export function yearlyMws(values, years) {
  const buckets = new Map();
  for (let i = 0; i < values.length; i++) {
    const y = years[i];
    if (!buckets.has(y)) buckets.set(y, []);
    buckets.get(y).push(values[i]);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([year, sample]) => {
      const fit = fitWeibull(sample);
      return {
        year, actual: fit.mean, weibull: meanWindSpeed(fit.k, fit.s),
        k: fit.k, s: fit.s, n: fit.n,
      };
    });
}

/**
 * Quantile-quantile pairs: observed against the fitted Weibull.
 *
 * Comparing observed and Weibull *means* is meaningless under MEPF, because
 * Eq. (5) sets the scale so the theoretical mean equals the sample mean; that
 * plot is an identity and always returns R^2 = 1. The distribution is what the
 * fit actually claims to describe, so this compares quantiles instead.
 */
export function weibullQQ(values, k, s, nPoints = 40) {
  if (!(k > 0) || !(s > 0)) return [];
  const sorted = Float64Array.from(values).sort();
  const out = [];
  for (let i = 1; i <= nPoints; i++) {
    const p = i / (nPoints + 1);
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    const observed = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    const theoretical = s * Math.pow(-Math.log(1 - p), 1 / k);
    out.push({ p, observed, theoretical });
  }
  return out;
}

/** Weibull probability density, for overlaying on the observed histogram. */
export function weibullPdf(x, k, s) {
  if (!(k > 0) || !(s > 0) || x < 0) return 0;
  return (k / s) * Math.pow(x / s, k - 1) * Math.exp(-Math.pow(x / s, k));
}

/** Least-squares fit plus R^2, for the actual-vs-estimate panels. */
export function linearFit(xs, ys) {
  let n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++; sx += x; sy += y; sxy += x * y; sxx += x * x;
  }
  if (n < 2) return null;
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const pred = slope * x + intercept;
    ssRes += (y - pred) ** 2;
    ssTot += (y - meanY) ** 2;
  }
  return { slope, intercept, r2: ssTot === 0 ? NaN : 1 - ssRes / ssTot };
}
