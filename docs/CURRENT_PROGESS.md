# CURRENT_PROGESS

Note: filename uses PROGESS (typo). Some people search for CURRENT_PROGRESS; this is the same file.

## Purpose

This document is a handoff summary for another LLM/AI agent. It captures what was requested, what was implemented, where the project pivoted, and what is currently blocked.

Expanded narrative on tensions and lessons lives in:

- `docs/handoff/struggles-and-realizations.md`

---

## High-level goals from this conversation

1. Build/seed a persona framework for simulated AI teammates:
   - agent schema
   - persona seed library
   - prompt templates
2. Create demos:
   - multi-agent git commits demo
   - project-idea-to-feature-docs demo using external model APIs
3. Iterate quickly across model providers and make the script usable despite auth/quota/provider issues.

---

## Major work completed

## 1) Persona data + schema

- Created and maintained:
  - `schemas/agent.schema.json`
  - `personas/*.json` (15 seed personas, 3 per role across 5 roles)
  - `personas/manifest.json`
- Roles represented:
  - `frontend`, `backend`, `scrum_master`, `tech_lead`, `solutions_architect`
- Added and later removed comment/note experiments around `performance_hints` to keep JSON valid.

## 2) Prompt template system

- Created prompt library:
  - `prompts/README.md`
  - `prompts/roles/standard.md` (shared GitHub + repo registry + numbered PR workflow; Cursor-style baseline)
  - `prompts/roles/*.md` (per-role templates aligned with that baseline)
  - `prompts/personas/*.md` (persona-level voice and turn behavior)
  - `prompts/commits.md` (commit / PR title guidance, standard vs sass)
- Evolved through several interpretations of "standard" (sprint one-liner vs Git tooling doc); settled on tooling-shaped role prompts with a Simians carve-out: team repo already exists, no `create_github_repository` for that product repo unless user explicitly wants a new unrelated repo (see role files).
- Removed `CHANNEL=...` sections from role prompts and dropped `{{CHANNEL}}` from persona/README placeholder lists; orchestrator must use another way to select standup vs implement vs review if needed.
- Reformatted roles, personas, `prompts/README.md`, and `prompts/commits.md` into plain text (no `#` headers, no `**` emphasis, no tables) per latest style request—easier to inject wholesale into prompts.

## 3) Multi-agent git commit demo

- Added:
  - `examples/multi-agent-commits/demo.sh`
  - `examples/multi-agent-commits/README.md`
  - `examples/multi-agent-commits/.gitignore`
- Demo creates a throwaway repo and authors commits as different personas.

## 4) Feature-split demo (project idea -> SRS/features docs)

Working directory:
- `examples/gemini-feature-split-demo/`

Core script:
- `examples/gemini-feature-split-demo/demo.py`

Output targets:
- `examples/gemini-feature-split-demo/docs/srs/overview.md`
- `examples/gemini-feature-split-demo/docs/features/*.md`

Prompt source:
- `llm/task_splitter.md`

---

## Provider/API migration history (important context)

The feature-split demo was intentionally switched multiple times:

1. Started as Gemini CLI approach.
2. Switched to Gemini API (quota problems).
3. Switched to Claude API.
4. Switched to OpenAI API.
5. Switched to K2 Think API (latest).

Current script is configured for:
- K2 Think endpoint: `https://api.k2think.ai/v1/chat/completions`
- Default model: `MBZUAI-IFM/K2-Think-v2`
- API key env var: `K2THINK_API_KEY`

---

## Current state of the feature-split script

File:
- `examples/gemini-feature-split-demo/demo.py`

Current capabilities:
- Accepts project idea from CLI arg or interactive prompt.
- Loads `.env` automatically from:
  - `examples/gemini-feature-split-demo/.env`
  - repo root `.env` (`/home/mayira/dev-sim/.env`)
- Calls K2 Think chat completions API.
- Requests JSON-only planning output and writes:
  - SRS overview
  - per-sprint feature docs
- Includes human-friendly error formatting for:
  - 429 rate/quota
  - 401/403 auth/permission
- Supports custom user-agent:
  - `--user-agent` (default `curl/8.5.0`)

README updated:
- `examples/gemini-feature-split-demo/README.md`

---

## Struggles and realizations (short)

- Ambiguity of "standard" (workflow tagline vs Git/PR instruction block) caused prompt rework; see `docs/handoff/struggles-and-realizations.md`.
- Balancing full coding-assistant capabilities (create repo, registry) with sim lore (TM2 provisions repo) required explicit bullets in each role file, not one vague sentence.
- Provider and WAF failures were easy to misdiagnose as "bad key only"; raw error bodies and Cloudflare codes matter.
- CHANNEL removal improves prompt simplicity but breaks any tool that still branches on `{{CHANNEL}}`—verify integration before shipping.
- Duplicating the seven PR steps in every role file is verbose; it avoids silent failure when only one file is loaded.

Full discussion: `docs/handoff/struggles-and-realizations.md`.

---

## Blockers encountered

## A) Quota/billing failures on mainstream providers

- Gemini API: 429 resource exhausted / quota exceeded.
- OpenAI API: 401 invalid key (at the time tested with provided key).
- Claude/OpenAI phases were used mainly as pivots/workarounds while troubleshooting.

## B) K2 Think access blocked by Cloudflare

Observed error:
- HTTP 403
- Cloudflare Error 1010
- `browser_signature_banned`
- Message: site owner blocked based on browser signature; do not retry until access policy changes.

Mitigation attempted:
- changed User-Agent to curl-like signature
- exposed `--user-agent`

Result:
- still potentially blocked if IP/WAF rule is strict.

Likely root cause:
- provider-side WAF policy (not purely API-key issue).

---

## Security note

Sensitive API keys were visible in `.env` during this conversation. Treat as compromised and rotate keys if they are real.

---

## Git/commit context

- Commits were created earlier for schema/persona seeding.
- Additional edits were made afterward (prompts + demo scripts + provider changes).
- Current workspace likely has uncommitted changes beyond earlier seed commits.

---

## Recommended next actions for the next agent

1. Decide target provider for demo stability:
   - If K2 must remain: contact provider support for Cloudflare 1010 unblock/allowlist.
   - If not strict: move script back to OpenAI or Claude with a valid funded key.

2. Normalize naming:
   - folder is still `examples/gemini-feature-split-demo` even though it now targets K2.
   - optionally rename to provider-agnostic path (e.g., `examples/feature-split-demo`).

3. Add robust fallback/provider abstraction:
   - `--provider k2|openai|anthropic|gemini`
   - shared output writer + per-provider call adapters.

4. Add response schema validation:
   - enforce top-level keys and feature structure before writing docs.

5. Add smoke tests:
   - dry parser test from canned JSON
   - doc generation assertions for file names and required sections.

---

## Quick run commands (current K2 config)

From repo root:

```bash
cd examples/gemini-feature-split-demo
./demo.py --idea "calculator"
```

With explicit key/model/user-agent:

```bash
./demo.py \
  --idea "calculator" \
  --api-key "$K2THINK_API_KEY" \
  --model "MBZUAI-IFM/K2-Think-v2" \
  --user-agent "curl/8.5.0"
```

---

## Outputs generated during conversation

At least one local synthetic test output set exists at:
- `examples/gemini-feature-split-demo/docs/srs/overview.md`
- `examples/gemini-feature-split-demo/docs/features/*.md`

These were generated both from mocked/simulated planning and script iterations.
