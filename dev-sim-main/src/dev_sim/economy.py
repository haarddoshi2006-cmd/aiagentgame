"""Standalone company economy state for the Simians tycoon layer.

Persists treasury, MRR, tech debt, viral hype, and sprint-based settlement. Intended
to be wired into the orchestration loop later; safe to import without side effects.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, Mapping, Protocol, runtime_checkable

# Keys used for tech-debt rules (K2-style audit metrics, 1–10 scale).
_SECURITY_KEY_CANDIDATES = ("SecurityBestPractices", "security_best_practices")
_ERROR_KEY_CANDIDATES = ("ErrorHandling", "error_handling")

SettlementStatus = Literal["SERIES_A", "BANKRUPT", "OUTAGE_SURVIVED", "CONTINUE"]

STAT_KEYS = ("velocity", "quality", "focus", "communication", "knowledge")


@runtime_checkable
class AgentWithStats(Protocol):
    """Any object exposing a ``stats`` mapping (e.g. persona dict or dataclass)."""

    stats: Mapping[str, int]


def _coerce_stats(agent: Any) -> dict[str, int] | None:
    """Return the five stat ints from an agent-like object or dict, or None if absent."""
    if agent is None:
        return None
    raw: Any
    if isinstance(agent, Mapping):
        raw = agent.get("stats")
    else:
        raw = getattr(agent, "stats", None)
    if not isinstance(raw, Mapping):
        return None
    out: dict[str, int] = {}
    for k in STAT_KEYS:
        v = raw.get(k)
        if v is None:
            return None
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            return None
        iv = int(v)
        if iv < 1 or iv > 5:
            return None
        out[k] = iv
    return out


def _sum_team_stat_points(agents: list[Any]) -> int:
    """Sum of all five stats across agents that define a complete ``stats`` block."""
    total = 0
    for a in agents:
        st = _coerce_stats(a)
        if st is None:
            continue
        total += sum(st.values())
    return total


def _pick_score(d: Mapping[str, Any], candidates: tuple[str, ...]) -> float | None:
    for k in candidates:
        if k not in d:
            continue
        v = d[k]
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
    return None


def _average_numeric_values(d: Mapping[str, Any]) -> float | None:
    """Arithmetic mean of all int/float values (ignores bool, nested dicts)."""
    vals: list[float] = []
    for v in d.values():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            vals.append(float(v))
    if not vals:
        return None
    return sum(vals) / len(vals)


@dataclass
class CompanyState:
    """Treasury and recurring-revenue simulation state for one studio playthrough.

    Attributes:
        balance: Cash on hand (USD).
        active_mrr: Recognized monthly recurring revenue (USD / month).
        tech_debt: 0–100 burden score; at 100+ triggers an outage penalty on settlement.
        hype_multiplier: Viral demand modifier applied to gross MRR each settlement.
        sprint_month: 1-based sprint counter advanced after each settlement.
        valuation: Paper valuation (updated each settlement as ``active_mrr * 12 * 10``).
        pending_recurring_mrr: Contracted MRR from shipped products that **starts next**
            settlement (game-month), then is folded into ``active_mrr``.
    """

    balance: float = 200_000.0
    active_mrr: float = 0.0
    tech_debt: float = 0.0
    hype_multiplier: float = 1.0
    sprint_month: int = 1
    valuation: float = 0.0
    pending_recurring_mrr: float = 0.0

    def calculate_monthly_burn(self, agents: list[Any]) -> float:
        """Compute monthly burn before this sprint's revenue.

        Salary load is ``(sum of all stat points across agents with valid stats) * 1000``,
        matching per-agent ``(sum of five stats) * 1000`` when every agent has stats.

        Adds a flat ``2000`` overhead and ``active_mrr * 0.10`` as scaling infra cost.
        """
        stat_load = float(_sum_team_stat_points(agents)) * 1000.0
        infra = 2000.0 + float(self.active_mrr) * 0.10
        return stat_load + infra

    def evaluate_project(
        self,
        expected_mrr: float,
        k2_audit_scores: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Score a shipped project from K2 metrics without mutating cash or MRR.

        Computes realized MRR from average audit quality, adjusts tech-debt guidance,
        and proposes the next sprint's ``hype_multiplier`` (viral spike vs decay toward 1).

        The caller should merge ``tech_debt_delta`` into ``tech_debt`` (clamped 0–100
        if desired) and assign ``next_hype_multiplier`` to ``self.hype_multiplier`` when
        the sprint boundary is appropriate.

        Args:
            expected_mrr: Contracted MRR if audits were perfect (10/10 average).
            k2_audit_scores: Metric name -> score (1–10). Averages use all numeric values.
        """
        scores_dict: dict[str, Any] = dict(k2_audit_scores)
        avg_all = _average_numeric_values(scores_dict)

        if avg_all is None:
            avg_k2 = 0.0
            actual_mrr = 0.0
        else:
            avg_k2 = avg_all
            actual_mrr = float(expected_mrr) * (avg_k2 / 10.0)

        sec = _pick_score(scores_dict, _SECURITY_KEY_CANDIDATES)
        err = _pick_score(scores_dict, _ERROR_KEY_CANDIDATES)
        tech_delta = 0.0
        if sec is not None and err is not None:
            pair_avg = (sec + err) / 2.0
            if pair_avg < 5.0:
                tech_delta += 20.0
            elif pair_avg > 8.0:
                tech_delta -= 10.0

        if avg_all is not None and avg_k2 > 9.0:
            next_hype = 2.0
        else:
            # Move halfway from current hype down toward 1.0 (gentle decay).
            h = float(self.hype_multiplier)
            next_hype = 1.0 + (h - 1.0) * 0.5
            if next_hype < 1.0:
                next_hype = 1.0

        return {
            "avg_k2_score": avg_k2,
            "actual_mrr": actual_mrr,
            "tech_debt_delta": tech_delta,
            "next_hype_multiplier": next_hype,
            "security_score": sec,
            "error_handling_score": err,
        }

    def process_sprint_settlement(
        self,
        burn_rate: float,
        newly_added_mrr: float,
    ) -> tuple[SettlementStatus, list[dict[str, Any]]]:
        """Apply one sprint of MRR, revenue, burn, outage risk, and valuation.

        Steps:

        1. Fold ``pending_recurring_mrr`` (earmarked when CEO products shipped) into ``active_mrr``, then clear it.
        2. Add ``newly_added_mrr`` to ``active_mrr`` (this sprint's modeled product uplift).
        3. Gross recurring revenue this sprint: ``active_mrr * hype_multiplier``.
        4. If ``tech_debt >= 100``, apply a $25k SLA penalty, reset tech debt to 50.
        5. Update ``balance`` by ``-burn_rate + revenue``.
        6. Set ``valuation`` to ``active_mrr * 12 * 10``.
        7. Increment ``sprint_month``.

        Returns:
            A tuple of ``(status, ledger_lines)`` where ``status`` is ``SERIES_A`` if paper
            valuation reaches $2M+, ``BANKRUPT`` if cash is depleted,
            ``OUTAGE_SURVIVED`` if an outage fired this sprint (and not bankrupt),
            otherwise ``CONTINUE``. ``ledger_lines`` is a list of dicts with
            ``label``, ``amount`` (signed where negative is cash out), and ``kind``.
        """
        ledger: list[dict[str, Any]] = []
        opening = float(self.balance)

        pipe = max(0.0, float(self.pending_recurring_mrr))
        if pipe > 0:
            ledger.append(
                {
                    "label": "Pipeline MRR now live (from shipped products)",
                    "amount": float(pipe),
                    "kind": "mrr",
                }
            )
        self.active_mrr += pipe
        self.pending_recurring_mrr = 0.0

        add_mrr = float(newly_added_mrr)
        if add_mrr > 0:
            ledger.append(
                {
                    "label": "This sprint’s product uplift → MRR",
                    "amount": add_mrr,
                    "kind": "mrr",
                }
            )
        self.active_mrr += add_mrr
        revenue = float(self.active_mrr) * float(self.hype_multiplier)
        ledger.append(
            {
                "label": "Recurring revenue (MRR × hype)",
                "amount": revenue,
                "kind": "credit",
            }
        )

        br = float(burn_rate)
        ledger.append(
            {
                "label": "Operating burn (payroll + infra, this period)",
                "amount": -br,
                "kind": "debit",
            }
        )

        outage = False
        if self.tech_debt >= 100.0:
            ledger.append(
                {
                    "label": "SLA / outage penalty (tech debt ≥ 100)",
                    "amount": -25_000.0,
                    "kind": "debit",
                }
            )
            self.balance -= 25_000.0
            self.tech_debt = 50.0
            outage = True

        self.balance -= br
        self.balance += revenue

        net_cashflow = float(self.balance) - opening
        ledger.append(
            {
                "label": "Net change to cash",
                "amount": net_cashflow,
                "kind": "net",
            }
        )

        self.valuation = float(self.active_mrr) * 12.0 * 10.0
        self.sprint_month += 1

        if self.valuation >= 2_000_000.0:
            return "SERIES_A", ledger
        if self.balance <= 0.0:
            return "BANKRUPT", ledger
        if outage:
            return "OUTAGE_SURVIVED", ledger
        return "CONTINUE", ledger

    def save_state(self, filepath: str | Path) -> None:
        """Persist state as JSON (UTF-8)."""
        path = Path(filepath)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = asdict(self)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load_state(cls, filepath: str | Path) -> CompanyState:
        """Load state from JSON written by :meth:`save_state`."""
        path = Path(filepath)
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("economy state file must contain a JSON object")
        return cls(
            balance=float(data.get("balance", 100_000.0)),
            active_mrr=float(data.get("active_mrr", 0.0)),
            tech_debt=float(data.get("tech_debt", 0.0)),
            hype_multiplier=float(data.get("hype_multiplier", 1.0)),
            sprint_month=int(data.get("sprint_month", 1)),
            valuation=float(data.get("valuation", 0.0)),
            pending_recurring_mrr=float(data.get("pending_recurring_mrr", 0.0)),
        )


__all__ = [
    "STAT_KEYS",
    "AgentWithStats",
    "CompanyState",
    "SettlementStatus",
]
