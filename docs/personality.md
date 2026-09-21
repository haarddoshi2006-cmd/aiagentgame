# Personality, traits, and behavior

This document explains how agent personas relate to intended behavior: voice, rituals, and hooks for a performance / scoring engine (e.g. Team Member 4). Personas are no longer fixed seed files; they are sampled from shared trait pools.

## What lives in the repo

| Piece | Purpose |
| --- | --- |
| `schemas/agent.schema.v2.json` | Canonical JSON Schema v2 (token stacks, `git_identity`, controlled vocabulary). |
| `schemas/agent.schema.json` | Thin `$ref` to v2 for stable path. |
| `personas/trait_pools.json` | Pools aligned with v2 enums and per-role stack tokens. |
| `personas/generate_persona.py` | CLI to emit random valid-shaped persona objects (JSON). |
| `personas/manifest.json` | Pointers to pools, generator, and schema. |

## Role voice (`role`)

v2 drops per-persona `voice_notes`; role-level prompt templates carry register guardrails. The `role` field selects those baselines plus few-shot examples in generated prompts.

## Personality traits → behavior

Traits are controlled vocabulary in v2 (`personality_traits`, `work_style`, `communication_style`, `strengths`, `weaknesses`) — see `trait_pools.json` and `agent.schema.v2.json`.

### Example mappings

| Trait / style | Typical behavioral bias |
| --- | --- |
| `perfectionist` | Slower reviews, more nits, higher defect catch (when encoded in `performance_hints`). |
| `shipper` | Faster iteration, more risk of missed edge cases unless balanced elsewhere. |
| `pedant` | Pushes naming, types, and consistency; can increase review latency. |
| `mentor` | More explanations in threads; boosts teaching outcomes in scoring. |
| `chaotic_good` | Breaks process gently for outcomes; unpredictable meeting airtime. |
| `rockstar` | Strong opinions; may dominate turns unless `meeting_airtime` is low. |
| `tdd_first` | Asks for tests first in design discussion or before handoff to tech lead. |
| `meeting_heavy` | Roles that run many rituals: more structured participation in stand-ups and retros. |
| `heads_down` | Fewer long messages; prefers async, shorter ritual turns. |

Exact numbers belong in `performance_hints` (optional on each persona) so a scoring layer can use one coherent formula without hard-coding trait names everywhere.

## Collaboration with Team Member 4 (performance model)

- Traits are human-readable labels; numeric behavior should use `performance_hints` when possible.
- Suggested field meanings: `review_latency_multiplier`, `bug_catch_rate`, `meeting_airtime`, `mentorship_boost`.

## Generating a team

```bash
cd personas
python3 generate_persona.py --count 3
python3 generate_persona.py --count 8 --format json --out team.json
```

Default stdout is an LLM system-style prompt. Use `--format json` for structured `AgentPersona` objects.

## Files to read next

- `schemas/agent.schema.v2.json`
- `personas/trait_pools.json`
- `personas/manifest.json`
