// Map dev-sim ``personas_bridge`` / ``generate_persona`` v2 dicts into the HUD / engine agent shape.

const HAIRS = ['short', 'long', 'curly', 'bun', 'bald', 'cap', 'hood', 'mohawk', 'braids', 'ponytail', 'beanie'];
const ACCS = ['none', 'glasses', 'shades', 'headset', 'monocle'];
const TINTS = ['#ff8fc8', '#9ef0a6', '#6ad7ff', '#c79bff', '#5ee0a0', '#ffd166', '#ff6b81', '#ffce5b'];

const SENIORITY_SALARY = {
  junior: 6500,
  mid: 10500,
  senior: 14500,
  staff: 18500,
};

function hashStr(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function portraitFromId(seed) {
  const h = hashStr(seed);
  return {
    hair: HAIRS[h % HAIRS.length],
    skin: (h >> 4) % 5,
    acc: ACCS[(h >> 8) % ACCS.length],
  };
}

export function tintFromId(seed) {
  return TINTS[hashStr(seed) % TINTS.length];
}

function defaultSkills(role) {
  const base = { frontend: 40, backend: 40, devops: 35, design: 35, comms: 50, leadership: 45 };
  if (role === 'frontend') {
    return { ...base, frontend: 78, backend: 28, design: 72 };
  }
  if (role === 'backend') {
    return { ...base, backend: 82, devops: 62, frontend: 28 };
  }
  if (role === 'tech_lead') {
    return { ...base, leadership: 82, frontend: 55, backend: 62, comms: 72 };
  }
  return base;
}

function buildBio(p) {
  const strengths = (p.strengths || []).join(', ');
  const w = (p.weaknesses || []).join(', ');
  const q = p.quirks ? ` ${p.quirks}` : '';
  const head = strengths ? `Strengths: ${strengths}.` : '';
  const mid = w ? ` Watch-outs: ${w}.` : '';
  return (head + mid + q).trim() || 'Teammate from dev-sim persona pools.';
}

/**
 * @param {object} persona - snake_case dict from ``GET /api/agents``
 * @param {'coding'|'coding_b'|'review'} agentKind
 */
const BENCH_FIRST = ['Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Avery', 'Skyler', 'Reese'];
const BENCH_LAST = ['Nguyen', 'Patel', 'Garcia', 'Okafor', 'Silva', 'Kim', 'Bak', 'Liu'];
const BENCH_ROLES = ['frontend', 'backend', 'tech_lead', 'frontend', 'backend', 'tech_lead', 'frontend', 'backend'];

/**
 * Synthetic roster candidates when no HR pool file exists (API-only team).
 * @returns {object[]}
 */
export function buildSyntheticCandidatePool() {
  const stamp = Date.now();
  return BENCH_ROLES.map((role, i) => {
    const id = `bench-${stamp}-${i}`;
    const displayName = `${BENCH_FIRST[i % BENCH_FIRST.length]} ${BENCH_LAST[i % BENCH_LAST.length]}`;
    const seniority = i % 3 === 0 ? 'junior' : i % 3 === 1 ? 'mid' : 'senior';
    const salary = SENIORITY_SALARY[seniority] ?? 12000;
    const idKey = `${id}-${role}`;
    const traitSets = [
      ['curious', 'pragmatic'],
      ['meticulous', 'quiet'],
      ['chaotic_good', 'fast'],
      ['skeptical', 'mentor'],
      ['optimist', 'detail_oriented'],
      ['pragmatic', 'shipping_first'],
      ['deep_diver', 'patient'],
      ['direct', 'systems_thinker'],
    ];
    return {
      id,
      displayName,
      role,
      seniority,
      yearsExperience: 2 + (hashStr(id) % 10),
      salary,
      preferredStack: role === 'frontend' ? ['React', 'TypeScript'] : role === 'backend' ? ['Rust', 'Go'] : ['Systems', 'APIs'],
      dislikedStack: [],
      traits: traitSets[i % traitSets.length],
      workStyle: i % 2 === 0 ? 'heads_down' : 'pairing_heavy',
      communicationStyle: i % 3 === 0 ? 'direct' : i % 3 === 1 ? 'diplomatic' : 'async_first',
      quirks: '',
      strengths: ['Ships on time', 'Clear writing'],
      weaknesses: ['Needs context on legacy code'],
      bio: 'Bench candidate surfaced for replacement hire.',
      portrait: portraitFromId(idKey),
      tint: tintFromId(idKey),
      skills: defaultSkills(role),
      gitIdentity: null,
    };
  });
}

export function agentFromBackendPersona(persona, agentKind) {
  const role = persona.role;
  const seniority = persona.seniority || 'mid';
  const salary = SENIORITY_SALARY[seniority] ?? 12000;
  const idKey = `${persona.id || 'agent'}-${agentKind}`;

  return {
    id: persona.id,
    agentKind,
    displayName: persona.display_name || 'Agent',
    role,
    seniority,
    yearsExperience: persona.years_experience ?? 3,
    salary,
    preferredStack: persona.preferred_stack || [],
    dislikedStack: persona.disliked_stack || [],
    traits: persona.personality_traits || [],
    workStyle: persona.work_style || 'heads_down',
    communicationStyle: persona.communication_style || 'diplomatic',
    quirks: persona.quirks || '',
    strengths: persona.strengths || [],
    weaknesses: persona.weaknesses || [],
    bio: buildBio(persona),
    portrait: portraitFromId(idKey),
    tint: tintFromId(idKey),
    skills: defaultSkills(role),
    gitIdentity: persona.git_identity || null,
  };
}
