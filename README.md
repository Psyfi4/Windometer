# Windlab

A wind-speed forecasting workbench that runs the machine-learning and hybrid
models from *Enhancing wind energy forecasting in India* (Yadav et al.,
**Sustainable Energy Technologies and Assessments** 84, 2025, 104735) against
any hourly wind record — one model at a time, or all of them at once.

**Everything computes in the browser.** The file never leaves the machine, and
the site is fully static, so it deploys to Vercel's free tier with no server,
no function timeouts, and nothing to keep running.

---

## Deploying to Vercel

**From the dashboard**

1. Push this folder to a GitHub repository.
2. On [vercel.com](https://vercel.com) choose **Add New → Project** and import it.
3. Accept the defaults — the framework is detected as Next.js — and deploy.

**From the terminal**

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

**Locally**

```bash
npm install
npm run dev     # http://localhost:3000
```

`next.config.mjs` sets `output: 'export'`, so `npm run build` emits a plain
static site to `out/`. That also means it will drop onto GitHub Pages, Netlify,
Cloudflare Pages or any static host without changes.

---

## Why the browser, and not a Python server

The earlier Streamlit version can't run on Vercel, and it isn't a porting
problem. Streamlit needs a long-lived stateful process holding a WebSocket per
visitor; Vercel runs stateless functions capped at 10–60 s with a 250 MB bundle
limit. TensorFlow alone is around 600 MB, and fitting a forest on 333,000 rows
takes minutes.

Moving the computation to the browser removes all three limits at once. It also
removes the Colab tunnel: there is no notebook to keep alive and no session to
reconnect to. The trade is that training is bounded by the visitor's laptop
rather than a T4, which is why the presets are smaller than the published
configuration.

---

## What it accepts

**IMD station format** — one row per day, with `YEAR`, `MN`, `DT` and 24 hourly
columns `S01`…`S24`.

**Generic format** — one row per reading, with a timestamp column (`datetime`,
`timestamp`, `date`) and a wind-speed column (`wind_speed`, `ws`, `speed`).
Sub-hourly readings are averaged up to the hour.

Dates in `dd/mm/yyyy` are read day-first unless the data shows otherwise, and
Excel serial dates are handled. Set the recorded unit in the sidebar; IMD
records are km/h and everything is converted to m/s.

---

## Models

**Base** — Random Forest, GBM, XGBoost-style, LightGBM-style, CatBoost-style,
LSTM, BiLSTM, 1D CNN

**Hybrid**

| Model | How it combines |
|---|---|
| RF + XGBoost | Stacking — a meta-regressor blends both predictions |
| RF + GBM | Weighted average — blend weight *w* found by grid search |
| 5-model stacking | All five tree learners into one meta-regressor |
| RF + LSTM | RF ranks the lags; the top-k feed an LSTM |
| RF + CNN | RF ranks the lags; the top-k feed a 1D CNN |
| GBM + LSTM | Residual learning — the LSTM predicts GBM's error |
| XGBoost + LSTM | Stacking a tree learner with a sequence learner |

Every hybrid fits its meta-regressor or blend weight on a **later held-out
slice** the base learners never saw, then refits the base learners on all
training data. Fitting a meta-model on in-sample base predictions leaks, and
makes stacking look worse than the components it is built from.

### On the tree learners

The five tree models are reimplementations, not bindings to scikit-learn,
XGBoost, LightGBM or CatBoost — none of which run in a browser. One
histogram-based builder backs all five, and each keeps the behaviour that
defines it: bagging with per-split feature sampling for RF, L2-regularised leaf
weights and column subsampling for XGBoost-style, leaf-wise growth under a leaf
budget for LightGBM-style, and oblivious trees for CatBoost-style. Results track
the reference implementations closely but will not match them bit for bit.

The neural models use TensorFlow.js at reduced width, and pick WebGL when the
browser offers it.

---

## What gets computed

- **Preprocessing** — gaps under 6 h by linear interpolation, longer gaps by the
  monthly median for that calendar month
- **Features** — 24 strictly causal lags forecasting one hour ahead
- **Split** — strictly chronological, earliest data trains and latest tests
- **Accuracy** — RMSE, MAE, R², MAPE
- **Uncertainty** — 95% intervals from a moving-block bootstrap over 24-hour
  blocks, which preserves temporal dependence
- **Significance** — pairwise two-sided Diebold-Mariano tests with a Newey-West
  correction at lag 23
- **Extremes** — P95 tail RMSE and MAE, plus exceedance recall
- **Agreement** — Bland-Altman bias, SD and limits; bias across deciles of
  observed speed
- **Statistical layer** — Weibull *k* and *s* by the Modified Energy Pattern
  Factor method, projected to 100 / 120 / 150 m with power density and mean
  wind speed at each height

---

## Three things worth knowing about the numbers

**Metric space.** Table 1 of the paper reports RMSE near 0.086 while its figures
run on axes of 0.0–0.8, which corresponds to a **min-max scaled** target rather
than raw m/s. Both are shown. A raw RMSE near 1.4 m/s and a scaled RMSE near
0.099 describe the same model.

**Weibull aggregation.** Eqs. (3)–(11) are implemented as printed. The paper's
headline power density — 1090 W/m² for Tuticorin in July at 150 m — depends on
monthly aggregation choices the text doesn't specify, so a faithful
implementation lands lower. The sidebar exposes the lever that matters most
(the shear exponent α) and the Weibull tab prints the published figures beside
yours rather than quietly tuning to match.

**The Weibull comparison is a Q-Q plot, not a mean-vs-mean scatter.** Under
MEPF the scale parameter is *defined* by Eq. (5) so that the theoretical mean
equals the sample mean. Plotting observed against Weibull-estimated means is
therefore an identity that returns R² = 1 no matter how badly the distribution
fits. Comparing quantiles tests what the fit actually claims to describe; on the
Tuticorin record that gives R² ≈ 0.985, with the gap concentrated at the calm
end where a Weibull cannot represent exact zeros.

---

## Layout

```
app/
  page.jsx          UI, tabs, run loop
  layout.jsx        document shell
  globals.css       dark theme
components/
  Charts.jsx        every chart, drawn as plain SVG
  ui.jsx            cards, tables, notes
lib/
  data.js           ingestion, gap filling, lag features, splits
  parse.js          workbook and CSV reading
  trees.js          histogram tree builder and the five ensembles
  neural.js         TensorFlow.js sequence models
  models.js         registry, hybrids, training orchestration
  stats.js          metrics, bootstrap, Diebold-Mariano, tails
  weibull.js        MEPF estimation, hub-height projection, power density
  sites.js          station coordinates and published reference values
```

## Presets

Training runs on the main thread and yields between batches, so the page stays
responsive. Sizes are set against measured timings, not copied from the paper —
500 trees and 100 epochs is not something to run in a tab.

| Preset | Trees / epochs | Training rows | Roughly |
|---|---|---|---|
| Quick | 60 / 6 | 15,000 | a second or two per tree model |
| Standard | 150 / 15 | 40,000 | a few seconds per tree model |
| Thorough | 300 / 30 | 100,000 | tens of seconds per tree model |

Neural models are slower than the tree learners at every preset and get a
tighter row budget. Start on **Quick** to confirm a new file reads correctly.
