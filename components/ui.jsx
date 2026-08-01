'use client';

/** Small presentational pieces shared across the tabs. */

export function Eyebrow({ children }) {
  return <div className="eyebrow">{children}</div>;
}

export function Note({ children, tone = '' }) {
  return <div className={`note-box ${tone}`}>{children}</div>;
}

export function Card({ label, value, note, tone = 't-ink' }) {
  return (
    <div className="card">
      <div className="lab">{label}</div>
      <div className={`val ${tone}`}>{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

/**
 * A stat card that carries its own confidence interval, read off a small rail.
 * The interval is placed on a shared axis so cards can be compared by eye.
 */
export function CardCI({ label, value, lo, hi, axisLo, axisHi, colour = 'var(--teal)', tone = 't-teal', digits = 5 }) {
  const ok = isFinite(lo) && isFinite(hi) && axisHi > axisLo;
  const clamp = (v) => Math.max(0, Math.min(100, ((v - axisLo) / (axisHi - axisLo)) * 100));
  return (
    <div className="card">
      <div className="lab">{label}</div>
      <div className={`val ${tone}`}>{isFinite(value) ? value.toFixed(digits) : '—'}</div>
      {ok && (
        <>
          <div className="rail">
            <div className="span" style={{ left: `${clamp(lo)}%`, width: `${Math.max(clamp(hi) - clamp(lo), 1.2)}%`, background: colour }} />
            <div className="dot" style={{ left: `${clamp(value)}%`, background: colour }} />
          </div>
          <div className="note">95% CI {lo.toFixed(digits)} – {hi.toFixed(digits)}</div>
        </>
      )}
    </div>
  );
}

export function CardRow({ children }) {
  return <div className="cardrow">{children}</div>;
}

export function Table({ columns, rows, bestColumn = null, bestDirection = 'min' }) {
  let bestIdx = -1;
  if (bestColumn) {
    const key = bestColumn;
    let bestVal = bestDirection === 'min' ? Infinity : -Infinity;
    rows.forEach((r, i) => {
      const v = r[key];
      if (typeof v !== 'number' || !isFinite(v)) return;
      if (bestDirection === 'min' ? v < bestVal : v > bestVal) { bestVal = v; bestIdx = i; }
    });
  }
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => {
                const raw = r[c.key];
                const isNum = typeof raw === 'number';
                const text = raw === null || raw === undefined || (isNum && !isFinite(raw))
                  ? '—'
                  : isNum ? raw.toFixed(c.digits ?? 4) : String(raw);
                return (
                  <td key={c.key} className={`${isNum ? 'num' : ''} ${i === bestIdx && c.key === bestColumn ? 'best' : ''}`}>
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Legend3() {
  return (
    <div className="legend">
      <span><span className="swatch" style={{ background: 'var(--teal)' }} />Tree</span>
      <span><span className="swatch" style={{ background: 'var(--violet)' }} />Neural</span>
      <span><span className="swatch" style={{ background: 'var(--amber)' }} />Hybrid</span>
    </div>
  );
}

export function Panel({ children, title }) {
  return (
    <div className="panel">
      {title ? <div className="eyebrow" style={{ marginTop: 0 }}>{title}</div> : null}
      {children}
    </div>
  );
}
