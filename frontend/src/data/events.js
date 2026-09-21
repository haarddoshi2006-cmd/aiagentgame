// Random events deck — drawable cards that mutate state.
export const EVENT_DECK = [
  {
    id: 'evt-hn',
    icon: 'fire',
    title: 'Viral on HN',
    desc: 'Your last release hit #1. MRR +$2k. Tech debt +10.',
    apply: (s) => { s.economy.mrr += 2000; s.economy.techDebt += 10; s.economy.reputation += 5; },
  },
  {
    id: 'evt-outage',
    icon: 'bolt',
    title: 'GitHub Outage',
    desc: 'Lost half a day. Morale -10 for everyone.',
    apply: (s) => { s.team.forEach(a => { a.morale = Math.max(-100, a.morale - 10); }); },
  },
  {
    id: 'evt-poach',
    icon: 'mail',
    title: 'Recruiter Email',
    desc: 'A senior agent gets a counter-offer. Loyalty drops.',
    apply: (s) => { const a = pickActive(s); if (a) { a.loyalty = Math.max(0, a.loyalty - 25); } },
  },
  {
    id: 'evt-grant',
    icon: 'gift',
    title: 'Innovation Grant',
    desc: 'Surprise +$8k. No strings attached.',
    apply: (s) => { s.economy.cash += 8000; },
  },
  {
    id: 'evt-conf',
    icon: 'star',
    title: 'Conference Buzz',
    desc: 'A teammate presents. +Reputation, -1 day of work.',
    apply: (s) => { s.economy.reputation += 8; },
  },
  {
    id: 'evt-bug',
    icon: 'bug',
    title: 'Production Bug',
    desc: 'Customer hit a P0. Reputation -5, cash -$2k.',
    apply: (s) => { s.economy.cash -= 2000; s.economy.reputation -= 5; s.economy.techDebt += 5; },
  },
  {
    id: 'evt-press',
    icon: 'mic',
    title: 'Press Mention',
    desc: 'A blog covers your team. +Reputation.',
    apply: (s) => { s.economy.reputation += 6; },
  },
  {
    id: 'evt-snack',
    icon: 'donut',
    title: 'Snack Bar Refilled',
    desc: 'Morale +5 across the board.',
    apply: (s) => { s.team.forEach(a => { a.morale = Math.min(100, a.morale + 5); }); },
  },
];

function pickActive(s) {
  const live = s.team.filter(a => !a.fired);
  return live[Math.floor(Math.random() * live.length)];
}

// Spend levers — purchasable upgrades / actions.
export const LEVERS = [
  { id: 'lvr-coffee', icon: 'mug', name: 'Coffee Machine', cost: 1200,
    apply: (s) => { s.team.forEach(a => { a.energy = Math.min(100, a.energy + 15); }); },
    blurb: 'Energy +15 to all.' },
  { id: 'lvr-desk', icon: 'desk', name: 'Standing Desks', cost: 3200,
    apply: (s) => { s.team.forEach(a => { a.focus = Math.min(100, a.focus + 10); }); },
    blurb: 'Focus +10, permanent.' },
  { id: 'lvr-ai', icon: 'spark', name: 'Premium AI Tools', cost: 4500,
    apply: (s) => { s.team.forEach(a => { Object.keys(a.skills).forEach(k => a.skills[k] = Math.min(100, a.skills[k] + 3)); }); },
    blurb: 'All skills +3.' },
  { id: 'lvr-retreat', icon: 'palm', name: 'Off-site Retreat', cost: 9000,
    apply: (s) => { s.team.forEach(a => { a.morale = Math.min(100, a.morale + 25); a.loyalty = Math.min(100, a.loyalty + 15); }); },
    blurb: 'Morale +25, Loyalty +15.' },
  { id: 'lvr-train', icon: 'book', name: 'Training Budget', cost: 3800,
    apply: (s) => { const a = pickActive(s); if (a) { Object.keys(a.skills).forEach(k => a.skills[k] = Math.min(100, a.skills[k] + 8)); } },
    blurb: 'Random teammate +8 all skills.' },
  { id: 'lvr-allhands', icon: 'mic', name: 'All-Hands Speech', cost: 0,
    apply: (s) => { const dm = (Math.random() - 0.4) * 30; s.team.forEach(a => { a.morale = Math.max(-100, Math.min(100, a.morale + dm)); }); s._lastSpeechDelta = dm; },
    blurb: 'Risky morale swing.' },
  { id: 'lvr-audit', icon: 'shield', name: 'Security Audit', cost: 5800,
    apply: (s) => { s.economy.techDebt = Math.max(0, s.economy.techDebt - 25); s.economy.reputation += 4; },
    blurb: 'Tech debt -25, Rep +4.' },
  { id: 'lvr-marketing', icon: 'star', name: 'Marketing Push', cost: 2600,
    apply: (s) => { s.economy.reputation += 10; s.economy.mrr += 1500; },
    blurb: 'Rep +10, MRR +$1.5k.' },
];

// Achievements unlocked on conditions — checked each tick.
export const ACHIEVEMENTS = [
  { id: 'first-blood', name: 'First Commit', test: (s) => s.stats.commits >= 1 },
  { id: 'centurion', name: '100 Commits', test: (s) => s.stats.commits >= 100 },
  { id: 'shipped-friday', name: 'Shipped on Friday', test: (s) => s.stats.fridayShips >= 1 },
  { id: 'survivor', name: 'Survived a Layoff', test: (s) => s.stats.firings >= 1 },
  { id: 'unicorn', name: 'Hired a Unicorn', test: (s) => s.stats.wildcardHires >= 1 },
  { id: 'profitable', name: 'Profitable Sprint', test: (s) => s.stats.profitableSprints >= 1 },
  { id: 'zerobug', name: 'Zero-Bug Sprint', test: (s) => s.stats.zeroBugSprints >= 1 },
  { id: 'series-a', name: 'Raised Series A', test: (s) => s.economy.cash >= 250000 },
  { id: 'mentor-king', name: 'The Mentor', test: (s) => s.stats.coachUses >= 5 },
  { id: 'tyrant', name: 'Tyrant', test: (s) => s.stats.firings >= 3 },
];
