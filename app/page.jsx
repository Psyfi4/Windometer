'use client';

/**
 * Windlab.
 *
 * Everything happens on this page and in the visitor's browser: the file is
 * read locally, models train on the main thread with yields between batches,
 * and no data leaves the machine. That is what lets it live on a static host.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as D from '@/lib/data';
import * as S from '@/lib/stats';
import * as W from '@/lib/weibull';
import * as MM from '@/lib/models';
import * as SITES from '@/lib/sites';
import { loadSeries } from '@/lib/parse';
import {
  FAMILY_COLOUR, ChartThemeProvider, TimeSeries, DensityScatter, IntervalPlot,
  BarsH, GroupedBars, MultiLine, FitScatter, BlandAltman, SignedBars,
  HistogramCurve, BandChart, PMatrix, LossCurves, WeightCurve,
} from '@/components/Charts';
import { themeForSite, chartTheme, PALETTE, SITE_THEMES } from '@/lib/theme';
// Namespace import for the frame helper on purpose. A named import of a symbol
// an older lib/theme.js does not export fails the build outright; reached
// through the namespace it is simply undefined, and the CSS falls back to the
// unrotated spectrum. Version skew degrades instead of breaking.
import * as Theme from '@/lib/theme';
import Backdrop from '@/components/Backdrop';
import { useSmoothScroll } from '@/lib/useSmoothScroll';
import {
  buildRecord, compareRuns, compareWeibull, summarise,
  compareAcross, summariseAcross, COMPARABLE_METRICS,
} from '@/lib/compare';
import { Eyebrow, Note, Card, CardCI, CardRow, Table, Legend3 } from '@/components/ui';

const HUB_HEIGHTS = [100, 120, 150];
const OUTPUTS = [
  { key: 'Dataset', title: 'Dataset', blurb: 'Record span, gap treatment, diurnal profile and the observed distribution against its Weibull fit.' },
  { key: 'Comparison', title: 'Comparison', blurb: 'Leaderboard, error with bootstrap intervals, Diebold-Mariano significance, all models against the observed series.' },
  { key: 'Models', title: 'Per model', blurb: 'One model at a time: accuracy, agreement, extreme-wind behaviour, which lags it leans on.' },
  { key: 'Weibull', title: 'Weibull & power', blurb: 'Shape and scale by the MEPF method, power density at 100, 120 and 150 m.' },
  { key: 'Region', title: 'Region', blurb: 'Where the record comes from, and the other stations in the study.' },
  { key: 'Compare', title: 'Across datasets', blurb: 'Set this run against one saved earlier: per-model deltas, whether the ordering holds between the two records, and the resource assessments side by side.' },
  { key: 'Export', title: 'Export', blurb: 'Metrics, predictions and tables as CSV, plus the exact run settings.' },
];

const fmtInt = (n) => n.toLocaleString('en-US');

export default function Page() {
  /* ------------------------------ state ------------------------------ */
  const [file, setFile] = useState(null);
  const [dataset, setDataset] = useState(null);   // { values, times, report, summary, ... }
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [unit, setUnit] = useState('kmh');
  const [site, setSite] = useState('auto');
  const [customLat, setCustomLat] = useState(8.7642);
  const [customLon, setCustomLon] = useState(78.1348);

  const [presetName, setPresetName] = useState('Standard');
  const [runAll, setRunAll] = useState(false);
  const [chosen, setChosen] = useState(['RF', 'GBM']);
  const [testSize, setTestSize] = useState(0.2);
  const [topK, setTopK] = useState(12);
  const [alphaMode, setAlphaMode] = useState('fixed');
  const [alphaCustom, setAlphaCustom] = useState(0.14);
  const [showScaled, setShowScaled] = useState(true);

  const [results, setResults] = useState({});
  const [evals, setEvals] = useState({});
  const [progress, setProgress] = useState(null);
  const [outputs, setOutputs] = useState(OUTPUTS.map((o) => o.key));
  const [activeModel, setActiveModel] = useState(null);
  const [dmLoss, setDmLoss] = useState('squared');
  const [chartStyle, setChartStyle] = useState('notebook');
  const [ambience, setAmbience] = useState(true);
  const [setupOpen, setSetupOpen] = useState(true);
  const scrollerRef = useRef(null);
  const [prefersReduced, setPrefersReduced] = useState(false);
  const [forceMotion, setForceMotion] = useState(false);

  // the run library, held in the browser
  const [library, setLibrary] = useState([]);
  const [baselineId, setBaselineId] = useState(null);
  const [libMsg, setLibMsg] = useState(null);
  const [libBusy, setLibBusy] = useState(false);
  const [restored, setRestored] = useState(null);

  const preset = MM.PRESETS[presetName];
  const stationTheme = themeForSite(site);
  const accent = stationTheme.accent;
  const chartT = useMemo(() => chartTheme(chartStyle, accent), [chartStyle, accent]);
  const alphaValue = alphaMode === 'fixed' ? 0.14 : alphaMode === 'computed' ? null : alphaCustom;

  /* ------------------------------ loading ---------------------------- */
  const handleFile = useCallback(async (f) => {
    if (!f) return;
    setBusy(true);
    setLoadError(null);
    setResults({});
    setEvals({});
    try {
      const raw = await loadSeries(f);
      const { values: filled, report } = D.fillGaps(raw.times, raw.values);
      const ms = D.toMetresPerSecond(filled, unit);
      const summary = D.summarise(ms, raw.times);
      const parts = D.calendarParts(raw.times);
      setDataset({
        values: ms, times: raw.times, report, summary, parts,
        format: raw.format, preview: raw.preview, headers: raw.headers,
      });
      setFile(f);
      const guess = SITES.detectSite(f.name);
      if (guess) setSite(guess);
    } catch (err) {
      setLoadError(err?.message || String(err));
      setDataset(null);
    } finally {
      setBusy(false);
    }
  }, [unit]);

  // changing the recorded unit rescales without re-reading the file
  const reunit = useCallback((next) => {
    if (next === unit) return;
    setUnit(next);
    if (!dataset) return;
    const back = unit === 'kmh' ? dataset.values.map((v) => v * 3.6) : dataset.values;
    const rescaled = D.toMetresPerSecond(Float64Array.from(back), next);
    setDataset((d) => ({ ...d, values: rescaled, summary: D.summarise(rescaled, d.times) }));
    setResults({});
    setEvals({});
  }, [dataset, unit]);

  // Eased wheel scrolling. Off when ambience is off, and the hook disables
  // itself under prefers-reduced-motion regardless.
  useSmoothScroll(scrollerRef, { enabled: ambience && (!prefersReduced || forceMotion) });

  // The platform can ask for less motion. Honour it, but say so, because
  // otherwise the ambient effects look simply broken.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReduced(mq.matches);
    const onChange = (e) => setPrefersReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const refreshLibrary = useCallback(async () => {
    try {
      const store = await import('@/lib/store');
      setLibrary(await store.listRuns());
    } catch (err) {
      setLibMsg(err?.message || 'The run library is unavailable in this browser.');
    }
  }, []);

  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  // Bring back the last finished run. A run costs minutes; a reload should not
  // cost them again. Predictions and the hourly series are stored as typed
  // arrays, so this is a read rather than a recomputation.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const store = await import('@/lib/store');
        const sess = await store.loadSession();
        if (!live || !sess?.dataset || !sess?.results) return;
        setDataset(sess.dataset);
        setResults(sess.results);
        setEvals(sess.evals ?? {});
        setFile(sess.fileMeta ?? null);
        if (sess.site) setSite(sess.site);
        if (sess.unit) setUnit(sess.unit);
        if (sess.presetName) setPresetName(sess.presetName);
        if (sess.chosen) setChosen(sess.chosen);
        if (typeof sess.testSize === 'number') setTestSize(sess.testSize);
        setActiveModel(Object.keys(sess.evals ?? {})[0] ?? null);
        setSetupOpen(false);
        setRestored({
          at: sess.savedAt,
          models: Object.keys(sess.evals ?? {}).length,
          name: sess.fileMeta?.name ?? 'a previous run',
        });
      } catch {
        // no session, or a browser without IndexedDB — start clean
      }
    })();
    return () => { live = false; };
  }, []);

  /* ------------------------------ features --------------------------- */
  const features = useMemo(() => {
    if (!dataset) return null;
    try {
      const fx = D.makeFeatures(dataset.values, dataset.times);
      const split = D.chronologicalSplit(fx, testSize, preset.maxTrainRows);
      const test = capBlock(split.test, preset.maxTestRows);
      return { train: split.train, test };
    } catch {
      return null;
    }
  }, [dataset, testSize, preset.maxTrainRows, preset.maxTestRows]);

  const weibull = useMemo(() => {
    if (!dataset) return null;
    const annual = W.annualSummary(dataset.values, HUB_HEIGHTS, alphaValue);
    const monthly = W.monthlyTable(dataset.values, dataset.parts.months, HUB_HEIGHTS, alphaValue);
    return { annual, monthly };
  }, [dataset, alphaValue]);

  /* ------------------------------ running ---------------------------- */
  const selected = runAll
    ? Object.keys(MM.REGISTRY)
    : chosen.filter((n) => MM.REGISTRY[n]);

  const persistRef = useRef(null);
  const run = useCallback(async () => {
    if (!features || !selected.length) return;
    setBusy(true);
    const nextResults = {};
    const nextEvals = {};
    const scaler = S.makeScaler(features.train.y);
    const neural = await import('@/lib/neural');

    for (let i = 0; i < selected.length; i++) {
      const name = selected[i];
      setProgress({ name, index: i, total: selected.length, fraction: 0, message: 'Starting' });
      await new Promise((r) => setTimeout(r, 0));
      try {
        const res = await MM.runModel(
          name, features.train, features.test, preset, { topK }, neural,
          (fraction, message) => setProgress({ name, index: i, total: selected.length, fraction, message })
        );
        nextResults[name] = res;
        nextEvals[name] = S.evaluateModel(features.test.y, res.predictions, scaler, preset.nBootstrap);
      } catch (err) {
        nextResults[name] = { name, failed: true, error: err?.message || String(err) };
      }
      setResults({ ...nextResults });
      setEvals({ ...nextEvals });
    }
    setProgress(null);
    setBusy(false);
    const ok = Object.keys(nextEvals);
    if (ok.length) {
      setActiveModel(ok[0]);
      setSetupOpen(false);   // give the results the room once there are some

      // Keep the run without being asked. Saving used to be a button, which
      // meant a reload after ten minutes of training threw the lot away — a
      // poor trade for the storage it saved. The session holds the whole thing
      // so the page comes back; the library entry holds the metrics so it can
      // still be compared against later.
      persistRef.current?.(nextResults, nextEvals).catch(() => {});

      // carry the reader down to the results rather than leaving them on the deck
      requestAnimationFrame(() => {
        document.getElementById('stage-outputs')?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, [features, selected, preset, topK]);

  /**
   * Write the finished run to both stores.
   *
   * The session is the working copy — everything needed to redraw the page.
   * The library entry is the durable record: metrics and the Weibull fit only,
   * because a comparison never reads a prediction and keeping them would put
   * megabytes into the archive for every run.
   */
  const persist = useCallback(async (runResults, runEvals) => {
    const store = await import('@/lib/store');

    const rows = Object.entries(runEvals).map(([name, ev]) => ({
      Model: name,
      Type: MM.REGISTRY[name].kind === 'base' ? 'Base' : 'Hybrid',
      rmse: ev.raw.rmse, mae: ev.raw.mae, r2: ev.raw.r2, mape: ev.raw.mape,
      rmseScaled: ev.scaled?.rmse, maeScaled: ev.scaled?.mae,
      seconds: runResults[name]?.seconds,
    })).sort((a, b) => a.rmse - b.rmse);

    await store.saveSession({
      dataset,
      results: runResults,
      evals: runEvals,
      fileMeta: file ? { name: file.name, size: file.size } : null,
      site, unit, presetName, testSize, topK,
      chosen: selected,
    });

    await store.saveRun(buildRecord({
      file, dataset, site, unit, presetName, preset, testSize, topK,
      board: rows, evals: runEvals, results: runResults, weibull,
      label: file?.name,
    }));
    await refreshLibrary();
  }, [dataset, file, site, unit, presetName, preset, testSize, topK, selected, weibull, refreshLibrary]);

  // run() is declared above persist, so it reaches it through a ref
  persistRef.current = persist;

  const saveCurrentRun = useCallback(async (label) => {
    if (!Object.keys(evals).length) return;
    setLibBusy(true);
    setLibMsg(null);
    try {
      const store = await import('@/lib/store');
      const record = buildRecord({
        file, dataset, site, unit, presetName, preset, testSize, topK,
        board: boardRef.current, evals, results, weibull, label,
      });
      await store.saveRun(record);
      await refreshLibrary();
      setLibMsg(`Saved “${record.label}” to the library.`);
    } catch (err) {
      setLibMsg(err?.message || 'Could not save that run.');
    } finally {
      setLibBusy(false);
    }
  }, [evals, results, file, dataset, site, unit, presetName, preset, testSize, topK, weibull, refreshLibrary]);

  /* ------------------------------ derived ---------------------------- */
  const board = useMemo(() => {
    const rows = Object.entries(evals).map(([name, ev]) => ({
      Model: name,
      Type: MM.REGISTRY[name].kind === 'base' ? 'Base' : 'Hybrid',
      rmse: ev.raw.rmse, mae: ev.raw.mae, r2: ev.raw.r2, mape: ev.raw.mape,
      rmseScaled: ev.scaled?.rmse, maeScaled: ev.scaled?.mae,
      seconds: results[name]?.seconds,
    }));
    return rows.sort((a, b) => a.rmse - b.rmse);
  }, [evals, results]);

  // saveCurrentRun is declared above board, so it reads it through a ref
  const boardRef = useRef([]);
  boardRef.current = board;

  const bestModel = board[0]?.Model ?? null;
  const failures = Object.values(results).filter((r) => r.failed);

  const siteMeta = site !== 'auto' ? SITES.SITES[site] : null;
  const lat = siteMeta ? siteMeta.lat : customLat;
  const lon = siteMeta ? siteMeta.lon : customLon;

  /* ------------------------------ render ----------------------------- */
  const breathe = stationTheme.breathe ?? [accent, accent, accent];
  const showResults = Object.keys(evals).length > 0;

  const setup = {
    file, dataset, busy, loadError, handleFile,
    unit, reunit, site, setSite, customLat, setCustomLat, customLon, setCustomLon,
    stationTheme, accent, presetName, setPresetName, preset,
    chartStyle, setChartStyle, ambience, setAmbience,
    runAll, setRunAll, chosen, setChosen, selected,
    testSize, setTestSize, topK, setTopK,
    alphaMode, setAlphaMode, alphaCustom, setAlphaCustom,
    showScaled, setShowScaled, features, run, progress,
    setupOpen, setSetupOpen, prefersReduced, forceMotion, setForceMotion,
  };

  const toggleOutput = (key) => setOutputs(
    outputs.includes(key) ? outputs.filter((k) => k !== key) : [...outputs, key]
  );

  return (
    <ChartThemeProvider theme={chartT}>
      <div
        ref={scrollerRef}
        // `ambient` gates 112 rules in the stylesheet — the breathing colour,
        // the glass surfaces, the drifting titles. It used to sit on a .shell
        // wrapper that the six-stage restructure removed, which left every one
        // of those rules matching nothing.
        className={
          'app-root'
          + (ambience ? ' ambient' : '')
          + (ambience && (!prefersReduced || forceMotion) ? ' eased' : '')
        }
        data-motion={forceMotion ? 'on' : undefined}
        style={{
          '--accent': accent,
          '--breathe-1': breathe[0],
          '--breathe-2': breathe[1],
          '--breathe-3': breathe[2],
          '--frame-conic': typeof Theme.frameConic === 'function'
            ? Theme.frameConic(accent)
            : undefined,
        }}
      >
        <Backdrop enabled={ambience} pinned={site !== 'auto' ? site : null} forceMotion={forceMotion} />
        {ambience && (
          <>
            <div className="grade" aria-hidden="true" />
            <div className="vignette" aria-hidden="true" />
            <div className="grain" aria-hidden="true" />
            <div className="frame-layer frame" aria-hidden="true" />
          </>
        )}

        <main className="main">

          {/* 1 — the mark. See the Wordmark component for how it is fitted. */}
          <section className="stage hero" id="stage-hero">
            <div className="stage-index">01 — Windlab</div>
            <div className="stage-inner">
              <Wordmark ambience={ambience} moving={!prefersReduced || forceMotion} />
              {/* Taken out of the centring calculation — see .hero-caption. */}
              <div className="hero-caption">
                <div className="wordmark-sub">Wind forecasting workbench</div>
                <p className="hero-lede">
                  Fifteen machine-learning models on your own wind record.
                  Trained in this tab, on your machine, with nothing sent anywhere.
                </p>
              </div>
            </div>
            <div className="scroll-hint">Scroll</div>
          </section>

          {/* 2 — what it does */}
          <section className="stage" id="stage-what">
            <div className="stage-index">02 — What it does</div>
            <div className="stage-inner">
              <h2 className="stage-title">Forecast wind,<br />an hour ahead.</h2>
              <p className="lede">
                Upload an hourly record and Windlab reconstructs it into a continuous
                series, builds causal features from the previous day, trains whichever
                models you choose, and reports how well each one did — with the
                statistics needed to say whether the difference between them is real.
              </p>
              <div className="grid2" style={{ marginTop: '2.2rem' }}>
                {[
                  ['Two layouts, no setup', 'IMD station files — one row per day with YEAR, MN, DT and hourly columns S01…S24 — or any table with a timestamp and a wind-speed column. Sub-hourly readings are averaged up to the hour.'],
                  ['Nothing leaves the machine', 'The file is read locally and every model trains in the browser. A long record is limited by your laptop rather than a server timeout, and no data is uploaded.'],
                  ['Fifteen models', 'Eight base learners — forests, four boosters, LSTM, BiLSTM, CNN — and seven hybrids that stack, blend or correct one another.'],
                  ['The statistical layer too', 'Weibull shape and scale by the Modified Energy Pattern Factor method, projected to turbine hub height for power density.'],
                ].map(([t, b]) => (
                  <div className="panel" key={t}>
                    <div className="eyebrow" style={{ marginTop: 0 }}>{t}</div>
                    <p style={{ fontSize: '0.86rem', lineHeight: 1.7, color: 'var(--muted)', margin: 0 }}>{b}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 3 — how it works */}
          <section className="stage" id="stage-how">
            <div className="stage-index">03 — How it works</div>
            <div className="stage-inner">
              <h2 className="stage-title">The protocol,<br />not just the score.</h2>
              <p className="lede">
                A number without a method behind it is decoration. Every run follows the
                evaluation protocol from Yadav et al. (2025), and reports the tests that
                say whether a difference is real.
              </p>
              <div className="grid2" style={{ marginTop: '2.2rem' }}>
                {[
                  ['Gaps', 'Under six hours by linear interpolation. Longer gaps take the monthly median for that calendar month. Empty months fall back to the record median.'],
                  ['Features', 'Twenty-four strictly causal lags forecasting one hour ahead. Nothing from the future reaches the model.'],
                  ['Split', 'Strictly chronological. Earliest data trains, latest data tests, no shuffling and no lookahead.'],
                  ['Accuracy', 'RMSE, MAE, R² and MAPE, in physical units and on the min-max scaled target so the published table can be compared with.'],
                  ['Uncertainty', 'Ninety-five per cent intervals from a moving-block bootstrap over twenty-four-hour blocks, which keeps temporal dependence intact.'],
                  ['Significance', 'Pairwise Diebold-Mariano tests with a Newey-West correction at lag 23. Overlapping intervals mean the data does not resolve the gap.'],
                  ['Extremes', 'P95 tail error and exceedance recall, because a model that tracks the mean and misses every gale is not much use to a turbine.'],
                  ['Honest hybrids', 'Every hybrid fits its meta-regressor on a later held-out slice the base learners never saw. Fitting it in-sample leaks, and flatters the result.'],
                ].map(([t, b]) => (
                  <div className="panel" key={t}>
                    <div className="eyebrow" style={{ marginTop: 0 }}>{t}</div>
                    <p style={{ fontSize: '0.85rem', lineHeight: 1.7, color: 'var(--muted)', margin: 0 }}>{b}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 4 — the workbench */}
          <section className="stage tall" id="stage-workbench">
            <div className="stage-index">04 — Set up the run</div>
            <div className="stage-inner">
              <h2 className="stage-title">Your data,<br />your models.</h2>
              <Deck {...setup} />

              {restored && (
                <div style={{ marginTop: '1rem' }}>
                  <Note tone="teal">
                    Picked up where you left off — <b>{restored.name}</b>, {restored.models}{' '}
                    model{restored.models === 1 ? '' : 's'}, finished{' '}
                    {new Date(restored.at).toLocaleString()}. Runs are kept automatically, so
                    a reload no longer costs you the training time.{' '}
                    <button
                      className="btn-ghost"
                      style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem', marginTop: '0.4rem' }}
                      onClick={async () => {
                        const store = await import('@/lib/store');
                        await store.clearSession();
                        setRestored(null);
                        setResults({});
                        setEvals({});
                        setDataset(null);
                        setFile(null);
                        setSetupOpen(true);
                      }}
                    >
                      Start fresh
                    </button>
                  </Note>
                </div>
              )}

              {!dataset && (
                <Note>
                  Drop a file above to begin. Nothing is uploaded — the file is read
                  locally and every model trains in this tab.
                </Note>
              )}
              {failures.length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                  <Note tone="coral">
                    {failures.length === 1 ? 'One model did not finish' : `${failures.length} models did not finish`}:{' '}
                    {failures.map((f) => `${f.name} (${f.error})`).join('; ')}
                  </Note>
                </div>
              )}
            </div>
          </section>

          {/* 5 — choose the output */}
          <section className="stage" id="stage-outputs">
            <div className="stage-index">05 — Choose the output</div>
            <div className="stage-inner">
              <h2 className="stage-title">What should<br />it show?</h2>
              <p className="lede">
                {showResults
                  ? 'Everything below is already computed. Pick which of it to lay out.'
                  : 'Pick now, or come back after a run. Nothing here recomputes anything.'}
              </p>
              <div className="picker">
                {OUTPUTS.map((o) => (
                  <button
                    key={o.key}
                    className={`picker-card${outputs.includes(o.key) ? ' on' : ''}`}
                    onClick={() => toggleOutput(o.key)}
                  >
                    <span className="mark" />
                    <span className="t">{o.title}</span>
                    <span className="b">{o.blurb}</span>
                  </button>
                ))}
              </div>
              {showResults && (
                <div style={{ marginTop: '1.6rem' }}>
                  <button
                    className="btn"
                    style={{ width: 'auto', padding: '0.6rem 1.8rem' }}
                    onClick={() => document.getElementById('stage-result-0')?.scrollIntoView({ behavior: 'smooth' })}
                  >
                    Show {outputs.length} {outputs.length === 1 ? 'section' : 'sections'}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* 6+ — one stage per chosen output, each with the same transition */}
          {showResults && OUTPUTS.filter((o) => outputs.includes(o.key)).map((o, i) => (
            <section className="stage tall" key={o.key} id={`stage-result-${i}`}>
              <div className="stage-index">{String(6 + i).padStart(2, '0')} — {o.title}</div>
              <div className="stage-inner">
                <h2 className="stage-title">{o.title}</h2>
                {o.key === 'Dataset' && <DatasetTab dataset={dataset} weibull={weibull} />}
                {o.key === 'Comparison' && (
                  <ComparisonTab
                    results={results} evals={evals} board={board} features={features}
                    showScaled={showScaled} site={site} dmLoss={dmLoss} setDmLoss={setDmLoss}
                  />
                )}
                {o.key === 'Models' && (
                  <ModelsTab
                    results={results} evals={evals} features={features}
                    activeModel={activeModel} setActiveModel={setActiveModel}
                    showScaled={showScaled}
                  />
                )}
                {o.key === 'Weibull' && (
                  <WeibullTab
                    weibull={weibull} dataset={dataset} site={site}
                    results={results} features={features} bestModel={bestModel}
                  />
                )}
                {o.key === 'Region' && <RegionTab site={site} lat={lat} lon={lon} />}
                {o.key === 'Compare' && (
                  <CompareTab
                    board={board} evals={evals} library={library}
                    baselineId={baselineId} setBaselineId={setBaselineId}
                    saveCurrentRun={saveCurrentRun} refreshLibrary={refreshLibrary}
                    libMsg={libMsg} setLibMsg={setLibMsg} libBusy={libBusy}
                    file={file} dataset={dataset} site={site} weibull={weibull}
                    unit={unit} presetName={presetName} preset={preset}
                    testSize={testSize} topK={topK} results={results}
                  />
                )}
                {o.key === 'Export' && (
                  <ExportTab
                    board={board} results={results} evals={evals} features={features}
                    weibull={weibull} dataset={dataset} file={file} preset={preset}
                    presetName={presetName} testSize={testSize} unit={unit} site={site}
                  />
                )}
              </div>
            </section>
          ))}

        </main>
      </div>
    </ChartThemeProvider>
  );
}

/* ==================================================================== *
 * The mark
 *
 * Measured rather than forced.
 *
 * The first version pinned the word to an exact width with textLength, on the
 * reasoning that it would then span the window whatever font loaded. It does
 * the opposite: the browser has to absorb the whole difference between the
 * font's natural width and the number given, and when that gap is large the
 * glyphs crowd, overlap or drop out entirely. The width was also chosen from
 * assumed advances, and measured before the webfont arrived, so the correction
 * was computed against a fallback face and never revisited.
 *
 * So the text is laid out normally and the viewBox is fitted to whatever it
 * actually measures. Same result — the mark spans the window exactly — with no
 * distortion, correct for any face, and re-fitted once the real font lands.
 * ==================================================================== */

function Wordmark({ ambience, moving }) {
  const textRef = useRef(null);
  const wrapRef = useRef(null);
  const [box, setBox] = useState(null);
  const [wrapW, setWrapW] = useState(0);

  useEffect(() => {
    const node = textRef.current;
    if (!node) return undefined;
    let live = true;
    let tries = 0;

    const fit = () => {
      if (!live) return false;
      let b = null;
      try {
        b = node.getBBox();
      } catch {
        // getBBox throws while the element is not being rendered
      }
      if (!b || b.width <= 1 || b.height <= 1) return false;
      const padX = b.width * 0.012;   // a hair of air so the ends do not clip
      setBox({ x: b.x - padX, y: b.y, w: b.width + padX * 2, h: b.height });
      return true;
    };

    // Keep asking until the text has actually been laid out.
    //
    // A single attempt on mount is not enough. getBBox returns nothing while
    // the subtree has yet to be laid out, and content-visibility: auto on the
    // stages can leave it skipped at exactly that moment. Nor is one retry on
    // fonts.ready: a cached font resolves that promise before first layout, so
    // the retry lands just as early as the original.
    const attempt = () => {
      if (fit()) return;
      tries += 1;
      if (tries < 60) requestAnimationFrame(attempt);   // about a second
    };
    requestAnimationFrame(attempt);

    // and once more when the real font arrives, since its metrics differ from
    // whatever fallback the first measurement caught
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready
        .then(() => requestAnimationFrame(fit))
        .catch(() => {});
    }

    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => fit())
      : null;
    if (ro) ro.observe(node);
    window.addEventListener('resize', fit);

    // Measure the container too, so the height can be set outright.
    //
    // Three attempts to have CSS derive it all failed the same way: width:100%
    // with height:auto, then an explicit aspect-ratio, both inside a grid track.
    // A grid item stretches to its row by default, and a stretched item whose
    // height is auto makes the row height and the item height depend on each
    // other — so the ratio is never reached, the element keeps some other
    // height, and preserveAspectRatio quietly shrinks the letters to fit it.
    // Measured at 180px tall where the width implied 262, which is exactly the
    // third of the width that went missing.
    //
    // Given the width and the ratio, the height is arithmetic. Doing it here
    // removes the circularity rather than negotiating with it.
    const wrap = wrapRef.current;
    const measureWrap = () => {
      if (!live || !wrap) return;
      const w = wrap.clientWidth;
      if (w > 0) setWrapW(w);
    };
    measureWrap();
    const wro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measureWrap)
      : null;
    if (wro && wrap) wro.observe(wrap);
    window.addEventListener('resize', measureWrap);

    return () => {
      live = false;
      window.removeEventListener('resize', fit);
      window.removeEventListener('resize', measureWrap);
      if (ro) ro.disconnect();
      if (wro) wro.disconnect();
    };
  }, []);

  // width times the measured ratio, in pixels, with nothing left to infer
  const ratio = box ? box.w / box.h : 940 / 142;
  const svgHeight = wrapW > 0 ? `${Math.round(wrapW / ratio)}px` : undefined;

  return (
    <div className="hero-mark" ref={wrapRef}>
      <svg
        className="wordmark-svg"
        // The fallback is only on screen for the frame or two before the real
        // measurement lands, but it should still be close: 940x142 is roughly
        // what WINDLAB measures at font-size 190.
        viewBox={box ? `${box.x} ${box.y} ${box.w} ${box.h}` : '0 20 940 142'}
        // Height in pixels, computed from the measured width and ratio. See the
        // note in the effect for why this is not left to CSS.
        style={{ height: svgHeight, aspectRatio: `${ratio}` }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Windlab"
      >
        <defs>
          {/* Vertical, like the logo it is sampled from: the V and the I run
              indigo at the top down to amber at the foot.

              spreadMethod="reflect" repeats the ramp mirrored beyond its ends,
              so translating the gradient slides new colour through the letters
              without ever leaving the nine sampled stops. */}
          <linearGradient
            id="wmGrad"
            x1="0%" y1="0%" x2="0%" y2="100%"
            spreadMethod="reflect"
          >
            <stop offset="0%" stopColor="#4D62D5" />
            <stop offset="12.5%" stopColor="#7A40C8" />
            <stop offset="25%" stopColor="#B62FC7" />
            <stop offset="37.5%" stopColor="#E634C7" />
            <stop offset="50%" stopColor="#F051B0" />
            <stop offset="62.5%" stopColor="#F5699A" />
            <stop offset="75%" stopColor="#F27B75" />
            <stop offset="87.5%" stopColor="#F79262" />
            <stop offset="100%" stopColor="#F5B35E" />
            {ambience && moving && (
              // two bbox heights is one full period of a reflected ramp, so the
              // slide loops with no visible seam
              <animateTransform
                attributeName="gradientTransform"
                type="translate"
                from="0 0"
                to="0 2"
                dur="17s"
                repeatCount="indefinite"
              />
            )}
          </linearGradient>
        </defs>
        <text ref={textRef} x="0" y="160" fill="url(#wmGrad)">
          WINDLAB
        </text>
      </svg>
    </div>
  );
}

/* ==================================================================== *
 * Control deck
 *
 * Everything that used to live in a sidebar. Across the top instead: the
 * controls get room to breathe, and once a run has produced results the
 * whole thing folds to a one-line summary so it stops taking the space
 * the charts want.
 * ==================================================================== */

function Deck(props) {
  const {
    file, dataset, busy, loadError, handleFile,
    unit, reunit, site, setSite, customLat, setCustomLat, customLon, setCustomLon,
    stationTheme, accent, presetName, setPresetName, preset,
    chartStyle, setChartStyle, ambience, setAmbience,
    runAll, setRunAll, chosen, setChosen, selected,
    testSize, setTestSize, topK, setTopK,
    alphaMode, setAlphaMode, alphaCustom, setAlphaCustom,
    showScaled, setShowScaled, features, run, progress,
    setupOpen, setSetupOpen, prefersReduced, forceMotion, setForceMotion,
  } = props;

  const dropRef = useRef(null);
  const toggle = (name) => setChosen(
    chosen.includes(name) ? chosen.filter((c) => c !== name) : [...chosen, name]
  );

  /* ---- folded: one line of what is set, and a way back in ---- */
  if (!setupOpen) {
    return (
      <div className="deck">
        <div className="deck-head" style={{ marginBottom: 0 }}>
          <div className="deck-summary">
            <span className="swatch" style={{ background: accent, width: 11, height: 11 }} />
            <b>{file?.name ?? 'No file'}</b>
            <span className="pill">{site === 'auto' ? 'Custom site' : site}</span>
            <span className="pill">{presetName}</span>
            <span className="pill">{selected.length} model{selected.length === 1 ? '' : 's'}</span>
            <span className="pill">{chartStyle === 'notebook' ? 'Notebook charts' : 'Dark charts'}</span>
          </div>
          <div className="deck-actions">
            <button className="btn-ghost" onClick={() => setSetupOpen(true)}>Edit setup</button>
            <button className="btn" disabled={!features || busy || !selected.length} onClick={run}>
              {busy ? 'Working…' : 'Run again'}
            </button>
          </div>
        </div>
        {progress && <Progress progress={progress} />}
      </div>
    );
  }

  /* ---- open ---- */
  return (
    <div className="deck">
      <div className="deck-head">
        <div className="eyebrow">Setup</div>
        <div className="deck-actions">
          {dataset && (
            <button className="btn-ghost" onClick={() => setSetupOpen(false)}>Collapse</button>
          )}
          <button className="btn" disabled={!features || busy || !selected.length} onClick={run}>
            {busy ? 'Working…' : 'Run analysis'}
          </button>
        </div>
      </div>

      <div className="deck-grid">
        {/* file */}
        <div>
          <div
            ref={dropRef}
            className="drop dropzone-wide"
            onClick={() => document.getElementById('fileInput').click()}
            onDragOver={(e) => { e.preventDefault(); dropRef.current?.classList.add('over'); }}
            onDragLeave={() => dropRef.current?.classList.remove('over')}
            onDrop={(e) => {
              e.preventDefault();
              dropRef.current?.classList.remove('over');
              handleFile(e.dataTransfer.files?.[0]);
            }}
          >
            <span className="glyph">◈</span>
            <span>
              <span className="big">{file ? file.name : 'Drop a wind dataset'}</span>
              <span className="small" style={{ display: 'block' }}>
                {file
                  ? `${dataset ? fmtInt(dataset.summary.nHours) + ' hours read' : 'reading…'} · click to replace`
                  : 'xlsx, xls or csv — or click to browse'}
              </span>
            </span>
          </div>
          <input id="fileInput" type="file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.tsv"
            style={{ display: 'none' }} onChange={(e) => handleFile(e.target.files?.[0])} />
          {loadError && (
            <div className="note-box coral" style={{ marginTop: '0.6rem' }}>{loadError}</div>
          )}
        </div>

        {/* units */}
        <div className="field">
          <label>Recorded in</label>
          <div className="seg">
            {[['kmh', 'km/h'], ['ms', 'm/s']].map(([v, l]) => (
              <button key={v} className={unit === v ? 'on' : ''} onClick={() => reunit(v)}>{l}</button>
            ))}
          </div>
        </div>

        {/* station */}
        <div className="field">
          <label>Station</label>
          <select value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="auto">Not listed / custom</option>
            {Object.keys(SITE_THEMES).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <div className="caption" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginTop: '0.4rem' }}>
            <span className="swatch" style={{ background: accent, width: 10, height: 10 }} />
            <span>{stationTheme.name} — {stationTheme.reason}</span>
          </div>
          {site === 'auto' && (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input type="number" step="0.0001" value={customLat} aria-label="Latitude"
                onChange={(e) => setCustomLat(parseFloat(e.target.value) || 0)} />
              <input type="number" step="0.0001" value={customLon} aria-label="Longitude"
                onChange={(e) => setCustomLon(parseFloat(e.target.value) || 0)} />
            </div>
          )}
        </div>
      </div>

      <div className="deck-grid four">
        <div className="field">
          <label>Training effort</label>
          <div className="seg">
            {Object.keys(MM.PRESETS).map((p) => (
              <button key={p} className={presetName === p ? 'on' : ''} onClick={() => setPresetName(p)}>{p}</button>
            ))}
          </div>
          <div className="caption">{preset.label}</div>
        </div>

        <div className="field">
          <label>Chart style</label>
          <div className="seg">
            {[['notebook', 'Notebook'], ['dark', 'Dark']].map(([v, l]) => (
              <button key={v} className={chartStyle === v ? 'on' : ''} onClick={() => setChartStyle(v)}>{l}</button>
            ))}
          </div>
          <div className="caption">
            {chartStyle === 'notebook'
              ? 'matplotlib defaults — the Colab look.'
              : `Dark panels on the ${stationTheme.name.toLowerCase()} accent.`}
          </div>
        </div>

        <div className="field">
          <label>Ambience</label>
          <div className="seg">
            {[[true, 'On'], [false, 'Off']].map(([v, l]) => (
              <button key={l} className={ambience === v ? 'on' : ''} onClick={() => setAmbience(v)}>{l}</button>
            ))}
          </div>
          <div className="caption">
            {ambience
              ? (site === 'auto' ? 'Scenes cycle all six stations.' : `Pinned to ${site}.`)
              : 'Plain background, still borders.'}
          </div>
          {ambience && prefersReduced && !forceMotion && (
            <div className="caption" style={{ marginTop: '0.45rem' }}>
              <span style={{ color: 'var(--amber)' }}>Motion is paused.</span>{' '}
              Your system asks for reduced motion, so the frame and scenes hold still.{' '}
              <button
                className="btn-ghost"
                style={{ padding: '0.18rem 0.5rem', fontSize: '0.74rem', marginTop: '0.3rem' }}
                onClick={() => setForceMotion(true)}
              >
                Animate anyway
              </button>
            </div>
          )}
          {ambience && prefersReduced && forceMotion && (
            <div className="caption" style={{ marginTop: '0.45rem' }}>
              Overriding the system motion preference.{' '}
              <button
                className="btn-ghost"
                style={{ padding: '0.18rem 0.5rem', fontSize: '0.74rem', marginTop: '0.3rem' }}
                onClick={() => setForceMotion(false)}
              >
                Respect it again
              </button>
            </div>
          )}
        </div>

        <div className="field">
          <label>Selection</label>
          <div className="seg">
            {[[true, 'Every model'], [false, 'Pick']].map(([v, l]) => (
              <button key={l} className={runAll === v ? 'on' : ''} onClick={() => setRunAll(v)}>{l}</button>
            ))}
          </div>
          <div className="caption">
            {runAll ? `All ${selected.length} will run.` : `${chosen.length} selected.`}
          </div>
        </div>
      </div>

      {!runAll && (
        <>
          <div className="chip-group">
            <div className="lab">Base models</div>
            <div className="chips">
              {MM.BASE_MODELS.map((n) => (
                <button key={n} title={MM.REGISTRY[n].blurb}
                  className={`chip${chosen.includes(n) ? ' on' : ''}`} onClick={() => toggle(n)}>
                  <span className="dot" style={{ background: FAMILY_COLOUR[MM.REGISTRY[n].family] }} />
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="chip-group">
            <div className="lab">Hybrid models</div>
            <div className="chips">
              {MM.HYBRID_MODELS.map((n) => (
                <button key={n} title={MM.REGISTRY[n].blurb}
                  className={`chip${chosen.includes(n) ? ' on' : ''}`} onClick={() => toggle(n)}>
                  <span className="dot" style={{ background: FAMILY_COLOUR[MM.REGISTRY[n].family] }} />
                  {n}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <details>
        <summary>Advanced</summary>
        <div className="deck-grid four">
          <div className="field">
            <label>Test share — {(testSize * 100).toFixed(0)}%</label>
            <input type="range" min="0.1" max="0.4" step="0.05" value={testSize}
              onChange={(e) => setTestSize(parseFloat(e.target.value))} />
            <div className="caption">Chronological, latest data held out.</div>
          </div>
          <div className="field">
            <label>Lags kept by RF selectors — {topK}</label>
            <input type="range" min="4" max="24" step="2" value={topK}
              onChange={(e) => setTopK(parseInt(e.target.value, 10))} />
          </div>
          <div className="field">
            <label>Wind shear exponent α</label>
            <select value={alphaMode} onChange={(e) => setAlphaMode(e.target.value)}>
              <option value="fixed">0.14 — one-seventh law</option>
              <option value="computed">Computed from Eq. 6</option>
              <option value="custom">Custom</option>
            </select>
            {alphaMode === 'custom' && (
              <input type="range" min="0.05" max="0.4" step="0.01" value={alphaCustom}
                style={{ marginTop: '0.5rem' }}
                onChange={(e) => setAlphaCustom(parseFloat(e.target.value))} />
            )}
          </div>
          <div className="field">
            <label>Metric space</label>
            <label className="checkline">
              <input type="checkbox" checked={showScaled} onChange={(e) => setShowScaled(e.target.checked)} />
              <span>Show min-max scaled metrics</span>
            </label>
            <div className="caption">Lets you compare with the published Table 1.</div>
          </div>
        </div>
      </details>

      {progress && <Progress progress={progress} />}
    </div>
  );
}

function Progress({ progress }) {
  return (
    <div style={{ marginTop: '1rem' }}>
      <div className="prog">
        <div style={{ width: `${((progress.index + progress.fraction) / progress.total) * 100}%` }} />
      </div>
      <div className="prog-label">
        {progress.name} ({progress.index + 1}/{progress.total}) · {progress.message}
      </div>
    </div>
  );
}

/* ==================================================================== *
 * Helpers
 * ==================================================================== */

function capBlock(block, cap) {
  if (!cap || block.nRows <= cap) return block;
  const X = new Float64Array(cap * block.nCols);
  const y = new Float64Array(cap);
  const times = new Float64Array(cap);
  for (let f = 0; f < block.nCols; f++) {
    for (let i = 0; i < cap; i++) X[f * cap + i] = block.X[f * block.nRows + i];
  }
  for (let i = 0; i < cap; i++) { y[i] = block.y[i]; times[i] = block.times[i]; }
  return { X, y, times, nRows: cap, nCols: block.nCols };
}

/* ==================================================================== *
 * Dataset
 * ==================================================================== */

function DatasetTab({ dataset, weibull }) {
  const s = dataset.summary;
  const diurnal = useMemo(
    () => D.diurnalProfile(dataset.values, dataset.parts.hours), [dataset]
  );
  const hist = useMemo(() => D.histogram(dataset.values, 60), [dataset]);
  const curve = useMemo(() => {
    const { k, s: scale } = weibull.annual;
    if (!isFinite(k) || !isFinite(scale)) return null;
    const lo = hist[0].centre, hi = hist[hist.length - 1].centre;
    return Array.from({ length: 220 }, (_, i) => {
      const x = lo + ((hi - lo) * i) / 219;
      return { x, y: W.weibullPdf(x, k, scale) };
    });
  }, [weibull, hist]);

  const r = dataset.report;
  return (
    <>
      <Eyebrow>Record</Eyebrow>
      <CardRow>
        <Card label="Span" value={`${s.startYear}–${s.endYear}`} note={`${s.nYears} years`} />
        <Card label="Hourly readings" value={fmtInt(s.nHours)} />
        <Card label="Mean speed" value={s.mean.toFixed(2)} note="m/s" tone="t-teal" />
        <Card label="Peak" value={s.max.toFixed(2)} note="m/s" tone="t-coral" />
        <Card label="P95" value={s.p95.toFixed(2)} note="m/s" />
        <Card label="Layout" value={dataset.format === 'wide' ? 'Wide' : 'Long'} note="auto-detected" />
      </CardRow>

      <Eyebrow>Gap treatment</Eyebrow>
      <div className="grid-15">
        <div>
          <BarsH
            labelWidth={230}
            rows={[
              { label: 'Linear interpolation (<6 h)', value: r.filledInterpolation, display: fmtInt(r.filledInterpolation) },
              { label: 'Monthly median (longer)', value: r.filledMonthlyMedian, display: fmtInt(r.filledMonthlyMedian) },
              { label: 'Record median (empty months)', value: r.filledGlobalMedian, display: fmtInt(r.filledGlobalMedian) },
            ]}
            xLabel="Hours filled"
            height={150}
          />
        </div>
        <div>
          <CardRow>
            <Card label="Missing before" value={`${r.missingPct.toFixed(1)}%`}
              note={`${fmtInt(r.missingBefore)} hours`} tone="t-amber" />
            <Card label="Missing after" value={fmtInt(r.missingAfter)} note="hours" tone="t-teal" />
          </CardRow>
          <div style={{ marginTop: '0.7rem' }}>
            <Note>
              Gaps shorter than <b>6 hours</b> are filled by linear interpolation. Longer gaps
              take the <b>monthly median</b> for that calendar month. A month with no readings
              at all falls back to the record median.
            </Note>
          </div>
        </div>
      </div>

      <Eyebrow>Behaviour</Eyebrow>
      <BandChart points={diurnal} yLabel="Wind speed (m/s)" xLabel="Hour of day" />
      <div className="caption">Mean wind speed by hour of day, with one standard deviation.</div>

      <div style={{ marginTop: '1.4rem' }}>
        <HistogramCurve bars={hist} curve={curve}
          curveLabel={`Weibull (k=${weibull.annual.k.toFixed(2)}, s=${weibull.annual.s.toFixed(2)})`} />
        <div className="caption">Observed distribution against the fitted Weibull density.</div>
      </div>
    </>
  );
}

/* ==================================================================== *
 * Models
 * ==================================================================== */

function ModelsTab({ results, evals, features, activeModel, setActiveModel, showScaled }) {
  const names = Object.keys(evals);
  if (!names.length) {
    return <div className="empty">Pick models in the setup deck above and press <b>Run analysis</b>.</div>;
  }
  const pick = names.includes(activeModel) ? activeModel : names[0];
  const res = results[pick];
  const ev = evals[pick];
  const spec = MM.REGISTRY[pick];
  const colour = FAMILY_COLOUR[spec.family];
  const yTest = features.test.y;

  const scaledVals = names.map((n) => evals[n].scaled?.rmse).filter(isFinite);
  const axisLo = Math.min(...scaledVals) * 0.92;
  const axisHi = Math.max(...scaledVals) * 1.08;
  const maeVals = names.map((n) => evals[n].scaled?.mae).filter(isFinite);

  const ba = useMemo(() => S.blandAltman(yTest, res.predictions), [yTest, res]);
  const deciles = useMemo(() => S.biasByDecile(yTest, res.predictions), [yTest, res]);

  return (
    <>
      <div className="field" style={{ maxWidth: 420 }}>
        <label>Model</label>
        <select value={pick} onChange={(e) => setActiveModel(e.target.value)}>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '-0.4rem 0 1rem' }}>{spec.blurb}</div>

      <Eyebrow>Test-window accuracy</Eyebrow>
      <CardRow>
        {showScaled && ev.scaled ? (
          <>
            <CardCI label="RMSE · scaled" value={ev.rmseCI.point} lo={ev.rmseCI.lo} hi={ev.rmseCI.hi}
              axisLo={axisLo} axisHi={axisHi} colour={colour} />
            <CardCI label="MAE · scaled" value={ev.maeCI.point} lo={ev.maeCI.lo} hi={ev.maeCI.hi}
              axisLo={Math.min(...maeVals) * 0.92} axisHi={Math.max(...maeVals) * 1.08} colour={colour} />
          </>
        ) : null}
        <Card label="R²" value={ev.raw.r2.toFixed(4)} tone="t-teal" />
        <Card label="MAPE" value={`${ev.raw.mape.toFixed(2)}%`} tone="t-amber" />
        <Card label="RMSE · m/s" value={ev.raw.rmse.toFixed(4)} note="physical units" />
        <Card label="MAE · m/s" value={ev.raw.mae.toFixed(4)} note="physical units" />
      </CardRow>
      <div className="caption">
        Trained in {res.seconds.toFixed(1)} s · {fmtInt(features.train.nRows)} training rows ·{' '}
        {fmtInt(features.test.nRows)} test rows.
      </div>

      <Eyebrow>Observed against predicted</Eyebrow>
      <div className="grid-15">
        <div>
          <TimeSeries observed={yTest} times={features.test.times}
            series={[{ label: pick, values: res.predictions, colour }]} />
        </div>
        <div>
          <DensityScatter x={yTest} y={res.predictions} label={pick} rmse={ev.raw.rmse} />
        </div>
      </div>

      <Eyebrow>Extreme-wind behaviour</Eyebrow>
      <CardRow>
        <Card label="P95 threshold" value={ev.tail.threshold.toFixed(2)} note="m/s" />
        <Card label="Tail RMSE" value={ev.tail.tailRmse.toFixed(4)} note="top 5% of speeds" tone="t-coral" />
        <Card label="Tail MAE" value={ev.tail.tailMae.toFixed(4)} note="top 5% of speeds" tone="t-coral" />
        <Card label="Exceedance recall" value={ev.tail.exceedanceRecall.toFixed(3)}
          note={`${fmtInt(ev.tail.nTail)} events`} tone="t-amber" />
      </CardRow>

      <div className="grid2" style={{ marginTop: '1rem' }}>
        <div>
          <BlandAltman {...ba} />
          <div className="caption">
            Bias {ba.bias.toFixed(4)} m/s · SD {ba.sd.toFixed(4)} · limits {ba.loaLower.toFixed(3)} to{' '}
            {ba.loaUpper.toFixed(3)} · {ba.withinPct.toFixed(1)}% inside.
          </div>
        </div>
        <div>
          <SignedBars points={deciles.map((d) => ({ centre: d.obsCentre, value: d.meanError }))}
            xLabel="Observed wind speed, decile centre (m/s)" yLabel="Prediction − observation (m/s)" />
          <div className="caption">
            Negative bars in the upper deciles mean the model under-calls strong wind.
          </div>
        </div>
      </div>

      {res.extras?.importance && (
        <>
          <Eyebrow>Which lags the model leans on</Eyebrow>
          <BarsH
            labelWidth={90}
            rows={res.extras.importance
              .map((v, i) => ({ label: `Lag_${i + 1}`, value: v }))
              .sort((a, b) => b.value - a.value)}
            xLabel="Gain-based importance"
            highlight={res.extras.selectedFeatures ?? null}
          />
          {res.extras.selectedFeatures && (
            <div className="caption">
              Highlighted lags were passed to the sequence model: {res.extras.selectedFeatures.join(', ')}.
            </div>
          )}
        </>
      )}

      {res.extras?.history && (
        <>
          <Eyebrow>Training</Eyebrow>
          <LossCurves history={res.extras.history} />
        </>
      )}

      {res.extras?.blendWeight !== undefined && (
        <>
          <Eyebrow>Blend search</Eyebrow>
          <CardRow>
            <Card label="Weight on first model" value={res.extras.blendWeight.toFixed(2)} tone="t-amber" />
            <Card label="Weight on second" value={(1 - res.extras.blendWeight).toFixed(2)} tone="t-teal" />
          </CardRow>
          <div style={{ marginTop: '0.8rem' }}>
            <WeightCurve curve={res.extras.weightCurve} best={res.extras.blendWeight} />
          </div>
        </>
      )}

      {res.extras?.metaWeights && (
        <>
          <Eyebrow>Meta-regressor</Eyebrow>
          <CardRow>
            {Object.entries(res.extras.metaWeights).map(([k, v]) => (
              <Card key={k} label={k} value={(v >= 0 ? '+' : '') + v.toFixed(4)}
                tone={k === 'intercept' ? 't-amber' : 't-teal'} />
            ))}
          </CardRow>
          <div className="caption">
            Coefficients learned on held-out base-model predictions, not on data the base
            learners were fitted to.
          </div>
        </>
      )}

      {res.extras?.residualSd !== undefined && (
        <>
          <Eyebrow>Residual signal</Eyebrow>
          <CardRow>
            <Card label="Residual mean" value={res.extras.residualMean.toFixed(4)} note="m/s" />
            <Card label="Residual SD" value={res.extras.residualSd.toFixed(4)} note="m/s" tone="t-amber" />
          </CardRow>
          <div className="caption">
            Spread of the base model's out-of-sample error, which the sequence model was
            trained to predict.
          </div>
        </>
      )}
    </>
  );
}

/* ==================================================================== *
 * Comparison
 * ==================================================================== */

function ComparisonTab({ results, evals, board, features, showScaled, site, dmLoss, setDmLoss }) {
  const names = Object.keys(evals);
  if (!names.length) return <div className="empty">Run at least one model to populate this view.</div>;

  const useScaled = showScaled && evals[names[0]].scaled;
  const yTest = features.test.y;

  const intervalRows = names.map((n) => ({
    model: n,
    value: useScaled ? evals[n].rmseCI.point : evals[n].raw.rmse,
    lo: useScaled ? evals[n].rmseCI.lo : NaN,
    hi: useScaled ? evals[n].rmseCI.hi : NaN,
    family: MM.REGISTRY[n].family,
  }));

  const dm = useMemo(() => {
    const preds = {};
    for (const n of names) preds[n] = results[n].predictions;
    return S.dmMatrix(yTest, preds, dmLoss);
  }, [names, results, yTest, dmLoss]);

  const paper = SITES.PAPER_TABLE1[site];

  return (
    <>
      <Eyebrow>Leaderboard</Eyebrow>
      <Table
        columns={[
          { key: 'Model', label: 'Model' },
          { key: 'Type', label: 'Type' },
          { key: 'rmse', label: 'RMSE m/s', digits: 4 },
          { key: 'mae', label: 'MAE m/s', digits: 4 },
          { key: 'r2', label: 'R²', digits: 4 },
          { key: 'mape', label: 'MAPE %', digits: 2 },
          { key: 'rmseScaled', label: 'RMSE scaled', digits: 5 },
          { key: 'seconds', label: 'Train s', digits: 1 },
        ]}
        rows={board}
        bestColumn="rmse"
      />
      <div style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '0.6rem 0 0' }}>
        Lowest error: <b style={{ color: 'var(--teal)' }}>{board[0].Model}</b> at{' '}
        {board[0].rmse.toFixed(4)} m/s RMSE and R² {board[0].r2.toFixed(4)}.
      </div>
      <Legend3 />

      {names.length > 1 && (
        <>
          <Eyebrow>Error with 95% confidence intervals</Eyebrow>
          <IntervalPlot rows={intervalRows} xLabel={useScaled ? 'RMSE (scaled)' : 'RMSE (m/s)'} />
          <div className="caption">
            Intervals from a moving-block bootstrap over 24-hour blocks, which preserves
            temporal dependence. Overlapping intervals mean the data does not resolve the gap.
          </div>

          <div className="grid2" style={{ marginTop: '1.2rem' }}>
            <div>
              <BarsH
                labelWidth={200}
                rows={[...board].sort((a, b) => a.mae - b.mae).map((r) => ({
                  label: r.Model, value: r.mae,
                  colour: FAMILY_COLOUR[MM.REGISTRY[r.Model].family],
                }))}
                xLabel="MAE (m/s)"
              />
            </div>
            <div>
              <BarsH
                labelWidth={200}
                rows={[...board].sort((a, b) => b.r2 - a.r2).map((r) => ({
                  label: r.Model, value: r.r2,
                  colour: FAMILY_COLOUR[MM.REGISTRY[r.Model].family],
                }))}
                xLabel="R²"
              />
            </div>
          </div>

          <Eyebrow>Diebold-Mariano significance</Eyebrow>
          <div className="seg" style={{ maxWidth: 320, marginBottom: '0.8rem' }}>
            {[['squared', 'Squared loss (RMSE)'], ['abs', 'Absolute loss (MAE)']].map(([v, l]) => (
              <button key={v} className={dmLoss === v ? 'on' : ''} onClick={() => setDmLoss(v)}>{l}</button>
            ))}
          </div>
          <PMatrix names={dm.names} rows={dm.rows} />
          <div style={{ marginTop: '0.8rem' }}>
            <Note>
              Two-sided p-values with a Newey-West correction at lag 23. Teal cells
              (<b>p &lt; 0.05</b>) mark pairs whose accuracy difference is statistically
              resolved; dark cells mean the two models are indistinguishable on this record.
            </Note>
          </div>

          <Eyebrow>All models against the observed series</Eyebrow>
          <TimeSeries
            observed={yTest}
            times={features.test.times}
            maxPoints={600}
            series={names.map((n) => ({
              label: n, values: results[n].predictions,
              colour: FAMILY_COLOUR[MM.REGISTRY[n].family],
            }))}
          />
        </>
      )}

      {paper && (
        <>
          <Eyebrow>Against the published results for {site}</Eyebrow>
          <Table
            columns={[
              { key: 'Model', label: 'Model' },
              { key: 'published', label: 'Published RMSE', digits: 5 },
              { key: 'yours', label: 'Your RMSE', digits: 5 },
              { key: 'publishedMae', label: 'Published MAE', digits: 5 },
              { key: 'yoursMae', label: 'Your MAE', digits: 5 },
            ]}
            rows={Object.entries(paper).map(([model, [pr, pm]]) => {
              const key = model === 'GBM' ? 'GBM' : model;
              const ev = evals[key];
              return {
                Model: model, published: pr, publishedMae: pm,
                yours: ev?.scaled?.rmse ?? null, yoursMae: ev?.scaled?.mae ?? null,
              };
            })}
          />
          <div style={{ marginTop: '0.8rem' }}>
            <Note>
              Published values are Table 1 of Yadav et al. (2025), on the <b>min-max scaled</b>{' '}
              target. Yours will not match exactly — training effort, test window and the exact
              scaling all move them. The comparison worth making is the <b>ordering</b> of the models.
            </Note>
          </div>
        </>
      )}
    </>
  );
}

/* ==================================================================== *
 * Weibull and power
 * ==================================================================== */

function WeibullTab({ weibull, dataset, site, results, features, bestModel }) {
  const { annual, monthly } = weibull;
  const cats = monthly.map((m) => m.month);

  const mlPairs = useMemo(() => {
    if (!bestModel || !results[bestModel]) return null;
    return D.monthlyPairs(features.test.y, results[bestModel].predictions, features.test.times);
  }, [bestModel, results, features]);

  const mlFit = mlPairs ? W.linearFit(mlPairs.map((p) => p.actual), mlPairs.map((p) => p.predicted)) : null;
  const qq = useMemo(
    () => W.weibullQQ(dataset.values, annual.k, annual.s, 40),
    [dataset, annual.k, annual.s]
  );
  const wbFit = W.linearFit(qq.map((q) => q.observed), qq.map((q) => q.theoretical));

  const peak = monthly.reduce((a, b) => (b.heights[150].wpd > a.heights[150].wpd ? b : a));
  const lean = monthly.reduce((a, b) => (b.heights[150].wpd < a.heights[150].wpd ? b : a));
  const ref = SITES.PAPER_WPD_REFERENCE[site];
  const r2ref = SITES.PAPER_R2_COMPARISON[site];

  return (
    <>
      <Eyebrow>Whole-record Weibull fit, MEPF method</Eyebrow>
      <CardRow>
        <Card label="Shape k" value={annual.k.toFixed(3)} tone="t-amber" />
        <Card label="Scale s" value={annual.s.toFixed(3)} note="m/s" tone="t-amber" />
        <Card label="Energy pattern factor" value={annual.epf.toFixed(3)} />
        <Card label="Observed mean" value={annual.meanObserved.toFixed(3)} note="m/s" />
        <Card label="Weibull MWS" value={annual.mwsWeibull.toFixed(3)} note="m/s" tone="t-teal" />
        <Card label="α used" value={annual.alpha.toFixed(3)} note="wind shear" />
      </CardRow>

      <Eyebrow>At hub height</Eyebrow>
      <CardRow>
        {HUB_HEIGHTS.map((h) => (
          <Card key={h} label={`${h} m`} value={annual.heights[h].wpd.toFixed(1)}
            note={`W/m² · MWS ${annual.heights[h].mws.toFixed(2)} m/s · k ${annual.heights[h].k.toFixed(2)}`}
            tone="t-teal" />
        ))}
      </CardRow>

      <Eyebrow>Monthly wind power density</Eyebrow>
      <GroupedBars
        categories={cats}
        yLabel="Wind power density (W/m²)"
        groups={HUB_HEIGHTS.map((h, i) => ({
          label: `${h} m`, colour: [PALETTE.teal, PALETTE.steel, PALETTE.amber][i],
          values: monthly.map((m) => m.heights[h].wpd),
        }))}
      />
      <div style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
        Strongest month at 150 m: <b style={{ color: 'var(--amber)' }}>{peak.month}</b> at{' '}
        {peak.heights[150].wpd.toFixed(1)} W/m². Weakest: <b>{lean.month}</b> at{' '}
        {lean.heights[150].wpd.toFixed(1)} W/m².
      </div>

      <div className="grid2" style={{ marginTop: '1.4rem' }}>
        <div>
          <Eyebrow>Monthly mean wind speed by height</Eyebrow>
          <MultiLine
            categories={cats}
            yLabel="Mean wind speed (m/s)"
            series={[
              { label: '10 m observed', colour: PALETTE.ink, values: monthly.map((m) => m.mwsObserved) },
              ...HUB_HEIGHTS.map((h, i) => ({
                label: `${h} m`, colour: [PALETTE.teal, PALETTE.steel, PALETTE.amber][i],
                values: monthly.map((m) => m.heights[h].mws),
              })),
            ]}
          />
        </div>
        <div>
          <Eyebrow>Monthly Weibull parameters</Eyebrow>
          <MultiLine
            categories={cats}
            yLabel="Shape k"
            yLabel2="Scale s (m/s)"
            series={[
              { label: 'Shape k', colour: PALETTE.amber, values: monthly.map((m) => m.k) },
              { label: 'Scale s', colour: PALETTE.teal, axis2: true, values: monthly.map((m) => m.s) },
            ]}
          />
        </div>
      </div>

      <Eyebrow>Monthly table</Eyebrow>
      <Table
        columns={[
          { key: 'month', label: 'Month' },
          { key: 'n', label: 'Hours', digits: 0 },
          { key: 'epf', label: 'Epf', digits: 3 },
          { key: 'k', label: 'k', digits: 3 },
          { key: 's', label: 's m/s', digits: 3 },
          { key: 'obs', label: 'MWS obs', digits: 3 },
          ...HUB_HEIGHTS.flatMap((h) => ([
            { key: `mws${h}`, label: `MWS ${h}m`, digits: 2 },
            { key: `wpd${h}`, label: `WPD ${h}m`, digits: 1 },
          ])),
        ]}
        rows={monthly.map((m) => ({
          month: m.month, n: m.n, epf: m.epf, k: m.k, s: m.s, obs: m.mwsObserved,
          ...Object.fromEntries(HUB_HEIGHTS.flatMap((h) => ([
            [`mws${h}`, m.heights[h].mws], [`wpd${h}`, m.heights[h].wpd],
          ]))),
        }))}
      />

      <Eyebrow>Machine learning against the statistical fit</Eyebrow>
      {mlPairs ? (
        <div className="grid2">
          <div>
            <FitScatter x={mlPairs.map((p) => p.actual)} y={mlPairs.map((p) => p.predicted)}
              colour={PALETTE.teal} label={`${bestModel} predicted`} fit={mlFit} />
            <div className="caption">Monthly means over the test window, {bestModel}.</div>
          </div>
          <div>
            <FitScatter x={qq.map((q) => q.observed)} y={qq.map((q) => q.theoretical)}
              colour={PALETTE.amber} label="Weibull quantile" fit={wbFit} />
            <div className="caption">
              Observed against fitted Weibull quantiles. Comparing <i>means</i> instead would
              be an identity: MEPF sets the scale so the theoretical mean equals the sample
              mean, so that plot always returns R² = 1 regardless of fit quality.
            </div>
          </div>
        </div>
      ) : (
        <div className="empty">Run a model to compare it against the Weibull fit.</div>
      )}

      {r2ref && (
        <div style={{ marginTop: '0.9rem' }}>
          <Note>
            Published R² for {site}: <b>{r2ref.ml}</b> for the ML models and <b>{r2ref.weibull}</b>{' '}
            for the Weibull fit. The study's point is that the statistical fit describes the
            wind-speed <i>distribution</i> while the ML models make the hour-ahead forecast —
            the two R² values answer different questions.
          </Note>
        </div>
      )}

      {ref && (
        <>
          <Eyebrow>Published reference for {site}</Eyebrow>
          <Table
            columns={Object.keys(ref).map((k) => ({ key: k, label: k.replace(/_/g, ' '), digits: 2 }))}
            rows={[ref]}
          />
          <div style={{ marginTop: '0.8rem' }}>
            <Note>
              These come from the paper's own monthly aggregation, which the text does not fully
              specify. If your figures sit below them, try raising <b>α</b> under Advanced — hub-height
              power density is very sensitive to the shear exponent.
            </Note>
          </div>
        </>
      )}
    </>
  );
}

/* ==================================================================== *
 * Region
 * ==================================================================== */

function RegionTab({ site, lat, lon }) {
  const meta = site !== 'auto' ? SITES.SITES[site] : null;
  const d = 1.4;
  const bbox = `${(lon - d).toFixed(4)},${(lat - d * 0.7).toFixed(4)},${(lon + d).toFixed(4)},${(lat + d * 0.7).toFixed(4)}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;

  return (
    <>
      <Eyebrow>Station</Eyebrow>
      <CardRow>
        <Card label="Location" value={meta ? site : 'Uploaded record'} />
        <Card label="Region" value={meta ? meta.region : 'Custom coordinates'} />
        <Card label="Setting" value={meta ? meta.terrain : '—'} />
        <Card label="Coordinates" value={`${lat.toFixed(4)}, ${lon.toFixed(4)}`} tone="t-teal" />
      </CardRow>

      <div className="mapframe" style={{ marginTop: '1rem' }}>
        <iframe title="Station location" src={src} loading="lazy" />
      </div>
      <div className="caption">
        OpenStreetMap, tinted to sit in the dark panel.{' '}
        <a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=9/${lat}/${lon}`}
          target="_blank" rel="noreferrer">Open the full map</a>.
      </div>

      <Eyebrow>All stations in the study</Eyebrow>
      <Table
        columns={[
          { key: 'station', label: 'Station' },
          { key: 'region', label: 'Region' },
          { key: 'terrain', label: 'Setting' },
          { key: 'lat', label: 'Latitude', digits: 4 },
          { key: 'lon', label: 'Longitude', digits: 4 },
        ]}
        rows={Object.entries(SITES.SITES).map(([name, m]) => ({
          station: name, region: m.region, terrain: m.terrain, lat: m.lat, lon: m.lon,
        }))}
      />
    </>
  );
}

/* ==================================================================== *
 * Across datasets
 *
 * Saved runs live in the browser (see lib/store.js). This is where one gets
 * chosen as a baseline and set against the run on screen.
 * ==================================================================== */

function CompareTab(props) {
  const {
    board, evals, library, baselineId, setBaselineId,
    saveCurrentRun, refreshLibrary, libMsg, setLibMsg, libBusy,
    file, dataset, site, weibull, unit, presetName, preset, testSize, topK, results,
  } = props;

  const [metric, setMetric] = useState('rmse');
  const [mode, setMode] = useState('pair');
  const [label, setLabel] = useState('');
  const fileRef = useRef(null);

  const hasResults = Object.keys(evals).length > 0;

  const current = useMemo(() => {
    if (!hasResults) return null;
    return buildRecord({
      file, dataset, site, unit, presetName, preset, testSize, topK,
      board, evals, results, weibull, label: label || file?.name,
    });
  }, [hasResults, file, dataset, site, unit, presetName, preset, testSize, topK,
    board, evals, results, weibull, label]);

  const baseline = library.find((r) => r.id === baselineId) ?? null;
  const cmp = (current && baseline) ? compareRuns(current, baseline, metric) : null;
  const wcmp = (current && baseline) ? compareWeibull(current, baseline) : null;

  // every saved record, plus the one on screen if it has not been saved yet
  const allRecords = useMemo(() => {
    const saved = [...library].sort((a, b) => a.savedAt - b.savedAt);
    return current ? [...saved, { ...current, label: `${current.label} (this run)` }] : saved;
  }, [library, current]);
  const across = allRecords.length >= 2 ? compareAcross(allRecords, metric) : null;

  const remove = async (id) => {
    const store = await import('@/lib/store');
    await store.deleteRun(id);
    if (baselineId === id) setBaselineId(null);
    await refreshLibrary();
  };

  const doExport = async () => {
    const store = await import('@/lib/store');
    download('windlab-library.json', await store.exportAll(), 'application/json');
  };

  const doImport = async (f) => {
    if (!f) return;
    try {
      const store = await import('@/lib/store');
      const { added, skipped } = await store.importAll(await f.text());
      await refreshLibrary();
      setLibMsg(`Imported ${added} run${added === 1 ? '' : 's'}`
        + (skipped ? `, skipped ${skipped} already present.` : '.'));
    } catch (err) {
      setLibMsg(err?.message || 'Could not read that file.');
    }
  };

  return (
    <>
      <Eyebrow>The library</Eyebrow>
      <Note>
        Saved runs live in <b>this browser</b>. There is no server behind the site, which
        is what lets a long record train at all — so a run stays on the machine that
        produced it, and clearing site data removes it. Export writes the whole library
        to a JSON file you can archive or move to another machine.
      </Note>

      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', margin: '1rem 0' }}>
        <input
          type="text" value={label} placeholder={file?.name ?? 'Label for this run'}
          onChange={(e) => setLabel(e.target.value)}
          style={{ maxWidth: 260 }} aria-label="Label for this run"
        />
        <button className="btn" style={{ width: 'auto', padding: '0.5rem 1.4rem' }}
          disabled={!hasResults || libBusy} onClick={() => saveCurrentRun(label)}>
          {libBusy ? 'Saving…' : 'Save this run'}
        </button>
        <button className="btn-ghost" onClick={doExport} disabled={!library.length}>
          Export library
        </button>
        <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Import</button>
        <input ref={fileRef} type="file" accept="application/json,.json"
          style={{ display: 'none' }} onChange={(e) => doImport(e.target.files?.[0])} />
      </div>

      {libMsg && <Note tone="teal">{libMsg}</Note>}

      {!hasResults && (
        <div className="empty">Run some models first — then this run can be saved or compared.</div>
      )}

      <Eyebrow>Saved runs</Eyebrow>
      {library.length === 0 ? (
        <div className="empty">Nothing saved yet. Run a dataset, save it, then upload another to compare.</div>
      ) : (
        <div className="picker">
          {library.map((r) => (
            <button
              key={r.id}
              className={`picker-card${baselineId === r.id ? ' on' : ''}`}
              onClick={() => setBaselineId(baselineId === r.id ? null : r.id)}
            >
              <span className="mark" />
              <span className="t">{r.label}</span>
              <span className="b">
                {r.station === 'auto' ? 'Custom site' : r.station}
                {r.file?.hours ? ` · ${fmtInt(r.file.hours)} h` : ''}
                {r.file?.startYear ? ` · ${r.file.startYear}–${r.file.endYear}` : ''}
                <br />
                {Object.keys(r.models ?? {}).length} models · {r.preset} ·{' '}
                {new Date(r.savedAt).toLocaleDateString()}
                <br />
                <span
                  role="button" tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); remove(r.id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); remove(r.id); } }}
                  style={{ color: 'var(--coral, #F27B75)', cursor: 'pointer' }}
                >
                  Delete
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {(cmp || across) && (
        <>
          <Eyebrow>Compare</Eyebrow>
          <div className="seg" style={{ maxWidth: 420, marginBottom: '0.9rem' }}>
            <button className={mode === 'pair' ? 'on' : ''} onClick={() => setMode('pair')}>
              Against one record
            </button>
            <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>
              Across all {allRecords.length}
            </button>
          </div>
          <div className="seg" style={{ maxWidth: 620, marginBottom: '0.9rem' }}>
            {COMPARABLE_METRICS.slice(0, 4).map((m) => (
              <button key={m.key} className={metric === m.key ? 'on' : ''}
                onClick={() => setMetric(m.key)}>{m.label}</button>
            ))}
          </div>
        </>
      )}

      {mode === 'all' && across && (
        <>
          <Eyebrow>Every model across every record</Eyebrow>
          <CardRow>
            <Card label="Records" value={across.records.length} />
            <Card label="Models ranked" value={across.rows.length}
              note={across.excluded.length ? `${across.excluded.length} not in every record` : 'present in all'} />
            <Card label="Best mean rank" value={across.rows[0]?.model ?? '—'} tone="t-teal" />
            <Card label="Rank agreement" value={Number.isFinite(across.kendallW) ? across.kendallW.toFixed(2) : '—'}
              note="Kendall's W" tone="t-amber" />
          </CardRow>

          <div style={{ marginTop: '0.9rem' }}>
            <Note>
              {summariseAcross(across)} W is the many-record form of the pairwise tau: it
              asks whether all the records put the models in the same order, which is the
              question the pooled analysis in the study is answering across its stations.
            </Note>
          </div>

          {across.excluded.length > 0 && (
            <div style={{ marginTop: '0.8rem' }}>
              <Note tone="coral">
                Left out of the ranking, because they did not run on every record:{' '}
                {across.excluded.map((e) => `${e.model} (${e.present}/${e.of})`).join(', ')}.
                Ranking a model that only ran on some of the sites against ones that ran on
                all of them would put a number on something never measured.
              </Note>
            </div>
          )}

          <Eyebrow>{across.meta.label} by record</Eyebrow>
          <Table
            columns={[
              { key: 'model', label: 'Model' },
              { key: 'kind', label: 'Type' },
              ...across.records.map((r, i) => ({ key: `r${i}`, label: r, digits: across.meta.digits })),
              { key: 'meanRank', label: 'Mean rank', digits: 2 },
              { key: 'bestCount', label: 'Best on', digits: 0 },
              { key: 'spread', label: 'Rank spread', digits: 0 },
            ]}
            rows={across.rows.map((r) => ({
              model: r.model, kind: r.kind,
              ...Object.fromEntries(r.values.map((v, i) => [`r${i}`, v])),
              meanRank: r.meanRank, bestCount: r.bestCount, spread: r.spread,
            }))}
            bestColumn="meanRank"
          />
          <div className="caption">
            Rank spread is the gap between a model's best and worst placing. A low mean
            rank with a high spread is a model that wins somewhere and fails elsewhere —
            worth more suspicion than one that is steadily second.
          </div>

          <Eyebrow>Each model on each record</Eyebrow>
          <GroupedBars
            categories={across.rows.map((r) => r.model)}
            yLabel={across.meta.label}
            groups={across.records.map((name, i) => ({
              label: name,
              colour: PALETTE.teal,
              values: across.rows.map((r) => r.values[i]),
            }))}
            height={400}
          />

          <Eyebrow>How steadily each model places</Eyebrow>
          <MultiLine
            categories={across.records}
            yLabel="Rank (0 is best)"
            series={across.rows.map((r, i) => ({
              label: r.model,
              colour: [PALETTE.teal, PALETTE.amber, PALETTE.violet, PALETTE.coral,
                PALETTE.steel, PALETTE.ink][i % 6],
              values: r.ranks,
            }))}
            height={340}
          />
          <div className="caption">
            Flat lines mean a model holds its place from record to record. Lines that
            cross mean the ordering is site-specific, and a pooled ranking would be
            hiding more than it shows.
          </div>
        </>
      )}

      {mode === 'pair' && cmp && (
        <>
          <Eyebrow>This run against {baseline.label}</Eyebrow>
          <CardRow>
            <Card label="Models in common" value={cmp.shared.length}
              note={cmp.onlyCurrent.length || cmp.onlyBaseline.length
                ? `${cmp.onlyCurrent.length} only here, ${cmp.onlyBaseline.length} only there`
                : 'both runs used the same set'} />
            <Card label="Better here" value={cmp.improved} tone="t-teal" />
            <Card label="Worse here" value={cmp.worsened} tone="t-coral" />
            <Card label="Rank agreement" value={Number.isFinite(cmp.tau) ? cmp.tau.toFixed(2) : '—'}
              note="Kendall's tau" tone="t-amber" />
          </CardRow>

          <div style={{ marginTop: '0.9rem' }}>
            <Note>
              {summarise(cmp)} Rank agreement matters more than the raw numbers here: wind
              records differ in how predictable they are, so a model can post a worse score
              at one site and still be the better model. A tau near 1 means the ordering
              carries across both records.
            </Note>
          </div>

          <Eyebrow>Per model</Eyebrow>
          <Table
            columns={[
              { key: 'model', label: 'Model' },
              { key: 'kind', label: 'Type' },
              { key: 'current', label: 'This run', digits: cmp.meta.digits },
              { key: 'baseline', label: baseline.label, digits: cmp.meta.digits },
              { key: 'delta', label: 'Difference', digits: cmp.meta.digits },
              { key: 'pct', label: 'Change %', digits: 1 },
            ]}
            rows={cmp.rows}
            bestColumn="current"
            bestDirection={cmp.meta.lowerIsBetter ? 'min' : 'max'}
          />

          <Eyebrow>{cmp.meta.label} on both records</Eyebrow>
          <GroupedBars
            categories={cmp.rows.map((r) => r.model)}
            yLabel={cmp.meta.label}
            groups={[
              { label: 'This run', colour: PALETTE.teal, values: cmp.rows.map((r) => r.current) },
              { label: baseline.label, colour: PALETTE.amber, values: cmp.rows.map((r) => r.baseline) },
            ]}
            height={380}
          />

          <Eyebrow>Ordering</Eyebrow>
          <FitScatter
            x={cmp.rows.map((r) => r.baseline)}
            y={cmp.rows.map((r) => r.current)}
            colour={PALETTE.teal}
            label="This run"
            unit=""
            fit={W.linearFit(cmp.rows.map((r) => r.baseline), cmp.rows.map((r) => r.current))}
          />
          <div className="caption">
            Each point is one model: its score on the baseline against its score here.
            Points on a rising line mean the two records agree about which models are
            strong; scatter means the ranking does not transfer.
          </div>

          {wcmp && (
            <>
              <Eyebrow>Wind resource, side by side</Eyebrow>
              <Table
                columns={[
                  { key: 'name', label: '' },
                  { key: 'current', label: 'This run', digits: 3 },
                  { key: 'baseline', label: baseline.label, digits: 3 },
                ]}
                rows={wcmp.scalars.map(([name, a, b]) => ({ name, current: a, baseline: b }))}
              />
              <div style={{ marginTop: '1rem' }}>
                <GroupedBars
                  categories={wcmp.heights.map((h) => `${h.height} m`)}
                  yLabel="Wind power density (W/m²)"
                  groups={[
                    { label: 'This run', colour: PALETTE.teal, values: wcmp.heights.map((h) => h.currentWpd) },
                    { label: baseline.label, colour: PALETTE.amber, values: wcmp.heights.map((h) => h.baselineWpd) },
                  ]}
                  height={320}
                />
              </div>
              {wcmp.monthly.length > 0 && (
                <div style={{ marginTop: '1.2rem' }}>
                  <Eyebrow>Monthly power density at 150 m</Eyebrow>
                  <MultiLine
                    categories={wcmp.monthly.map((m) => m.month)}
                    yLabel="WPD (W/m²)"
                    series={[
                      { label: 'This run', colour: PALETTE.teal, values: wcmp.monthly.map((m) => m.current) },
                      { label: baseline.label, colour: PALETTE.amber, values: wcmp.monthly.map((m) => m.baseline) },
                    ]}
                  />
                </div>
              )}
            </>
          )}
        </>
      )}

      {hasResults && library.length > 0 && !baseline && (
        <div className="empty">Pick a saved run above to compare this one against.</div>
      )}
    </>
  );
}

/* ==================================================================== *
 * Export
 * ==================================================================== */

function download(name, text, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const toCsv = (rows) => {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  return [keys.join(','), ...rows.map((r) => keys.map((k) => {
    const v = r[k];
    return v === null || v === undefined ? '' : String(v);
  }).join(','))].join('\n');
};

function ExportTab({ board, results, evals, features, weibull, dataset, file, preset, presetName, testSize, unit, site }) {
  const names = Object.keys(evals);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  if (!names.length) return <div className="empty">Run a model first — then every table here becomes available.</div>;

  const metricsCsv = () => toCsv(board.map((r) => ({
    model: r.Model, type: r.Type, rmse_ms: r.rmse, mae_ms: r.mae, r2: r.r2, mape_pct: r.mape,
    rmse_scaled: r.rmseScaled, mae_scaled: r.maeScaled,
    rmse_ci_lo: evals[r.Model].rmseCI?.lo, rmse_ci_hi: evals[r.Model].rmseCI?.hi,
    tail_rmse: evals[r.Model].tail.tailRmse, exceedance_recall: evals[r.Model].tail.exceedanceRecall,
    train_seconds: r.seconds,
  })));

  const predictionsCsv = () => {
    const rows = [];
    for (let i = 0; i < features.test.nRows; i++) {
      const row = {
        timestamp: new Date(features.test.times[i]).toISOString(),
        observed: features.test.y[i],
      };
      for (const n of names) row[n] = results[n].predictions[i];
      rows.push(row);
    }
    return toCsv(rows);
  };

  const weibullCsv = () => toCsv(weibull.monthly.map((m) => ({
    month: m.month, hours: m.n, epf: m.epf, k: m.k, s: m.s,
    mws_observed: m.mwsObserved, wpd_10m: m.wpd10,
    ...Object.fromEntries(HUB_HEIGHTS.flatMap((h) => ([
      [`k_${h}m`, m.heights[h].k], [`s_${h}m`, m.heights[h].s],
      [`mws_${h}m`, m.heights[h].mws], [`wpd_${h}m`, m.heights[h].wpd],
    ]))),
  })));

  const dmCsv = () => {
    const preds = {};
    for (const n of names) preds[n] = results[n].predictions;
    const m = S.dmMatrix(features.test.y, preds);
    return toCsv(m.names.map((a) => ({ model: a, ...Object.fromEntries(m.names.map((b) => [b, m.rows[a][b]])) })));
  };

  const settings = {
    file: file?.name, recorded_unit: unit === 'kmh' ? 'km/h' : 'm/s', station: site,
    hourly_rows: dataset.summary.nHours, training_rows: features.train.nRows,
    test_rows: features.test.nRows, test_share: testSize, preset: presetName,
    n_estimators: preset.nEstimators, max_depth: preset.maxDepth, epochs: preset.epochs,
    bootstrap_resamples: preset.nBootstrap, shear_exponent: weibull.annual.alpha,
    lags: D.LAG_HOURS, models: names,
  };

  /** A name reduced to something safe to put in a download. */
  const slug = (name) => String(name || 'run')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run';

  /**
   * The figures, straight off the page.
   *
   * Read from the document rather than re-rendered, so what is saved is what
   * was on screen — same station colours, same chart style, same models. The
   * charts carry their styling in the stylesheet, much of it through custom
   * properties, so lib/export.js walks a clone and writes the computed value
   * of everything that matters onto each node before serialising. Without
   * that the file opens with no colour at all.
   *
   * withAllStagesRendered suspends content-visibility for the moment it takes
   * to collect. A stage that has never been scrolled to has no layout, so its
   * charts measure zero and would be dropped from the archive without a word.
   */
  const chartsOnPage = (section) => withAllStagesRendered(
    () => collectCharts(document, { section }),
  );

  const saveCharts = async (format, section = null) => {
    const found = await chartsOnPage(section);
    if (!found.length) {
      setNote(section
        ? `No ${section} charts on the page. That section may not be switched on under Choose the output.`
        : 'No charts to save. Switch some sections on under Choose the output first.');
      return;
    }
    setBusy(format);
    setNote(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const entries = [];
      for (const { svg, name } of found) {
        if (format === 'svg') {
          entries.push({ name: `charts/${name}.svg`, data: svgToString(svg, { background: '#ffffff' }) });
        } else {
          const blob = await svgToPng(svg, { scale: 2, background: '#ffffff' });
          entries.push({ name: `charts/${name}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
        }
      }
      const tag = section ? `${slug(section)}-` : '';
      downloadBlob(`windlab-${tag}charts-${stamp}.zip`, makeZip(entries));
      setNote(`Saved ${entries.length} chart${entries.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`);
    } catch (err) {
      setNote(err?.message || 'Those charts could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  /** Everything at once: the figures, every table, and the run settings. */
  const saveEverything = async () => {
    setBusy('all');
    setNote(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const entries = [
        { name: 'model_metrics.csv', data: metricsCsv() },
        { name: 'test_predictions.csv', data: predictionsCsv() },
        { name: 'weibull_monthly.csv', data: weibullCsv() },
        { name: 'run_settings.json', data: JSON.stringify(settings, null, 2) },
      ];
      if (names.length > 1) entries.push({ name: 'diebold_mariano.csv', data: dmCsv() });

      for (const { svg, name } of await chartsOnPage()) {
        entries.push({ name: `charts/${name}.svg`, data: svgToString(svg, { background: '#ffffff' }) });
      }

      entries.push({
        name: 'README.txt',
        data: [
          `Windlab export — ${stamp}`,
          '',
          `Record       ${file?.name ?? 'unnamed'}`,
          `Station      ${site === 'auto' ? 'custom coordinates' : site}`,
          `Hours        ${dataset.summary.nHours}`,
          `Models       ${names.join(', ')}`,
          `Effort       ${presetName}`,
          `Test share   ${(testSize * 100).toFixed(0)}%`,
          '',
          'model_metrics.csv      accuracy per model, with bootstrap intervals and tail behaviour',
          'test_predictions.csv   the observed series and every model against it, hour by hour',
          'weibull_monthly.csv    Weibull fit and power density by month, at each hub height',
          'diebold_mariano.csv    pairwise p-values; small means the difference is resolved',
          'run_settings.json      exactly what produced the above',
          'charts/                the figures as they appeared, as SVG',
          '',
          'Charts are vector and carry their own styling, so they can be opened',
          'or edited anywhere.',
        ].join('\n'),
      });

      downloadBlob(`windlab-${slug(file?.name)}-${stamp}.zip`, makeZip(entries));
      setNote(`Saved ${entries.length} files.`);
    } catch (err) {
      setNote(err?.message || 'That export could not be built.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Eyebrow>Everything at once</Eyebrow>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" style={{ width: 'auto', padding: '0.55rem 1.6rem' }}
          disabled={!!busy} onClick={saveEverything}>
          {busy === 'all' ? 'Building…' : 'Download everything'}
        </button>
        <button className="btn-ghost" disabled={!!busy} onClick={() => saveCharts('svg')}>
          {busy === 'svg' ? 'Saving…' : 'Charts as SVG'}
        </button>
        <button className="btn-ghost" disabled={!!busy} onClick={() => saveCharts('png')}>
          {busy === 'png' ? 'Rendering…' : 'Charts as PNG'}
        </button>
      </div>
      <div className="caption">
        One archive with every table, the run settings and each figure as vector.
        SVG keeps the charts editable and sharp at any size; PNG is the one to
        reach for when something will only accept an image.
      </div>
      {note && <div style={{ marginTop: '0.8rem' }}><Note tone="teal">{note}</Note></div>}

      <Eyebrow>One section at a time</Eyebrow>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        {OUTPUTS.filter((o) => o.key !== 'Export').map((o) => (
          <button key={o.key} className="btn-ghost" disabled={!!busy}
            onClick={() => saveCharts('svg', o.title)}>
            {o.title}
          </button>
        ))}
      </div>
      <div className="caption">
        Just the figures from one part of the results. Every stage is laid out
        before collecting, so a section you have not scrolled to still exports
        rather than coming out empty without saying why.
      </div>

      <Eyebrow>Individual files</Eyebrow>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={() => download('model_metrics.csv', metricsCsv())}>Model metrics</button>
        <button className="btn-ghost" onClick={() => download('test_predictions.csv', predictionsCsv())}>Test predictions</button>
        <button className="btn-ghost" onClick={() => download('weibull_monthly.csv', weibullCsv())}>Weibull monthly</button>
        {names.length > 1 && (
          <button className="btn-ghost" onClick={() => download('diebold_mariano.csv', dmCsv())}>Diebold-Mariano</button>
        )}
        <button className="btn-ghost"
          onClick={() => download('run_settings.json', JSON.stringify(settings, null, 2), 'application/json')}>
          Run settings
        </button>
      </div>

      <Eyebrow>Run settings</Eyebrow>
      <div className="panel">
        <pre style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: '0.76rem', color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(settings, null, 2)}
        </pre>
      </div>
    </>
  );
}
