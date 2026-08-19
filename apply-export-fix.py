#!/usr/bin/env python3
"""
Add chart and bundle downloads to the Export section.

Run from the repository root:

    python3 apply-export-fix.py

Adds, to ExportTab:

    Charts as SVG      every figure on the page, vector, one file each
    Charts as PNG      the same, rasterised at 2x
    Everything         a single archive: charts, every CSV, the settings

Each block below must appear exactly once. If any does not, nothing is
changed and the script says which — better a refusal than a file half edited.
A backup is written to app/page.jsx.bak.
"""

import sys
from pathlib import Path

PAGE = Path("app/page.jsx")

IMPORT_OLD = "import Backdrop from '@/components/Backdrop';"
IMPORT_NEW = """import Backdrop from '@/components/Backdrop';
import {
  svgToString, svgToPng, collectCharts, withAllStagesRendered,
  makeZip, downloadBlob,
} from '@/lib/export';"""

# ---- the new buttons, and the state behind them ----

SIG_OLD = """function ExportTab({ board, results, evals, features, weibull, dataset, file, preset, presetName, testSize, unit, site }) {
  const names = Object.keys(evals);
  if (!names.length) return <div className="empty">Run a model first — then every table here becomes available.</div>;
"""

SIG_NEW = """function ExportTab({ board, results, evals, features, weibull, dataset, file, preset, presetName, testSize, unit, site }) {
  const names = Object.keys(evals);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  if (!names.length) return <div className="empty">Run a model first — then every table here becomes available.</div>;
"""

BLOCK_OLD = """  return (
    <>
      <Eyebrow>Download</Eyebrow>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={() => download('model_metrics.csv', metricsCsv())}>Model metrics</button>"""

BLOCK_NEW = """  /**
   * The figures, straight off the page.
   *
   * Read from the document rather than re-rendered, so what is saved is what
   * was on screen — same station colours, same chart style, same models. The
   * charts carry their styling in the stylesheet, much of it through custom
   * properties, so lib/export.js walks a clone and writes the computed value
   * of everything that matters onto each node before serialising. Without
   * that the file opens with no colour at all.
   *
   * Only sections you chose to show are on the page, so only those are
   * collected — which is the behaviour you want, but worth knowing if a
   * figure you expected is missing.
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
      const tag = section ? `${section}-` : '';
      downloadBlob(`windlab-${tag}charts-${stamp}.zip`, makeZip(entries));
      setNote(`Saved ${entries.length} ${section ?? ''} chart${entries.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`.replace('  ', ' '));
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
          'or edited anywhere. Only sections that were on the page are included.',
        ].join('\\n'),
      });

      downloadBlob(`windlab-${slugForFile(file?.name)}-${stamp}.zip`, makeZip(entries));
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
        Just the figures from one part of the results. Sections are matched by
        their heading, and every stage is laid out before collecting — so a
        section you have not scrolled to still exports, rather than coming out
        empty without saying why.
      </div>

      <Eyebrow>Individual files</Eyebrow>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={() => download('model_metrics.csv', metricsCsv())}>Model metrics</button>"""

# a small helper the bundle name uses
HELPER_OLD = """const toCsv = (rows) => {"""
HELPER_NEW = """/** A record's filename, reduced to something safe to put in a download. */
const slugForFile = (name) => String(name || 'run')
  .replace(/\\.[^.]+$/, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || 'run';

const toCsv = (rows) => {"""

EDITS = [
    ("import the export helpers", IMPORT_OLD, IMPORT_NEW),
    ("add state to ExportTab", SIG_OLD, SIG_NEW),
    ("add a filename helper", HELPER_OLD, HELPER_NEW),
    ("add the download controls", BLOCK_OLD, BLOCK_NEW),
]


def main() -> int:
    if not PAGE.exists():
        print(f"  {PAGE} not found. Run this from the repository root.")
        return 1
    if not Path("lib/export.js").exists():
        print("  lib/export.js not found. Add it before running this.")
        return 1

    src = PAGE.read_text()

    problems = []
    for label, old, _new in EDITS:
        n = src.count(old)
        print(f"  {'ok  ' if n == 1 else 'FAIL'} {label}  ({'ok' if n == 1 else f'found {n} times'})")
        if n != 1:
            problems.append(label)

    if problems:
        print()
        print("  Nothing changed. The file does not match what this patch expects.")
        return 1

    PAGE.with_suffix(".jsx.bak").write_text(src)
    for _label, old, new in EDITS:
        src = src.replace(old, new, 1)
    PAGE.write_text(src)

    print()
    print(f"  Patched {PAGE}. Previous version at {PAGE}.bak")
    for label, present in [
        ("collectCharts wired", "collectCharts(document, { section })" in src),
        ("stages forced to lay out first", "withAllStagesRendered" in src),
        ("per-section export present", "saveCharts('svg', o.title)" in src),
        ("bundle builder present", "saveEverything" in src),
        ("SVG and PNG paths present", "saveCharts('svg')" in src and "saveCharts('png')" in src),
        ("useState available in this file", "useState" in src.split("\n")[10 - 1] or "useState" in src[:2000]),
    ]:
        print(f"  {'ok  ' if present else 'FAIL'} {label}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
