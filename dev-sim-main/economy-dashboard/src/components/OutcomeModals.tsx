import type { CSSProperties } from 'react';
import { useGame } from '@/context/GameContext';

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(2, 8, 16, 0.75)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '24px',
};

const modal: CSSProperties = {
  maxWidth: '420px',
  width: '100%',
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: '14px',
  padding: '28px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
};

export function OutcomeModals() {
  const { victoryOpen, gameOverOpen, closeVictory, closeGameOver, companyValuation } = useGame();

  if (victoryOpen) {
    return (
      <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="vic-title">
        <div style={modal}>
          <h2 id="vic-title" style={{ margin: '0 0 12px', color: 'var(--good)' }}>
            Series A
          </h2>
          <p style={{ margin: '0 0 8px', lineHeight: 1.5 }}>
            Paper valuation crossed <strong>$2M</strong> on the server ledger. Current valuation:{' '}
            <strong>${Math.round(companyValuation).toLocaleString()}</strong>.
          </p>
          <button type="button" style={primaryBtn} onClick={closeVictory}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (gameOverOpen) {
    return (
      <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="go-title">
        <div style={modal}>
          <h2 id="go-title" style={{ margin: '0 0 12px', color: 'var(--bad)' }}>
            Bankrupt
          </h2>
          <p style={{ margin: '0 0 8px', lineHeight: 1.5 }}>
            Cash on hand hit zero (or below) after settlement. Tweak roster burn or expected MRR and try another
            sprint.
          </p>
          <button type="button" style={primaryBtn} onClick={closeGameOver}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return null;
}

const primaryBtn: CSSProperties = {
  marginTop: '16px',
  padding: '10px 18px',
  borderRadius: '8px',
  border: 'none',
  fontWeight: 700,
  cursor: 'pointer',
  background: 'var(--accent)',
  color: '#021018',
};
