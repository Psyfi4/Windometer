'use client';

/**
 * Windlab.
 *
 * Everything happens on this page and in the visitor's browser: the file is
 * read locally, models train on the main thread with yields between batches,
 * and no data leaves the machine. That is what lets it live on a static host.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

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
import { themeForSite, chartTheme, PALETTE, SITE_THEMES, frameGradient } from '@/lib/theme';
import Backdrop from '@/components/Backdrop';
import { Eyebrow, Note, Card, CardCI, CardRow, Table, Legend3 } from '@/components/ui';

const HUB_HEIGHTS = [100, 120, 150];
const TABS = ['Dataset', 'Models', 'Comparison', 'Weibull & power', 'Region', 'Export'];

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
  const [tab, setTab] = useState('Dataset');
  const [activeModel, setActiveModel] = useState(null);
  const [dmLoss, setDmLoss] = useState('squared');
  const [chartStyle, setChartStyle] = useState('notebook');
  const [ambience, setAmbience] = useState(true);
  const [setupOpen, setSetupOpen] = useState(true);
  const dropRef = useRef(null);

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
      setTab('Dataset');
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
      setTab(ok.length > 1 ? 'Comparison' : 'Models');
      setSetupOpen(false);   // give the results the room once there are some
    }
  }, [features, selected, preset, topK]);

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

  const bestModel = board[0]?.Model ?? null;
  const failures = Object.values(results).filter((r) => r.failed);

  const siteMeta = site !== 'auto' ? SITES.SITES[site] : null;
  const lat = siteMeta ? siteMeta.lat : customLat;
  const lon = siteMeta ? siteMeta.lon : customLon;

  /* ------------------------------ render ----------------------------- */
  const breathe = stationTheme.breathe ?? [accent, accent, accent];

  const setup = {
    file, dataset, busy, loadError, handleFile,
    unit, reunit, site, setSite, customLat, setCustomLat, customLon, setCustomLon,
    stationTheme, accent, presetName, setPresetName, preset,
    chartStyle, setChartStyle, ambience, setAmbience,
    runAll, setRunAll, chosen, setChosen, selected,
    testSize, setTestSize, topK, setTopK,
    alphaMode, setAlphaMode, alphaCustom, setAlphaCustom,
    showScaled, setShowScaled, features, run, progress,
    setupOpen, setSetupOpen,
  };

  return (
    <ChartThemeProvider theme={chartT}>
      {/* The custom properties live here, above the frame as well as the
          shell. Setting them on the shell alone left the frame — a sibling —
          unable to resolve them, so it painted nothing. */}
      <div
        className="app-root"
        style={{
          '--accent': accent,
          '--breathe-1': breathe[0],
          '--breathe-2': breathe[1],
          '--breathe-3': breathe[2],
          '--frame-gradient': frameGradient(accent),
        }}
      >
        <Backdrop enabled={ambience} pinned={site !== 'auto' ? site : null} />
        {ambience && (
          <>
            <div className="frame" aria-hidden="true" />
            <div className="frame-glow" aria-hidden="true" />
          </>
        )}
        <div className={`shell${ambience ? ' ambient' : ''}`}>
          <main className="main">
          <div className="masthead">
            <h1>Wind forecasting <span className="mark">workbench</span></h1>
            <div className="sub">
              Upload an hourly wind record, then run any model on its own or the whole set.
              Error metrics with bootstrap intervals, Diebold-Mariano tests, tail behaviour
              and Weibull power density at hub height, all computed from your own data —
              in this tab, with nothing sent to a server.
            </div>
          </div>

          <Deck {...setup} />

          {!dataset ? (
            <Landing />
          ) : (
            <>
              <div className="tabs">
                {TABS.map((t) => (
                  <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>
                ))}
              </div>

              {failures.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <Note tone="coral">
                    {failures.length === 1 ? 'One model did not finish' : `${failures.length} models did not finish`}:{' '}
                    {failures.map((f) => `${f.name} (${f.error})`).join('; ')}
                  </Note>
                </div>
              )}

              {tab === 'Dataset' && <DatasetTab dataset={dataset} weibull={weibull} />}
              {tab === 'Models' && (
                <ModelsTab
                  results={results} evals={evals} features={features}
                  activeModel={activeModel} setActiveModel={setActiveModel}
                  showScaled={showScaled}
                />
              )}
              {tab === 'Comparison' && (
                <ComparisonTab
                  results={results} evals={evals} board={board} features={features}
                  showScaled={showScaled} site={site} dmLoss={dmLoss} setDmLoss={setDmLoss}
                />
              )}
              {tab === 'Weibull & power' && (
                <WeibullTab
                  weibull={weibull} dataset={dataset} site={site}
                  results={results} features={features} bestModel={bestModel}
                />
              )}
              {tab === 'Region' && <RegionTab site={site} lat={lat} lon={lon} />}
              {tab === 'Export' && (
                <ExportTab
                  board={board} results={results} evals={evals} features={features}
                  weibull={weibull} dataset={dataset} file={file} preset={preset}
                  presetName={presetName} testSize={testSize} unit={unit} site={site}
                />
              )}
            </>
          )}
          </main>
        </div>
      </div>
    </ChartThemeProvider>
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
    setupOpen, setSetupOpen,
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

function ModelCheck({ name, chosen, setChosen }) {
  const spec = MM.REGISTRY[name];
  const on = chosen.includes(name);
  return (
    <label className="checkline" title={spec.blurb}>
      <input
        type="checkbox" checked={on}
        onChange={() => setChosen(on ? chosen.filter((c) => c !== name) : [...chosen, name])}
      />
      <span>
        {name}
        {spec.needsTF && <span className="pill" style={{ marginLeft: '0.35rem' }}>slower</span>}
      </span>
    </label>
  );
}

function Landing() {
  return (
    <div className="grid-15">
      <div>
        <Eyebrow>Getting started</Eyebrow>
        <p style={{ color: 'var(--muted)', fontSize: '0.88rem', lineHeight: 1.7 }}>
          Drop a file into the panel on the left. Two layouts are recognised without
          any configuration:
        </p>
        <p style={{ fontSize: '0.86rem', lineHeight: 1.7 }}>
          <b>IMD station format</b> — one row per day, with <code>YEAR</code>, <code>MN</code>,{' '}
          <code>DT</code> and 24 hourly columns <code>S01</code>…<code>S24</code>.<br />
          <b>Generic format</b> — one row per reading, with a timestamp column
          (<code>datetime</code>, <code>timestamp</code>, <code>date</code>) and a wind-speed
          column (<code>wind_speed</code>, <code>ws</code>, <code>speed</code>).
        </p>
        <Eyebrow>What gets computed</Eyebrow>
        <ul style={{ color: 'var(--muted)', fontSize: '0.85rem', lineHeight: 1.85, paddingLeft: '1.1rem' }}>
          <li>Gap handling: linear interpolation under 6 h, monthly median beyond</li>
          <li>24 strictly causal lag features forecasting one hour ahead</li>
          <li>Chronological train/test split — no shuffling, no lookahead</li>
          <li>RMSE, MAE, R², MAPE with 95% moving-block bootstrap intervals</li>
          <li>Pairwise Diebold-Mariano tests with a Newey-West correction</li>
          <li>P95 tail errors, exceedance recall, Bland-Altman agreement</li>
          <li>Weibull <i>k</i> and <i>s</i> by the MEPF method, power density at 100/120/150 m</li>
        </ul>
      </div>
      <div>
        <Eyebrow>Model library</Eyebrow>
        {[['Base', MM.BASE_MODELS], ['Hybrid', MM.HYBRID_MODELS]].map(([group, names]) => (
          <div key={group} style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' }}>{group}</div>
            {names.map((n) => (
              <div key={n} style={{ fontSize: '0.8rem', color: 'var(--muted)', margin: '0.25rem 0', lineHeight: 1.45 }}>
                <span style={{ color: FAMILY_COLOUR[MM.REGISTRY[n].family] }}>·</span> {n}
              </div>
            ))}
          </div>
        ))}
        <Note>
          Nothing is uploaded. The file is read locally and every model trains in this
          tab, so a large record is limited by your machine rather than a server timeout.
        </Note>
      </div>
    </div>
  );
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
    return <div className="empty">Choose models on the left and press <b>Run analysis</b>.</div>;
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

  return (
    <>
      <Eyebrow>Download</Eyebrow>
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
