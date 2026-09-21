"""Optional FastAPI dev server for the tycoon mock sprint (same logic as ``dev_sim_bridge``).

For day-to-day CEO UI, prefer ``python -m dev_sim_bridge`` on port 8765 (``POST /api/simulate``).
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

_SRC_ROOT = Path(__file__).resolve().parents[1]
_repo_s = str(Path(__file__).resolve().parents[2])
if str(_SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(_SRC_ROOT))
if _repo_s not in sys.path:
    sys.path.append(_repo_s)

from dev_sim.agents_payload import get_session_agents
from dev_sim.economy import CompanyState, SettlementStatus
from dev_sim.tycoon_sprint import company_state_path, reset_company_state_file, run_mock_sprint

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(
    title="Simians API",
    description="Dev-only FastAPI wrapper around ``run_mock_sprint`` (bridge is canonical).",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:4174",
        "http://127.0.0.1:4174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_company_or_fresh(path: Path) -> CompanyState:
    if not path.is_file():
        return CompanyState()
    try:
        return CompanyState.load_state(path)
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        return CompanyState()


class SprintRequest(BaseModel):
    """One mocked sprint driven from the frontend."""

    project_name: str = Field(..., min_length=1, description="Short label for the engagement.")
    project_spec: str = Field(
        default="",
        description="Natural-language scope (reserved for future orchestration).",
    )
    expected_mrr: float = Field(..., ge=0.0, description="Target MRR if audits averaged 10/10.")
    team_stats_sum: int = Field(
        ...,
        ge=0,
        description="Sum of roster stat points used for burn (matches API burn formula).",
    )


class SprintResponse(BaseModel):
    """Economy outcome after a mocked sprint."""

    project_name: str
    project_spec: str = ""
    technical_scores: dict[str, int]
    tech_debt_delta: float
    actual_mrr: float
    balance: float
    opening_balance: float = 0.0
    closing_balance: float = 0.0
    valuation: float
    tech_debt: float
    hype_multiplier: float
    active_mrr: float
    pending_recurring_mrr: float = 0.0
    burn_rate: float
    sprint_month: int
    status: SettlementStatus
    ledger_lines: list[dict[str, Any]] = Field(default_factory=list)


@app.get("/api/agents")
def get_agents(
    seed: Optional[int] = Query(None, description="RNG seed used only on the first sample for this process."),
    refresh: bool = Query(False, description="If true, discard cached personas and sample again."),
) -> dict[str, Any]:
    """Personas for three dev-sim agents (coding, coding_b, review); sampled once per process then reused (unless ``refresh``)."""
    rs = None if seed is None else seed ^ 0x9E3779B9
    return get_session_agents(coding_seed=seed, review_seed=rs, force_refresh=refresh)


@app.get("/api/company")
def get_company() -> dict[str, Any]:
    """Return :class:`CompanyState` plus ``persisted`` when loaded from disk."""
    path = company_state_path()
    persisted = path.is_file()
    company = _load_company_or_fresh(path)
    out: dict[str, Any] = asdict(company)
    out["persisted"] = persisted
    return out


@app.post("/api/company/reset")
def post_company_reset() -> dict[str, Any]:
    """Overwrite persisted :class:`CompanyState` with Day 1 defaults (matches CEO UI restart)."""
    company = reset_company_state_file()
    out: dict[str, Any] = asdict(company)
    out["persisted"] = True
    out["ok"] = True
    return out


@app.post("/api/simulate", response_model=SprintResponse)
def simulate_sprint(body: SprintRequest) -> SprintResponse:
    """Thin wrapper: delegates to :func:`dev_sim.tycoon_sprint.run_mock_sprint`."""
    data = run_mock_sprint(
        body.project_name,
        body.project_spec,
        body.expected_mrr,
        body.team_stats_sum,
    )
    return SprintResponse(**data)


__all__ = [
    "app",
    "company_state_path",
    "reset_company_state_file",
    "SprintRequest",
    "SprintResponse",
    "run_mock_sprint",
]
