/**
 * Tree learners for the browser.
 *
 * One histogram-based builder backs five distinct learners, which is what makes
 * training a forest on a hundred thousand rows viable in JavaScript:
 *
 *   Random Forest    bagged trees, depth-wise, feature subsampling per split
 *   GBM              depth-wise boosting on residuals, row subsampling
 *   XGBoost-style    L2-regularised leaf weights, column subsampling per tree
 *   LightGBM-style   leaf-wise (best-first) growth under a leaf budget
 *   CatBoost-style   oblivious trees: one split shared across each depth level
 *
 * Features are binned once into a Uint8Array up front. Split finding then costs
 * one pass per feature per node instead of a sort, and every learner reuses the
 * same binning. Everything is column-major so a feature's values are contiguous.
 *
 * These are faithful reimplementations of each algorithm's defining behaviour,
 * not bindings to the original libraries. Results track the reference
 * implementations closely but will not match them bit for bit.
 */

const MAX_BINS = 64;

/* ------------------------------------------------------------------ *
 * Binning
 * ------------------------------------------------------------------ */

/**
 * Quantile-bin a column-major feature matrix.
 * Quantile edges rather than uniform, because wind lags are strongly skewed
 * and uniform bins would leave most of the range nearly empty.
 */
export function binFeatures(X, nRows, nCols, maxBins = MAX_BINS) {
  const binned = new Uint8Array(nRows * nCols);
  const edges = [];
  const sampleSize = Math.min(nRows, 20000);
  const stride = Math.max(1, Math.floor(nRows / sampleSize));

  for (let f = 0; f < nCols; f++) {
    const base = f * nRows;
    const sample = [];
    for (let i = 0; i < nRows; i += stride) sample.push(X[base + i]);
    sample.sort((a, b) => a - b);

    const cuts = [];
    for (let b = 1; b < maxBins; b++) {
      const pos = (sample.length - 1) * (b / maxBins);
      const lo = Math.floor(pos), hi = Math.ceil(pos);
      const v = lo === hi ? sample[lo] : sample[lo] + (sample[hi] - sample[lo]) * (pos - lo);
      if (!cuts.length || v > cuts[cuts.length - 1]) cuts.push(v);
    }
    edges.push(cuts);

    for (let i = 0; i < nRows; i++) {
      binned[base + i] = searchBin(cuts, X[base + i]);
    }
  }
  return { binned, edges };
}

function searchBin(cuts, v) {
  let lo = 0, hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v > cuts[mid]) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Apply existing edges to new data, so test rows land in training bins. */
export function applyBins(X, nRows, nCols, edges) {
  const binned = new Uint8Array(nRows * nCols);
  for (let f = 0; f < nCols; f++) {
    const base = f * nRows;
    const cuts = edges[f];
    for (let i = 0; i < nRows; i++) binned[base + i] = searchBin(cuts, X[base + i]);
  }
  return binned;
}

/* ------------------------------------------------------------------ *
 * A single tree
 * ------------------------------------------------------------------ */

function makeTree(capacity) {
  return {
    feature: new Int32Array(capacity).fill(-1),
    threshold: new Int32Array(capacity),
    left: new Int32Array(capacity).fill(-1),
    right: new Int32Array(capacity).fill(-1),
    value: new Float64Array(capacity),
    count: new Int32Array(capacity),
    nNodes: 0,
  };
}

/**
 * Build one regression tree over binned features.
 *
 * @param opts.growth      'depth' | 'leaf'
 * @param opts.symmetric   one split per level, shared by every node (CatBoost)
 * @param opts.lambda      L2 penalty on leaf weights
 * @param opts.featureBag  candidate features considered at each split
 */
function buildTree(binned, nRows, nCols, target, rows, opts, importance) {
  const {
    maxDepth = 8, minSamplesLeaf = 5, numLeaves = 31,
    growth = 'depth', symmetric = false, lambda = 0,
    featureFraction = 1, rng = Math.random, nBins = MAX_BINS,
  } = opts;

  const capacity = Math.max(64, Math.min(4 * numLeaves + 64, 1 << (Math.min(maxDepth, 16) + 1)));
  const tree = makeTree(capacity + 64);

  const histSum = new Float64Array(nBins);
  const histCnt = new Int32Array(nBins);

  const nodeRows = [rows];
  const nodeDepth = [0];
  tree.nNodes = 1;

  const leafValue = (sum, cnt) => sum / (cnt + lambda);

  function statsOf(idx) {
    let sum = 0;
    for (let i = 0; i < idx.length; i++) sum += target[idx[i]];
    return sum;
  }

  /** Best (feature, bin) split for one node, or null if none improves. */
  function findSplit(idx, features) {
    const total = statsOf(idx);
    const n = idx.length;
    const parentGain = (total * total) / (n + lambda);
    let best = null;

    for (const f of features) {
      histSum.fill(0); histCnt.fill(0);
      const base = f * nRows;
      for (let i = 0; i < n; i++) {
        const r = idx[i];
        const b = binned[base + r];
        histSum[b] += target[r];
        histCnt[b]++;
      }
      let leftSum = 0, leftCnt = 0;
      for (let b = 0; b < nBins - 1; b++) {
        leftSum += histSum[b]; leftCnt += histCnt[b];
        if (leftCnt < minSamplesLeaf) continue;
        const rightCnt = n - leftCnt;
        if (rightCnt < minSamplesLeaf) break;
        const rightSum = total - leftSum;
        const gain = (leftSum * leftSum) / (leftCnt + lambda)
          + (rightSum * rightSum) / (rightCnt + lambda) - parentGain;
        if (!best || gain > best.gain) {
          best = { feature: f, bin: b, gain, leftSum, leftCnt, rightSum, rightCnt };
        }
      }
    }
    return best && best.gain > 1e-12 ? best : null;
  }

  function pickFeatures() {
    if (featureFraction >= 1) return Array.from({ length: nCols }, (_, i) => i);
    const k = Math.max(1, Math.round(nCols * featureFraction));
    const pool = Array.from({ length: nCols }, (_, i) => i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, k);
  }

  function partition(idx, feature, bin) {
    const base = feature * nRows;
    const L = [], R = [];
    for (let i = 0; i < idx.length; i++) {
      (binned[base + idx[i]] <= bin ? L : R).push(idx[i]);
    }
    return [L, R];
  }

  function finalise(node) {
    const idx = nodeRows[node];
    tree.value[node] = leafValue(statsOf(idx), idx.length);
    tree.count[node] = idx.length;
    tree.feature[node] = -1;
  }

  /* ---------------- oblivious (CatBoost-style) ---------------- */
  if (symmetric) {
    let level = [0];
    for (let d = 0; d < maxDepth; d++) {
      const features = pickFeatures();
      const perNode = level.map((nd) => nodeRows[nd])
        .filter((idx) => idx.length >= 2 * minSamplesLeaf);
      if (!perNode.length) break;

      // One histogram pass per (feature, node), then a cumulative scan over
      // bins. Scoring every candidate bin by rescanning rows instead would be
      // nBins times more work and dominates training time.
      let bestFeature = -1, bestBin = -1, bestGain = 0;
      for (const f of features) {
        const base = f * nRows;
        const sums = [], cnts = [], totals = [];
        for (const idx of perNode) {
          const hs = new Float64Array(nBins);
          const hc = new Int32Array(nBins);
          let tot = 0;
          for (let i = 0; i < idx.length; i++) {
            const r = idx[i];
            const b = binned[base + r];
            hs[b] += target[r]; hc[b]++; tot += target[r];
          }
          sums.push(hs); cnts.push(hc); totals.push(tot);
        }
        const runS = new Float64Array(perNode.length);
        const runC = new Int32Array(perNode.length);
        for (let bin = 0; bin < nBins - 1; bin++) {
          let gain = 0, ok = true;
          for (let j = 0; j < perNode.length; j++) {
            runS[j] += sums[j][bin]; runC[j] += cnts[j][bin];
            const lc = runC[j], rc = perNode[j].length - lc;
            if (lc < minSamplesLeaf || rc < minSamplesLeaf) { ok = false; continue; }
            const ls = runS[j], rs = totals[j] - ls;
            gain += (ls * ls) / (lc + lambda) + (rs * rs) / (rc + lambda)
              - (totals[j] * totals[j]) / (perNode[j].length + lambda);
          }
          if (ok && gain > bestGain) { bestGain = gain; bestFeature = f; bestBin = bin; }
        }
      }
      if (bestFeature < 0) break;
      importance[bestFeature] += bestGain;

      const next = [];
      for (const nd of level) {
        if (tree.nNodes + 2 >= tree.value.length) break;
        const [L, R] = partition(nodeRows[nd], bestFeature, bestBin);
        if (!L.length || !R.length) continue;
        const li = tree.nNodes++, ri = tree.nNodes++;
        tree.feature[nd] = bestFeature;
        tree.threshold[nd] = bestBin;
        tree.left[nd] = li; tree.right[nd] = ri;
        nodeRows[li] = L; nodeRows[ri] = R;
        nodeDepth[li] = d + 1; nodeDepth[ri] = d + 1;
        next.push(li, ri);
      }
      if (!next.length) break;
      level = next;
    }
    for (let nd = 0; nd < tree.nNodes; nd++) {
      if (tree.feature[nd] === -1) finalise(nd);
    }
    nodeRows.length = 0;
    return tree;
  }

  /* ---------------- leaf-wise (LightGBM-style) ---------------- */
  if (growth === 'leaf') {
    const frontier = [];
    const seed = findSplit(rows, pickFeatures());
    if (seed) frontier.push({ node: 0, split: seed });
    let leaves = 1;

    while (frontier.length && leaves < numLeaves && tree.nNodes + 2 < tree.value.length) {
      let bi = 0;
      for (let i = 1; i < frontier.length; i++) {
        if (frontier[i].split.gain > frontier[bi].split.gain) bi = i;
      }
      const { node, split } = frontier.splice(bi, 1)[0];
      if (nodeDepth[node] >= maxDepth) continue;

      const [L, R] = partition(nodeRows[node], split.feature, split.bin);
      if (!L.length || !R.length) continue;
      importance[split.feature] += split.gain;

      const li = tree.nNodes++, ri = tree.nNodes++;
      tree.feature[node] = split.feature;
      tree.threshold[node] = split.bin;
      tree.left[node] = li; tree.right[node] = ri;
      nodeRows[li] = L; nodeRows[ri] = R;
      nodeDepth[li] = nodeDepth[node] + 1;
      nodeDepth[ri] = nodeDepth[node] + 1;
      leaves++;

      for (const child of [li, ri]) {
        if (nodeDepth[child] < maxDepth && nodeRows[child].length >= 2 * minSamplesLeaf) {
          const sp = findSplit(nodeRows[child], pickFeatures());
          if (sp) frontier.push({ node: child, split: sp });
        }
      }
    }
    for (let nd = 0; nd < tree.nNodes; nd++) {
      if (tree.feature[nd] === -1) finalise(nd);
    }
    nodeRows.length = 0;
    return tree;
  }

  /* ---------------- depth-wise (RF / GBM / XGBoost-style) ---------------- */
  const stack = [0];
  while (stack.length) {
    const node = stack.pop();
    const idx = nodeRows[node];
    const depth = nodeDepth[node];
    if (depth >= maxDepth || idx.length < 2 * minSamplesLeaf
      || tree.nNodes + 2 >= tree.value.length) {
      finalise(node);
      continue;
    }
    const split = findSplit(idx, pickFeatures());
    if (!split) { finalise(node); continue; }

    const [L, R] = partition(idx, split.feature, split.bin);
    if (!L.length || !R.length) { finalise(node); continue; }
    importance[split.feature] += split.gain;

    const li = tree.nNodes++, ri = tree.nNodes++;
    tree.feature[node] = split.feature;
    tree.threshold[node] = split.bin;
    tree.left[node] = li; tree.right[node] = ri;
    nodeRows[li] = L; nodeRows[ri] = R;
    nodeDepth[li] = depth + 1; nodeDepth[ri] = depth + 1;
    stack.push(li, ri);
  }
  nodeRows.length = 0;
  return tree;
}

/** Traverse one tree for every row of a binned matrix. */
function predictTree(tree, binned, nRows, out, scale = 1) {
  for (let i = 0; i < nRows; i++) {
    let node = 0;
    while (tree.feature[node] !== -1) {
      const f = tree.feature[node];
      node = binned[f * nRows + i] <= tree.threshold[node] ? tree.left[node] : tree.right[node];
    }
    out[i] += tree.value[node] * scale;
  }
}

/* ------------------------------------------------------------------ *
 * Ensembles
 * ------------------------------------------------------------------ */

export class TreeEnsemble {
  constructor(config) {
    this.config = config;
    this.trees = [];
    this.edges = null;
    this.base = 0;
    this.nCols = 0;
    this.importance = null;
  }

  /**
   * @param X column-major Float64Array of length nRows*nCols
   * @param y Float64Array of length nRows
   * @param onProgress called with a 0-1 fraction
   */
  fit(X, y, nRows, nCols, onProgress) {
    const c = this.config;
    this.nCols = nCols;
    const { binned, edges } = binFeatures(X, nRows, nCols);
    this.edges = edges;
    this.importance = new Float64Array(nCols);
    const rng = mulberry(c.seed ?? 42);

    const allRows = new Int32Array(nRows);
    for (let i = 0; i < nRows; i++) allRows[i] = i;

    if (c.kind === 'forest') {
      this.base = 0;
      for (let t = 0; t < c.nEstimators; t++) {
        const bag = new Int32Array(nRows);
        for (let i = 0; i < nRows; i++) bag[i] = Math.floor(rng() * nRows);
        const tree = buildTree(binned, nRows, nCols, y, Array.from(bag), {
          maxDepth: c.maxDepth, minSamplesLeaf: c.minSamplesLeaf,
          featureFraction: c.featureFraction, rng, growth: 'depth', lambda: 0,
        }, this.importance);
        this.trees.push(tree);
        if (onProgress && (t % 5 === 0)) onProgress((t + 1) / c.nEstimators);
      }
      return this;
    }

    // boosting: start from the mean, then fit successive trees to residuals
    let mean = 0;
    for (let i = 0; i < nRows; i++) mean += y[i];
    mean /= nRows;
    this.base = mean;

    const pred = new Float64Array(nRows).fill(mean);
    const residual = new Float64Array(nRows);

    for (let t = 0; t < c.nEstimators; t++) {
      for (let i = 0; i < nRows; i++) residual[i] = y[i] - pred[i];

      let rows;
      if (c.subsample < 1) {
        rows = [];
        for (let i = 0; i < nRows; i++) if (rng() < c.subsample) rows.push(i);
        if (rows.length < 10) rows = Array.from(allRows);
      } else {
        rows = Array.from(allRows);
      }

      const tree = buildTree(binned, nRows, nCols, residual, rows, {
        maxDepth: c.maxDepth, minSamplesLeaf: c.minSamplesLeaf,
        numLeaves: c.numLeaves, growth: c.growth, symmetric: c.symmetric,
        lambda: c.lambda, featureFraction: c.featureFraction, rng,
      }, this.importance);

      this.trees.push(tree);
      predictTree(tree, binned, nRows, pred, c.learningRate);
      if (onProgress && (t % 5 === 0)) onProgress((t + 1) / c.nEstimators);
    }
    return this;
  }

  /**
   * Same as fit, but yields to the event loop periodically so the page keeps
   * painting. Training runs on the main thread; a worker would need TF.js
   * bundled into it too, and this keeps one code path.
   */
  async fitAsync(X, y, nRows, nCols, onProgress, breathe) {
    const c = this.config;
    this.nCols = nCols;
    const { binned, edges } = binFeatures(X, nRows, nCols);
    this.edges = edges;
    this.importance = new Float64Array(nCols);
    const rng = mulberry(c.seed ?? 42);

    const allRows = new Int32Array(nRows);
    for (let i = 0; i < nRows; i++) allRows[i] = i;

    const tick = async (t) => {
      if (onProgress) onProgress((t + 1) / c.nEstimators);
      if (breathe && t % 8 === 7) await breathe();
    };

    if (c.kind === 'forest') {
      this.base = 0;
      for (let t = 0; t < c.nEstimators; t++) {
        const bag = new Array(nRows);
        for (let i = 0; i < nRows; i++) bag[i] = Math.floor(rng() * nRows);
        this.trees.push(buildTree(binned, nRows, nCols, y, bag, {
          maxDepth: c.maxDepth, minSamplesLeaf: c.minSamplesLeaf,
          featureFraction: c.featureFraction, rng, growth: 'depth', lambda: 0,
        }, this.importance));
        await tick(t);
      }
      return this;
    }

    let mean = 0;
    for (let i = 0; i < nRows; i++) mean += y[i];
    mean /= nRows;
    this.base = mean;

    const pred = new Float64Array(nRows).fill(mean);
    const residual = new Float64Array(nRows);

    for (let t = 0; t < c.nEstimators; t++) {
      for (let i = 0; i < nRows; i++) residual[i] = y[i] - pred[i];
      let rows;
      if (c.subsample < 1) {
        rows = [];
        for (let i = 0; i < nRows; i++) if (rng() < c.subsample) rows.push(i);
        if (rows.length < 10) rows = Array.from(allRows);
      } else {
        rows = Array.from(allRows);
      }
      const tree = buildTree(binned, nRows, nCols, residual, rows, {
        maxDepth: c.maxDepth, minSamplesLeaf: c.minSamplesLeaf,
        numLeaves: c.numLeaves, growth: c.growth, symmetric: c.symmetric,
        lambda: c.lambda, featureFraction: c.featureFraction, rng,
      }, this.importance);
      this.trees.push(tree);
      predictTree(tree, binned, nRows, pred, c.learningRate);
      await tick(t);
    }
    return this;
  }

  predict(X, nRows) {
    const binned = applyBins(X, nRows, this.nCols, this.edges);
    const out = new Float64Array(nRows).fill(this.base);
    const c = this.config;
    if (c.kind === 'forest') {
      for (const tree of this.trees) predictTree(tree, binned, nRows, out, 1);
      for (let i = 0; i < nRows; i++) out[i] /= this.trees.length;
      return out;
    }
    for (const tree of this.trees) predictTree(tree, binned, nRows, out, c.learningRate);
    return out;
  }

  /** Gain-based importance, normalised to sum to one. */
  featureImportance() {
    const total = this.importance.reduce((a, b) => a + b, 0);
    const out = new Float64Array(this.importance.length);
    if (total > 0) for (let i = 0; i < out.length; i++) out[i] = this.importance[i] / total;
    return out;
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Named configurations
 * ------------------------------------------------------------------ */

export function forestConfig(p) {
  return {
    kind: 'forest', nEstimators: p.nEstimators, maxDepth: p.maxDepth,
    minSamplesLeaf: 1, featureFraction: Math.sqrt(1 / 24) * 4.9, // ~sqrt(nFeatures)/nFeatures
    growth: 'depth', lambda: 0, subsample: 1, learningRate: 1, seed: 42,
  };
}

export function gbmConfig(p) {
  return {
    kind: 'boost', nEstimators: p.nEstimators, maxDepth: Math.min(p.maxDepth, 6),
    minSamplesLeaf: 2, featureFraction: 1, growth: 'depth', lambda: 0,
    subsample: 0.8, learningRate: 0.05, seed: 42,
  };
}

export function xgbConfig(p) {
  return {
    kind: 'boost', nEstimators: p.nEstimators, maxDepth: Math.min(p.maxDepth, 6),
    minSamplesLeaf: 1, featureFraction: 0.8, growth: 'depth', lambda: 1,
    subsample: 0.8, learningRate: 0.05, seed: 7,
  };
}

export function lgbmConfig(p) {
  return {
    kind: 'boost', nEstimators: p.nEstimators, maxDepth: Math.min(p.maxDepth + 4, 14),
    minSamplesLeaf: 20, numLeaves: 31, featureFraction: 0.8, growth: 'leaf',
    lambda: 0, subsample: 0.8, learningRate: 0.05, seed: 11,
  };
}

export function catboostConfig(p) {
  return {
    kind: 'boost', nEstimators: p.nEstimators, maxDepth: Math.min(p.maxDepth, 6),
    minSamplesLeaf: 1, featureFraction: 1, growth: 'depth', symmetric: true,
    lambda: 3, subsample: 1, learningRate: 0.05, seed: 23,
  };
}
