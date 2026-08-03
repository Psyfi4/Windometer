/**
 * Comparing one run against another.
 *
 * Kept free of storage and of React so it can be reasoned about and tested on
 * its own: everything here is a pure function over two saved records.
 *
 * The interesting question when the same models are run on two different sites
 * is rarely "which numbers are bigger". Wind records differ in how predictable
 * they are, so a model can post a worse RMSE at one site and still be the
 * better model. What transfers is the *ordering* — whether the models rank the
 * same way on both records — so that is reported alongside the raw deltas.
 */

/* ------------------------------------------------------------------ *
 * Building a record
 * ------------------------------------------------------------------ */

/**
 * Reduce a finished run to something small enough to keep.
 *
 * Predictions are deliberately dropped. A test block runs to tens of thousands
 * of rows per model, which would put megabytes into storage per run for
 * something no comparison here reads. Metrics, the Weibull fit and the monthly
 * table are a few kilobytes and answer every question the comparison asks.
 */
export function buildRecord({
  file, dataset, site, unit, presetName, preset, testSize, topK,
  board, evals, results, weibull, label,
}) {
  const models = {};
  for (const row of board) {
    const ev = evals[row.Model];
    models[row.Model] = {
      rmse: row.rmse,
      mae: row.mae,
      r2: row.r2,
      mape: row.mape,
      rmseScaled: row.rmseScaled ?? null,
      maeScaled: row.maeScaled ?? null,
      rmseCiLo: ev?.rmseCI?.lo ?? null,
      rmseCiHi: ev?.rmseCI?.hi ?? null,
      tailRmse: ev?.tail?.tailRmse ?? null,
      tailMae: ev?.tail?.tailMae ?? null,
      exceedance: ev?.tail?.exceedanceRecall ?? null,
      seconds: results[row.Model]?.seconds ?? null,
      kind: row.Type,
    };
  }

  const heights = {};
  if (weibull?.annual?.heights) {
    for (const [h, v] of Object.entries(weibull.annual.heights)) {
      heights[h] = { wpd: v.wpd, mws: v.mws, k: v.k, s: v.s };
    }
  }

  return {
    savedAt: Date.now(),
    label: label || file?.name || 'Untitled run',
    file: {
      name: file?.name ?? null,
      hours: dataset?.summary?.nHours ?? null,
      startYear: dataset?.summary?.startYear ?? null,
      endYear: dataset?.summary?.endYear ?? null,
      mean: dataset?.summary?.mean ?? null,
      p95: dataset?.summary?.p95 ?? null,
    },
    station: site,
    unit,
    preset: presetName,
    settings: {
      nEstimators: preset?.nEstimators ?? null,
      maxDepth: preset?.maxDepth ?? null,
      epochs: preset?.epochs ?? null,
      testSize,
      topK,
    },
    models,
    weibull: weibull?.annual
      ? {
        k: weibull.annual.k,
        s: weibull.annual.s,
        epf: weibull.annual.epf,
        meanObserved: weibull.annual.meanObserved,
        alpha: weibull.annual.alpha,
        heights,
      }
      : null,
    monthly: (weibull?.monthly ?? []).map((m) => ({
      month: m.month,
      k: m.k,
      s: m.s,
      mwsObserved: m.mwsObserved,
      wpd150: m.heights?.[150]?.wpd ?? null,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Rank agreement
 * ------------------------------------------------------------------ */

/**
 * Kendall's tau-b between two orderings of the same models.
 *
 * Chosen over Spearman because it counts concordant and discordant pairs
 * directly, which is the question being asked — for any two models, do both
 * records agree on which is better? It also handles the small n here (rarely
 * more than fifteen models) more gracefully.
 *
 * +1  every pair ranked the same way on both records
 *  0  no relationship
 * -1  the ordering is exactly reversed
 */
export function kendallTau(a, b) {
  const n = a.length;
  if (n < 2) return NaN;
  let concordant = 0;
  let discordant = 0;
  let tiedA = 0;
  let tiedB = 0;

  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const da = a[i] - a[j];
      const db = b[i] - b[j];
      const s = Math.sign(da) * Math.sign(db);
      if (da === 0 && db === 0) continue;
      else if (da === 0) tiedA++;
      else if (db === 0) tiedB++;
      else if (s > 0) concordant++;
      else discordant++;
    }
  }

  const denom = Math.sqrt((concordant + discordant + tiedA) * (concordant + discordant + tiedB));
  return denom === 0 ? NaN : (concordant - discordant) / denom;
}

/* ------------------------------------------------------------------ *
 * Comparing
 * ------------------------------------------------------------------ */

const METRICS = {
  rmse: { label: 'RMSE (m/s)', lowerIsBetter: true, digits: 4 },
  mae: { label: 'MAE (m/s)', lowerIsBetter: true, digits: 4 },
  r2: { label: 'R²', lowerIsBetter: false, digits: 4 },
  mape: { label: 'MAPE (%)', lowerIsBetter: true, digits: 2 },
  rmseScaled: { label: 'RMSE (scaled)', lowerIsBetter: true, digits: 5 },
  tailRmse: { label: 'Tail RMSE', lowerIsBetter: true, digits: 4 },
  exceedance: { label: 'Exceedance recall', lowerIsBetter: false, digits: 3 },
};

export const COMPARABLE_METRICS = Object.entries(METRICS)
  .map(([key, m]) => ({ key, ...m }));

/**
 * Line up two records model by model.
 *
 * Only models present in both are compared; running different selections on
 * the two records is normal, and silently comparing a model against nothing
 * would invent a result.
 */
export function compareRuns(current, baseline, metric = 'rmse') {
  const meta = METRICS[metric] ?? METRICS.rmse;
  const shared = Object.keys(current.models)
    .filter((m) => baseline.models[m] != null);
  const onlyCurrent = Object.keys(current.models).filter((m) => !baseline.models[m]);
  const onlyBaseline = Object.keys(baseline.models).filter((m) => !current.models[m]);

  const rows = shared.map((model) => {
    const a = current.models[model][metric];
    const b = baseline.models[model][metric];
    const delta = (Number.isFinite(a) && Number.isFinite(b)) ? a - b : NaN;
    const pct = (Number.isFinite(delta) && b !== 0) ? (delta / Math.abs(b)) * 100 : NaN;
    const better = Number.isFinite(delta)
      ? (meta.lowerIsBetter ? delta < 0 : delta > 0)
      : null;
    return {
      model,
      kind: current.models[model].kind ?? baseline.models[model].kind ?? '',
      current: a,
      baseline: b,
      delta,
      pct,
      better,
    };
  });

  // rank within each record, then ask whether the two agree
  const rank = (vals) => {
    const order = vals.map((v, i) => [v, i])
      .sort((x, y) => (meta.lowerIsBetter ? x[0] - y[0] : y[0] - x[0]));
    const out = new Array(vals.length);
    order.forEach(([, i], r) => { out[i] = r; });
    return out;
  };
  const finite = rows.filter((r) => Number.isFinite(r.current) && Number.isFinite(r.baseline));
  const tau = finite.length >= 2
    ? kendallTau(rank(finite.map((r) => r.current)), rank(finite.map((r) => r.baseline)))
    : NaN;

  const bestOf = (rec) => {
    let best = null;
    for (const m of shared) {
      const v = rec.models[m][metric];
      if (!Number.isFinite(v)) continue;
      if (best === null || (meta.lowerIsBetter ? v < best.value : v > best.value)) {
        best = { model: m, value: v };
      }
    }
    return best;
  };

  rows.sort((x, y) => (meta.lowerIsBetter ? x.current - y.current : y.current - x.current));

  return {
    metric,
    meta,
    rows,
    shared,
    onlyCurrent,
    onlyBaseline,
    tau,
    bestCurrent: bestOf(current),
    bestBaseline: bestOf(baseline),
    improved: rows.filter((r) => r.better === true).length,
    worsened: rows.filter((r) => r.better === false).length,
  };
}

/** Side-by-side of the two Weibull fits, for the resource comparison. */
export function compareWeibull(current, baseline) {
  if (!current.weibull || !baseline.weibull) return null;
  const heights = [...new Set([
    ...Object.keys(current.weibull.heights ?? {}),
    ...Object.keys(baseline.weibull.heights ?? {}),
  ])].map(Number).sort((a, b) => a - b);

  return {
    scalars: [
      ['Shape k', current.weibull.k, baseline.weibull.k, 3],
      ['Scale s (m/s)', current.weibull.s, baseline.weibull.s, 3],
      ['Energy pattern factor', current.weibull.epf, baseline.weibull.epf, 3],
      ['Observed mean (m/s)', current.weibull.meanObserved, baseline.weibull.meanObserved, 3],
    ],
    heights: heights.map((h) => ({
      height: h,
      currentWpd: current.weibull.heights?.[h]?.wpd ?? NaN,
      baselineWpd: baseline.weibull.heights?.[h]?.wpd ?? NaN,
      currentMws: current.weibull.heights?.[h]?.mws ?? NaN,
      baselineMws: baseline.weibull.heights?.[h]?.mws ?? NaN,
    })),
    monthly: (current.monthly ?? []).map((m, i) => ({
      month: m.month,
      current: m.wpd150,
      baseline: baseline.monthly?.[i]?.wpd150 ?? NaN,
    })),
  };
}

/** One line summarising what the comparison found. */
export function summarise(cmp) {
  if (!cmp || !cmp.rows.length) return 'No models in common between the two runs.';
  const dir = cmp.meta.lowerIsBetter ? 'lower' : 'higher';
  const agree = Number.isFinite(cmp.tau)
    ? (cmp.tau > 0.7 ? 'The two records rank the models almost identically'
      : cmp.tau > 0.3 ? 'The two records broadly agree on the ordering'
        : cmp.tau > -0.3 ? 'The two records disagree on the ordering'
          : 'The ordering is close to reversed between the two records')
    : 'Not enough shared models to compare the ordering';
  return `${cmp.improved} of ${cmp.rows.length} models score ${dir} on this record than on the baseline. `
    + `${agree} (Kendall's tau ${Number.isFinite(cmp.tau) ? cmp.tau.toFixed(2) : '—'}).`;
}


/* ------------------------------------------------------------------ *
 * Across every record at once
 * ------------------------------------------------------------------ */

/**
 * Kendall's W, the coefficient of concordance.
 *
 * Tau answers "do these two records agree?". W answers the same question for
 * any number of them at once, which is what the pooled analysis in the study
 * is doing across its six stations. Each record ranks the models; W measures
 * how much those rankings coincide.
 *
 *   1  every record puts the models in exactly the same order
 *   0  the orderings are unrelated
 *
 * @param rankings array of arrays; one ranking per record, models in a fixed
 *                 column order, values are ranks starting at 0
 */
export function kendallW(rankings) {
  const m = rankings.length;          // records
  if (m < 2) return NaN;
  const n = rankings[0].length;       // models
  if (n < 2) return NaN;

  const sums = new Array(n).fill(0);
  for (const r of rankings) {
    for (let i = 0; i < n; i++) sums[i] += r[i];
  }
  const mean = sums.reduce((a, b) => a + b, 0) / n;
  const S = sums.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  const denom = (m * m * (n ** 3 - n)) / 12;
  return denom === 0 ? NaN : S / denom;
}

/**
 * Every model against every record.
 *
 * Restricted to models that appear in all of them. Ranking a model that only
 * ran on half the datasets against ones that ran on all of them would put a
 * number on something that was never measured, and the mean rank would quietly
 * favour whichever models happened to be selected on the easier sites. The
 * excluded ones are returned so the interface can say what was left out.
 */
export function compareAcross(records, metric = 'rmse') {
  const meta = METRICS[metric] ?? METRICS.rmse;
  if (!records.length) {
    return { models: [], records: [], rows: [], excluded: [], kendallW: NaN, meta };
  }

  const counts = new Map();
  for (const rec of records) {
    for (const m of Object.keys(rec.models ?? {})) {
      const v = rec.models[m][metric];
      if (Number.isFinite(v)) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  }
  const models = [...counts.entries()]
    .filter(([, c]) => c === records.length)
    .map(([m]) => m);
  const excluded = [...counts.entries()]
    .filter(([, c]) => c < records.length)
    .map(([m, c]) => ({ model: m, present: c, of: records.length }));

  // rank the models within each record independently
  const rankings = records.map((rec) => {
    const vals = models.map((m) => rec.models[m][metric]);
    const order = vals.map((v, i) => [v, i])
      .sort((a, b) => (meta.lowerIsBetter ? a[0] - b[0] : b[0] - a[0]));
    const ranks = new Array(models.length);
    order.forEach(([, i], r) => { ranks[i] = r; });
    return ranks;
  });

  const rows = models.map((model, i) => {
    const values = records.map((rec) => rec.models[model][metric]);
    const ranks = rankings.map((r) => r[i]);
    const meanRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const best = ranks.filter((r) => r === 0).length;
    const spread = Math.max(...ranks) - Math.min(...ranks);
    const finite = values.filter(Number.isFinite);
    return {
      model,
      kind: records.find((r) => r.models[model])?.models[model]?.kind ?? '',
      values,
      ranks,
      meanRank,
      bestCount: best,
      spread,
      mean: finite.reduce((a, b) => a + b, 0) / (finite.length || 1),
    };
  });

  rows.sort((a, b) => a.meanRank - b.meanRank);

  return {
    models,
    records: records.map((r) => r.label),
    rows,
    excluded,
    kendallW: kendallW(rankings),
    meta,
    metric,
  };
}

/** One line on what the pooled comparison found. */
export function summariseAcross(across) {
  if (!across || !across.rows.length) {
    return 'No model appears in every record, so nothing can be ranked across them.';
  }
  const w = across.kendallW;
  const agree = !Number.isFinite(w) ? 'Only one record, so there is nothing to agree with'
    : w > 0.8 ? 'The records agree strongly on the ordering'
      : w > 0.5 ? 'The records mostly agree on the ordering'
        : w > 0.25 ? 'The records agree only loosely'
          : 'The records disagree; the ranking is site-specific';
  const top = across.rows[0];
  return `${top.model} has the best mean rank across ${across.records.length} records, `
    + `leading on ${top.bestCount} of them. ${agree} `
    + `(Kendall's W ${Number.isFinite(w) ? w.toFixed(2) : '—'}).`;
}
