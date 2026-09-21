"""Run the same coding → K2 review → optional follow-up flow as ``dev_sim.orchestrate`` CLI."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Load repo secrets before any ``dev_sim`` import (those modules pull config at import time).
_REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_REPO_ROOT / ".dev-sim" / ".env", override=True)
load_dotenv(_REPO_ROOT / ".env", override=True)

from dev_sim.coding_agent import run_coding_agent, workspace_root
from dev_sim.config import (
    DEFAULT_REPO_REGISTRY,
    get_anthropic_api_key,
    get_github_token,
    get_k2_api_key,
    load_env,
    resolve_coding_model,
    resolve_k2_review_model,
)
from dev_sim.orchestrate import _followup_prompt
from dev_sim.personas_bridge import (
    coding_persona_bundle,
    persona_slice_coding,
    persona_slice_review,
    review_persona_bundle,
)
from dev_sim.planner import planning_decompose
from dev_sim.push_target_repo import push_workspace_to_target
from dev_sim.review_agent import compute_k2_pr_review, post_pr_issue_comment
from dev_sim.tycoon_sprint import apply_shipped_product_economics


def _read_workspace_preview(ws: Path, max_bytes: int = 400_000) -> tuple[str, str]:
    """Return ``(html, relative_path)`` for the first reasonable entry page under *ws*."""
    if not ws.is_dir():
        return "", ""
    candidates: list[Path] = [
        ws / "index.html",
        ws / "dist" / "index.html",
        ws / "public" / "index.html",
    ]
    try:
        for child in sorted(ws.iterdir()):
            if child.is_dir():
                candidates.append(child / "index.html")
    except OSError:
        pass
    for p in candidates:
        if not p.is_file():
            continue
        try:
            raw = p.read_bytes()[:max_bytes]
            rel = str(p.relative_to(ws))
            return raw.decode("utf-8", errors="replace"), rel
        except (OSError, ValueError):
            continue
    return "", ""


def run_planned_orchestrate_for_prompt(
    text: str,
    *,
    repo_root: Path,
    workspace: Path | None = None,
    repo_registry: Path | None = None,
    max_turns: int = 60,
    followup_max_turns: int = 60,
    max_diff_chars: int = 200_000,
    always_followup: bool = False,
    no_review_comment: bool = False,
    no_agent_progress: bool = True,
    progress_interval_sec: float = 30.0,
    expected_one_time: float = 0.0,
    expected_monthly: float = 0.0,
    coding_persona: dict[str, Any] | None = None,
    review_persona: dict[str, Any] | None = None,
    skip_planning: bool = False,
    skip_k2_review: bool = False,
) -> dict[str, Any]:
    """
    Same env checks as ``run_orchestrate_for_prompt``, then Claude ``planning_decompose``,
    then one full orchestrate pass per planned sprint (sequential, shared workspace).

    On success, top-level ``lastPr`` / ``review`` / ``verdict`` / ``codingPass1`` / etc.
    reflect the **final** sprint so the CEO UI stays compatible. ``sprintResults`` lists
    each sprint; ``plannedSprints`` lists ``number`` and ``title`` only (compact).
    """
    load_env()
    t = (text or "").strip()
    if not t:
        return {"ok": False, "error": "Prompt is empty."}
    if not get_anthropic_api_key():
        return {"ok": False, "error": "ANTHROPIC_API_KEY is not set (needed for the coding agent)."}
    if not (get_github_token() or "").strip():
        return {"ok": False, "error": "GITHUB_TOKEN is not set (needed for PRs and review)."}
    if not skip_k2_review and not get_k2_api_key():
        return {"ok": False, "error": "K2_API_KEY is not set (needed for K2 PR review)."}

    planning_output_cap = 50_000
    planned_sprints: list[dict[str, Any]] = []

    if skip_planning:
        title_line = ((t.split("\n", 1)[0] if t else "") or "").strip()[:120] or "CEO build request"
        sprints = [{"number": 1, "title": title_line, "prompt": t}]
        planning_raw_text = (
            "[Fast path] Planning model skipped — one orchestrate pass on your full prompt.\n"
            + ("[Fast path] K2 PR review skipped after the coding agent opens a PR.\n" if skip_k2_review else "")
        )
        excerpt = (t[:400] + "…") if len(t) > 400 else t
        planned_sprints = [{"number": 1, "title": title_line, "promptExcerpt": excerpt}]
    else:
        try:
            sprints, planning_raw_text = planning_decompose(t, model=None, planning_prompt_path=None)
        except Exception as e:  # noqa: BLE001 — return to UI
            return {"ok": False, "error": f"Planning failed: {e}"}

        planning_output = (
            planning_raw_text
            if len(planning_raw_text) <= planning_output_cap
            else planning_raw_text[:planning_output_cap] + "\n…[truncated]"
        )

        if not sprints:
            return {"ok": False, "error": "Planner returned no sprints.", "planningOutput": planning_output}

        for s in sprints:
            prompt = (s.get("prompt") or "").strip()
            excerpt = (prompt[:400] + "…") if len(prompt) > 400 else prompt
            planned_sprints.append(
                {
                    "number": s.get("number"),
                    "title": s.get("title"),
                    "promptExcerpt": excerpt,
                }
            )

    if skip_planning:
        planning_output = (
            planning_raw_text
            if len(planning_raw_text) <= planning_output_cap
            else planning_raw_text[:planning_output_cap] + "\n…[truncated]"
        )

    sprint_results: list[dict[str, Any]] = []
    last_payload: dict[str, Any] | None = None

    n_sprints = len(sprints)
    for idx, sprint in enumerate(sprints):
        sprompt = (sprint.get("prompt") or "").strip()
        if not sprompt:
            err = f"Sprint {sprint.get('number', '?')} has an empty prompt."
            sprint_results.append(
                {
                    "number": sprint.get("number"),
                    "title": sprint.get("title"),
                    "ok": False,
                    "error": err,
                }
            )
            return {
                "ok": False,
                "error": err,
                "plannedSprints": planned_sprints,
                "planningOutput": planning_output,
                "sprintResults": sprint_results,
            }

        is_last = idx == n_sprints - 1
        r = run_orchestrate_for_prompt(
            sprompt,
            repo_root=repo_root,
            workspace=workspace,
            repo_registry=repo_registry,
            max_turns=max_turns,
            followup_max_turns=followup_max_turns,
            max_diff_chars=max_diff_chars,
            always_followup=always_followup,
            no_review_comment=no_review_comment,
            no_agent_progress=no_agent_progress,
            progress_interval_sec=progress_interval_sec,
            expected_one_time=float(expected_one_time) if is_last else 0.0,
            expected_monthly=float(expected_monthly) if is_last else 0.0,
            coding_persona=coding_persona,
            review_persona=review_persona,
            skip_k2_review=skip_k2_review,
        )

        entry: dict[str, Any] = {
            "number": sprint.get("number"),
            "title": sprint.get("title"),
            "ok": bool(r.get("ok")),
            "error": r.get("error"),
            "lastPr": r.get("lastPr"),
            "review": r.get("review"),
            "verdict": r.get("verdict"),
            "reviewRawOk": r.get("reviewRawOk"),
            "postedReviewCommentUrl": r.get("postedReviewCommentUrl"),
            "followUpSkipped": r.get("followUpSkipped"),
            "codingPass1": r.get("codingPass1"),
            "codingPass2": r.get("codingPass2"),
        }
        sprint_results.append(entry)

        if not r.get("ok"):
            out: dict[str, Any] = {
                "ok": False,
                "error": r.get("error") or "Sprint orchestration failed.",
                "plannedSprints": planned_sprints,
                "planningOutput": planning_output,
                "sprintResults": sprint_results,
            }
            if last_payload is not None:
                out["lastPr"] = last_payload.get("lastPr")
                out["review"] = last_payload.get("review")
                out["verdict"] = last_payload.get("verdict")
            return out

        last_payload = r

    assert last_payload is not None
    merged: dict[str, Any] = {**last_payload}
    merged["ok"] = True
    merged["plannedSprints"] = planned_sprints
    merged["planningOutput"] = planning_output
    merged["sprintResults"] = sprint_results
    merged["fastPath"] = {"skipPlanning": bool(skip_planning), "skipK2Review": bool(skip_k2_review)}
    return merged


def run_orchestrate_for_prompt(
    text: str,
    *,
    repo_root: Path,
    workspace: Path | None = None,
    repo_registry: Path | None = None,
    max_turns: int = 60,
    followup_max_turns: int = 60,
    max_diff_chars: int = 200_000,
    always_followup: bool = False,
    no_review_comment: bool = False,
    no_agent_progress: bool = True,
    progress_interval_sec: float = 30.0,
    expected_one_time: float = 0.0,
    expected_monthly: float = 0.0,
    coding_persona: dict[str, Any] | None = None,
    review_persona: dict[str, Any] | None = None,
    skip_k2_review: bool = False,
) -> dict[str, Any]:
    """
    Returns a JSON-serializable dict. Never calls ``sys.exit`` (unlike the CLI).

    ``repo_root`` is used for ``repo-registry.json`` when ``repo_registry`` is omitted.
    """
    load_dotenv(repo_root / ".dev-sim" / ".env", override=True)
    load_dotenv(repo_root / ".env", override=True)
    load_env()
    t = (text or "").strip()
    if not t:
        return {"ok": False, "error": "Prompt is empty."}
    if not get_anthropic_api_key():
        return {"ok": False, "error": "ANTHROPIC_API_KEY is not set (needed for the coding agent)."}
    if not (get_github_token() or "").strip():
        return {"ok": False, "error": "GITHUB_TOKEN is not set (needed for PRs and review)."}
    if not skip_k2_review and not get_k2_api_key():
        return {"ok": False, "error": "K2_API_KEY is not set (needed for K2 PR review)."}

    ws = workspace_root(workspace)
    gh = get_github_token()
    model = resolve_coding_model(None)
    k2_model = resolve_k2_review_model(None)
    reg = (repo_registry or (repo_root / DEFAULT_REPO_REGISTRY)).expanduser().resolve()

    if coding_persona is not None and review_persona is not None:
        try:
            coding_suffix = persona_slice_coding(coding_persona)
            coding_persona_dict = coding_persona
            review_prefix = persona_slice_review(review_persona)
            review_persona_dict = review_persona
        except (KeyError, TypeError, ValueError) as e:
            return {
                "ok": False,
                "error": f"Invalid coding/review persona payload (must match generate_persona v2 roles): {e}",
            }
    else:
        coding_suffix, coding_persona_dict = coding_persona_bundle(None, None)
        review_prefix, review_persona_dict = review_persona_bundle(None)
    prog = not no_agent_progress

    r1 = run_coding_agent(
        t,
        workspace=ws,
        model=model,
        max_turns=max_turns,
        github_token=gh,
        repo_registry_path=reg,
        persona_system_suffix=coding_suffix,
        persona_dict=coding_persona_dict,
        agent_progress=prog,
        progress_log_path=ws / "dev-sim-agents-progress.log",
        progress_interval_sec=progress_interval_sec,
    )
    last_pr = r1.get("last_pr")
    if not last_pr or not last_pr.get("number"):
        return {
            "ok": False,
            "error": (
                "Coding pass did not open a pull request (check agent logs). "
                f"stop={r1.get('stop')!r}"
            ),
            "codingPass1": _serialize_run(r1),
        }

    owner, repo = str(last_pr["owner"]), str(last_pr["repo"])
    prn = int(last_pr["number"])
    html_url = str(last_pr.get("html_url") or f"https://github.com/{owner}/{repo}/pull/{prn}")

    if skip_k2_review:
        review: dict[str, Any] = {
            "verdict": "approve",
            "summary": "K2 review skipped (fast path).",
            "issues": [],
        }
        review_out: dict[str, Any] = {"ok": True, "parse_ok": False, "review": review}
        raw_model = ""
        comment_md = ""
        posted_url = None
        verdict = "approve"
        skip_followup = True
        r2_summary: dict[str, Any] | None = None
    else:
        review_out = compute_k2_pr_review(
            gh,
            owner,
            repo,
            prn,
            model=k2_model,
            max_diff_chars=max_diff_chars,
            include_json_in_comment=True,
            persona_system_prefix=review_prefix,
            persona_dict=review_persona_dict,
            agent_progress=prog,
            progress_log_path=ws / "dev-sim-agents-progress.log",
            progress_interval_sec=progress_interval_sec,
        )
        if not review_out.get("ok"):
            return {
                "ok": False,
                "error": review_out.get("error") or "K2 review failed.",
                "codingPass1": _serialize_run(r1),
                "lastPr": _serialize_pr(last_pr),
            }

        review = review_out.get("review") if isinstance(review_out.get("review"), dict) else {}
        raw_model = str(review_out.get("raw_model") or "")
        comment_md = str(review_out.get("comment_markdown") or "")

        posted_url = None
        if not no_review_comment:
            posted = post_pr_issue_comment(gh, owner, repo, prn, comment_md)
            if isinstance(posted, dict):
                posted_url = str(posted.get("html_url") or "")

        verdict = (review or {}).get("verdict") if isinstance(review, dict) else None
        skip_followup = verdict == "approve" and not always_followup

        r2_summary = None
    if not skip_k2_review and not skip_followup:
        follow = _followup_prompt(
            owner=owner,
            repo=repo,
            number=prn,
            html_url=html_url,
            review=review if isinstance(review, dict) else None,
            raw_model=raw_model,
        )
        r2 = run_coding_agent(
            follow,
            workspace=ws,
            model=model,
            max_turns=followup_max_turns,
            github_token=gh,
            repo_registry_path=reg,
            persona_system_suffix=coding_suffix,
            persona_dict=coding_persona_dict,
            agent_progress=prog,
            progress_log_path=ws / "dev-sim-agents-progress.log",
            progress_interval_sec=progress_interval_sec,
        )
        r2_summary = _serialize_run(r2)

    project_label = _project_label(t)
    # Persist workspace + PR slug so POST /api/simulate can run a follow-up GitHub export.
    ctx_path = repo_root / ".dev-sim" / "last-export-context.json"
    try:
        ctx_path.parent.mkdir(parents=True, exist_ok=True)
        ctx_path.write_text(
            json.dumps(
                {"workspace": str(ws.resolve()), "pr_owner": owner, "pr_repo": repo},
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError:
        pass

    target_push: dict[str, Any] | None = None
    try:
        target_push = push_workspace_to_target(
            workspace=ws,
            pr_owner=owner,
            pr_repo=repo,
            github_token=gh or "",
            project_name=project_label,
        )
    except Exception as e:  # noqa: BLE001 — never fail the orchestrate response
        target_push = {"ok": False, "error": f"{type(e).__name__}: {e}"}

    economy_snapshot: dict[str, Any] | None = None
    ot = max(0.0, float(expected_one_time or 0.0))
    mo = max(0.0, float(expected_monthly or 0.0))
    if ot > 0 or mo > 0:
        try:
            economy_snapshot = apply_shipped_product_economics(
                repo_root,
                one_time=ot,
                monthly_mrr=mo,
                label=project_label,
            )
        except Exception as e:  # noqa: BLE001
            economy_snapshot = {"ok": False, "error": f"{type(e).__name__}: {e}"}

    preview_html, preview_entry = _read_workspace_preview(ws.resolve())
    return {
        "ok": True,
        "codingPass1": _serialize_run(r1),
        "review": review if isinstance(review, dict) else None,
        "reviewRawOk": bool(review_out.get("parse_ok")),
        "verdict": verdict,
        "postedReviewCommentUrl": posted_url,
        "followUpSkipped": skip_followup,
        "codingPass2": r2_summary,
        "lastPr": _serialize_pr(last_pr),
        "targetPush": target_push,
        "economySnapshot": economy_snapshot,
        "workspacePath": str(ws.resolve()),
        "previewHtml": preview_html,
        "previewEntryPath": preview_entry,
    }


def _project_label(prompt: str) -> str:
    line = (prompt or "").strip().split("\n", 1)[0].strip()
    return (line[:80] if line else "project").strip() or "project"


def _serialize_run(r: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"stop": r.get("stop"), "last_pr": _serialize_pr(r.get("last_pr"))}
    at = r.get("assistant_text")
    if isinstance(at, str) and at.strip():
        out["assistant_text"] = at.strip()
    return out


def _serialize_pr(last_pr: Any) -> dict[str, Any] | None:
    if not last_pr or not isinstance(last_pr, dict):
        return None
    owner = str(last_pr.get("owner", ""))
    repo = str(last_pr.get("repo", ""))
    num = last_pr.get("number")
    return {
        "owner": owner,
        "repo": repo,
        "number": int(num) if num is not None else None,
        "html_url": str(last_pr.get("html_url") or ""),
        "title": str(last_pr.get("title") or ""),
        "fullName": f"{owner}/{repo}" if owner and repo else "",
    }
