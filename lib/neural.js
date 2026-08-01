/**
 * Neural runtime, TensorFlow.js.
 *
 * LSTM, bidirectional LSTM and a 1D CNN over the lag window. The architectures
 * follow the study's, at reduced width: a browser tab has far less compute than
 * the T4 the paper trained on, and a 64/32-unit LSTM over 100k sequences is not
 * something to run on someone's laptop fan.
 *
 * Inputs and targets are standardised on training statistics only. Trees are
 * scale-free, but an LSTM fed raw m/s converges badly.
 *
 * The backend is chosen at runtime: WebGL when the browser exposes it inside a
 * worker, otherwise CPU. Everything is disposed explicitly, because TF.js
 * tensors are not garbage collected.
 */

let tfPromise = null;

async function getTf() {
  if (!tfPromise) {
    tfPromise = (async () => {
      const tf = await import('@tensorflow/tfjs');
      try {
        await tf.setBackend('webgl');
        await tf.ready();
      } catch {
        await tf.setBackend('cpu');
        await tf.ready();
      }
      return tf;
    })();
  }
  return tfPromise;
}

export async function backendName() {
  const tf = await getTf();
  return tf.getBackend();
}

/* ------------------------------------------------------------------ *
 * Scaling
 * ------------------------------------------------------------------ */

function standardiser(block) {
  const { X, y, nRows, nCols } = block;
  const mean = new Float64Array(nCols);
  const std = new Float64Array(nCols);
  for (let f = 0; f < nCols; f++) {
    let s = 0;
    for (let i = 0; i < nRows; i++) s += X[f * nRows + i];
    const m = s / nRows;
    let v = 0;
    for (let i = 0; i < nRows; i++) v += (X[f * nRows + i] - m) ** 2;
    mean[f] = m;
    std[f] = Math.sqrt(v / nRows) || 1;
  }
  let ys = 0;
  for (let i = 0; i < nRows; i++) ys += y[i];
  const yMean = ys / nRows;
  let yv = 0;
  for (let i = 0; i < nRows; i++) yv += (y[i] - yMean) ** 2;
  const yStd = Math.sqrt(yv / nRows) || 1;
  return { mean, std, yMean, yStd };
}

/**
 * Column-major block to a flat [n, timesteps, 1] buffer.
 * Column j is timestep j, so the caller must pass columns oldest first.
 */
function toSequence(block, sc) {
  const { X, nRows, nCols } = block;
  const out = new Float32Array(nRows * nCols);
  for (let i = 0; i < nRows; i++) {
    for (let f = 0; f < nCols; f++) {
      out[i * nCols + f] = (X[f * nRows + i] - sc.mean[f]) / sc.std[f];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Architectures
 * ------------------------------------------------------------------ */

function buildModel(tf, kind, timesteps) {
  const model = tf.sequential();
  const inputShape = [timesteps, 1];

  if (kind === 'LSTM') {
    model.add(tf.layers.lstm({ units: 32, returnSequences: true, inputShape }));
    model.add(tf.layers.dropout({ rate: 0.2 }));
    model.add(tf.layers.lstm({ units: 16 }));
    model.add(tf.layers.dropout({ rate: 0.2 }));
    model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
  } else if (kind === 'BiLSTM') {
    model.add(tf.layers.bidirectional({
      layer: tf.layers.lstm({ units: 32, returnSequences: true }),
      inputShape,
    }));
    model.add(tf.layers.dropout({ rate: 0.2 }));
    model.add(tf.layers.bidirectional({ layer: tf.layers.lstm({ units: 16 }) }));
    model.add(tf.layers.dropout({ rate: 0.2 }));
    model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
  } else if (kind === 'CNN') {
    model.add(tf.layers.conv1d({
      filters: 32, kernelSize: 3, activation: 'relu', padding: 'same', inputShape,
    }));
    model.add(tf.layers.batchNormalization());
    if (timesteps >= 4) model.add(tf.layers.maxPooling1d({ poolSize: 2 }));
    model.add(tf.layers.dropout({ rate: 0.25 }));
    model.add(tf.layers.conv1d({
      filters: 64, kernelSize: 3, activation: 'relu', padding: 'same',
    }));
    model.add(tf.layers.batchNormalization());
    if (timesteps >= 8) model.add(tf.layers.maxPooling1d({ poolSize: 2 }));
    model.add(tf.layers.dropout({ rate: 0.25 }));
    model.add(tf.layers.flatten());
    model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
  } else {
    throw new Error(`Unknown neural model ${kind}`);
  }

  model.add(tf.layers.dense({ units: 1, activation: 'linear' }));
  model.compile({ optimizer: tf.train.adam(1e-3), loss: 'meanSquaredError' });
  return model;
}

/* ------------------------------------------------------------------ *
 * Training
 * ------------------------------------------------------------------ */

/** Neural models get a tighter row budget than the tree learners. */
export function neuralRowCap(preset) {
  return Math.min(preset.maxTrainRows, preset.nEstimators >= 300 ? 30000 : 12000);
}

function tailBlock(block, cap) {
  if (block.nRows <= cap) return block;
  const from = block.nRows - cap;
  const X = new Float64Array(cap * block.nCols);
  const y = new Float64Array(cap);
  const times = new Float64Array(cap);
  for (let f = 0; f < block.nCols; f++) {
    for (let i = 0; i < cap; i++) X[f * cap + i] = block.X[f * block.nRows + from + i];
  }
  for (let i = 0; i < cap; i++) { y[i] = block.y[from + i]; times[i] = block.times[from + i]; }
  return { X, y, times, nRows: cap, nCols: block.nCols };
}

/**
 * Fit a sequence model and predict the test block.
 *
 * @param report (fraction, message)
 * @returns { predictions: Float64Array, history: {loss:[], valLoss:[]} }
 */
export async function fitPredict(kind, trainBlock, testBlock, preset, report = () => {}) {
  const tf = await getTf();
  const train = tailBlock(trainBlock, neuralRowCap(preset));
  const sc = standardiser(train);
  const timesteps = train.nCols;

  report(0.05, `Preparing tensors (${tf.getBackend()})`);

  const xBuf = toSequence(train, sc);
  const yBuf = new Float32Array(train.nRows);
  for (let i = 0; i < train.nRows; i++) yBuf[i] = (train.y[i] - sc.yMean) / sc.yStd;

  // chronological validation tail, never shuffled
  const valCount = Math.max(1, Math.floor(train.nRows * 0.2));
  const fitCount = train.nRows - valCount;

  const xAll = tf.tensor3d(xBuf, [train.nRows, timesteps, 1]);
  const yAll = tf.tensor2d(yBuf, [train.nRows, 1]);
  const xFit = xAll.slice([0, 0, 0], [fitCount, timesteps, 1]);
  const yFit = yAll.slice([0, 0], [fitCount, 1]);
  const xVal = xAll.slice([fitCount, 0, 0], [valCount, timesteps, 1]);
  const yVal = yAll.slice([fitCount, 0], [valCount, 1]);

  const model = buildModel(tf, kind, timesteps);
  const history = { loss: [], valLoss: [] };

  let best = Infinity;
  let bestWeights = null;
  let patienceLeft = Math.max(3, Math.round(preset.epochs / 4));

  try {
    for (let epoch = 0; epoch < preset.epochs; epoch++) {
      const h = await model.fit(xFit, yFit, {
        epochs: 1,
        batchSize: preset.batchSize,
        shuffle: false,
        validationData: [xVal, yVal],
        verbose: 0,
      });
      const loss = h.history.loss[0];
      const valLoss = h.history.val_loss[0];
      history.loss.push(loss);
      history.valLoss.push(valLoss);

      if (valLoss < best - 1e-5) {
        best = valLoss;
        patienceLeft = Math.max(3, Math.round(preset.epochs / 4));
        if (bestWeights) bestWeights.forEach((w) => w.dispose());
        bestWeights = model.getWeights().map((w) => w.clone());
      } else if (--patienceLeft <= 0) {
        report(0.9, `Early stop at epoch ${epoch + 1}`);
        break;
      }

      report(0.1 + ((epoch + 1) / preset.epochs) * 0.8,
        `Epoch ${epoch + 1}/${preset.epochs} · val ${valLoss.toFixed(5)}`);
      await tf.nextFrame();
    }

    if (bestWeights) model.setWeights(bestWeights);

    report(0.95, 'Predicting');
    const predictions = new Float64Array(testBlock.nRows);
    const chunk = 4096;
    for (let start = 0; start < testBlock.nRows; start += chunk) {
      const size = Math.min(chunk, testBlock.nRows - start);
      const buf = new Float32Array(size * timesteps);
      for (let i = 0; i < size; i++) {
        for (let f = 0; f < timesteps; f++) {
          buf[i * timesteps + f] =
            (testBlock.X[f * testBlock.nRows + start + i] - sc.mean[f]) / sc.std[f];
        }
      }
      const xt = tf.tensor3d(buf, [size, timesteps, 1]);
      const out = model.predict(xt);
      const arr = await out.data();
      for (let i = 0; i < size; i++) predictions[start + i] = arr[i] * sc.yStd + sc.yMean;
      xt.dispose();
      out.dispose();
      await tf.nextFrame();
    }

    return { predictions, history };
  } finally {
    if (bestWeights) bestWeights.forEach((w) => w.dispose());
    [xAll, yAll, xFit, yFit, xVal, yVal].forEach((t) => t.dispose());
    model.dispose();
  }
}
