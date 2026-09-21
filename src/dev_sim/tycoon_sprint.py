"""Mock sprint + :class:`CompanyState` settlement (shared by FastAPI and ``dev_sim_bridge``)."""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from typing import Any

# ``shared`` lives at repository root (not under ``src/``).
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.append(str(_REPO_ROOT))

from shared.review_schema import TECHNICAL_SCORE_KEYS

from dev_sim.economy import CompanyState, SettlementStatus

DEFAULT_STATE_REL = Path(".dev-sim") / "company-state.json"


def company_state_path() -> Path:
    """JSON path for :class:`CompanyState` (under repo ``.dev-sim/``)."""
    return _REPO_ROOT / DEFAULT_STATE_REL


def _load_company_or_fresh(path: Path) -> CompanyState:
    if not path.is_file():
        return CompanyState()
    try:
        return CompanyState.load_state(path)
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        return CompanyState()


def _company_state_day_one_seed() -> CompanyState:
    """Day-1 ledger aligned with the CEO canvas ``resetGameState`` (defined here to avoid import drift)."""
    return CompanyState(
        balance=200_000.0,
        active_mrr=3_000.0,
        tech_debt=0.0,
        hype_multiplier=1.0,
        sprint_month=1,
        valuation=0.0,
        pending_recurring_mrr=0.0,
    )


def reset_company_state_file() -> CompanyState:
    """Overwrite ``company-state.json`` with Day 1 values (CEO UI restart + ``run_mock_sprint`` in sync)."""
    path = company_state_path()
    company = _company_state_day_one_seed()
    company.save_state(path)
    return company


def _mock_technical_scores() -> dict[str, int]:
    """Random rubric scores for rapid UI iteration (no K2 / Claude)."""
    return {k: random.randint(1, 10) for k in TECHNICAL_SCORE_KEYS}


def apply_shipped_product_economics(
    repo_root: Path,
    *,
    one_time: float,
    monthly_mrr: float,
    label: str = "",
) -> dict[str, Any]:
    """Apply CEO-declared revenue when a real product ships (orchestrate success).

    - ``one_time``: credited to ``balance`` immediately.
    - ``monthly_mrr``: added to ``pending_recurring_mrr``; folded into ``active_mrr`` on the **next**
      :meth:`~dev_sim.economy.CompanyState.process_sprint_settlement` (end-of-sprint / month tick).

    Persists ``.dev-sim/company-state.json`` under ``repo_root``.
    """
    path = Path(repo_root) / DEFAULT_STATE_REL
    company = _load_company_or_fresh(path)
    company.balance += max(0.0, float(one_time))
    company.pending_recurring_mrr = float(company.pending_recurring_mrr) + max(0.0, float(monthly_mrr))
    company.save_state(path)
    return {
        "label": (label or "").strip()[:120],
        "applied_one_time": max(0.0, float(one_time)),
        "applied_monthly_pipeline": max(0.0, float(monthly_mrr)),
        "balance": float(company.balance),
        "active_mrr": float(company.active_mrr),
        "pending_recurring_mrr": float(company.pending_recurring_mrr),
        "valuation": float(company.valuation),
        "sprint_month": int(company.sprint_month),
        "tech_debt": float(company.tech_debt),
        "hype_multiplier": float(company.hype_multiplier),
    }


def run_mock_sprint(
    project_name: str,
    project_spec: str,
    expected_mrr: float,
    team_stats_sum: int,
) -> dict[str, Any]:
    """Load ledger, run one mock audit + settlement, persist, return a JSON-serializable summary.

    ``project_name`` and ``project_spec`` are echoed for callers; settlement math is unchanged
    if they differ (reserved for future orchestration metadata).

    Args:
        project_name: Short label for the engagement.
        project_spec: Scope text (unused in current math).
        expected_mrr: Target MRR if the mock audit averaged 10/10.
        team_stats_sum: Sum of roster stat points for the sprint burn formula.

    Returns:
        Keys: ``project_name``, ``project_spec``, ``technical_scores``, ``tech_debt_delta``,
        ``actual_mrr``, ``balance``, ``valuation``, ``tech_debt``, ``hype_multiplier``,
        ``active_mrr``, ``burn_rate``, ``sprint_month``, ``status`` (see :class:`SettlementStatus`).
    """
    path = company_state_path()
    company = _load_company_or_fresh(path)

    opening_balance = float(company.balance)
    raw_burn = float(team_stats_sum) * 1000.0 + 2000.0 + float(company.active_mrr) * 0.10
    # Demo-friendly runway: operating burn is scaled down (CEO upgrades are one-time; this is recurring burn).
    burn_rate = raw_burn * 0.52

    mock_scores = _mock_technical_scores()
    impacts: dict[str, Any] = company.evaluate_project(expected_mrr, mock_scores)

    tech_delta = float(impacts.get("tech_debt_delta", 0.0))
    company.tech_debt = max(0.0, float(company.tech_debt) + tech_delta)
    company.hype_multiplier = float(impacts.get("next_hype_multiplier", company.hype_multiplier))

    actual_mrr = float(impacts.get("actual_mrr", 0.0))
    status, ledger_lines = company.process_sprint_settlement(burn_rate, actual_mrr)

    company.save_state(path)

    return {
        "project_name": str(project_name).strip(),
        "project_spec": str(project_spec or ""),
        "technical_scores": mock_scores,
        "tech_debt_delta": tech_delta,
        "actual_mrr": actual_mrr,
        "balance": float(company.balance),
        "opening_balance": opening_balance,
        "closing_balance": float(company.balance),
        "valuation": float(company.valuation),
        "tech_debt": float(company.tech_debt),
        "hype_multiplier": float(company.hype_multiplier),
        "active_mrr": float(company.active_mrr),
        "pending_recurring_mrr": float(company.pending_recurring_mrr),
        "burn_rate": burn_rate,
        "sprint_month": int(company.sprint_month),
        "status": status,
        "ledger_lines": ledger_lines,
    }


__all__ = [
    "apply_shipped_product_economics",
    "company_state_path",
    "reset_company_state_file",
    "run_mock_sprint",
]
