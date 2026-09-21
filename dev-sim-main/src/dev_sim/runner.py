"""Full pipeline: plan a project idea, then run each sprint through the 3-pass orchestrate flow."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from dev_sim.coding_agent import run_coding_agent, workspace_root
from dev_sim.config import (
    DEFAULT_CODING_PERSONA_ROLE,
    DEFAULT_REPO_REGISTRY,
    get_anthropic_api_key,
    get_github_token,
    load_env,
    resolve_coding_model,
    resolve_k2_review_model,
)
from dev_sim.orchestrate import _followup_prompt
from dev_sim.personas_bridge import (
    apply_personas_dir_from_cli,
    coding_persona_bundle,
    review_persona_bundle,
)
from dev_sim.planner import run_planning_agent
from dev_sim.review_agent import compute_k2_pr_review, post_pr_issue_comment


def _run_sprint(
    sprint: dict[str, Any],
    *,
    ws: Path,
    model: str,
    k2_model: str,
    gh: str,
    reg: Path,
    max_turns: int,
    followup_max_turns: int,
    max_diff_chars: int,
    always_followup: bool,
    no_review_comment: bool,
    coding_suffix: str,
    coding_persona_dict: dict[str, Any],
    review_prefix: str,
    review_persona_dict: dict[str, Any],
    prog: bool,
    prog_iv: float,
) -> None:
    number = sprint.get("number", "?")
    title = sprint.get("title", "")
    prompt = sprint["prompt"]

    print(f"\n{'='*60}", file=sys.stderr)
    print(f"Sprint {number}: {title}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    print(f"--- Sprint {number} / Pass 1: coding agent ---", file=sys.stderr)
    r1 = run_coding_agent(
        prompt,
        workspace=ws,
        model=model,
        max_turns=max_turns,
        github_token=gh,
        repo_registry_path=reg,
        persona_system_suffix=coding_suffix,
        persona_dict=coding_persona_dict,
        agent_progress=prog,
        progress_log_path=ws / "dev-sim-agent-progress.log",
        progress_interval_sec=prog_iv,
    )

    last_pr = r1.get("last_pr")
    if not last_pr or not last_pr.get("number"):
        print(
            f"Sprint {number}: coding pass did not open a PR (stop={r1.get('stop')}). Skipping review.",
            file=sys.stderr,
        )
        return

    owner, repo = str(last_pr["owner"]), str(last_pr["repo"])
    prn = int(last_pr["number"])
    html_url = str(last_pr.get("html_url") or f"https://github.com/{owner}/{repo}/pull/{prn}")

    print(f"--- Sprint {number} / Pass 2: K2 review on {owner}/{repo}#{prn} ---", file=sys.stderr)
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
        progress_log_path=ws / "dev-sim-review-progress.log",
        progress_interval_sec=prog_iv,
    )
    if not review_out.get("ok"):
        print(f"Sprint {number}: K2 review failed: {review_out.get('error')}", file=sys.stderr)
        return

    review = review_out.get("review")
    raw_model = str(review_out.get("raw_model") or "")
    comment_md = str(review_out.get("comment_markdown") or "")

    if not no_review_comment:
        posted = post_pr_issue_comment(gh, owner, repo, prn, comment_md)
        if isinstance(posted, str):
            print(f"Sprint {number}: warning posting review comment: {posted}", file=sys.stderr)
        else:
            u = posted.get("html_url", "")
            print(f"Posted review comment: {u}" if u else "Posted review comment.", file=sys.stderr)

    verdict = (review or {}).get("verdict") if review else None
    if verdict == "approve" and not always_followup:
        print(f"--- Sprint {number} / Pass 3: skipped (verdict=approve) ---", file=sys.stderr)
        return

    print(f"--- Sprint {number} / Pass 3: coding agent (apply review) ---", file=sys.stderr)
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
        max_turns=followup_max_turns,
        github_token=gh,
        repo_registry_path=reg,
        persona_system_suffix=coding_suffix,
        persona_dict=coding_persona_dict,
        agent_progress=prog,
        progress_log_path=ws / "dev-sim-agent-progress.log",
        progress_interval_sec=prog_iv,
    )


def main() -> None:
    load_env()
    parser = argparse.ArgumentParser(
        description="Plan a project idea into sprints, then run each sprint through the full orchestrate flow.",
    )
    parser.add_argument("idea", nargs="?", help="Free-form project description")
    parser.add_argument("-f", "--idea-file", type=Path, help="Read idea from file")
    parser.add_argument(
        "--sprints-file",
        type=Path,
        default=None,
        help="Skip planning and load sprints from a JSON file (output of dev-sim-plan)",
    )
    parser.add_argument("-m", "--model", default=None, help="Claude model id (coding passes only)")
    parser.add_argument(
        "--planning-model",
        default=None,
        help="K2 model id for sprint planning (default: K2_REVIEW_MODEL env, then built-in)",
    )
    parser.add_argument("--planning-prompt", type=Path, default=None, help="Path to planning system prompt")
    parser.add_argument("-w", "--workspace", type=Path, help="Working directory for repos")
    parser.add_argument("--max-turns", type=int, default=60)
    parser.add_argument("--followup-max-turns", type=int, default=60)
    parser.add_argument("--repo-registry", type=Path)
    parser.add_argument("--review-model", default=None)
    parser.add_argument("--no-review-comment", action="store_true")
    parser.add_argument("--always-followup", action="store_true")
    parser.add_argument("--max-diff-chars", type=int, default=200_000)
    parser.add_argument("--persona-role", choices=("backend", "frontend"), default=DEFAULT_CODING_PERSONA_ROLE)
    parser.add_argument("--persona-seed", type=int, default=None)
    parser.add_argument("--review-persona-seed", type=int, default=None)
    parser.add_argument("--personas-dir", type=Path, default=None)
    parser.add_argument("--no-agent-progress", action="store_true")
    parser.add_argument("--progress-interval", type=float, default=30.0)
    parser.add_argument(
        "--only-sprint",
        type=int,
        default=None,
        help="Run only this sprint number (useful for retrying a failed sprint)",
    )
    args = parser.parse_args()

    apply_personas_dir_from_cli(args.personas_dir)

    gh = get_github_token()
    if not gh:
        print("GITHUB_TOKEN is required.", file=sys.stderr)
        sys.exit(1)

    if not args.sprints_file and not get_anthropic_api_key():
        print("ANTHROPIC_API_KEY is required for planning (use --sprints-file to skip).", file=sys.stderr)
        sys.exit(1)

    # --- Resolve sprints ---
    if args.sprints_file:
        sprints = json.loads(args.sprints_file.read_text(encoding="utf-8"))
        print(f"Loaded {len(sprints)} sprint(s) from {args.sprints_file}", file=sys.stderr)
    else:
        if args.idea_file:
            idea = args.idea_file.read_text(encoding="utf-8").strip()
        elif args.idea:
            idea = args.idea.strip()
        else:
            print("Provide an idea as an argument, --idea-file, or --sprints-file.", file=sys.stderr)
            sys.exit(2)

        print("--- Planning (Claude) ---", file=sys.stderr)
        sprints = run_planning_agent(
            idea,
            model=args.planning_model,
            planning_prompt_path=args.planning_prompt,
        )
        print(f"\nPlanned {len(sprints)} sprint(s).", file=sys.stderr)

    if args.only_sprint is not None:
        sprints = [s for s in sprints if s.get("number") == args.only_sprint]
        if not sprints:
            print(f"No sprint with number {args.only_sprint} found.", file=sys.stderr)
            sys.exit(2)

    ws = workspace_root(args.workspace)
    model = resolve_coding_model(args.model)
    k2_model = resolve_k2_review_model(args.review_model)
    reg = (
        args.repo_registry.expanduser().resolve()
        if args.repo_registry
        else (Path.cwd() / DEFAULT_REPO_REGISTRY).resolve()
    )
    coding_suffix, coding_persona_dict = coding_persona_bundle(args.persona_role, args.persona_seed)
    review_seed = args.review_persona_seed if args.review_persona_seed is not None else args.persona_seed
    review_prefix, review_persona_dict = review_persona_bundle(review_seed)
    prog = not args.no_agent_progress

    for sprint in sprints:
        _run_sprint(
            sprint,
            ws=ws,
            model=model,
            k2_model=k2_model,
            gh=gh,
            reg=reg,
            max_turns=args.max_turns,
            followup_max_turns=args.followup_max_turns,
            max_diff_chars=args.max_diff_chars,
            always_followup=args.always_followup,
            no_review_comment=args.no_review_comment,
            coding_suffix=coding_suffix,
            coding_persona_dict=coding_persona_dict,
            review_prefix=review_prefix,
            review_persona_dict=review_persona_dict,
            prog=prog,
            prog_iv=args.progress_interval,
        )


if __name__ == "__main__":
    main()
