// In-character lines used for stand-ups, PR comments, retros, and quips.
// Templated by communicationStyle and trait so personalities feel distinct.

const STANDUP_TEMPLATES = {
  diplomatic: [
    'Yesterday I wrapped {ticket}. Today I will pair with {peer} on the parser. No blockers.',
    'Solid progress on {ticket}. Want to flag we may slip {risk} unless we trim scope.',
    'Quick callout: {ticket} is in review. Would love eyes from {peer} when free.',
  ],
  blunt: [
    'Did {ticket}. Doing {next}. {peer} please review or I push it anyway.',
    '{ticket} done. {risk} is broken because no one read the spec.',
    'Status: green. Ask me later.',
  ],
  terse: [
    '{ticket}: done. Next: {next}.',
    'On {ticket}. Need {peer}.',
    'Shipping {ticket}. EOD.',
  ],
  verbose: [
    'OK so yesterday I dug into {ticket} and it turns out the operator precedence is more nuanced than the spec suggests, so today I am writing a small ADR plus the actual fix, and I would love {peer} to sanity-check before I push.',
    'I have a thought about {risk} that I think is worth a quick async — basically if we keep going down this path we are going to regret it in two sprints.',
    'Going to do {next} today. Also wrote up retro notes for last sprint, link in the channel.',
  ],
};

const PR_COMMENT_TEMPLATES = {
  perfectionist: [
    'Nit: trailing space line 42. Also, can we extract this into a hook? It is doing too much.',
    'This works but I would not ship it. The error path is silent and the test misses the boundary case.',
    'Looks good. Two small nits, one structural concern. Will approve once addressed.',
  ],
  shipper: [
    'LGTM. Let us iterate after merge.',
    'Approved. We can refactor in the next sprint if needed.',
    'Ship it. Bug? Bug fix PR.',
  ],
  pedant: [
    'The naming here is inconsistent with the convention we agreed on three sprints ago.',
    'We have an ADR for this. Please see /docs/adr/0007.',
    'Why are we re-implementing what stdlib already provides?',
  ],
  blunt: [
    'No.',
    'This will not scale.',
    'Rewrite. Half of this is unnecessary.',
  ],
  diplomatic: [
    'Really nice work — small suggestion below, but love the direction.',
    'I want to gently push back on the abstraction here, but happy to chat on a call.',
    'Approving once you address Marcus\'s comment. Great progress.',
  ],
  mentor: [
    'Nice solution. One thing to consider for next time: what happens if input is empty?',
    'You are getting closer. Look at how {peer} solved the same thing in CAL-3.',
    'Great PR description. Code is solid. Approved.',
  ],
  chaotic_good: [
    'I have rewritten half of this on my fork. Want me to push?',
    'This works. I have no idea why. Approved.',
    'LGTM. PS your branch name is amazing.',
  ],
};

const RETRO_TEMPLATES = {
  diplomatic: [
    'I think we communicated well this sprint, but estimation is still our weak spot.',
    'Want to celebrate {peer} for unblocking us on day three.',
  ],
  blunt: [
    'We over-committed. Again. Cut scope earlier.',
    '{peer} carried this sprint. Pay them more.',
  ],
  terse: [
    'Good sprint. Less meetings.',
    'Tickets too vague.',
  ],
  verbose: [
    'OK so my reflection is that we had a great execution week one but we lost momentum mid-sprint when the parser refactor came in unannounced and I think next time we should...',
  ],
};

const QUIPS = [
  'Why is the build red again?',
  'Coffee. Now.',
  'PR up.',
  'Did anyone else see that Slack thread?',
  'Standing desk to seated. Big day.',
  'I am going to pair on this one.',
  'Refactoring. Do not look at the diff.',
  'Lunch?',
  'Friday deploy. What could go wrong.',
  'I love this team.',
  'Anyone seen the Figma link?',
  'I am taking PTO next week. Please survive.',
];

function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

function fill(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (_, k) => ctx[k] || k);
}

export function makeStandup(persona, ctx) {
  const tpl = STANDUP_TEMPLATES[persona.communicationStyle] || STANDUP_TEMPLATES.terse;
  return fill(pick(tpl), ctx);
}

export function makePRComment(persona, ctx) {
  // pick by dominant trait when possible
  const candidate = persona.traits.find(t => PR_COMMENT_TEMPLATES[t]) || persona.communicationStyle;
  const tpl = PR_COMMENT_TEMPLATES[candidate] || PR_COMMENT_TEMPLATES.diplomatic;
  return fill(pick(tpl), ctx);
}

export function makeRetro(persona, ctx) {
  const tpl = RETRO_TEMPLATES[persona.communicationStyle] || RETRO_TEMPLATES.terse;
  return fill(pick(tpl), ctx);
}

export function makeQuip() {
  return pick(QUIPS);
}

export function makeCommitMsg(ticket) {
  const verbs = ['feat', 'fix', 'refactor', 'chore', 'perf', 'test', 'docs'];
  const v = pick(verbs);
  return `${v}(${ticket.id}): ${ticket.title.toLowerCase()}`;
}

export function whyDifferent(fired, candidate) {
  const diffs = [];
  if (fired.communicationStyle !== candidate.communicationStyle) {
    diffs.push(`As ${candidate.communicationStyle} as they were ${fired.communicationStyle}.`);
  }
  if (fired.workStyle !== candidate.workStyle) {
    diffs.push(`Prefers ${candidate.workStyle.replace(/_/g, ' ')} over ${fired.workStyle.replace(/_/g, ' ')}.`);
  }
  const newTraits = candidate.traits.filter(t => !fired.traits.includes(t));
  if (newTraits.length) {
    diffs.push(`Brings: ${newTraits.join(', ')}.`);
  }
  return diffs.join(' ') || 'Quietly competent. A change of pace.';
}
