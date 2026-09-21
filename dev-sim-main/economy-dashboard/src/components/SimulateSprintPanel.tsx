import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useGame } from '@/context/GameContext';

export function SimulateSprintPanel() {
  const { runSimulateSprint, loading, error, teamStatsSum } = useGame();
  const [projectName, setProjectName] = useState('Sprint Alpha');
  const [projectSpec, setProjectSpec] = useState(
    'Ship onboarding polish, fix flaky CI, and prep investor metrics deck.',
  );
  const [expectedMrr, setExpectedMrr] = useState(12_000);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await runSimulateSprint({
      projectName,
      projectSpec,
      expectedMrr,
    });
  }

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: '12px',
        padding: '20px',
      }}
    >
      <h2 style={{ margin: '0 0 4px', fontSize: '18px' }}>Simulate sprint</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: '13px' }}>
        Sends <code style={{ color: 'var(--accent)' }}>POST /api/simulate</code> with your roster’s{' '}
        <strong>team_stats_sum = {teamStatsSum}</strong> (sum of Velocity + Quality + Focus + Communication +
        Knowledge, 1–5 each per engineer).
      </p>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <label style={lbl}>
          Project name
          <input
            style={inp}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            required
            minLength={1}
          />
        </label>
        <label style={lbl}>
          Project spec
          <textarea style={{ ...inp, minHeight: '88px', resize: 'vertical' }} value={projectSpec} onChange={(e) => setProjectSpec(e.target.value)} />
        </label>
        <label style={lbl}>
          Expected MRR (USD / month if audits averaged 10/10)
          <input
            style={inp}
            type="number"
            min={0}
            step={100}
            value={expectedMrr}
            onChange={(e) => setExpectedMrr(Number(e.target.value))}
          />
        </label>
        {error ? (
          <div role="alert" style={{ color: 'var(--bad)', fontSize: '13px' }}>
            {error}
          </div>
        ) : null}
        <button type="submit" disabled={loading} style={btn}>
          {loading ? 'Running settlement…' : 'Simulate sprint'}
        </button>
      </form>
    </section>
  );
}

const lbl: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  fontSize: '12px',
  color: 'var(--muted)',
};

const inp: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: '8px',
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--ink)',
  fontFamily: 'inherit',
  fontSize: '14px',
};

const btn: CSSProperties = {
  marginTop: '4px',
  padding: '12px 16px',
  borderRadius: '8px',
  border: 'none',
  cursor: 'pointer',
  fontWeight: 700,
  fontSize: '15px',
  background: 'linear-gradient(180deg, var(--accent), #3aa0c4)',
  color: '#021018',
};
