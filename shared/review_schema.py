"""Contract for a **reviewing agent** output, designed so the **coding agent** can apply it.

A reviewer (human or model) fills this structure after inspecting diffs, files, or commits
produced by the coding agent. The coding agent can then:

* Order work by ``verdict`` and issue ``severity``.
* Map each issue to ``write_workspace_file`` / ``run_git`` using ``location`` and
  ``suggested_fix``.
* Apply ``suggested_edits`` (path + instruction) for broader changes.
* Use ``follow_up_tasks`` as a short, ordered checklist.

``schema_version`` must be bumped if you change field names or required keys.

This module is stdlib-only and can live outside the packaged ``dev_sim`` wheel until you
include ``shared/`` in your build or move it under ``src/``.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict, cast

# ---------------------------------------------------------------------------
# Typed contract
# ---------------------------------------------------------------------------

Severity = Literal["blocker", "major", "minor", "nit", "suggestion"]
Verdict = Literal["approve", "request_changes", "comment_only"]

# K2 / economy pipeline: fixed rubric keys (exact spelling), scores 1–10 inclusive.
TECHNICAL_SCORE_KEYS: tuple[str, ...] = (
    "CodeReadability",
    "LogicComplexity",
    "ErrorHandling",
    "BuildStability",
    "SecurityBestPractices",
    "Scalability",
    "TaskAlignment",
    "Documentation",
    "PerformanceEfficiency",
    "CollaborationQuality",
)


class TechnicalScores(TypedDict):
    """Staff-engineer audit rubric scores (1 = disastrous, 10 = industry standard)."""

    CodeReadability: int
    LogicComplexity: int
    ErrorHandling: int
    BuildStability: int
    SecurityBestPractices: int
    Scalability: int
    TaskAlignment: int
    Documentation: int
    PerformanceEfficiency: int
    CollaborationQuality: int


class ReviewLocation(TypedDict, total=False):
    """Where a finding applies (paths relative to the repo / workspace clone root)."""

    path: str
    start_line: int
    end_line: int
    label: str  # e.g. component or symbol name


class ReviewIssue(TypedDict, total=False):
    """One finding. ``suggested_fix`` should be imperative and concrete for another agent."""

    severity: Severity
    title: str
    detail: str
    location: ReviewLocation
    suggested_fix: str


class SuggestedEdit(TypedDict, total=False):
    """
    File-scoped instruction. Prefer short ``instruction`` text over pasting full files;
    the coding agent can re-read the path and apply a minimal edit.
    """

    path: str
    instruction: str
    snippet: str  # optional small literal to insert or replace


class CodeReviewResult(TypedDict, total=False):
    """
    Root object from the reviewing agent. JSON-serializable.

    If ``verdict`` is ``request_changes``, the coding agent should process ``issues`` in
    severity order (blocker → major → …), then ``suggested_edits``, then ``follow_up_tasks``.

    ``schema_version`` ``1.1.0`` requires ``technical_scores`` for the tycoon economy pipeline.
    """

    schema_version: str
    summary: str
    verdict: Verdict
    issues: list[ReviewIssue]
    suggested_edits: list[SuggestedEdit]
    follow_up_tasks: list[str]
    technical_scores: TechnicalScores
    review_context: str  # e.g. branch, PR, commit — opaque to the contract


# ---------------------------------------------------------------------------
# JSON Schema (tools, response_format, or validation)
# ---------------------------------------------------------------------------

VERDICT_ENUM = ["approve", "request_changes", "comment_only"]
SEVERITY_ENUM = ["blocker", "major", "minor", "nit", "suggestion"]

_TECH_SCORE_JSON_PROPERTIES: dict[str, Any] = {
    k: {"type": "integer", "minimum": 1, "maximum": 10} for k in TECHNICAL_SCORE_KEYS
}

REVIEW_RESULT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "description": "Structured code review for follow-up by the coding agent",
    "properties": {
        "schema_version": {"type": "string", "const": "1.1.0"},
        "summary": {"type": "string"},
        "verdict": {"type": "string", "enum": VERDICT_ENUM},
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["severity", "title", "detail", "suggested_fix"],
                "properties": {
                    "severity": {"type": "string", "enum": SEVERITY_ENUM},
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "suggested_fix": {
                        "type": "string",
                        "description": "Imperative steps the coding agent should take",
                    },
                    "location": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "path": {"type": "string"},
                            "start_line": {"type": "integer"},
                            "end_line": {"type": "integer"},
                            "label": {"type": "string"},
                        },
                    },
                },
            },
        },
        "suggested_edits": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["path", "instruction"],
                "properties": {
                    "path": {"type": "string"},
                    "instruction": {"type": "string"},
                    "snippet": {"type": "string"},
                },
            },
        },
        "follow_up_tasks": {"type": "array", "items": {"type": "string"}},
        "technical_scores": {
            "type": "object",
            "additionalProperties": False,
            "description": "Staff engineer audit rubric (1-10 per metric) for studio simulation",
            "required": list(TECHNICAL_SCORE_KEYS),
            "properties": _TECH_SCORE_JSON_PROPERTIES,
        },
        "review_context": {"type": "string"},
    },
    "required": [
        "schema_version",
        "summary",
        "verdict",
        "issues",
        "suggested_edits",
        "follow_up_tasks",
        "technical_scores",
    ],
}


# ---------------------------------------------------------------------------
# Optional dataclass builder (tests, fixtures, in-process use)
# ---------------------------------------------------------------------------


@dataclass
class ReviewIssueD:
    severity: Severity
    title: str
    detail: str
    location: dict[str, Any] | None = None
    suggested_fix: str = ""


def _default_technical_scores() -> dict[str, int]:
    return {k: 5 for k in TECHNICAL_SCORE_KEYS}


@dataclass
class CodeReviewResultD:
    """Build a :class:`CodeReviewResult` in code, then call :meth:`to_typed` / :meth:`to_json`."""

    schema_version: str = "1.1.0"
    summary: str = ""
    verdict: Verdict = "comment_only"
    issues: list[ReviewIssueD] = field(default_factory=list)
    suggested_edits: list[dict[str, str]] = field(default_factory=list)
    follow_up_tasks: list[str] = field(default_factory=list)
    technical_scores: dict[str, int] = field(default_factory=_default_technical_scores)
    review_context: str = ""

    def to_typed(self) -> CodeReviewResult:
        ts: TechnicalScores = cast(
            TechnicalScores,
            {k: int(self.technical_scores.get(k, 5)) for k in TECHNICAL_SCORE_KEYS},
        )
        out: CodeReviewResult = {
            "schema_version": self.schema_version,
            "summary": self.summary,
            "verdict": self.verdict,
            "issues": [],
            "suggested_edits": [
                cast(SuggestedEdit, copy.deepcopy(s)) for s in self.suggested_edits
            ],
            "follow_up_tasks": list(self.follow_up_tasks),
            "technical_scores": ts,
        }
        if self.review_context:
            out["review_context"] = self.review_context
        for it in self.issues:
            issue: ReviewIssue = {
                "severity": it.severity,
                "title": it.title,
                "detail": it.detail,
                "suggested_fix": it.suggested_fix,
            }
            if it.location is not None:
                issue["location"] = cast(ReviewLocation, it.location)
            out["issues"].append(issue)  # type: ignore[typeddict-item]
        return out

    def to_json(self) -> str:
        return format_review_json(self.to_typed())


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def to_plain_dict(result: CodeReviewResult) -> dict[str, Any]:
    """Return a plain ``dict`` suitable for ``json.dumps`` (shallow+JSON types only)."""
    return cast(dict[str, Any], copy.deepcopy(result))


def format_review_json(result: CodeReviewResult) -> str:
    return json.dumps(to_plain_dict(result), indent=2, ensure_ascii=False) + "\n"


def _coerce_technical_scores(raw: Any) -> TechnicalScores:
    if not isinstance(raw, dict):
        raise ValueError("technical_scores must be an object")
    out: dict[str, int] = {}
    for k in TECHNICAL_SCORE_KEYS:
        v = raw.get(k)
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise ValueError(f"technical_scores.{k} must be a number")
        iv = int(v)
        if iv < 1 or iv > 10:
            raise ValueError(f"technical_scores.{k} must be between 1 and 10")
        out[k] = iv
    return cast(TechnicalScores, out)


def parse_review_json(text: str) -> CodeReviewResult:
    """Parse JSON text into a :class:`CodeReviewResult` (validates v1.1 rubric keys)."""
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("review root must be a JSON object")
    for k in (
        "schema_version",
        "summary",
        "verdict",
        "issues",
        "suggested_edits",
        "follow_up_tasks",
        "technical_scores",
    ):
        if k not in data:
            raise ValueError(f"missing required key: {k}")
    if str(data.get("schema_version")) != "1.1.0":
        raise ValueError("schema_version must be 1.1.0")
    data["technical_scores"] = _coerce_technical_scores(data.get("technical_scores"))
    return cast(CodeReviewResult, data)


__all__ = [
    "SEVERITY_ENUM",
    "VERDICT_ENUM",
    "TECHNICAL_SCORE_KEYS",
    "REVIEW_RESULT_JSON_SCHEMA",
    "CodeReviewResult",
    "CodeReviewResultD",
    "ReviewIssue",
    "ReviewIssueD",
    "ReviewLocation",
    "Severity",
    "SuggestedEdit",
    "TechnicalScores",
    "Verdict",
    "format_review_json",
    "parse_review_json",
    "to_plain_dict",
]
