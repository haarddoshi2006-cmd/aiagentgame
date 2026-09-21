import type { CSSProperties } from 'react';
import { OutcomeModals } from '@/components/OutcomeModals';
import { RosterPanel } from '@/components/RosterPanel';
import { SimulateSprintPanel } from '@/components/SimulateSprintPanel';
import { TechnicalAudit } from '@/components/TechnicalAudit';
import { GameProvider, useGame } from '@/context/GameContext';

function Shell() {
  const {
    bankBalance,
    companyValuation,
    techDebt,
    activeMrr,
    burnRate,
    sprintMonth,
    lastTechnicalScores,
    lastSettlementStatus,
  } = useGame();

  return (
    <div style={page}>
      <header style={header}>
        <div>
          <h1 style={{ margin: 0, fontSize: '22px' }}>Economy dashboard</h1>
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '13px' }}>
            React + TypeScript · FastAPI on port <code>8000</code> · <code>python run_api.py</code>
          </p>
        </div>
        <div style={metrics}>
          <Metric label="Bank" value={`$${Math.round(bankBalance).toLocaleString()}`} />
          <Metric label="Valuation" value={`$${Math.round(companyValuation).toLocaleString()}`} />
          <Metric label="Tech debt" value={`${techDebt.toFixed(1)}`} />
          <Metric label="Active MRR" value={`$${Math.round(activeMrr).toLocaleString()}/mo`} />
          <Metric label="Burn (last)" value={`$${Math.round(burnRate).toLocaleString()}`} />
          <Metric label="Sprint month" value={String(sprintMonth)} />
          {lastSettlementStatus ? <Metric label="Last status" value={lastSettlementStatus} /> : null}
        </div>
      </header>
      <main className="grid-main" style={main}>
        <div style={col}>
          <SimulateSprintPanel />
          <section style={{ ...panel, marginTop: '20px' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: '18px' }}>Audit rubric (last sprint)</h2>
            <TechnicalAudit scores={lastTechnicalScores} />
          </section>
        </div>
        <div style={col}>
          <RosterPanel />
        </div>
      </main>
      <OutcomeModals />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricCard}>
      <div style={metricLbl}>{label}</div>
      <div style={metricVal}>{value}</div>
    </div>
  );
}

const page: CSSProperties = {
  minHeight: '100vh',
  background: 'var(--bg)',
  color: 'var(--ink)',
  fontFamily: 'system-ui, Segoe UI, Roboto, sans-serif',
};

const header: CSSProperties = {
  padding: '20px 24px',
  borderBottom: '1px solid var(--line)',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '20px',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
};

const metrics: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
};

const metricCard: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  padding: '10px 14px',
  minWidth: '100px',
};

const metricLbl: CSSProperties = { fontSize: '10px', color: 'var(--muted)', letterSpacing: '0.06em' };
const metricVal: CSSProperties = { fontSize: '15px', fontWeight: 700, marginTop: '4px' };

const main: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '24px',
  padding: '24px',
  maxWidth: '1200px',
  margin: '0 auto',
};

const col: CSSProperties = { minWidth: 0 };

const panel: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '12px',
  padding: '20px',
};

export default function App() {
  return (
    <GameProvider>
      <Shell />
    </GameProvider>
  );
}
