/**
 * Model registry and training orchestration.
 *
 * Base learners plus the seven hybrid architectures. Every hybrid fits its
 * meta-regressor or blend weight on a later held-out slice the base learners
 * never saw, then refits the base learners on all training data. Fitting a
 * meta-model on in-sample base predictions leaks, and makes stacking look worse
 * than the components it is built from.
 */

import {
  TreeEnsemble, forestConfig, gbmConfig, xgbConfig, lgbmConfig, catboostConfig,
} from './trees.js';
import { selectColumns, reverseColumns } from './data.js';
import { rmse } from './stats.js';

/* ------------------------------------------------------------------ *
 * Presets
 *
 * Sized against measured browser timings rather than copied from the paper:
 * the published 500-tree / 100-epoch configuration is impractical in a tab.
 * ------------------------------------------------------------------ */
export const PRESETS = {
  Quick: {
    label: 'A first look. Seconds per model.',
    nEstimators: 60, maxDepth: 6, epochs: 6, batchSize: 256,
    maxTrainRows: 15000, maxTestRows: 6000, nBootstrap: 200,
  },
  Standard: {
    label: 'Sensible default for exploring a dataset.',
    nEstimators: 150, maxDepth: 8, epochs: 15, batchSize: 128,
    maxTrainRows: 40000, maxTestRows: 12000, nBootstrap: 500,
  },
  Thorough: {
    label: 'Closest to the published setup. Minutes per model.',
    nEstimators: 300, maxDepth: 10, epochs: 30, batchSize: 128,
    maxTrainRows: 100000, maxTestRows: 25000, nBootstrap: 1000,
  },
};

export const FAMILY = { TREE: 'tree', NEURAL: 'neural', HYBRID: 'hybrid' };

export const REGISTRY = {
  RF: {
    kind: 'base', family: FAMILY.TREE, needsTF: false,
    blurb: 'Bagged regression trees over the 24 causal lags. Low variance, resistant to overfitting.',
  },
  GBM: {
    kind: 'base', family: FAMILY.TREE, needsTF: false,
    blurb: 'Gradient boosting on residuals. The best single model in the study.',
  },
  'XGBoost-style': {
    kind: 'base', family: FAMILY.TREE, needsTF: false,
    blurb: 'Boosting with L2-regularised leaf weights and column subsampling per tree.',
  },
  'LightGBM-style': {
    kind: 'base', family: FAMILY.TREE, needsTF: false,
    blurb: 'Leaf-wise growth under a leaf budget, rather than growing level by level.',
  },
  'CatBoost-style': {
    kind: 'base', family: FAMILY.TREE, needsTF: false,
    blurb: 'Oblivious trees: one split shared across every node at a given depth.',
  },
  LSTM: {
    kind: 'base', family: FAMILY.NEURAL, needsTF: true,
    blurb: 'Two stacked LSTM layers reading the lag window as a sequence.',
  },
  BiLSTM: {
    kind: 'base', family: FAMILY.NEURAL, needsTF: true,
    blurb: 'Bidirectional LSTM, reading the window forwards and backwards.',
  },
  CNN: {
    kind: 'base', family: FAMILY.NEURAL, needsTF: true,
    blurb: '1D convolutions over the lag window, picking up local patterns.',
  },
  'RF + XGBoost (stacking)': {
    kind: 'hybrid', family: FAMILY.HYBRID, needsTF: false,
    blurb: 'Both models predict; a meta-regressor learns how to weight them.',
  },
  'RF + GBM (weighted average)': {
    kind: 'hybrid', family: FAMILY.HYBRID, needsTF: false,
    blurb: 'Blend weight w swept on held-out data. Final = w·RF + (1−w)·GBM.',
  },
  '5-model stacking': {
    kind: 'hybrid', family: FAMILY.HYBRID, needsTF: false,
    blurb: 'All five tree learners feeding one meta-regressor.',
  },
  'RF + LSTM (feature selection)': {
    kind: 'hybrid', family: FAMILY.HYBRID, needsTF: true,
    blurb: 'RF ranks the lags by importance; only the top ones reach the LSTM.',
  },
  'RF + CNN (feature selection)': {
    kind: 'hybrid', family: FAMILY.HYBRID, needsTF: true,
    blurb: 'RF ranks the lags by importance; only the top ones reach the CNN.',
  },
  'GBM + LSTM (residual)': {
    kind: 'hybrid', family: FAMILY.HYBRID, needsTF: true,
    blurb: "GBM predicts, an LSTM learns GBM's error, and the two are summed.",
  },
  'XGBoost + LSTM (stacking)': {
    kind: 'hybrid', family: FAMILY.HYBRID, needsTF: true,
    blurb: 'A tree learner and a sequence learner combined by a meta-regressor.',
  },
};

export const BASE_MODELS = Object.keys(REGISTRY).filter((k) => REGISTRY[k].kind === 'base');
export const HYBRID_MODELS = Object.keys(REGISTRY).filter((k) => REGISTRY[k].kind === 'hybrid');

const TREE_CONFIGS = {
  RF: forestConfig,
  GBM: gbmConfig,
  'XGBoost-style': xgbConfig,
  'LightGBM-style': lgbmConfig,
  'CatBoost-style': catboostConfig,
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Split a training block into an earlier fit part and a later held-out part. */
export function innerSplit(block, ratio = 0.15) {
  const cut = Math.max(1, Math.floor(block.nRows * (1 - ratio)));
  const take = (from, to) => {
    const m = to - from;
    const X = new Float64Array(m * block.nCols);
    const y = new Float64Array(m);
    const times = new Float64Array(m);
    for (let f = 0; f < block.nCols; f++) {
      for (let i = 0; i < m; i++) X[f * m + i] = block.X[f * block.nRows + from + i];
    }
    for (let i = 0; i < m; i++) { y[i] = block.y[from + i]; times[i] = block.times[from + i]; }
    return { X, y, times, nRows: m, nCols: block.nCols };
  };
  return { fit: take(0, cut), hold: take(cut, block.nRows) };
}

/** Ordinary least squares with an intercept, via Gaussian elimination. */
export function leastSquares(columns, y) {
  const p = columns.length, n = y.length;
  const A = Array.from({ length: p + 1 }, () => new Float64Array(p + 2));
  for (let i = 0; i <= p; i++) {
    for (let j = 0; j <= p; j++) {
      let s = 0;
      for (let r = 0; r < n; r++) {
        s += (i === p ? 1 : columns[i][r]) * (j === p ? 1 : columns[j][r]);
      }
      A[i][j] = s;
    }
    let s = 0;
    for (let r = 0; r < n; r++) s += (i === p ? 1 : columns[i][r]) * y[r];
    A[i][p + 1] = s;
  }
  const m = p + 1;
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-12) continue;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const d = A[col][col];
    for (let j = col; j <= m; j++) A[col][j] /= d;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      if (!factor) continue;
      for (let j = col; j <= m; j++) A[r][j] -= factor * A[col][j];
    }
  }
  const coef = new Float64Array(p);
  for (let i = 0; i < p; i++) coef[i] = A[i][m];
  return { coef, intercept: A[p][m] };
}

export function applyLinear(columns, model) {
  const n = columns[0].length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = model.intercept;
    for (let j = 0; j < columns.length; j++) v += model.coef[j] * columns[j][i];
    out[i] = v;
  }
  return out;
}

const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

async function fitTree(name, block, preset, onProgress) {
  const cfg = TREE_CONFIGS[name]({ nEstimators: preset.nEstimators, maxDepth: preset.maxDepth });
  const model = new TreeEnsemble(cfg);
  await model.fitAsync(block.X, block.y, block.nRows, block.nCols, onProgress, breathe);
  return model;
}

/** Indices of the top-k lags by importance, ordered oldest first. */
export function topLagColumns(importance, k) {
  const order = Array.from({ length: importance.length }, (_, i) => i)
    .sort((a, b) => importance[b] - importance[a])
    .slice(0, k);
  return order.sort((a, b) => b - a); // Lag_24 ... Lag_1
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

/**
 * Train one model and predict the test block.
 *
 * @param neural  async helpers from lib/neural.js; required for TF models
 * @param report  progress callback (fraction, message)
 */
export async function runModel(name, train, test, preset, options = {}, neural = null, report = () => {}) {
  const t0 = Date.now();
  const spec = REGISTRY[name];
  if (!spec) throw new Error(`Unknown model: ${name}`);
  if (spec.needsTF && !neural) throw new Error(`${name} needs the neural runtime.`);

  const topK = options.topK ?? 12;
  const extras = {};
  let predictions;

  /* -------- base tree learners -------- */
  if (TREE_CONFIGS[name]) {
    report(0.05, 'Binning features');
    const model = await fitTree(name, train, preset, (f) => report(0.05 + f * 0.9, 'Growing trees'));
    predictions = model.predict(test.X, test.nRows);
    extras.importance = Array.from(model.featureImportance());
  }

  /* -------- base neural learners -------- */
  else if (name === 'LSTM' || name === 'BiLSTM' || name === 'CNN') {
    // sequence models read timesteps oldest first
    const out = await neural.fitPredict(
      name, reverseColumns(train), reverseColumns(test), preset, report
    );
    predictions = out.predictions;
    extras.history = out.history;
  }

  /* -------- RF + XGBoost stacking -------- */
  else if (name === 'RF + XGBoost (stacking)') {
    const { fit, hold } = innerSplit(train);
    report(0.05, 'Training base learners');
    const rf = await fitTree('RF', fit, preset);
    const xg = await fitTree('XGBoost-style', fit, preset);
    report(0.45, 'Fitting meta-regressor');
    const meta = leastSquares(
      [rf.predict(hold.X, hold.nRows), xg.predict(hold.X, hold.nRows)], hold.y
    );
    report(0.6, 'Refitting on all training data');
    const rfFull = await fitTree('RF', train, preset);
    const xgFull = await fitTree('XGBoost-style', train, preset);
    predictions = applyLinear(
      [rfFull.predict(test.X, test.nRows), xgFull.predict(test.X, test.nRows)], meta
    );
    extras.metaWeights = { RF: meta.coef[0], 'XGBoost-style': meta.coef[1], intercept: meta.intercept };
    extras.importance = Array.from(rfFull.featureImportance());
  }

  /* -------- RF + GBM weighted average -------- */
  else if (name === 'RF + GBM (weighted average)') {
    const { fit, hold } = innerSplit(train);
    report(0.05, 'Training base learners');
    const rf = await fitTree('RF', fit, preset);
    const gb = await fitTree('GBM', fit, preset);
    report(0.45, 'Searching the blend weight');
    const pr = rf.predict(hold.X, hold.nRows);
    const pg = gb.predict(hold.X, hold.nRows);
    const curve = [];
    let bestW = 0, bestErr = Infinity;
    const blend = new Float64Array(hold.nRows);
    for (let w = 0; w <= 1.0001; w += 0.01) {
      for (let i = 0; i < hold.nRows; i++) blend[i] = w * pr[i] + (1 - w) * pg[i];
      const e = rmse(hold.y, blend);
      curve.push({ w: +w.toFixed(2), rmse: e });
      if (e < bestErr) { bestErr = e; bestW = +w.toFixed(2); }
    }
    report(0.6, 'Refitting on all training data');
    const rfFull = await fitTree('RF', train, preset);
    const gbFull = await fitTree('GBM', train, preset);
    const a = rfFull.predict(test.X, test.nRows);
    const b = gbFull.predict(test.X, test.nRows);
    predictions = new Float64Array(test.nRows);
    for (let i = 0; i < test.nRows; i++) predictions[i] = bestW * a[i] + (1 - bestW) * b[i];
    extras.blendWeight = bestW;
    extras.weightCurve = curve;
    extras.importance = Array.from(rfFull.featureImportance());
  }

  /* -------- five-model stacking -------- */
  else if (name === '5-model stacking') {
    const names = Object.keys(TREE_CONFIGS);
    const { fit, hold } = innerSplit(train);
    const holdCols = [];
    for (let i = 0; i < names.length; i++) {
      report(0.05 + (i / names.length) * 0.4, `Training ${names[i]}`);
      const m = await fitTree(names[i], fit, preset);
      holdCols.push(m.predict(hold.X, hold.nRows));
    }
    const meta = leastSquares(holdCols, hold.y);
    const testCols = [];
    let rfFull = null;
    for (let i = 0; i < names.length; i++) {
      report(0.45 + (i / names.length) * 0.5, `Refitting ${names[i]}`);
      const m = await fitTree(names[i], train, preset);
      if (names[i] === 'RF') rfFull = m;
      testCols.push(m.predict(test.X, test.nRows));
    }
    predictions = applyLinear(testCols, meta);
    extras.metaWeights = Object.fromEntries(
      names.map((n, i) => [n, meta.coef[i]]).concat([['intercept', meta.intercept]])
    );
    if (rfFull) extras.importance = Array.from(rfFull.featureImportance());
  }

  /* -------- RF-selected lags into a sequence model -------- */
  else if (name === 'RF + LSTM (feature selection)' || name === 'RF + CNN (feature selection)') {
    report(0.05, 'Ranking lags with a random forest');
    const selector = await fitTree('RF', train, preset);
    const importance = selector.featureImportance();
    const cols = topLagColumns(importance, topK);
    const kind = name.includes('LSTM') ? 'LSTM' : 'CNN';
    const trainSel = selectColumns(train, cols);
    const testSel = selectColumns(test, cols);
    const out = await neural.fitPredict(kind, trainSel, testSel, preset,
      (f, m) => report(0.35 + f * 0.6, m));
    predictions = out.predictions;
    extras.history = out.history;
    extras.importance = Array.from(importance);
    extras.selectedColumns = cols;
    extras.selectedFeatures = cols.map((c) => `Lag_${c + 1}`);
  }

  /* -------- GBM + LSTM residual learning -------- */
  else if (name === 'GBM + LSTM (residual)') {
    const { fit, hold } = innerSplit(train);
    report(0.05, 'Training GBM');
    const gbm = await fitTree('GBM', fit, preset);
    const holdPred = gbm.predict(hold.X, hold.nRows);
    const residual = new Float64Array(hold.nRows);
    let mean = 0;
    for (let i = 0; i < hold.nRows; i++) {
      residual[i] = hold.y[i] - holdPred[i];
      mean += residual[i];
    }
    mean /= hold.nRows;
    let varSum = 0;
    for (let i = 0; i < hold.nRows; i++) varSum += (residual[i] - mean) ** 2;

    report(0.35, 'Learning the residual');
    const residBlock = reverseColumns({ ...hold, y: residual });
    const out = await neural.fitPredict('LSTM', residBlock, reverseColumns(test), preset,
      (f, m) => report(0.35 + f * 0.4, m));

    report(0.8, 'Refitting GBM on all training data');
    const gbmFull = await fitTree('GBM', train, preset);
    const base = gbmFull.predict(test.X, test.nRows);
    predictions = new Float64Array(test.nRows);
    for (let i = 0; i < test.nRows; i++) predictions[i] = base[i] + out.predictions[i];
    extras.residualMean = mean;
    extras.residualSd = Math.sqrt(varSum / hold.nRows);
    extras.history = out.history;
    extras.importance = Array.from(gbmFull.featureImportance());
  }

  /* -------- XGBoost + LSTM stacking -------- */
  else if (name === 'XGBoost + LSTM (stacking)') {
    const { fit, hold } = innerSplit(train);
    report(0.05, 'Training XGBoost-style');
    const xg = await fitTree('XGBoost-style', fit, preset);
    report(0.2, 'Training LSTM');
    const lstmHold = await neural.fitPredict(
      'LSTM', reverseColumns(fit), reverseColumns(hold), preset,
      (f, m) => report(0.2 + f * 0.3, m)
    );
    const meta = leastSquares([lstmHold.predictions, xg.predict(hold.X, hold.nRows)], hold.y);

    report(0.55, 'Refitting on all training data');
    const xgFull = await fitTree('XGBoost-style', train, preset);
    const lstmFull = await neural.fitPredict(
      'LSTM', reverseColumns(train), reverseColumns(test), preset,
      (f, m) => report(0.6 + f * 0.35, m)
    );
    predictions = applyLinear(
      [lstmFull.predictions, xgFull.predict(test.X, test.nRows)], meta
    );
    extras.metaWeights = { LSTM: meta.coef[0], 'XGBoost-style': meta.coef[1], intercept: meta.intercept };
    extras.history = lstmFull.history;
    extras.importance = Array.from(xgFull.featureImportance());
  } else {
    throw new Error(`Unknown model: ${name}`);
  }

  report(1, 'Done');
  return { name, predictions, extras, seconds: (Date.now() - t0) / 1000 };
}
