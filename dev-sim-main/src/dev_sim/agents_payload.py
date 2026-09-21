"""Expose three orchestration personas (two coding + review) for HTTP / UI consumers.

Personas are sampled once per process and reused for every ``GET /api/agents`` unless
``refresh=true``. Orchestration should use the same dicts (sent from the client or read
from this cache in-process).
"""

from __future__ import annotations

import copy
from typing import Any

from dev_sim.config import load_env
from dev_sim.personas_bridge import coding_persona_bundle, review_persona_bundle

# One triple of personas per server process (FastAPI uvicorn child, bridge worker, etc.).
_session_agents: dict[str, Any] | None = None

# XOR constant so second coder seed differs from the first when ``coding_seed`` is set.
_CODING_B_SEED_XOR = 0xC001_D00D


def sample_agents(*, coding_seed: int | None = None, review_seed: int | None = None) -> dict[str, Any]:
    """
    Return fresh JSON-serializable persona dicts (always samples; does not update session).

    When only ``coding_seed`` is set, review uses a derived seed so both stay stable per request.
    Second coding persona uses ``coding_seed ^ _CODING_B_SEED_XOR`` when ``coding_seed`` is set,
    else independent random sampling (``None`` seed).
    """
    load_env()
    rs = review_seed
    if rs is None and coding_seed is not None:
        rs = coding_seed ^ 0x9E3779B9
    _, coding_dict = coding_persona_bundle(None, coding_seed)
    coding_b_seed = None if coding_seed is None else (coding_seed ^ _CODING_B_SEED_XOR)
    _, coding_b_dict = coding_persona_bundle(None, coding_b_seed)
    _, review_dict = review_persona_bundle(rs)

    if coding_dict.get("id") is not None and coding_dict.get("id") == coding_b_dict.get("id"):
        base = str(coding_b_dict.get("id") or "agent")
        coding_b_dict = {**coding_b_dict, "id": f"{base}-b"}

    return {"coding": coding_dict, "coding_b": coding_b_dict, "review": review_dict}


def get_session_agents(
    *,
    coding_seed: int | None = None,
    review_seed: int | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """
    Return the process-wide two coding + one review personas.

    First call (or ``force_refresh``) samples and caches; later calls return a deep copy
    of the same triple so the UI and orchestrate stay aligned without resampling.
    """
    global _session_agents
    if _session_agents is None or force_refresh:
        _session_agents = sample_agents(coding_seed=coding_seed, review_seed=review_seed)
    out = copy.deepcopy(_session_agents)
    try:
        from dev_sim.agent_run_logging import log_get_api_agents_payload

        log_get_api_agents_payload(out)
    except Exception:
        # Do not fail GET /api/agents if the personas log cannot be written.
        pass
    return out
