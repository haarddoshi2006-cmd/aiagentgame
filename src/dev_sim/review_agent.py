"""PR review agent: fetch a GitHub pull request diff, call K2 Think, post an issue comment.

Uses the OpenAI-compatible K2 API (``K2_API_KEY``) and :func:`config.resolve_k2_review_model`.
Tries to parse structured JSON; comment body is always a markdown summary (with optional JSON).
"""

from __future__ import annotations

import json
import re
import sys
from contextlib import nullcontext
from pathlib import Path
from typing import Any

import httpx
from openai import OpenAI

from dev_sim.agent_progress import AgentProgressLogger, ProgressAnnouncer
from dev_sim.config import get_k2_api_key, resolve_k2_api_base

# Must match shared/review_schema.TECHNICAL_SCORE_KEYS (economy + audit rubric).
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

_TECH_SCORE_JSON_EXAMPLE = ",\n  ".join(f'"{k}": <1-10 integer>' for k in TECHNICAL_SCORE_KEYS)

STRUCTURED_OUTPUT_INSTRUCTION = (
    "Respond with a **single** JSON object only, no markdown fences, with keys: "
    'schema_version (string, use "1.1.0"), summary, verdict (one of '
    "approve, request_changes, comment_only), issues (array of objects with "
    "severity, title, detail, suggested_fix, optional location {path, start_line, end_line, label}), "
    "suggested_edits (array of {path, instruction, optional snippet}), "
    "follow_up_tasks (string array), "
    "technical_scores (object — REQUIRED), optional review_context. "
    "The technical_scores object MUST contain exactly these 10 keys, each an integer from 1 to 10 "
    "(1 = disastrous or missing, 10 = flawless / industry standard): "
    + ", ".join(TECHNICAL_SCORE_KEYS)
    + ". Example shape for technical_scores (replace placeholders with integers 1-10):\n"
    "{\n  "
    + _TECH_SCORE_JSON_EXAMPLE
    + "\n}\n"
    "Set suggested_fix to concrete, imperative text for a coding agent. "
    "List issues in severity order: blocker, major, minor, nit, suggestion."
)


REVIEW_SYSTEM_PROMPT = f"""You are a Senior Staff Engineer acting as a technical auditor for a software studio simulation. In addition to your standard review, you MUST grade the provided code across 10 specific technical metrics. Score each metric strictly from 1 to 10 (1 = disastrous/missing, 10 = flawless/industry-standard). Pay special attention to 'SecurityBestPractices' and 'ErrorHandling', as poor scores here will cause critical production outages.

Review the pull request for correctness, security, performance, and maintainability. {STRUCTURED_OUTPUT_INSTRUCTION}"""


def _gh_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def fetch_pr_metadata(
    token: str, owner: str, repo: str, pull_number: int, timeout: float = 60.0
) -> dict[str, Any] | None:
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pull_number}"
    r = httpx.get(url, headers=_gh_headers(token), timeout=timeout)
    if r.is_error:
        return None
    return r.json()


def fetch_pr_diff(
    token: str,
    owner: str,
    repo: str,
    pull_number: int,
    max_chars: int = 200_000,
    timeout: float = 120.0,
) -> str:
    """Return unified diff for the PR, truncated to ``max_chars`` for model context."""
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pull_number}"
    r = httpx.get(
        url,
        headers={
            **_gh_headers(token),
            "Accept": "application/vnd.github.diff",
        },
        timeout=timeout,
    )
    if r.is_error:
        return f"[Error fetching diff: HTTP {r.status_code} — {r.text[:500]}]\n"
    text = r.text
    if len(text) > max_chars:
        return text[: max_chars] + f"\n\n[… diff truncated: {len(text) - max_chars} characters omitted …]\n"
    return text


def post_pr_issue_comment(
    token: str, owner: str, repo: str, issue_number: int, body: str, timeout: float = 60.0
) -> dict[str, Any] | str:
    """
    Add a top-level **issue** comment to the pull request (for PRs, the issue id equals the
    PR number).
    """
    url = f"https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}/comments"
    r = httpx.post(
        url,
        headers=_gh_headers(token),
        json={"body": body},
        timeout=timeout,
    )
    if r.is_error:
        return f"HTTP {r.status_code}: {r.text[:2000]}"
    try:
        return r.json()
    except Exception:
        return str(r.text[:500])


# K2-Think and similar models may emit a long "thinking" preface, draft JSON, then the
# final object. A naive first-{ to last-} slice breaks when early prose or drafts contain `{`.
# We anchor on the first `{` of a top-level "schema_version" key, then `JSONDecoder.raw_decode`
# to parse the exact one JSON value (string-aware, balanced braces).
REVIEW_ROOT_JSON_START = re.compile(
    r'(\{)\s*"schema_version"\s*:',
    re.MULTILINE,
)

_decoder = json.JSONDecoder()


def _raw_decode_object_at(s: str, i: int) -> dict[str, Any] | None:
    if i < 0 or i >= len(s) or s[i] not in " \t\r\n{":
        return None
    if s[i] in " \t\r\n":
        i = s.find("{", i)
        if i < 0:
            return None
    try:
        o, _end = _decoder.raw_decode(s, i)
    except json.JSONDecodeError:
        return None
    return o if isinstance(o, dict) else None


def _try_parse_review_json(text: str) -> dict[str, Any] | None:
    """Parse the CodeReviewResult object from the model, anchored on top-level ``schema_version``.

    Callers should run :func:`_finalize_code_review_result` on the returned dict so
    ``technical_scores`` and ``schema_version`` ``1.1.0`` are guaranteed for the economy pipeline.
    """
    t = text.strip()
    if "schema_version" in t and '"schema_version"' in t:
        # Try from last `{"schema_version"…` first (K2-Think: final object after long thinking).
        for m in reversed(list(REVIEW_ROOT_JSON_START.finditer(t))):
            out = _raw_decode_object_at(t, m.start(1))
            if out and "schema_version" in out:
                return out
    # Fenced ` ```json` block without a matching `{"schema_version"…` in the same span.
    m2 = re.search(r"```(?:json)?\s*(\{)", t)
    if m2 is not None:
        out2 = _raw_decode_object_at(t, m2.start(1))
        if isinstance(out2, dict) and "schema_version" in out2:
            return out2
    a = t.find("{")
    if a < 0:
        return None
    try:
        o3, _end = _decoder.raw_decode(t, a)
    except (json.JSONDecodeError, TypeError, ValueError):
        o3 = None
    if isinstance(o3, dict) and o3:
        return o3
    b = t.rfind("}")
    if 0 > a or a >= b:
        return None
    try:
        o4 = json.loads(t[a : b + 1])
    except json.JSONDecodeError:
        return None
    return o4 if isinstance(o4, dict) else None


def _coerce_score_1_10(value: Any) -> int:
    """Normalize a model-provided score to an int in 1..10."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 5
    iv = int(round(float(value)))
    if iv < 1:
        return 1
    if iv > 10:
        return 10
    return iv


def _finalize_code_review_result(obj: dict[str, Any]) -> dict[str, Any]:
    """Ensure ``technical_scores`` exists and ``schema_version`` is v1.1 for downstream tooling.

    Accepts legacy ``1.0.0`` payloads by synthesizing missing rubric scores (default mid-range).
    Mutates ``obj`` in place and returns it.
    """
    raw_ts = obj.get("technical_scores")
    scores: dict[str, int] = {}
    if isinstance(raw_ts, dict):
        for k in TECHNICAL_SCORE_KEYS:
            scores[k] = _coerce_score_1_10(raw_ts.get(k))
    else:
        scores = {k: 5 for k in TECHNICAL_SCORE_KEYS}

    obj["technical_scores"] = scores

    sv = str(obj.get("schema_version", "")).strip()
    if sv == "1.0.0" or not sv:
        obj["schema_version"] = "1.1.0"
    elif sv != "1.1.0":
        # Unknown version: normalize to current contract for the economy pipeline.
        obj["schema_version"] = "1.1.0"

    return obj


def format_review_markdown(review: dict[str, Any], include_json: bool) -> str:
    """Build GitHub-Flavored Markdown for the PR issue comment from parsed JSON."""
    v = str(review.get("verdict", "comment_only"))
    sm = str(review.get("summary", "")).strip()
    parts: list[str] = [
        "### Automated code review (K2 / dev-sim)\n",
        f"**Verdict:** `{v}`\n",
    ]
    if sm:
        parts.append("\n" + sm + "\n")

    ts = review.get("technical_scores")
    if isinstance(ts, dict):
        parts.append("\n#### Staff Engineer Audit Rubric\n\n")
        parts.append("| Metric | Score |\n")
        parts.append("|:-------|------:|\n")
        numeric: list[int] = []
        for key in TECHNICAL_SCORE_KEYS:
            cell = ts.get(key, "—")
            if isinstance(cell, (int, float)) and not isinstance(cell, bool):
                iv = int(round(float(cell)))
                numeric.append(max(1, min(10, iv)))
                parts.append(f"| **{key}** | {iv} / 10 |\n")
            else:
                parts.append(f"| **{key}** | — |\n")
        if numeric:
            avg = sum(numeric) / len(numeric)
            parts.append(f"\n*Average technical score: **{avg:.2f}** / 10*\n")

    for i, isu in enumerate(review.get("issues") or [], 1):
        if not isinstance(isu, dict):
            continue
        sev = isu.get("severity", "—")
        title = isu.get("title", "Issue")
        det = (isu.get("detail") or "").strip()
        loc = isu.get("location") or {}
        path = loc.get("path", "—") if isinstance(loc, dict) else "—"
        parts.append(f"\n**{i}. [{sev}]** {title}  \n")
        if path and path != "—":
            parts.append(f"*{path}*\n\n")
        if det:
            parts.append(det + "\n\n")
        sf = (isu.get("suggested_fix") or "").strip()
        if sf:
            parts.append(f"**Suggested fix:** {sf}\n\n")
    for ed in review.get("suggested_edits") or []:
        if not isinstance(ed, dict):
            continue
        p, ins = ed.get("path", ""), ed.get("instruction", "")
        if p or ins:
            parts.append(f"- **{p}** — {ins}\n")
    for task in review.get("follow_up_tasks") or []:
        if isinstance(task, str) and task.strip():
            parts.append(f"- [ ] {task}\n")
    if include_json:
        pretty = json.dumps(review, indent=2, ensure_ascii=False)[:20_000]
        parts.append("\n\n<details><summary>Structured <code>CodeReviewResult</code> (for agents)</summary>\n\n")
        parts.append(f"```json\n{pretty}\n```\n</details>\n")
    return "".join(parts)


def compute_k2_pr_review(
    token: str,
    owner: str,
    repo: str,
    pull_number: int,
    *,
    model: str,
    max_diff_chars: int = 200_000,
    include_json_in_comment: bool = True,
    persona_system_prefix: str | None = None,
    persona_dict: dict[str, Any] | None = None,
    agent_progress: bool = True,
    progress_log_path: Path | None = None,
    progress_interval_sec: float = 30.0,
) -> dict[str, Any]:
    """
    Fetch PR diff, call K2, parse ``CodeReviewResult`` JSON. Does **not** post to GitHub.

    Returns keys: ``ok`` (bool), ``error`` (str | None), ``review`` (dict | None),
    ``raw_model`` (str), ``comment_markdown`` (str), ``parse_ok`` (bool), ``meta`` (dict | None).
    """
    token = (token or "").strip()
    if not token:
        return {
            "ok": False,
            "error": "GITHUB_TOKEN is required.",
            "review": None,
            "raw_model": "",
            "comment_markdown": "",
            "parse_ok": False,
            "meta": None,
        }
    k2_key = get_k2_api_key()
    if not k2_key:
        return {
            "ok": False,
            "error": "K2_API_KEY is required for the PR review agent.",
            "review": None,
            "raw_model": "",
            "comment_markdown": "",
            "parse_ok": False,
            "meta": None,
        }

    log_path = progress_log_path or (Path.cwd() / ".dev-sim-workspace" / "dev-sim-agents-progress.log")
    if agent_progress:
        plog = AgentProgressLogger(log_path, agent_label="k2_review")
        plog.log_persona_start(persona_dict)
        progress_cm: Any = ProgressAnnouncer(
            plog,
            persona_dict,
            agent_label="k2_review",
            interval_sec=progress_interval_sec,
        )
    else:
        progress_cm = nullcontext()

    with progress_cm as announcer:
        if announcer is not None:
            announcer.set_phase("fetching_pr")
        meta = fetch_pr_metadata(token, owner, repo, pull_number)
        if not meta:
            return {
                "ok": False,
                "error": "Failed to fetch pull request (metadata).",
                "review": None,
                "raw_model": "",
                "comment_markdown": "",
                "parse_ok": False,
                "meta": None,
            }

        title = meta.get("title", "")
        body = (meta.get("body") or "")[:8000]
        head = (meta.get("head") or {}).get("ref", "head")
        base = (meta.get("base") or {}).get("ref", "base")
        html = meta.get("html_url", "")
        user = (meta.get("user") or {}).get("login", "author")

        diff = fetch_pr_diff(
            token, owner, repo, pull_number, max_chars=max_diff_chars
        )
        user_msg = f"""## PR metadata
- **Repository:** {owner}/{repo}
- **Number:** {pull_number}
- **Title:** {title}
- **Author:** {user}
- **Base** ← **Head:** `{base}` ← `{head}`
- **URL:** {html}
- **PR description (excerpt):**
{body or "(none)"}

## Diff (unified, may be truncated for size)

```diff
{diff}
```
"""
        review_system = REVIEW_SYSTEM_PROMPT
        if persona_system_prefix and persona_system_prefix.strip():
            review_system = (
                persona_system_prefix.strip() + "\n\n---\n\n" + REVIEW_SYSTEM_PROMPT.strip()
            )

        client = OpenAI(api_key=k2_key, base_url=resolve_k2_api_base())
        if announcer is not None:
            announcer.set_phase("reviewing")
        try:
            resp = client.chat.completions.create(
                model=model,
                max_tokens=8192,
                messages=[
                    {"role": "system", "content": review_system},
                    {"role": "user", "content": user_msg},
                ],
            )
        except Exception as e:
            return {
                "ok": False,
                "error": f"K2 request failed: {e}",
                "review": None,
                "raw_model": "",
                "comment_markdown": "",
                "parse_ok": False,
                "meta": meta,
            }

        choice = resp.choices[0] if resp.choices else None
        raw = (choice.message.content or "").strip() if choice and choice.message else ""
        if not raw:
            return {
                "ok": False,
                "error": "Empty model response",
                "review": None,
                "raw_model": "",
                "comment_markdown": "",
                "parse_ok": False,
                "meta": meta,
            }

        review_obj = _try_parse_review_json(raw)
        if review_obj:
            _finalize_code_review_result(review_obj)
            comment_body = format_review_markdown(review_obj, include_json=include_json_in_comment)
        else:
            comment_body = f"### Automated code review (K2 / dev-sim)\n\n" + (
                f"The model did not return parseable JSON. Raw response:\n\n```\n{raw[:50_000]}\n```"
            )

        return {
            "ok": True,
            "error": None,
            "review": review_obj,
            "raw_model": raw,
            "comment_markdown": comment_body,
            "parse_ok": review_obj is not None,
            "meta": meta,
        }


def run_k2_pr_review(
    token: str,
    owner: str,
    repo: str,
    pull_number: int,
    *,
    model: str,
    post_comment: bool = True,
    max_diff_chars: int = 200_000,
    include_json: bool = True,
    persona_system_prefix: str | None = None,
    persona_dict: dict[str, Any] | None = None,
    agent_progress: bool = True,
    progress_log_path: Path | None = None,
    progress_interval_sec: float = 30.0,
) -> None:
    out = compute_k2_pr_review(
        token,
        owner,
        repo,
        pull_number,
        model=model,
        max_diff_chars=max_diff_chars,
        include_json_in_comment=include_json,
        persona_system_prefix=persona_system_prefix,
        persona_dict=persona_dict,
        agent_progress=agent_progress,
        progress_log_path=progress_log_path,
        progress_interval_sec=progress_interval_sec,
    )
    if not out["ok"]:
        print(out.get("error") or "Review failed.", file=sys.stderr)
        sys.exit(1)
    comment_body = str(out["comment_markdown"])
    if post_comment:
        r = post_pr_issue_comment(
            token, owner, repo, issue_number=pull_number, body=comment_body
        )
        if isinstance(r, str):
            print(f"Failed to post comment: {r}", file=sys.stderr)
            sys.exit(1)
        c_url = (r or {}).get("html_url", "")
        print("Posted PR comment" + (f": {c_url}" if c_url else ""), file=sys.stderr)
    else:
        print(comment_body)


__all__ = [
    "TECHNICAL_SCORE_KEYS",
    "compute_k2_pr_review",
    "fetch_pr_diff",
    "fetch_pr_metadata",
    "format_review_markdown",
    "post_pr_issue_comment",
    "run_k2_pr_review",
]
