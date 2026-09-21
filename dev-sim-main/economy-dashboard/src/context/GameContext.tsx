import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { simulateSprint as simulateSprintApi } from '@/services/api';

/** Matches backend ``STAT_KEYS`` for burn / ``team_stats_sum``. */
export type AgentStats = {
  velocity: number;
  quality: number;
  focus: number;
  communication: number;
  knowledge: number;
};

export type RosterAgent = {
  id: string;
  name: string;
  stats: AgentStats;
};

function clampStat(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}

function sumTeamStatsSum(roster: RosterAgent[]): number {
  let total = 0;
  for (const a of roster) {
    const s = a.stats;
    total += s.velocity + s.quality + s.focus + s.communication + s.knowledge;
  }
  return Math.max(1, total);
}

const defaultRoster: RosterAgent[] = [
  {
    id: 'a1',
    name: 'Alex Rivera',
    stats: { velocity: 4, quality: 4, focus: 3, communication: 4, knowledge: 3 },
  },
  {
    id: 'a2',
    name: 'Jordan Kim',
    stats: { velocity: 3, quality: 5, focus: 4, communication: 3, knowledge: 4 },
  },
  {
    id: 'a3',
    name: 'Sam Okonkwo',
    stats: { velocity: 5, quality: 3, focus: 4, communication: 4, knowledge: 3 },
  },
];

let idSeq = 100;

type GameContextValue = {
  bankBalance: number;
  companyValuation: number;
  techDebt: number;
  activeMrr: number;
  burnRate: number;
  sprintMonth: number;
  roster: RosterAgent[];
  teamStatsSum: number;
  lastTechnicalScores: Record<string, number> | null;
  lastSettlementStatus: string | null;
  loading: boolean;
  error: string | null;
  victoryOpen: boolean;
  gameOverOpen: boolean;
  closeVictory: () => void;
  closeGameOver: () => void;
  hireAgent: (name: string, stats: Partial<AgentStats>) => void;
  fireAgent: (id: string) => void;
  updateAgentStat: (id: string, key: keyof AgentStats, value: number) => void;
  runSimulateSprint: (args: {
    projectName: string;
    projectSpec: string;
    expectedMrr: number;
  }) => Promise<void>;
};

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [bankBalance, setBankBalance] = useState(100_000);
  const [companyValuation, setCompanyValuation] = useState(0);
  const [techDebt, setTechDebt] = useState(0);
  const [activeMrr, setActiveMrr] = useState(0);
  const [burnRate, setBurnRate] = useState(0);
  const [sprintMonth, setSprintMonth] = useState(1);
  const [roster, setRoster] = useState<RosterAgent[]>(() => [...defaultRoster]);
  const [lastTechnicalScores, setLastTechnicalScores] = useState<Record<string, number> | null>(
    null,
  );
  const [lastSettlementStatus, setLastSettlementStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [victoryOpen, setVictoryOpen] = useState(false);
  const [gameOverOpen, setGameOverOpen] = useState(false);

  const teamStatsSum = useMemo(() => sumTeamStatsSum(roster), [roster]);

  const hireAgent = useCallback((name: string, stats: Partial<AgentStats>) => {
    const base: AgentStats = {
      velocity: 3,
      quality: 3,
      focus: 3,
      communication: 3,
      knowledge: 3,
    };
    const merged: AgentStats = { ...base, ...stats };
    for (const k of Object.keys(merged) as (keyof AgentStats)[]) {
      merged[k] = clampStat(merged[k]);
    }
    idSeq += 1;
    setRoster((r) => [...r, { id: `hire-${idSeq}`, name: name.trim() || `Engineer ${idSeq}`, stats: merged }]);
  }, []);

  const fireAgent = useCallback((id: string) => {
    setRoster((r) => {
      if (r.length <= 1) return r;
      return r.filter((a) => a.id !== id);
    });
  }, []);

  const updateAgentStat = useCallback((id: string, key: keyof AgentStats, value: number) => {
    setRoster((r) =>
      r.map((a) =>
        a.id === id
          ? { ...a, stats: { ...a.stats, [key]: clampStat(value) } }
          : a,
      ),
    );
  }, []);

  const runSimulateSprint = useCallback(
    async ({
      projectName,
      projectSpec,
      expectedMrr,
    }: {
      projectName: string;
      projectSpec: string;
      expectedMrr: number;
    }) => {
      setError(null);
      setLoading(true);
      try {
        const sum = sumTeamStatsSum(roster);
        const res = await simulateSprintApi({
          project_name: projectName.trim() || 'Sprint',
          project_spec: projectSpec.trim() || '(no spec)',
          expected_mrr: Math.max(0, expectedMrr),
          team_stats_sum: sum,
        });

        setBankBalance(res.balance);
        setCompanyValuation(res.valuation);
        setTechDebt(res.tech_debt);
        setActiveMrr(res.active_mrr);
        setBurnRate(res.burn_rate);
        setSprintMonth(res.sprint_month);
        setLastTechnicalScores(res.technical_scores);
        setLastSettlementStatus(res.status);

        if (res.status === 'SERIES_A') setVictoryOpen(true);
        if (res.status === 'BANKRUPT') setGameOverOpen(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [roster],
  );

  const value: GameContextValue = {
    bankBalance,
    companyValuation,
    techDebt,
    activeMrr,
    burnRate,
    sprintMonth,
    roster,
    teamStatsSum,
    lastTechnicalScores,
    lastSettlementStatus,
    loading,
    error,
    victoryOpen,
    gameOverOpen,
    closeVictory: () => setVictoryOpen(false),
    closeGameOver: () => setGameOverOpen(false),
    hireAgent,
    fireAgent,
    updateAgentStat,
    runSimulateSprint,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}
