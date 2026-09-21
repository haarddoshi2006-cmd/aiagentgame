Prompt templates for AgentPersona

Templates live in prompts/personas/ (one file per seed in personas/*.json) and prompts/roles/ (shared patterns by role).

How to use

1. Load the matching JSON from personas/<id>.json (see personas/manifest.json).
2. Open prompts/personas/<id>.md and substitute runtime placeholders (see below).
3. Optionally prepend the matching prompts/roles/<role>.md block if you want a longer, role-generic baseline before persona specifics.
4. For git subjects and PR titles, use prompts/commits.md and set {{COMMIT_TONE}} to standard or sass (spicy / rival-banter commits — see that file for boundaries).
5. For shared GitHub and registry behavior, see prompts/roles/standard.md.

Workflow phases (matches devteam.svg)

- Phase 1 — Initiation: Orchestrator (Scrum Master). CEO app idea to backlog draft.
- Phase 2 — Sprint Planning: All agents. Review backlog, commit to {{SPRINT_GOAL}}.
- Phase 3 — Execution: FE, BE, TL, SA, SM. Code, review PRs, stand-ups on feature branches.
- Phase 4 — Scoring: Engine (automatic). Per-agent score across metrics below.
- Phase 5 — CEO Decision: CEO (player). Keep/fire per agent; optional corporate initiative.
- Loop: Orchestrator. Updated roster and initiative re-enters Phase 1.

Scoring metrics (engine, read-only for agents)

Agents know they are evaluated but do not control the engine. Metrics: commits and PR size, review comments, build pass rate, time-to-merge, in-character quality, team-fit signals.

Scoring weights shift when the CEO sets a corporate initiative (e.g. Ship Faster raises velocity weight).

Runtime placeholders (inject from orchestrator)

- {{SPRINT_GOAL}}: current sprint objective.
- {{SPRINT_NUMBER}}: sprint index (1, 2, 3 …).
- {{TASK}}: assigned task description for this turn.
- {{SCRATCHPAD}}: shared team context (stand-up / review thread).
- {{PRIVATE_MEMORY}}: this agent's private notes only.
- {{ROSTER}}: current team members (name, role); updates after fires/hires.
- {{COMMIT_TONE}}: standard (default) or sass; see prompts/commits.md.
- {{INITIATIVE}}: optional CEO corporate directive for this sprint (e.g. Add API /v1/).
- {{DEPARTED_PEER}}: optional id/name when someone left the team.
- {{NEW_HIRE}}: optional id/name and role when a replacement joins (grace period applies).

Persona files repeat fixed fields from JSON so prompts stay token-efficient; refresh from JSON if seeds change.

Files

- prompts/commits.md: commit and PR title tone (standard vs sass).
- prompts/roles/standard.md: repo registry and GitHub workflow baseline.
- prompts/roles/{frontend,backend,scrum_master,tech_lead,solutions_architect}.md: five role shells.
- prompts/personas/<id>.md: fifteen personas (matches personas/manifest.json).

Seed persona templates (prompts/personas/)

maya-chen, jordan-ortiz, sam-okonkwo, elliott-vance, priya-nair, chen-wei-backend, riley-kim, taylor-brooks, morgan-reyes, alex-hsu, jamie-flores, casey-ng, nova-patel, lin-vasquez, wei-zhang-sa.
