// Role labels for sprint tickets and agents whose ``role`` comes from generated personas
// (frontend | backend | tech_lead). Roster is loaded from ``GET /api/agents``.

export const ROLES = ['frontend', 'backend', 'scrum_master', 'tech_lead', 'solutions_architect'];

export const ROLE_LABELS = {
  frontend: 'Frontend Dev',
  backend: 'Backend Dev',
  scrum_master: 'Scrum Master',
  tech_lead: 'Tech Lead',
  solutions_architect: 'Sol. Architect',
};

export const ROLE_SHORT = {
  frontend: 'FE',
  backend: 'BE',
  scrum_master: 'SM',
  tech_lead: 'TL',
  solutions_architect: 'SA',
};

/** Shown next to simulator role for the real dev-sim agents from ``GET /api/agents``. */
export const AGENT_KIND_LABELS = {
  coding: 'Coding (Claude)',
  coding_b: 'Coding (Claude) · pair',
  review: 'PR review (K2)',
};

// Tech tickets for the calculator product
export const SEED_BACKLOG = [
  { id: 'CAL-1', title: 'Project scaffold + CI', estimate: 3, role: 'tech_lead' },
  { id: 'CAL-2', title: 'Number pad UI', estimate: 2, role: 'frontend' },
  { id: 'CAL-3', title: 'Expression parser', estimate: 5, role: 'backend' },
  { id: 'CAL-4', title: 'Operator precedence', estimate: 3, role: 'backend' },
  { id: 'CAL-5', title: 'History panel', estimate: 2, role: 'frontend' },
  { id: 'CAL-6', title: 'Keyboard shortcuts', estimate: 2, role: 'frontend' },
  { id: 'CAL-7', title: 'Theme system', estimate: 3, role: 'frontend' },
  { id: 'CAL-8', title: 'Scientific mode', estimate: 5, role: 'backend' },
  { id: 'CAL-9', title: 'Cloud sync API', estimate: 5, role: 'solutions_architect' },
  { id: 'CAL-10', title: 'A11y pass', estimate: 2, role: 'frontend' },
  { id: 'CAL-11', title: 'Standup automation bot', estimate: 3, role: 'scrum_master' },
  { id: 'CAL-12', title: 'Architecture ADR', estimate: 2, role: 'solutions_architect' },
];
