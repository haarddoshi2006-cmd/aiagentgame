"""Orchestrate coding agent → K2 PR review → coding agent follow-up from one user prompt."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from dev_sim.personas_bridge import (
    apply_personas_dir_from_cli,
    coding_persona_bundle,
    review_persona_bundle,
)

from dev_sim.coding_agent import run_coding_agent, workspace_root
from dev_sim.config import (
    DEFAULT_CODING_PERSONA_ROLE,
    DEFAULT_REPO_REGISTRY,
    get_github_token,
    load_env,
    resolve_coding_model,
    resolve_k2_review_model,
)
from dev_sim.review_agent import compute_k2_pr_review, post_pr_issue_comment


def _followup_prompt(
    *,
    owner: str,
    repo: str,
    number: int,
    html_url: str,
    review: dict[str, Any] | None,
    raw_model: str,
) -> str:
    if review is not None:
        payload = json.dumps(review, indent=2, ensure_ascii=False)
    else:
        payload = json.dumps(
            {
                "schema_version": "1.0.0",
                "summary": "Automated review did not return parseable CodeReviewResult JSON.",
                "verdict": "comment_only",
                "issues": [],
                "suggested_edits": [],
                "follow_up_tasks": [],
                "review_context": "Use the raw model excerpt below; infer fixes from the PR diff if possible.",
                "raw_review_excerpt": (raw_model or "")[:24_000],
            },
            indent=2,
            ensure_ascii=False,
        )
    return f"""## Orchestrated review follow-up

An automated **K2** review just ran on the pull request you opened (or last pushed). Apply what it asks for in your **workspace clone** (same paths as before).

### Pull request (do not merge via API or git)
- **URL:** {html_url}
- **Repository:** `{owner}/{repo}` — PR **#{number}**

### Workflow
1. Use the existing clone under the workspace. Fetch/pull so you are on the **PR head branch** (the branch already pushed for this PR).
2. Address findings in this order: **blocker** and **major** ``issues`` first (use ``suggested_fix`` and ``location``), then **minor** / **nit** / **suggestion** issues, then **suggested_edits**, then **follow_up_tasks**.
3. Commit and **git push** to update the PR. Do **not** merge to the default branch.

### Structured review (CodeReviewResult JSON — source of truth)

```json
{payload}
```
"""


def main() -> None:
    load_env()
    parser = argparse.ArgumentParser(
        description=(
            "Run the Claude coding agent, then K2 PR review on the created PR, "
            "then the coding agent again with the review JSON to apply fixes."
        ),
    )
    parser.add_argument(
        "prompt",
        nargs="?",
        help="What you want implemented (same as dev-sim)",
    )
    parser.add_argument("-p", "--prompt-file", type=Path, help="Read initial prompt from file")
    parser.add_argument(
        "-w",
        "--workspace",
        type=Path,
        help="Working directory for repos (default: ./.dev-sim-workspace)",
    )
    parser.add_argument(
        "-m",
        "--model",
        default=None,
        help="Claude model id (default from ANTHROPIC_MODEL / built-in)",
    )
    parser.add_argument("--max-turns", type=int, default=60, help="Max turns for the first coding pass")
    parser.add_argument(
        "--followup-max-turns",
        type=int,
        default=60,
        help="Max turns for the follow-up coding pass after review",
    )
    parser.add_argument("--repo-registry", type=Path, help=f"Repo registry JSON (default: ./{DEFAULT_REPO_REGISTRY})")
    parser.add_argument(
        "--review-model",
        default=None,
        help="K2 model id for review (default from K2_REVIEW_MODEL / built-in)",
    )
    parser.add_argument(
        "--no-review-comment",
        action="store_true",
        help="Do not post the K2 review as a GitHub issue comment (review still runs)",
    )
    parser.add_argument(
        "--always-followup",
        action="store_true",
        help="Run the second coding pass even when the review verdict is approve",
    )
    parser.add_argument(
        "--max-diff-chars",
        type=int,
        default=200_000,
        help="Truncate PR unified diff for K2 context",
    )
    parser.add_argument(
        "--persona-role",
        choices=("backend", "frontend"),
        default=DEFAULT_CODING_PERSONA_ROLE,
        help="Coding passes: backend or frontend persona after operational prompt (default: backend)",
    )
    parser.add_argument(
        "--persona-seed",
        type=int,
        default=None,
        help="RNG seed for coding persona (both coding passes)",
    )
    parser.add_argument(
        "--review-persona-seed",
        type=int,
        default=None,
        help="RNG seed for tech-lead review persona (default: same as --persona-seed if set)",
    )
    parser.add_argument(
        "--personas-dir",
        type=Path,
        default=None,
        help="Directory with trait_pools.json (sets DEV_SIM_PERSONAS_DIR)",
    )
    parser.add_argument(
        "--no-agent-progress",
        action="store_true",
        help="Disable periodic progress logs for coding and review passes",
    )
    parser.add_argument(
        "--progress-interval",
        type=float,
        default=30.0,
        help="Seconds between progress announcements (default: 30)",
    )
    args = parser.parse_args()

    apply_personas_dir_from_cli(args.personas_dir)

    if args.prompt_file:
        text = args.prompt_file.read_text(encoding="utf-8").strip()
    elif args.prompt:
        text = args.prompt.strip()
    else:
        print("Provide a prompt as an argument or use --prompt-file.", file=sys.stderr)
        sys.exit(2)

    ws = workspace_root(args.workspace)
    gh = get_github_token()
    if not gh:
        print("GITHUB_TOKEN is required for PR creation, review, and follow-up.", file=sys.stderr)
        sys.exit(1)

    model = resolve_coding_model(args.model)
    k2_model = resolve_k2_review_model(args.review_model)
    reg = (
        args.repo_registry.expanduser().resolve()
        if args.repo_registry
        else (Path.cwd() / DEFAULT_REPO_REGISTRY).resolve()
    )

    coding_suffix, coding_persona_dict = coding_persona_bundle(args.persona_role, args.persona_seed)
    review_seed = (
        args.review_persona_seed
        if args.review_persona_seed is not None
        else args.persona_seed
    )
    review_prefix, review_persona_dict = review_persona_bundle(review_seed)
    prog = not args.no_agent_progress
    prog_iv = args.progress_interval

    print("--- Pass 1: coding agent ---", file=sys.stderr)
    print(f"Workspace: {ws}", file=sys.stderr)
    print(f"Repo registry: {reg}", file=sys.stderr)
    r1 = run_coding_agent(
        text,
        workspace=ws,
        model=model,
        max_turns=args.max_turns,
        github_token=gh,
        repo_registry_path=reg,
        persona_system_suffix=coding_suffix,
        persona_dict=coding_persona_dict,
        agent_progress=prog,
        progress_log_path=ws / "dev-sim-agents-progress.log",
        progress_interval_sec=prog_iv,
    )
    last_pr = r1.get("last_pr")
    if not last_pr or not last_pr.get("number"):
        print(
            "Orchestrator: coding pass did not call create_github_pull_request successfully. "
            "Cannot run automated review. (stop=%s)" % r1.get("stop"),
            file=sys.stderr,
        )
        sys.exit(3)

    owner, repo = str(last_pr["owner"]), str(last_pr["repo"])
    prn = int(last_pr["number"])
    html_url = str(last_pr.get("html_url") or f"https://github.com/{owner}/{repo}/pull/{prn}")

    print(f"--- Pass 2: K2 review on {owner}/{repo}#{prn} ---", file=sys.stderr)
    review_out = compute_k2_pr_review(
        gh,
        owner,
        repo,
        prn,
        model=k2_model,
        max_diff_chars=args.max_diff_chars,
        include_json_in_comment=True,
        persona_system_prefix=review_prefix,
        persona_dict=review_persona_dict,
        agent_progress=prog,
        progress_log_path=ws / "dev-sim-agents-progress.log",
        progress_interval_sec=prog_iv,
    )
    if not review_out.get("ok"):
        print(f"K2 review failed: {review_out.get('error')}", file=sys.stderr)
        sys.exit(4)

    review = review_out.get("review")
    raw_model = str(review_out.get("raw_model") or "")
    comment_md = str(review_out.get("comment_markdown") or "")

    if not args.no_review_comment:
        posted = post_pr_issue_comment(gh, owner, repo, prn, comment_md)
        if isinstance(posted, str):
            print(f"Warning: failed to post review comment: {posted}", file=sys.stderr)
        else:
            u = posted.get("html_url", "")
            print(f"Posted review comment: {u}" if u else "Posted review comment.", file=sys.stderr)
    else:
        print("(Skipping GitHub review comment; --no-review-comment)", file=sys.stderr)

    verdict = (review or {}).get("verdict") if review else None
    skip_followup = verdict == "approve" and not args.always_followup

    if skip_followup:
        print(
            "--- Pass 3: skipped (review verdict is approve; use --always-followup to run coding agent again) ---",
            file=sys.stderr,
        )
        return

    print("--- Pass 3: coding agent (apply review) ---", file=sys.stderr)
    follow = _followup_prompt(
        owner=owner,
        repo=repo,
        number=prn,
        html_url=html_url,
        review=review if isinstance(review, dict) else None,
        raw_model=raw_model,
    )
    run_coding_agent(
        follow,
        workspace=ws,
        model=model,
        max_turns=args.followup_max_turns,
        github_token=gh,
        repo_registry_path=reg,
        persona_system_suffix=coding_suffix,
        persona_dict=coding_persona_dict,
        agent_progress=prog,
        progress_log_path=ws / "dev-sim-agents-progress.log",
        progress_interval_sec=prog_iv,
    )


if __name__ == "__main__":
    main()