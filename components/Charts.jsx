'use client';

/**
 * Charts, drawn as plain SVG.
 *
 * Hand-rolled rather than pulled from a chart library: the palette and the
 * axis treatment are specific enough that configuring a library would cost
 * more than drawing it, and it keeps the bundle small.
 *
 * Reproduces the study's figure set — time series, observed-vs-predicted
 * density, error with confidence intervals, monthly power density, the
 * actual-vs-estimate regressions, lag importance, Bland-Altman and the
 * Diebold-Mariano matrix.
 */

import { useMemo } from 'react';

export const C = {
  ink: '#e6eef3', muted: '#7c8fa0', dim: '#55697a',
  line: '#1e2a34', grid: '#1b2731',
  teal: '#5fd3c4', violet: '#9d8ce0', amber: '#e3a857',
  coral: '#e56c73', steel: '#6c9cc4',
};

export const FAMILY_COLOUR = { tree: C.teal, neural: C.violet, hybrid: C.amber };
export const SERIES = [C.teal, C.violet, C.amber, C.steel, C.coral, '#7fd1a6', '#d89acf', '#c4b457'];

const PAD = { l: 56, r: 16, t: 14, b: 34 };

function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}

const fmt = (v, d = 2) => {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(Math.min(d, 1));
  return v.toFixed(d);
};

/* ------------------------------------------------------------------ *
 * Frame: axes, grid, labels
 * ------------------------------------------------------------------ */
function Frame({ w, h, xDomain, yDomain, xLabel, yLabel, xTicks, children, xFormat = fmt }) {
  const iw = w - PAD.l - PAD.r;
  const ih = h - PAD.t - PAD.b;
  const [x0, x1] = xDomain;
  const [y0, y1] = yDomain;
  const yt = niceTicks(y0, y1, 5);
  const xt = xTicks ?? niceTicks(x0, x1, 6);

  return (
    <g>
      {yt.map((t) => {
        const y = PAD.t + ih - ((t - y0) / (y1 - y0 || 1)) * ih;
        return (
          <g key={`y${t}`}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y} y2={y} stroke={C.grid} strokeWidth="1" />
            <text x={PAD.l - 8} y={y + 3.5} fill={C.muted} fontSize="10" textAnchor="end">{fmt(t)}</text>
          </g>
        );
      })}
      {xt.map((t, i) => {
        const x = PAD.l + ((t.value ?? t) - x0) / (x1 - x0 || 1) * iw;
        const label = t.label ?? xFormat(t.value ?? t);
        return (
          <g key={`x${i}`}>
            <line x1={x} x2={x} y1={PAD.t} y2={PAD.t + ih} stroke={C.grid} strokeWidth="1" />
            <text x={x} y={h - PAD.b + 15} fill={C.muted} fontSize="10" textAnchor="middle">{label}</text>
          </g>
        );
      })}
      {yLabel && (
        <text transform={`translate(13 ${PAD.t + ih / 2}) rotate(-90)`} fill={C.muted}
          fontSize="10.5" textAnchor="middle">{yLabel}</text>
      )}
      {xLabel && (
        <text x={PAD.l + iw / 2} y={h - 3} fill={C.muted} fontSize="10.5" textAnchor="middle">{xLabel}</text>
      )}
      {children}
    </g>
  );
}

function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}>
          <span className="swatch" style={{ background: it.colour }} />{it.label}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Time series — observed against one or more model predictions
 * ------------------------------------------------------------------ */
export function TimeSeries({ observed, series, times, unit = 'm/s', height = 300, maxPoints = 900 }) {
  const w = 900, h = height;
  const n = observed.length;
  const take = Math.min(maxPoints, n);
  const start = n - take;
  const step = Math.max(1, Math.floor(take / maxPoints));

  const { xs, obs, preds, yDomain, tickList } = useMemo(() => {
    const xsArr = [], obsArr = [];
    for (let i = start; i < n; i += step) { xsArr.push(i - start); obsArr.push(observed[i]); }
    const predArr = series.map((s) => {
      const a = [];
      for (let i = start; i < n; i += step) a.push(s.values[i]);
      return { ...s, arr: a };
    });
    let lo = Infinity, hi = -Infinity;
    for (const v of obsArr) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (const p of predArr) for (const v of p.arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const pad = (hi - lo) * 0.06 || 1;

    const ticks = [];
    if (times && times.length) {
      for (let k = 0; k <= 5; k++) {
        const idx = Math.min(xsArr.length - 1, Math.round((xsArr.length - 1) * (k / 5)));
        const d = new Date(times[start + idx * step]);
        ticks.push({ value: xsArr[idx], label: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` });
      }
    }
    return { xs: xsArr, obs: obsArr, preds: predArr, yDomain: [lo - pad, hi + pad], tickList: ticks.length ? ticks : null };
  }, [observed, series, times, start, step, n]);

  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const xMax = xs[xs.length - 1] || 1;
  const px = (v) => PAD.l + (v / xMax) * iw;
  const py = (v) => PAD.t + ih - ((v - yDomain[0]) / (yDomain[1] - yDomain[0] || 1)) * ih;
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${px(xs[i]).toFixed(1)} ${py(v).toFixed(1)}`).join('');

  return (
    <div>
      <Legend items={[{ label: 'Observed', colour: C.ink }, ...preds.map((p) => ({ label: p.label, colour: p.colour }))]} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Frame w={w} h={h} xDomain={[0, xMax]} yDomain={yDomain} yLabel={`Wind speed (${unit})`} xTicks={tickList}>
          <path d={path(obs)} fill="none" stroke={C.ink} strokeWidth="1" opacity="0.75" />
          {preds.map((p) => (
            <path key={p.label} d={path(p.arr)} fill="none" stroke={p.colour} strokeWidth="1.3" opacity="0.92" />
          ))}
        </Frame>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Observed vs predicted, as a binned density with the 1:1 line
 * ------------------------------------------------------------------ */
export function DensityScatter({ x, y, unit = 'm/s', label, rmse, height = 340, bins = 44 }) {
  const w = 460, h = height;
  const { cells, lo, hi, maxCount } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < x.length; i++) {
      if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i];
      if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i];
    }
    const span = hi - lo || 1;
    const grid = new Int32Array(bins * bins);
    for (let i = 0; i < x.length; i++) {
      const bx = Math.min(bins - 1, Math.max(0, Math.floor(((x[i] - lo) / span) * bins)));
      const by = Math.min(bins - 1, Math.max(0, Math.floor(((y[i] - lo) / span) * bins)));
      grid[by * bins + bx]++;
    }
    let mx = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > mx) mx = grid[i];
    const out = [];
    for (let by = 0; by < bins; by++) {
      for (let bx = 0; bx < bins; bx++) {
        const c = grid[by * bins + bx];
        if (c) out.push({ bx, by, c });
      }
    }
    return { cells: out, lo, hi, maxCount: mx };
  }, [x, y, bins]);

  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const cw = iw / bins, ch = ih / bins;
  const shade = (c) => {
    const t = Math.log1p(c) / Math.log1p(maxCount || 1);
    const stops = [[23, 48, 56], [44, 110, 118], [95, 211, 196], [216, 245, 238]];
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const f = t * (stops.length - 1) - seg;
    const a = stops[seg], b = stops[seg + 1];
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  };

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
      <Frame w={w} h={h} xDomain={[lo, hi]} yDomain={[lo, hi]}
        xLabel={`Observed (${unit})`} yLabel={`Predicted (${unit})`}>
        {cells.map((c, i) => (
          <rect key={i} x={PAD.l + c.bx * cw} y={PAD.t + ih - (c.by + 1) * ch}
            width={Math.ceil(cw) + 0.4} height={Math.ceil(ch) + 0.4} fill={shade(c.c)} />
        ))}
        <line x1={PAD.l} y1={PAD.t + ih} x2={w - PAD.r} y2={PAD.t}
          stroke={C.coral} strokeWidth="1.3" strokeDasharray="5 4" />
        {label && (
          <text x={PAD.l + 8} y={PAD.t + 15} fill={C.ink} fontSize="11.5" fontWeight="600">
            {label}{rmse != null ? `   RMSE ${rmse.toFixed(4)}` : ''}
          </text>
        )}
      </Frame>
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Error with 95% confidence intervals — the Fig. 6a panel
 * ------------------------------------------------------------------ */
export function IntervalPlot({ rows, xLabel = 'RMSE (scaled)' }) {
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const rowH = 30;
  const w = 900, h = Math.max(150, sorted.length * rowH + 56);
  const left = 210, right = 26;
  const iw = w - left - right;

  let lo = Infinity, hi = -Infinity;
  for (const r of sorted) {
    lo = Math.min(lo, isFinite(r.lo) ? r.lo : r.value);
    hi = Math.max(hi, isFinite(r.hi) ? r.hi : r.value);
  }
  const pad = (hi - lo) * 0.15 || 0.01;
  lo -= pad; hi += pad;
  const px = (v) => left + ((v - lo) / (hi - lo || 1)) * iw;
  const ticks = niceTicks(lo, hi, 5);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={px(t)} x2={px(t)} y1={18} y2={h - 34} stroke={C.grid} />
          <text x={px(t)} y={h - 20} fill={C.muted} fontSize="10" textAnchor="middle">{t.toFixed(3)}</text>
        </g>
      ))}
      {sorted.map((r, i) => {
        const y = 32 + i * rowH;
        const colour = FAMILY_COLOUR[r.family] || C.teal;
        const a = isFinite(r.lo) ? r.lo : r.value;
        const b = isFinite(r.hi) ? r.hi : r.value;
        return (
          <g key={r.model}>
            <text x={left - 12} y={y + 4} fill={C.ink} fontSize="11.5" textAnchor="end">{r.model}</text>
            <line x1={px(a)} x2={px(b)} y1={y} y2={y} stroke={colour} strokeWidth="2.4" opacity="0.45" strokeLinecap="round" />
            <circle cx={px(r.value)} cy={y} r="4.6" fill={colour} stroke="#0c1116" strokeWidth="1.4" />
          </g>
        );
      })}
      <text x={left + iw / 2} y={h - 4} fill={C.muted} fontSize="10.5" textAnchor="middle">{xLabel}</text>
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Horizontal bars — leaderboard metrics, lag importance
 * ------------------------------------------------------------------ */
export function BarsH({ rows, xLabel, height, labelWidth = 190, highlight = null }) {
  const rowH = 22;
  const w = 900, h = height ?? Math.max(120, rows.length * rowH + 48);
  const left = labelWidth, right = 60;
  const iw = w - left - right;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
      {rows.map((r, i) => {
        const y = 14 + i * rowH;
        const bw = (Math.abs(r.value) / max) * iw;
        const colour = r.colour || (highlight && !highlight.includes(r.label) ? '#2c3b46' : C.teal);
        return (
          <g key={r.label}>
            <text x={left - 10} y={y + 11} fill={C.muted} fontSize="10.5" textAnchor="end">{r.label}</text>
            <rect x={left} y={y + 2} width={Math.max(bw, 1)} height={rowH - 8} rx="2" fill={colour} />
            <text x={left + Math.max(bw, 1) + 7} y={y + 11} fill={C.muted} fontSize="10"
              fontFamily="var(--mono)">{r.display ?? fmt(r.value, 4)}</text>
          </g>
        );
      })}
      {xLabel && <text x={left + iw / 2} y={h - 4} fill={C.muted} fontSize="10.5" textAnchor="middle">{xLabel}</text>}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Grouped bars — monthly power density across hub heights
 * ------------------------------------------------------------------ */
export function GroupedBars({ categories, groups, yLabel, height = 340 }) {
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const max = Math.max(...groups.flatMap((g) => g.values.filter(isFinite)), 1e-9);
  const bandW = iw / categories.length;
  const barW = (bandW * 0.72) / groups.length;

  return (
    <div>
      <Legend items={groups.map((g) => ({ label: g.label, colour: g.colour }))} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Frame w={w} h={h} xDomain={[0, categories.length]} yDomain={[0, max * 1.08]} yLabel={yLabel}
          xTicks={categories.map((c, i) => ({ value: i + 0.5, label: c }))}>
          {groups.map((g, gi) =>
            g.values.map((v, ci) => {
              if (!isFinite(v)) return null;
              const bh = (v / (max * 1.08)) * ih;
              const x = PAD.l + ci * bandW + bandW * 0.14 + gi * barW;
              return <rect key={`${gi}-${ci}`} x={x} y={PAD.t + ih - bh} width={barW - 1.5}
                height={Math.max(bh, 0.5)} rx="1.5" fill={g.colour} />;
            })
          )}
        </Frame>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Multi-line — monthly means by height, Weibull parameters
 * ------------------------------------------------------------------ */
export function MultiLine({ categories, series, yLabel, height = 320, yLabel2 }) {
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const left = series.filter((s) => !s.axis2);
  const right = series.filter((s) => s.axis2);
  const dom = (list) => {
    const vals = list.flatMap((s) => s.values.filter(isFinite));
    if (!vals.length) return [0, 1];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.1 || 1;
    return [lo - pad, hi + pad];
  };
  const dL = dom(left), dR = right.length ? dom(right) : null;
  const px = (i) => PAD.l + ((i + 0.5) / categories.length) * iw;
  const py = (v, d) => PAD.t + ih - ((v - d[0]) / (d[1] - d[0] || 1)) * ih;

  return (
    <div>
      <Legend items={series.map((s) => ({ label: s.label, colour: s.colour }))} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Frame w={w} h={h} xDomain={[0, categories.length]} yDomain={dL} yLabel={yLabel}
          xTicks={categories.map((c, i) => ({ value: i + 0.5, label: c }))}>
          {series.map((s) => {
            const d = s.axis2 && dR ? dR : dL;
            const path = s.values.map((v, i) => (isFinite(v) ? `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v, d).toFixed(1)}` : '')).join('');
            return (
              <g key={s.label}>
                <path d={path} fill="none" stroke={s.colour} strokeWidth="1.9" />
                {s.values.map((v, i) => (isFinite(v) ? <circle key={i} cx={px(i)} cy={py(v, d)} r="2.6" fill={s.colour} /> : null))}
              </g>
            );
          })}
          {dR && niceTicks(dR[0], dR[1], 5).map((t) => (
            <text key={`r${t}`} x={w - PAD.r + 4} y={py(t, dR) + 3.5} fill={C.muted} fontSize="10">{fmt(t)}</text>
          ))}
          {yLabel2 && (
            <text transform={`translate(${w - 2} ${PAD.t + ih / 2}) rotate(-90)`} fill={C.muted}
              fontSize="10.5" textAnchor="middle">{yLabel2}</text>
          )}
        </Frame>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Scatter with a fitted line — actual against ML or Weibull estimate
 * ------------------------------------------------------------------ */
export function FitScatter({ x, y, colour, label, unit = 'm/s', fit, height = 330 }) {
  const w = 460, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const all = [...x, ...y].filter(isFinite);
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 1;
  const d = [lo - pad, hi + pad];
  const px = (v) => PAD.l + ((v - d[0]) / (d[1] - d[0] || 1)) * iw;
  const py = (v) => PAD.t + ih - ((v - d[0]) / (d[1] - d[0] || 1)) * ih;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
      <Frame w={w} h={h} xDomain={d} yDomain={d} xLabel={`Actual MWS (${unit})`} yLabel={`${label} (${unit})`}>
        {x.map((v, i) => (isFinite(v) && isFinite(y[i])
          ? <circle key={i} cx={px(v)} cy={py(y[i])} r="4" fill={colour} opacity="0.8" stroke="#0c1116" strokeWidth="0.8" />
          : null))}
        {fit && (
          <line x1={px(d[0])} y1={py(fit.slope * d[0] + fit.intercept)}
            x2={px(d[1])} y2={py(fit.slope * d[1] + fit.intercept)}
            stroke={colour} strokeWidth="1.4" strokeDasharray="4 3" />
        )}
        {fit && (
          <text x={PAD.l + 8} y={PAD.t + 14} fill={C.ink} fontSize="11">
            y = {fit.slope.toFixed(4)}x {fit.intercept >= 0 ? '+' : '−'} {Math.abs(fit.intercept).toFixed(4)}
            <tspan x={PAD.l + 8} dy="14">R² = {fit.r2.toFixed(4)}</tspan>
          </text>
        )}
      </Frame>
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Bland-Altman
 * ------------------------------------------------------------------ */
export function BlandAltman({ meanPair, diff, bias, loaLower, loaUpper, unit = 'm/s', height = 330, maxPoints = 4000 }) {
  const w = 460, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const step = Math.max(1, Math.floor(meanPair.length / maxPoints));
  const xs = [], ys = [];
  for (let i = 0; i < meanPair.length; i += step) { xs.push(meanPair[i]); ys.push(diff[i]); }
  const xd = [Math.min(...xs), Math.max(...xs)];
  const yAbs = Math.max(Math.abs(loaLower), Math.abs(loaUpper), ...ys.map(Math.abs)) * 1.05;
  const yd = [-yAbs, yAbs];
  const px = (v) => PAD.l + ((v - xd[0]) / (xd[1] - xd[0] || 1)) * iw;
  const py = (v) => PAD.t + ih - ((v - yd[0]) / (yd[1] - yd[0] || 1)) * ih;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
      <Frame w={w} h={h} xDomain={xd} yDomain={yd}
        xLabel={`Mean of observed and predicted (${unit})`} yLabel={`Observed − predicted (${unit})`}>
        {xs.map((v, i) => <circle key={i} cx={px(v)} cy={py(ys[i])} r="1.5" fill={C.teal} opacity="0.3" />)}
        {[[bias, C.amber, 'Bias'], [loaUpper, C.coral, '+1.96 SD'], [loaLower, C.coral, '−1.96 SD']].map(([v, col, lab]) => (
          <g key={lab}>
            <line x1={PAD.l} x2={w - PAD.r} y1={py(v)} y2={py(v)} stroke={col} strokeWidth="1.2" strokeDasharray="5 4" />
            <text x={w - PAD.r - 3} y={py(v) - 4} fill={col} fontSize="9.5" textAnchor="end">{lab} {v.toFixed(3)}</text>
          </g>
        ))}
      </Frame>
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Signed bars — bias across deciles of observed speed
 * ------------------------------------------------------------------ */
export function SignedBars({ points, xLabel, yLabel, height = 300 }) {
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const vals = points.map((p) => p.value);
  const absMax = Math.max(...vals.map(Math.abs), 1e-9) * 1.15;
  const yd = [-absMax, absMax];
  const bandW = iw / points.length;
  const py = (v) => PAD.t + ih - ((v - yd[0]) / (yd[1] - yd[0])) * ih;
  const zero = py(0);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
      <Frame w={w} h={h} xDomain={[0, points.length]} yDomain={yd} xLabel={xLabel} yLabel={yLabel}
        xTicks={points.map((p, i) => ({ value: i + 0.5, label: fmt(p.centre, 1) }))}>
        {points.map((p, i) => {
          const y = py(p.value);
          return <rect key={i} x={PAD.l + i * bandW + bandW * 0.2} y={Math.min(y, zero)}
            width={bandW * 0.6} height={Math.max(Math.abs(y - zero), 0.8)} rx="1.5"
            fill={p.value >= 0 ? C.teal : C.coral} />;
        })}
        <line x1={PAD.l} x2={w - PAD.r} y1={zero} y2={zero} stroke={C.muted} strokeWidth="1" />
      </Frame>
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Histogram with a fitted density curve
 * ------------------------------------------------------------------ */
export function HistogramCurve({ bars, curve, unit = 'm/s', height = 320, curveLabel }) {
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const xd = [bars[0].centre, bars[bars.length - 1].centre];
  const maxY = Math.max(...bars.map((b) => b.density), ...(curve?.map((c) => c.y) ?? [0])) * 1.08;
  const px = (v) => PAD.l + ((v - xd[0]) / (xd[1] - xd[0] || 1)) * iw;
  const py = (v) => PAD.t + ih - (v / (maxY || 1)) * ih;
  const bw = iw / bars.length;

  return (
    <div>
      <Legend items={[{ label: 'Observed', colour: 'rgba(95,211,196,0.5)' },
        ...(curve ? [{ label: curveLabel ?? 'Weibull fit', colour: C.amber }] : [])]} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Frame w={w} h={h} xDomain={xd} yDomain={[0, maxY]} xLabel={`Wind speed (${unit})`} yLabel="Probability density">
          {bars.map((b, i) => (
            <rect key={i} x={px(b.centre) - bw / 2} y={py(b.density)} width={Math.max(bw - 0.6, 0.6)}
              height={Math.max(PAD.t + ih - py(b.density), 0)} fill="rgba(95,211,196,0.42)" />
          ))}
          {curve && (
            <path d={curve.map((c, i) => `${i ? 'L' : 'M'}${px(c.x).toFixed(1)} ${py(c.y).toFixed(1)}`).join('')}
              fill="none" stroke={C.amber} strokeWidth="2" />
          )}
        </Frame>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Band chart — diurnal mean with one standard deviation
 * ------------------------------------------------------------------ */
export function BandChart({ points, yLabel, xLabel, height = 300 }) {
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const los = points.map((p) => p.mean - p.sd), his = points.map((p) => p.mean + p.sd);
  const lo = Math.min(...los), hi = Math.max(...his);
  const pad = (hi - lo) * 0.1 || 1;
  const yd = [lo - pad, hi + pad];
  const px = (i) => PAD.l + (i / (points.length - 1 || 1)) * iw;
  const py = (v) => PAD.t + ih - ((v - yd[0]) / (yd[1] - yd[0] || 1)) * ih;
  const band = [...points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(p.mean + p.sd).toFixed(1)}`),
    ...points.slice().reverse().map((p, i) => `L${px(points.length - 1 - i).toFixed(1)} ${py(p.mean - p.sd).toFixed(1)}`), 'Z'].join('');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
      <Frame w={w} h={h} xDomain={[0, points.length - 1]} yDomain={yd} yLabel={yLabel} xLabel={xLabel}
        xTicks={points.filter((_, i) => i % 3 === 0).map((p, k) => ({ value: k * 3, label: String(p.hour) }))}>
        <path d={band} fill="rgba(95,211,196,0.14)" stroke="none" />
        <path d={points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(p.mean).toFixed(1)}`).join('')}
          fill="none" stroke={C.teal} strokeWidth="2.1" />
        {points.map((p, i) => <circle key={i} cx={px(i)} cy={py(p.mean)} r="2.6" fill={C.teal} />)}
      </Frame>
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Diebold-Mariano matrix
 * ------------------------------------------------------------------ */
export function PMatrix({ names, rows }) {
  const cell = 62, labelW = 190, headH = 96;
  const w = labelW + names.length * cell + 12;
  const h = headH + names.length * 28 + 10;

  const shade = (p) => {
    if (!isFinite(p)) return '#0d141a';
    if (p < 0.001) return '#5fd3c4';
    if (p < 0.01) return '#4bab9f';
    if (p < 0.05) return '#3a8279';
    return '#1a242c';
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width={Math.max(w, 640)} role="img">
        {names.map((n, j) => (
          <text key={n} transform={`translate(${labelW + j * cell + cell / 2} ${headH - 8}) rotate(-38)`}
            fill={C.muted} fontSize="10" textAnchor="start">{n}</text>
        ))}
        {names.map((a, i) => (
          <g key={a}>
            <text x={labelW - 10} y={headH + i * 28 + 18} fill={C.ink} fontSize="10.5" textAnchor="end">{a}</text>
            {names.map((b, j) => {
              const p = rows[a][b];
              return (
                <g key={b}>
                  <rect x={labelW + j * cell} y={headH + i * 28 + 2} width={cell - 2} height={24} rx="3" fill={shade(p)} />
                  <text x={labelW + j * cell + (cell - 2) / 2} y={headH + i * 28 + 18}
                    fill={isFinite(p) && p < 0.05 ? '#06231f' : C.muted} fontSize="9.5" textAnchor="middle"
                    fontFamily="var(--mono)">{isFinite(p) ? p.toFixed(3) : ''}</text>
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Training loss curves
 * ------------------------------------------------------------------ */
export function LossCurves({ history, height = 280 }) {
  const w = 900, h = height;
  const series = [
    { label: 'Training loss', values: history.loss, colour: C.teal },
    { label: 'Validation loss', values: history.valLoss, colour: C.amber },
  ].filter((s) => s.values?.length);
  if (!series.length) return null;
  const all = series.flatMap((s) => s.values).filter(isFinite);
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.1 || 0.01;
  const yd = [Math.max(0, lo - pad), hi + pad];
  const n = Math.max(...series.map((s) => s.values.length));
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const px = (i) => PAD.l + (i / Math.max(n - 1, 1)) * iw;
  const py = (v) => PAD.t + ih - ((v - yd[0]) / (yd[1] - yd[0] || 1)) * ih;

  return (
    <div>
      <Legend items={series.map((s) => ({ label: s.label, colour: s.colour }))} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Frame w={w} h={h} xDomain={[0, Math.max(n - 1, 1)]} yDomain={yd} xLabel="Epoch" yLabel="MSE">
          {series.map((s) => (
            <path key={s.label} d={s.values.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join('')}
              fill="none" stroke={s.colour} strokeWidth="1.9" />
          ))}
        </Frame>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Blend-weight search curve
 * ------------------------------------------------------------------ */
export function WeightCurve({ curve, best, height = 280 }) {
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const ys = curve.map((c) => c.rmse);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.12 || 0.01;
  const yd = [lo - pad, hi + pad];
  const px = (v) => PAD.l + v * iw;
  const py = (v) => PAD.t + ih - ((v - yd[0]) / (yd[1] - yd[0] || 1)) * ih;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
      <Frame w={w} h={h} xDomain={[0, 1]} yDomain={yd}
        xLabel="Weight on the first model (w)" yLabel="Held-out RMSE">
        <path d={curve.map((c, i) => `${i ? 'L' : 'M'}${px(c.w).toFixed(1)} ${py(c.rmse).toFixed(1)}`).join('')}
          fill="none" stroke={C.teal} strokeWidth="2" />
        <line x1={px(best)} x2={px(best)} y1={PAD.t} y2={PAD.t + ih} stroke={C.amber} strokeWidth="1.3" strokeDasharray="4 3" />
        <text x={px(best) + 6} y={PAD.t + 14} fill={C.amber} fontSize="10.5">w = {best.toFixed(2)}</text>
      </Frame>
    </svg>
  );
}
