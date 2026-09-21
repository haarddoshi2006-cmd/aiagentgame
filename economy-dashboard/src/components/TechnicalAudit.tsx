import type { CSSProperties } from 'react';

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: '10px',
  marginTop: '12px',
};

const card: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  padding: '10px 12px',
};

const labelStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--muted)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase' as const,
};

const scoreStyle = (n: number): CSSProperties => ({
  fontSize: '22px',
  fontWeight: 700,
  color: n >= 8 ? 'var(--good)' : n >= 5 ? 'var(--ink)' : 'var(--bad)',
});

type Props = {
  scores: Record<string, number> | null;
};

/** Renders the 10 rubric metrics (1–10) returned by ``POST /api/simulate``. */
export function TechnicalAudit({ scores }: Props) {
  if (!scores || Object.keys(scores).length === 0) {
    return (
      <p style={{ color: 'var(--muted)', fontSize: '13px' }}>
        Run a sprint to see the mock audit rubric scores (drives MRR and tech-debt deltas on the server).
      </p>
    );
  }

  const entries = Object.entries(scores).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div style={grid}>
      {entries.map(([key, value]) => (
        <div key={key} style={card}>
          <div style={labelStyle}>{humanize(key)}</div>
          <div style={scoreStyle(value)}>{value}</div>
          <div style={{ height: '4px', marginTop: '6px', background: 'var(--line)', borderRadius: '2px' }}>
            <div
              style={{
                width: `${Math.min(100, Math.max(0, value * 10))}%`,
                height: '100%',
                borderRadius: '2px',
                background: value >= 8 ? 'var(--good)' : value >= 5 ? 'var(--accent)' : 'var(--bad)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim();
}
