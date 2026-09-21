import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { AgentStats, RosterAgent } from '@/context/GameContext';
import { useGame } from '@/context/GameContext';

export function RosterPanel() {
  const { roster, teamStatsSum, hireAgent, fireAgent, updateAgentStat } = useGame();
  const [hireName, setHireName] = useState('New hire');

  return (
    <section style={section}>
      <h2 style={{ margin: '0 0 4px', fontSize: '18px' }}>Team roster</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: '13px' }}>
        Each stat is 1–5. <strong>team_stats_sum</strong> for the API = sum of all five stats across all engineers (
        {teamStatsSum}).
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
        <input style={inp} value={hireName} onChange={(e) => setHireName(e.target.value)} placeholder="Name" />
        <button
          type="button"
          style={btnGhost}
          onClick={() => {
            hireAgent(hireName, {});
            setHireName('New hire');
          }}
        >
          Hire (default 3s)
        </button>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {roster.map((a) => (
          <RosterRow key={a.id} agent={a} onFire={() => fireAgent(a.id)} onChangeStat={updateAgentStat} />
        ))}
      </ul>
    </section>
  );
}

function RosterRow({
  agent,
  onFire,
  onChangeStat,
}: {
  agent: RosterAgent;
  onFire: () => void;
  onChangeStat: (id: string, key: keyof AgentStats, v: number) => void;
}) {
  const keys: (keyof AgentStats)[] = ['velocity', 'quality', 'focus', 'communication', 'knowledge'];
  return (
    <li style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <strong>{agent.name}</strong>
        <button type="button" style={btnDanger} onClick={onFire}>
          Fire
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px' }}>
        {keys.map((k) => (
          <label key={k} style={statLbl}>
            {k.slice(0, 3)}
            <input
              type="number"
              min={1}
              max={5}
              style={statInp}
              value={agent.stats[k]}
              onChange={(e) => onChangeStat(agent.id, k, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
    </li>
  );
}

const section: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '12px',
  padding: '20px',
};

const inp: CSSProperties = {
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--ink)',
};

const btnGhost: CSSProperties = {
  ...inp,
  cursor: 'pointer',
  fontWeight: 600,
};

const btnDanger: CSSProperties = {
  padding: '6px 10px',
  borderRadius: '6px',
  border: '1px solid var(--bad)',
  background: 'transparent',
  color: 'var(--bad)',
  cursor: 'pointer',
  fontSize: '12px',
};

const card: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: '8px',
  padding: '12px',
  background: 'var(--bg)',
};

const statLbl: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontSize: '10px',
  color: 'var(--muted)',
  gap: '4px',
};

const statInp: CSSProperties = {
  width: '100%',
  padding: '6px',
  borderRadius: '6px',
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  color: 'var(--ink)',
};
