'use client';

/**
 * Charts, drawn as plain SVG.
 *
 * Every chart reads colours from a theme in context, so the whole set switches
 * between two looks:
 *
 *   notebook  matplotlib's defaults — white panel, black spines and text,
 *             #b0b0b0 grid, the tab10 cycle, actual in C0 blue and predicted in
 *             C1 orange, reference lines dashed red. Matches the figures the
 *             Colab notebooks produce.
 *   dark      the workbench look, following the selected station's accent.
 *
 * Covers the study's figure set: time series, actual-vs-predicted, error with
 * confidence intervals, monthly power density, the actual-vs-estimate
 * regressions, lag importance, Bland-Altman, bias deciles and the
 * Diebold-Mariano matrix.
 */

import { createContext, useContext, useMemo } from 'react';
import { NOTEBOOK, FAMILY } from '@/lib/theme';

const ChartThemeContext = createContext(NOTEBOOK);
export const useChartTheme = () => useContext(ChartThemeContext);

export function ChartThemeProvider({ theme, children }) {
  return <ChartThemeContext.Provider value={theme}>{children}</ChartThemeContext.Provider>;
}

export { FAMILY as FAMILY_COLOUR };

const PAD = { l: 58, r: 18, t: 16, b: 36 };

/* ------------------------------------------------------------------ *
 * Scales and formatting
 * ------------------------------------------------------------------ */

function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const raw = (max - min) / count;
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

const parseHex = (s) => {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/* ------------------------------------------------------------------ *
 * Panel: background, grid, spines, axis labels
 * ------------------------------------------------------------------ */

function Panel({ w, h, xDomain, yDomain, xLabel, yLabel, xTicks, children, title }) {
  const T = useChartTheme();
  const iw = w - PAD.l - PAD.r;
  const ih = h - PAD.t - PAD.b;
  const [x0, x1] = xDomain;
  const [y0, y1] = yDomain;
  const yt = niceTicks(y0, y1, 5);
  const xt = xTicks ?? niceTicks(x0, x1, 6);

  return (
    <g>
      {T.panel !== 'transparent' && (
        <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill={T.panel} />
      )}
      {yt.map((t) => {
        const y = PAD.t + ih - ((t - y0) / (y1 - y0 || 1)) * ih;
        if (y < PAD.t - 0.5 || y > PAD.t + ih + 0.5) return null;
        return (
          <g key={`y${t}`}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y} y2={y} stroke={T.grid} strokeWidth={T.gridWidth} />
            <text x={PAD.l - 8} y={y + 3.5} fill={T.muted} fontSize={T.fontSize} textAnchor="end">{fmt(t)}</text>
          </g>
        );
      })}
      {xt.map((t, i) => {
        const value = t.value ?? t;
        const x = PAD.l + ((value - x0) / (x1 - x0 || 1)) * iw;
        if (x < PAD.l - 0.5 || x > w - PAD.r + 0.5) return null;
        return (
          <g key={`x${i}`}>
            <line x1={x} x2={x} y1={PAD.t} y2={PAD.t + ih} stroke={T.grid} strokeWidth={T.gridWidth} />
            <text x={x} y={h - PAD.b + 15} fill={T.muted} fontSize={T.fontSize} textAnchor="middle">
              {t.label ?? fmt(value)}
            </text>
          </g>
        );
      })}
      {T.showSpines && (
        <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill="none"
          stroke={T.spine} strokeWidth={T.spineWidth} />
      )}
      {yLabel && (
        <text transform={`translate(14 ${PAD.t + ih / 2}) rotate(-90)`} fill={T.muted}
          fontSize={T.fontSize + 0.5} textAnchor="middle">{yLabel}</text>
      )}
      {xLabel && (
        <text x={PAD.l + iw / 2} y={h - 3} fill={T.muted} fontSize={T.fontSize + 0.5} textAnchor="middle">{xLabel}</text>
      )}
      {title && (
        <text x={PAD.l + iw / 2} y={PAD.t - 4} fill={T.ink} fontSize={T.fontSize + 2} textAnchor="middle">{title}</text>
      )}
      {children}
    </g>
  );
}

/** Notebook charts sit on a white card, the way a matplotlib figure does. */
function Figure({ children }) {
  const T = useChartTheme();
  // the class is what the scroll-linked reveal hooks onto
  if (T.panel === 'transparent') return <div className="chart-figure">{children}</div>;
  return (
    <div className="chart-figure" style={{
      background: T.panel,
      borderRadius: T.panelRadius,
      padding: '0.5rem 0.4rem 0.2rem',
      border: '1px solid #d5d5d5',
    }}>{children}</div>
  );
}

function Legend({ items }) {
  const T = useChartTheme();
  const style = T.panel !== 'transparent'
    ? { color: '#333', margin: '0.15rem 0 0.3rem 0.7rem' }
    : undefined;
  return (
    <div className="legend" style={style}>
      {items.map((it) => (
        <span key={it.label}>
          <span className="swatch" style={{ background: it.colour }} />{it.label}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Time series
 * ------------------------------------------------------------------ */

export function TimeSeries({ observed, series, times, unit = 'm/s', height = 300, maxPoints = 900, title }) {
  const T = useChartTheme();
  const w = 900, h = height;
  const n = observed.length;
  const take = Math.min(maxPoints, n);
  const start = n - take;
  const step = Math.max(1, Math.floor(take / maxPoints));

  const { xs, obs, preds, yDomain, tickList } = useMemo(() => {
    const xsArr = [], obsArr = [];
    for (let i = start; i < n; i += step) { xsArr.push(i - start); obsArr.push(observed[i]); }
    const predArr = series.map((s, k) => {
      const a = [];
      for (let i = start; i < n; i += step) a.push(s.values[i]);
      return { ...s, arr: a, k };
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

  // a single prediction reads as matplotlib's Actual/Predicted pair;
  // several cycle through tab10 the way repeated plt.plot calls would
  const colourFor = (p) => (T.key === 'notebook'
    ? (preds.length === 1 ? T.predicted : T.series[(p.k + 1) % T.series.length])
    : (p.colour ?? T.series[p.k % T.series.length]));

  return (
    <Figure>
      <Legend items={[{ label: 'Actual', colour: T.observed },
        ...preds.map((p) => ({ label: p.label, colour: colourFor(p) }))]} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={[0, xMax]} yDomain={yDomain} yLabel={`Wind speed (${unit})`}
          xTicks={tickList} title={title}>
          <path d={path(obs)} fill="none" stroke={T.observed} strokeWidth="1"
            opacity={T.key === 'notebook' ? 1 : 0.75} />
          {preds.map((p) => (
            <path key={p.label} d={path(p.arr)} fill="none" stroke={colourFor(p)} strokeWidth="1.1" opacity="0.92" />
          ))}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Actual vs predicted
 *
 * The notebooks draw plt.scatter(alpha=0.6) with a red dashed 1:1 line, so
 * notebook mode plots points. Dark mode bins to a density, which reads better
 * at tens of thousands of rows.
 * ------------------------------------------------------------------ */

export function DensityScatter({ x, y, unit = 'm/s', label, rmse, height = 340, bins = 44, maxPoints = 6000 }) {
  const T = useChartTheme();
  const w = 460, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;

  const { cells, lo, hi, maxCount, pts } = useMemo(() => {
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
    const stride = Math.max(1, Math.floor(x.length / maxPoints));
    const sample = [];
    for (let i = 0; i < x.length; i += stride) sample.push([x[i], y[i]]);
    return { cells: out, lo, hi, maxCount: mx, pts: sample };
  }, [x, y, bins, maxPoints]);

  const cw = iw / bins, ch = ih / bins;
  const px = (v) => PAD.l + ((v - lo) / (hi - lo || 1)) * iw;
  const py = (v) => PAD.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

  const shade = (c) => {
    const t = Math.log1p(c) / Math.log1p(maxCount || 1);
    const stops = T.density;
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const f = t * (stops.length - 1) - seg;
    const a = parseHex(stops[seg]), b = parseHex(stops[seg + 1]);
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  };

  return (
    <Figure>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={[lo, hi]} yDomain={[lo, hi]}
          xLabel={`Actual (${unit})`} yLabel={`Predicted (${unit})`}>
          {T.key === 'notebook'
            ? pts.map((p, i) => (
              <circle key={i} cx={px(p[0])} cy={py(p[1])} r="2.4" fill={T.observed} opacity="0.6" />
            ))
            : cells.map((c, i) => (
              <rect key={i} x={PAD.l + c.bx * cw} y={PAD.t + ih - (c.by + 1) * ch}
                width={Math.ceil(cw) + 0.4} height={Math.ceil(ch) + 0.4} fill={shade(c.c)} />
            ))}
          <line x1={px(lo)} y1={py(lo)} x2={px(hi)} y2={py(hi)}
            stroke={T.reference} strokeWidth="1.6" strokeDasharray="6 4" />
          {label && (
            <text x={PAD.l + 8} y={PAD.t + 15} fill={T.ink} fontSize="11.5" fontWeight="600">
              {label}{rmse != null ? `   RMSE ${rmse.toFixed(4)}` : ''}
            </text>
          )}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Error with 95% confidence intervals
 * ------------------------------------------------------------------ */

export function IntervalPlot({ rows, xLabel = 'RMSE (scaled)' }) {
  const T = useChartTheme();
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const rowH = 30;
  const w = 900, h = Math.max(150, sorted.length * rowH + 60);
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
  const top = 16, bottom = h - 36;

  return (
    <Figure>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        {T.panel !== 'transparent' && (
          <rect x={left} y={top} width={iw} height={bottom - top} fill={T.panel} />
        )}
        {niceTicks(lo, hi, 5).map((t) => (
          <g key={t}>
            <line x1={px(t)} x2={px(t)} y1={top} y2={bottom} stroke={T.grid} strokeWidth={T.gridWidth} />
            <text x={px(t)} y={bottom + 14} fill={T.muted} fontSize={T.fontSize} textAnchor="middle">{t.toFixed(3)}</text>
          </g>
        ))}
        {T.showSpines && (
          <rect x={left} y={top} width={iw} height={bottom - top} fill="none" stroke={T.spine} strokeWidth={T.spineWidth} />
        )}
        {sorted.map((r, i) => {
          const y = 32 + i * rowH;
          const colour = T.key === 'notebook' ? T.series[i % T.series.length] : (FAMILY[r.family] ?? T.bar);
          const a = isFinite(r.lo) ? r.lo : r.value;
          const b = isFinite(r.hi) ? r.hi : r.value;
          return (
            <g key={r.model}>
              <text x={left - 12} y={y + 4} fill={T.ink} fontSize="11.5" textAnchor="end">{r.model}</text>
              <line x1={px(a)} x2={px(b)} y1={y} y2={y} stroke={colour} strokeWidth="2" strokeLinecap="butt" />
              <line x1={px(a)} x2={px(a)} y1={y - 5} y2={y + 5} stroke={colour} strokeWidth="1.6" />
              <line x1={px(b)} x2={px(b)} y1={y - 5} y2={y + 5} stroke={colour} strokeWidth="1.6" />
              <circle cx={px(r.value)} cy={y} r="4.4" fill={colour}
                stroke={T.key === 'notebook' ? '#ffffff' : '#0c1116'} strokeWidth="1.2" />
            </g>
          );
        })}
        <text x={left + iw / 2} y={h - 5} fill={T.muted} fontSize={T.fontSize + 0.5} textAnchor="middle">{xLabel}</text>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Horizontal bars
 * ------------------------------------------------------------------ */

export function BarsH({ rows, xLabel, height, labelWidth = 190, highlight = null }) {
  const T = useChartTheme();
  const rowH = 22;
  const w = 900, h = height ?? Math.max(120, rows.length * rowH + 52);
  const left = labelWidth, right = 62;
  const iw = w - left - right;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  const top = 10, bottom = h - 32;

  return (
    <Figure>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        {T.panel !== 'transparent' && <rect x={left} y={top} width={iw} height={bottom - top} fill={T.panel} />}
        {T.showSpines && (
          <rect x={left} y={top} width={iw} height={bottom - top} fill="none" stroke={T.spine} strokeWidth={T.spineWidth} />
        )}
        {rows.map((r, i) => {
          const y = 14 + i * rowH;
          const bw = (Math.abs(r.value) / max) * iw;
          const dimmed = highlight && !highlight.includes(r.label);
          const colour = r.colour ?? (dimmed ? T.barMuted : T.bar);
          return (
            <g key={r.label}>
              <text x={left - 10} y={y + 11} fill={T.muted} fontSize="10.5" textAnchor="end">{r.label}</text>
              <rect x={left} y={y + 2} width={Math.max(bw, 1)} height={rowH - 8} fill={colour}
                stroke={T.key === 'notebook' ? 'rgba(0,0,0,0.18)' : 'none'} strokeWidth="0.5" />
              <text x={left + Math.max(bw, 1) + 7} y={y + 11} fill={T.muted} fontSize="10"
                fontFamily="var(--mono)">{r.display ?? fmt(r.value, 4)}</text>
            </g>
          );
        })}
        {xLabel && <text x={left + iw / 2} y={h - 5} fill={T.muted} fontSize={T.fontSize + 0.5} textAnchor="middle">{xLabel}</text>}
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Grouped bars
 * ------------------------------------------------------------------ */

export function GroupedBars({ categories, groups, yLabel, height = 340, title }) {
  const T = useChartTheme();
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const max = Math.max(...groups.flatMap((g) => g.values.filter(isFinite)), 1e-9);
  const bandW = iw / categories.length;
  const barW = (bandW * 0.72) / groups.length;
  const colourFor = (g, i) => (T.key === 'notebook' ? T.series[i % T.series.length] : g.colour);

  return (
    <Figure>
      <Legend items={groups.map((g, i) => ({ label: g.label, colour: colourFor(g, i) }))} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={[0, categories.length]} yDomain={[0, max * 1.08]} yLabel={yLabel}
          title={title} xTicks={categories.map((c, i) => ({ value: i + 0.5, label: c }))}>
          {groups.map((g, gi) =>
            g.values.map((v, ci) => {
              if (!isFinite(v)) return null;
              const bh = (v / (max * 1.08)) * ih;
              const x = PAD.l + ci * bandW + bandW * 0.14 + gi * barW;
              return <rect key={`${gi}-${ci}`} x={x} y={PAD.t + ih - bh} width={barW - 1.2}
                height={Math.max(bh, 0.5)} fill={colourFor(g, gi)}
                stroke={T.key === 'notebook' ? 'rgba(0,0,0,0.18)' : 'none'} strokeWidth="0.5" />;
            })
          )}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Multi-line
 * ------------------------------------------------------------------ */

export function MultiLine({ categories, series, yLabel, height = 320, yLabel2, title }) {
  const T = useChartTheme();
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
  const colourFor = (s, i) => (T.key === 'notebook' ? T.series[i % T.series.length] : s.colour);

  return (
    <Figure>
      <Legend items={series.map((s, i) => ({ label: s.label, colour: colourFor(s, i) }))} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={[0, categories.length]} yDomain={dL} yLabel={yLabel} title={title}
          xTicks={categories.map((c, i) => ({ value: i + 0.5, label: c }))}>
          {series.map((s, si) => {
            const d = s.axis2 && dR ? dR : dL;
            const colour = colourFor(s, si);
            const path = s.values.map((v, i) => (isFinite(v) ? `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v, d).toFixed(1)}` : '')).join('');
            return (
              <g key={s.label}>
                <path d={path} fill="none" stroke={colour} strokeWidth="1.7" />
                {s.values.map((v, i) => (isFinite(v) ? <circle key={i} cx={px(i)} cy={py(v, d)} r="2.6" fill={colour} /> : null))}
              </g>
            );
          })}
          {dR && niceTicks(dR[0], dR[1], 5).map((t) => (
            <text key={`r${t}`} x={w - PAD.r + 4} y={py(t, dR) + 3.5} fill={T.muted} fontSize={T.fontSize}>{fmt(t)}</text>
          ))}
          {yLabel2 && (
            <text transform={`translate(${w - 2} ${PAD.t + ih / 2}) rotate(-90)`} fill={T.muted}
              fontSize={T.fontSize + 0.5} textAnchor="middle">{yLabel2}</text>
          )}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Scatter with a fitted line
 * ------------------------------------------------------------------ */

export function FitScatter({ x, y, colour, label, unit = 'm/s', fit, height = 330 }) {
  const T = useChartTheme();
  const w = 460, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const all = [...x, ...y].filter(isFinite);
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 1;
  const d = [lo - pad, hi + pad];
  const px = (v) => PAD.l + ((v - d[0]) / (d[1] - d[0] || 1)) * iw;
  const py = (v) => PAD.t + ih - ((v - d[0]) / (d[1] - d[0] || 1)) * ih;
  const dot = T.key === 'notebook' ? T.series[0] : colour;

  return (
    <Figure>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={d} yDomain={d} xLabel={`Actual MWS (${unit})`} yLabel={`${label} (${unit})`}>
          {x.map((v, i) => (isFinite(v) && isFinite(y[i])
            ? <circle key={i} cx={px(v)} cy={py(y[i])} r="4" fill={dot} opacity="0.85" />
            : null))}
          {fit && (
            <line x1={px(d[0])} y1={py(fit.slope * d[0] + fit.intercept)}
              x2={px(d[1])} y2={py(fit.slope * d[1] + fit.intercept)}
              stroke={dot} strokeWidth="1.3" strokeDasharray="4 3" />
          )}
          {fit && (
            <text x={PAD.l + 8} y={PAD.t + 14} fill={T.ink} fontSize="11">
              y = {fit.slope.toFixed(4)}x {fit.intercept >= 0 ? '+' : '−'} {Math.abs(fit.intercept).toFixed(4)}
              <tspan x={PAD.l + 8} dy="14">R² = {fit.r2.toFixed(4)}</tspan>
            </text>
          )}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Bland-Altman
 * ------------------------------------------------------------------ */

export function BlandAltman({ meanPair, diff, bias, loaLower, loaUpper, unit = 'm/s', height = 330, maxPoints = 4000 }) {
  const T = useChartTheme();
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
  const biasCol = T.key === 'notebook' ? T.series[2] : '#E3A857';

  return (
    <Figure>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={xd} yDomain={yd}
          xLabel={`Mean of actual and predicted (${unit})`} yLabel={`Actual − predicted (${unit})`}>
          {xs.map((v, i) => (
            <circle key={i} cx={px(v)} cy={py(ys[i])} r={T.key === 'notebook' ? 1.9 : 1.5}
              fill={T.observed} opacity={T.key === 'notebook' ? 0.45 : 0.3} />
          ))}
          {[[bias, biasCol, 'Bias'], [loaUpper, T.reference, '+1.96 SD'], [loaLower, T.reference, '−1.96 SD']]
            .map(([v, col, lab]) => (
              <g key={lab}>
                <line x1={PAD.l} x2={w - PAD.r} y1={py(v)} y2={py(v)} stroke={col} strokeWidth="1.2" strokeDasharray="5 4" />
                <text x={w - PAD.r - 3} y={py(v) - 4} fill={col} fontSize="9.5" textAnchor="end">{lab} {v.toFixed(3)}</text>
              </g>
            ))}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Signed bars
 * ------------------------------------------------------------------ */

export function SignedBars({ points, xLabel, yLabel, height = 300 }) {
  const T = useChartTheme();
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const absMax = Math.max(...points.map((p) => Math.abs(p.value)), 1e-9) * 1.15;
  const yd = [-absMax, absMax];
  const bandW = iw / points.length;
  const py = (v) => PAD.t + ih - ((v - yd[0]) / (yd[1] - yd[0])) * ih;
  const zero = py(0);

  return (
    <Figure>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={[0, points.length]} yDomain={yd} xLabel={xLabel} yLabel={yLabel}
          xTicks={points.map((p, i) => ({ value: i + 0.5, label: fmt(p.centre, 1) }))}>
          {points.map((p, i) => {
            const y = py(p.value);
            return <rect key={i} x={PAD.l + i * bandW + bandW * 0.2} y={Math.min(y, zero)}
              width={bandW * 0.6} height={Math.max(Math.abs(y - zero), 0.8)}
              fill={p.value >= 0 ? T.positive : T.negative}
              stroke={T.key === 'notebook' ? 'rgba(0,0,0,0.18)' : 'none'} strokeWidth="0.5" />;
          })}
          <line x1={PAD.l} x2={w - PAD.r} y1={zero} y2={zero} stroke={T.reference} strokeWidth="1.2" strokeDasharray="5 4" />
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Histogram with a density curve
 * ------------------------------------------------------------------ */

export function HistogramCurve({ bars, curve, unit = 'm/s', height = 320, curveLabel }) {
  const T = useChartTheme();
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const xd = [bars[0].centre, bars[bars.length - 1].centre];
  const maxY = Math.max(...bars.map((b) => b.density), ...(curve?.map((c) => c.y) ?? [0])) * 1.08;
  const px = (v) => PAD.l + ((v - xd[0]) / (xd[1] - xd[0] || 1)) * iw;
  const py = (v) => PAD.t + ih - (v / (maxY || 1)) * ih;
  const bw = iw / bars.length;
  const barFill = T.key === 'notebook' ? T.series[0] : 'rgba(95,211,196,0.42)';
  const curveCol = T.key === 'notebook' ? T.series[1] : '#E3A857';

  return (
    <Figure>
      <Legend items={[{ label: 'Observed', colour: barFill },
        ...(curve ? [{ label: curveLabel ?? 'Weibull fit', colour: curveCol }] : [])]} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={xd} yDomain={[0, maxY]} xLabel={`Wind speed (${unit})`} yLabel="Probability density">
          {bars.map((b, i) => (
            <rect key={i} x={px(b.centre) - bw / 2} y={py(b.density)} width={Math.max(bw - 0.6, 0.6)}
              height={Math.max(PAD.t + ih - py(b.density), 0)} fill={barFill}
              opacity={T.key === 'notebook' ? 0.75 : 1}
              stroke={T.key === 'notebook' ? 'rgba(0,0,0,0.15)' : 'none'} strokeWidth="0.4" />
          ))}
          {curve && (
            <path d={curve.map((c, i) => `${i ? 'L' : 'M'}${px(c.x).toFixed(1)} ${py(c.y).toFixed(1)}`).join('')}
              fill="none" stroke={curveCol} strokeWidth="2" />
          )}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Band chart
 * ------------------------------------------------------------------ */

export function BandChart({ points, yLabel, xLabel, height = 300 }) {
  const T = useChartTheme();
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const lo = Math.min(...points.map((p) => p.mean - p.sd));
  const hi = Math.max(...points.map((p) => p.mean + p.sd));
  const pad = (hi - lo) * 0.1 || 1;
  const yd = [lo - pad, hi + pad];
  const px = (i) => PAD.l + (i / (points.length - 1 || 1)) * iw;
  const py = (v) => PAD.t + ih - ((v - yd[0]) / (yd[1] - yd[0] || 1)) * ih;
  const line = T.key === 'notebook' ? T.series[0] : T.bar;
  const band = T.key === 'notebook' ? 'rgba(31,119,180,0.20)' : T.band;
  const area = [...points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(p.mean + p.sd).toFixed(1)}`),
    ...points.slice().reverse().map((p, i) => `L${px(points.length - 1 - i).toFixed(1)} ${py(p.mean - p.sd).toFixed(1)}`), 'Z'].join('');

  return (
    <Figure>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={[0, points.length - 1]} yDomain={yd} yLabel={yLabel} xLabel={xLabel}
          xTicks={points.filter((_, i) => i % 3 === 0).map((p, k) => ({ value: k * 3, label: String(p.hour) }))}>
          <path d={area} fill={band} stroke="none" />
          <path d={points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(p.mean).toFixed(1)}`).join('')}
            fill="none" stroke={line} strokeWidth="2" />
          {points.map((p, i) => <circle key={i} cx={px(i)} cy={py(p.mean)} r="2.6" fill={line} />)}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Diebold-Mariano matrix
 * ------------------------------------------------------------------ */

export function PMatrix({ names, rows }) {
  const T = useChartTheme();
  const cell = 62, labelW = 190, headH = 96;
  const w = labelW + names.length * cell + 12;
  const h = headH + names.length * 28 + 10;

  // notebook mode uses a Blues ramp, as an imshow with cmap='Blues' would
  const shade = (p) => {
    if (!isFinite(p)) return T.key === 'notebook' ? '#eeeeee' : '#0d141a';
    if (T.key === 'notebook') {
      if (p < 0.001) return '#08306b';
      if (p < 0.01) return '#2171b5';
      if (p < 0.05) return '#6baed6';
      return '#deebf7';
    }
    if (p < 0.001) return T.bar;
    if (p < 0.01) return '#4bab9f';
    if (p < 0.05) return '#3a8279';
    return '#1a242c';
  };
  const textOn = (p) => {
    if (!isFinite(p)) return T.muted;
    if (T.key === 'notebook') return p < 0.01 ? '#ffffff' : '#000000';
    return p < 0.05 ? '#06231f' : T.muted;
  };

  return (
    <Figure>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${w} ${h}`} width={Math.max(w, 640)} role="img">
          {names.map((n, j) => (
            <text key={n} transform={`translate(${labelW + j * cell + cell / 2} ${headH - 8}) rotate(-38)`}
              fill={T.muted} fontSize="10" textAnchor="start">{n}</text>
          ))}
          {names.map((a, i) => (
            <g key={a}>
              <text x={labelW - 10} y={headH + i * 28 + 18} fill={T.ink} fontSize="10.5" textAnchor="end">{a}</text>
              {names.map((b, j) => {
                const p = rows[a][b];
                return (
                  <g key={b}>
                    <rect x={labelW + j * cell} y={headH + i * 28 + 2} width={cell - 2} height={24}
                      fill={shade(p)} stroke={T.key === 'notebook' ? '#ffffff' : 'none'} strokeWidth="1" />
                    <text x={labelW + j * cell + (cell - 2) / 2} y={headH + i * 28 + 18}
                      fill={textOn(p)} fontSize="9.5" textAnchor="middle"
                      fontFamily="var(--mono)">{isFinite(p) ? p.toFixed(3) : ''}</text>
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Training loss
 * ------------------------------------------------------------------ */

export function LossCurves({ history, height = 280 }) {
  const T = useChartTheme();
  const w = 900, h = height;
  const series = [
    { label: 'Training loss', values: history.loss, colour: T.key === 'notebook' ? T.series[0] : T.bar },
    { label: 'Validation loss', values: history.valLoss, colour: T.key === 'notebook' ? T.series[1] : '#E3A857' },
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
    <Figure>
      <Legend items={series.map((s) => ({ label: s.label, colour: s.colour }))} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={[0, Math.max(n - 1, 1)]} yDomain={yd} xLabel="Epoch" yLabel="MSE">
          {series.map((s) => (
            <path key={s.label} d={s.values.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join('')}
              fill="none" stroke={s.colour} strokeWidth="1.8" />
          ))}
        </Panel>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * Blend-weight search
 * ------------------------------------------------------------------ */

export function WeightCurve({ curve, best, height = 280 }) {
  const T = useChartTheme();
  const w = 900, h = height;
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const ys = curve.map((c) => c.rmse);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.12 || 0.01;
  const yd = [lo - pad, hi + pad];
  const px = (v) => PAD.l + v * iw;
  const py = (v) => PAD.t + ih - ((v - yd[0]) / (yd[1] - yd[0] || 1)) * ih;
  const line = T.key === 'notebook' ? T.series[0] : T.bar;

  return (
    <Figure>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img">
        <Panel w={w} h={h} xDomain={[0, 1]} yDomain={yd}
          xLabel="Weight on the first model (w)" yLabel="Held-out RMSE">
          <path d={curve.map((c, i) => `${i ? 'L' : 'M'}${px(c.w).toFixed(1)} ${py(c.rmse).toFixed(1)}`).join('')}
            fill="none" stroke={line} strokeWidth="1.9" />
          <line x1={px(best)} x2={px(best)} y1={PAD.t} y2={PAD.t + ih}
            stroke={T.reference} strokeWidth="1.3" strokeDasharray="4 3" />
          <text x={px(best) + 6} y={PAD.t + 14} fill={T.reference} fontSize="10.5">w = {best.toFixed(2)}</text>
        </Panel>
      </svg>
    </Figure>
  );
}
