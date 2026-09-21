// Mirrors shared/review_schema.TECHNICAL_SCORE_KEYS (K2 rubric).
export const TYCOON_TECH_KEYS = [
  'CodeReadability',
  'LogicComplexity',
  'ErrorHandling',
  'BuildStability',
  'SecurityBestPractices',
  'Scalability',
  'TaskAlignment',
  'Documentation',
  'PerformanceEfficiency',
  'CollaborationQuality',
];

/** @param {Record<string, unknown> | null | undefined} scores */
export function averageTechnicalScores(scores) {
  if (!scores || typeof scores !== 'object') return 0;
  let sum = 0;
  let n = 0;
  for (const k of TYCOON_TECH_KEYS) {
    const v = Number(scores[k]);
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : 0;
}
