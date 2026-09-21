"""CLI: review a GitHub pull request with K2 and post an issue comment."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from dev_sim.config import get_github_token, load_env, resolve_k2_review_model
from dev_sim.review_agent import run_k2_pr_review


def main() -> None:
    load_env()
    p = argparse.ArgumentParser(
        description="Fetch a PR diff, run K2 Think code review, and post a comment on the PR.",
    )
    p.add_argument("owner", help="GitHub org or user (repository owner)")
    p.add_argument("repo", help="Repository name")
    p.add_argument(
        "pull_number",
        type=int,
        help="Pull request number",
    )
    p.add_argument(
        "-m",
        "--model",
        default=None,
        help="K2 model id (overrides K2_REVIEW_MODEL env; default from config)",
    )
    p.add_argument(
        "--no-post",
        action="store_true",
        help="Print the comment to stdout and do not post to GitHub",
    )
    p.add_argument(
        "--max-diff-chars",
        type=int,
        default=200_000,
        help="Truncate unified diff to this many characters (default: 200000)",
    )
    p.add_argument(
        "--no-json-in-comment",
        action="store_true",
        help="Omit the collapsible raw CodeReviewResult JSON from the comment body",
    )
    p.add_argument(
        "--persona-seed",
        type=int,
        default=None,
        help="RNG seed for reproducible tech-lead review persona",
    )
    p.add_argument(
        "--personas-dir",
        type=Path,
        default=None,
        help="Directory with trait_pools.json (sets DEV_SIM_PERSONAS_DIR)",
    )
    p.add_argument(
        "--no-agent-progress",
        action="store_true",
        help="Disable periodic progress announcements and review progress log",
    )
    p.add_argument(
        "--progress-log",
        type=Path,
        default=None,
        help="Append progress log here (default: ./.dev-sim-workspace/dev-sim-agents-progress.log)",
    )
    p.add_argument(
        "--progress-interval",
        type=float,
        default=30.0,
        help="Seconds between progress announcements (default: 30)",
    )
    args = p.parse_args()

    from dev_sim.personas_bridge import apply_personas_dir_from_cli, review_persona_bundle

    apply_personas_dir_from_cli(args.personas_dir)
    token = get_github_token()
    if not token:
        print("GITHUB_TOKEN is required in the environment (or .env).", file=sys.stderr)
        sys.exit(1)
    model = resolve_k2_review_model(args.model)
    prefix, persona_dict = review_persona_bundle(args.persona_seed)
    run_k2_pr_review(
        token,
        args.owner,
        args.repo,
        args.pull_number,
        model=model,
        post_comment=not args.no_post,
        max_diff_chars=args.max_diff_chars,
        include_json=not args.no_json_in_comment,
        persona_system_prefix=prefix,
        persona_dict=persona_dict,
        agent_progress=not args.no_agent_progress,
        progress_log_path=args.progress_log,
        progress_interval_sec=args.progress_interval,
    )


if __name__ == "__main__":
    main()
