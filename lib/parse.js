/**
 * Browser file reading.
 *
 * Workbooks go through SheetJS, delimited text through PapaParse. Both are
 * loaded on demand so they stay out of the initial bundle; nothing is parsed
 * until someone actually drops a file in.
 */

import { detectFormat, wideToHourly, longToHourly, DataFormatError } from './data.js';

/** Read an uploaded File into rows plus their header names. */
export async function readFile(file) {
  const name = (file.name || '').toLowerCase();

  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) {
    const Papa = (await import('papaparse')).default;
    const text = await file.text();
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
    if (!parsed.data?.length) throw new DataFormatError('That file has no rows.');
    return { rows: parsed.data, headers: parsed.meta.fields ?? Object.keys(parsed.data[0]) };
  }

  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new DataFormatError('That workbook has no sheets.');

  // IMD station files carry a title row above the real header, so try both.
  for (const range of [undefined, 1]) {
    const opts = { defval: null, raw: true };
    if (range !== undefined) opts.range = range;
    const rows = XLSX.utils.sheet_to_json(sheet, opts);
    if (!rows.length) continue;
    const headers = Object.keys(rows[0]);
    const unnamed = headers.filter((h) => /^(__EMPTY|Column\d|Unnamed)/i.test(h)).length;
    const upper = headers.map((h) => String(h).toUpperCase());
    const looksReal = upper.includes('YEAR') || upper.includes('MN')
      || headers.some((h) => /date|time|wind|speed|ws/i.test(h));
    if (looksReal || unnamed < headers.length / 2) return { rows, headers };
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
  if (!rows.length) throw new DataFormatError('That sheet has no rows.');
  return { rows, headers: Object.keys(rows[0]) };
}

/** Read a file and reduce it to a continuous hourly series. */
export async function loadSeries(file) {
  const { rows, headers } = await readFile(file);
  const format = detectFormat(headers);
  const series = format === 'wide' ? wideToHourly(rows, headers) : longToHourly(rows, headers);
  return { ...series, format, headers, preview: rows.slice(0, 60) };
}
