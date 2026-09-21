"""Mirror the agent workspace clone into ``TARGET_GITHUB_REPO`` (hackathon demo export)."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

K_TARGET_GITHUB_REPO = "TARGET_GITHUB_REPO"
EXPORT_BRANCH = "devsim/hackathon-export"


def _parse_target_slug(raw: str) -> tuple[str, str] | None:
    s = (raw or "").strip().removeprefix("https://github.com/").removeprefix("http://github.com/")
    s = s.removesuffix(".git")
    if "/" not in s:
        return None
    owner, repo = s.split("/", 1)
    owner, repo = owner.strip(), repo.strip().removesuffix(".git")
    if not owner or not repo or ".." in owner or ".." in repo:
        return None
    return owner, repo


def _git_run(cwd: Path, args: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
        env={**os.environ, **(env or {})},
    )


def find_workspace_clone(workspace: Path, owner: str, repo: str) -> Path | None:
    """Return the workspace subdirectory whose ``origin`` matches ``owner/repo``."""
    if not workspace.is_dir():
        return None
    needle = f"github.com/{owner}/{repo}".lower()
    for child in sorted(workspace.iterdir()):
        if not child.is_dir() or not (child / ".git").is_dir():
            continue
        r = _git_run(child, ["remote", "get-url", "origin"])
        url = (r.stdout or "").strip().lower()
        if r.returncode != 0 or not url:
            continue
        u = url.replace(".git", "")
        if needle in u:
            return child
    return None


def _copy_tree_skip_git(src: Path, dst: Path) -> int:
    """Copy files from ``src`` to ``dst`` (existing); skip ``.git``. Returns file count."""
    n = 0
    for root, dirs, files in os.walk(src, topdown=True):
        dirs[:] = [d for d in dirs if d != ".git"]
        rel = Path(root).relative_to(src)
        for name in files:
            if name == ".git":
                continue
            sp = Path(root) / name
            dp = dst / rel / name
            dp.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(sp, dp)
            n += 1
    return n


def push_workspace_to_target(
    *,
    workspace: Path,
    pr_owner: str,
    pr_repo: str,
    github_token: str,
    project_name: str,
) -> dict[str, Any]:
    """
    Clone ``TARGET_GITHUB_REPO``, mirror files from the PR workspace clone, commit, push branch.

    If ``TARGET_GITHUB_REPO`` is unset or matches the PR repo, returns a skip dict (no-op).
    """
    raw_target = (os.environ.get(K_TARGET_GITHUB_REPO) or "").strip()
    if not raw_target:
        return {"ok": True, "skipped": True, "reason": "TARGET_GITHUB_REPO is not set."}

    parsed = _parse_target_slug(raw_target)
    if not parsed:
        return {"ok": False, "error": f"Invalid TARGET_GITHUB_REPO: {raw_target!r} (expected owner/repo)."}

    t_owner, t_repo = parsed
    if (t_owner.lower(), t_repo.lower()) == (pr_owner.lower(), pr_repo.lower()):
        return {
            "ok": True,
            "skipped": True,
            "reason": "TARGET_GITHUB_REPO matches the PR repository; code is already on GitHub.",
        }

    source = find_workspace_clone(workspace, pr_owner, pr_repo)
    if not source:
        return {
            "ok": False,
            "error": f"Could not find a git clone under {workspace} for {pr_owner}/{pr_repo}.",
        }

    token = (github_token or "").strip()
    if not token:
        return {"ok": False, "error": "GITHUB_TOKEN is empty."}

    authed = f"https://x-access-token:{token}@github.com/{t_owner}/{t_repo}.git"
    tmp = Path(tempfile.mkdtemp(prefix="devsim-push-"))
    dest = tmp / "repo"
    try:
        r0 = subprocess.run(
            ["git", "clone", "--depth", "1", authed, str(dest)],
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        if r0.returncode != 0:
            return {
                "ok": False,
                "error": f"git clone failed: {(r0.stderr or r0.stdout or '').strip()[:800]}",
            }

        r_branch = _git_run(dest, ["checkout", "-B", EXPORT_BRANCH])
        if r_branch.returncode != 0:
            return {"ok": False, "error": f"git checkout -B failed: {r_branch.stderr}"}

        # Remove tracked tree (keep .git)
        for item in list(dest.iterdir()):
            if item.name == ".git":
                continue
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
            else:
                try:
                    item.unlink()
                except OSError:
                    pass

        copied = _copy_tree_skip_git(source, dest)
        if copied == 0:
            return {"ok": True, "skipped": True, "reason": "No files copied from workspace (empty?)."}

        msg = f"DevSim Agent: Completed Sprint for {project_name.strip() or pr_repo}"
        author = "DevSim Agent <devsim@local>"
        env = {
            "GIT_AUTHOR_NAME": "DevSim Agent",
            "GIT_AUTHOR_EMAIL": "devsim@local",
            "GIT_COMMITTER_NAME": "DevSim Agent",
            "GIT_COMMITTER_EMAIL": "devsim@local",
        }
        _git_run(dest, ["config", "user.email", "devsim@local"])
        _git_run(dest, ["config", "user.name", "DevSim Agent"])

        r1 = _git_run(dest, ["add", "-A"])
        if r1.returncode != 0:
            return {"ok": False, "error": f"git add failed: {r1.stderr}"}

        r2 = _git_run(dest, ["commit", "-m", msg], env=env)
        if r2.returncode != 0 and "nothing to commit" not in (r2.stdout + r2.stderr).lower():
            return {"ok": False, "error": f"git commit failed: {(r2.stderr or r2.stdout)[:800]}"}
        if r2.returncode != 0:
            return {"ok": True, "skipped": True, "reason": "Nothing to commit after copy."}

        r3 = _git_run(
            dest,
            ["push", "-u", "origin", EXPORT_BRANCH, "--force-with-lease"],
        )
        if r3.returncode != 0:
            return {
                "ok": False,
                "error": f"git push failed: {(r3.stderr or r3.stdout or '').strip()[:1200]}",
            }

        return {
            "ok": True,
            "skipped": False,
            "branch": EXPORT_BRANCH,
            "target": f"{t_owner}/{t_repo}",
            "filesCopied": copied,
            "commitMessage": msg,
            "url": f"https://github.com/{t_owner}/{t_repo}/tree/{EXPORT_BRANCH}",
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


__all__ = ["find_workspace_clone", "push_workspace_to_target", "EXPORT_BRANCH", "K_TARGET_GITHUB_REPO"]
