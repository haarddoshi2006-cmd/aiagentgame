"""Coding agent: Anthropic tool-calling loop for Git, GitHub, and repo registry.

The `dev-sim` CLI in `dev_sim.cli` loads environment variables and calls `run_coding_agent()`.
This module owns system prompts, tool schemas, tool execution, and the Messages API loop.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import anthropic
import httpx

from dev_sim.agent_progress import AgentProgressLogger, ProgressAnnouncer
from dev_sim.config import get_anthropic_api_key, load_env

# Intentionally omits log/status/branch/show/diff-style archaeology — use read_workspace_file to read files.
ALLOWED_GIT_SUBCOMMANDS = frozenset(
    {
        "init",
        "clone",
        "add",
        "commit",
        "push",
        "pull",
        "remote",
        "checkout",
        "config",
        "fetch",
        "merge",
        "mv",
        "rm",
    }
)

# Instructions and guardrails for the model; kept in code (not a file) so installs always match behavior.
SYSTEM_PROMPT = """You are a coding assistant with tools to create GitHub repositories, run git commands locally, and open pull requests for human review.

**Use as few tool calls as possible.** Prefer the coarse tools below over many small `run_git` steps.
`run_git` only allows: add, checkout, commit, push, pull, fetch, merge, remote, config, init, clone, mv, rm — **not** log, status, branch, show, or diff (those tools are unavailable on purpose).
There is **no** `list_workspace` tool. To read a file before editing, use **`read_workspace_file`**. Do not call `get_github_repository_metadata` before `prepare_repo_branch_for_work`; after `prepare_repo_branch_for_work` you already have `default_branch` for PRs. Avoid redundant reads of the same file.

Repo name registry (short name -> remote URL):
- When create_github_repository succeeds, the CLI automatically saves the GitHub repo `name` and HTTPS `clone_url` into the repo registry file (you do not need to call upsert_repo_registry_entry for that case).
- At the start of work involving a known project, call read_repo_registry to resolve friendly names to clone URLs.
- For extra aliases, manual URL fixes, or non-created remotes, use upsert_repo_registry_entry or remove_repo_registry_entry when the user asks.
- Use the URL from the registry with git_clone_repository or git_set_remote as appropriate.

General guidelines:
- Use create_github_repository when the user wants a new repo on GitHub. Prefer concise names and clear descriptions.
- After creating a repo, use git_clone_repository with the returned clone_url (use the https URL) into the workspace, or git_init_local + git_set_remote if you prefer a fresh init.
- **Multiple files:** use `write_workspace_files` (one call with a `files` array) instead of many `write_workspace_file` calls when you touch more than one path.
- **Single file:** `write_workspace_file` is fine.
- After edits: use `run_git` with add and commit (often one add of `.` and one commit is enough).
- For first push to a new empty repo, use branch name main unless the remote uses another default.
- Never echo or reveal API keys or tokens. If credentials are missing, explain what env vars are required.
- If a git command fails, read the error and adjust (e.g. set user.name / user.email with git config if commit requires them).

Pull request workflow (when the user wants a PR or standard team workflow):
1. Ensure you have a local clone (git_clone_repository) with origin pointing at github.com.
2. **One tool —** call `prepare_repo_branch_for_work` with `repo_subdir` and `feature_branch` (e.g. feature/add-readme). It fetches origin, checks out the remote default branch, pulls, and creates your feature branch. Do **not** replace this with separate get_github_repository_metadata + multiple run_git calls unless it fails and you must recover manually.
3. Make edits under the repo subdirectory; prefer `write_workspace_files` when changing several files.
4. **One tool —** call `push_feature_branch` with `repo_subdir` and `branch` to embed the GitHub token for HTTPS (when set) and `git push -u origin <branch>`. Prefer this over rewrite_origin_for_github_token_push + run_git push as two steps.
5. Call `create_github_pull_request` with repo_subdir, head_branch = your feature branch, and **base_branch** copied from the `default_branch` field returned by `prepare_repo_branch_for_work` (keep it in memory—do not call `get_github_repository_metadata` just to re-fetch the same value). Use draft true only if the user asked for a draft.
6. After the PR is opened, give the user the PR html_url. Do not merge or approve PRs via API or git merge to main; a human will review and merge on GitHub.

Direct push to main without a PR: only when the user explicitly asks to skip the PR workflow.
"""


# ---------------------------------------------------------------------------
# Workspace layout
# ---------------------------------------------------------------------------


def workspace_root(workdir: Path | None) -> Path:
    base = workdir.expanduser().resolve() if workdir else Path.cwd() / ".dev-sim-workspace"
    base.mkdir(parents=True, exist_ok=True)
    return base


# ---------------------------------------------------------------------------
# Anthropic "tools" — JSON Schema fragments passed to messages.create(tools=...)
# ---------------------------------------------------------------------------


def _tool_specs() -> list[dict[str, Any]]:
    return [
        {
            "name": "create_github_repository",
            "description": "Create a new repository for the authenticated GitHub user.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Repository name (e.g. my-project)",
                    },
                    "description": {"type": "string", "description": "Short description"},
                    "private": {
                        "type": "boolean",
                        "description": "Whether the repo should be private",
                    },
                },
                "required": ["name"],
            },
        },
        {
            "name": "git_clone_repository",
            "description": "Clone a remote repository into the workspace (under a subdirectory).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "clone_url": {
                        "type": "string",
                        "description": "HTTPS or SSH clone URL",
                    },
                    "target_dir": {
                        "type": "string",
                        "description": "Directory name under the workspace (no path traversal)",
                    },
                },
                "required": ["clone_url", "target_dir"],
            },
        },
        {
            "name": "git_init_local",
            "description": "Run git init in a subdirectory of the workspace.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "target_dir": {
                        "type": "string",
                        "description": "Directory under workspace to initialize",
                    },
                },
                "required": ["target_dir"],
            },
        },
        {
            "name": "git_set_remote",
            "description": "Set origin URL for a repo under the workspace.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo_subdir": {
                        "type": "string",
                        "description": "Repo root relative to workspace",
                    },
                    "url": {"type": "string", "description": "Remote URL (typically https)"},
                },
                "required": ["repo_subdir", "url"],
            },
        },
        {
            "name": "run_git",
            "description": (
                f"Run git in a subdirectory of the workspace. Allowed first argument must be one of: "
                f"{', '.join(sorted(ALLOWED_GIT_SUBCOMMANDS))}. Prefer coarse tools "
                f"(prepare_repo_branch_for_work, push_feature_branch) for the standard PR workflow."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo_subdir": {
                        "type": "string",
                        "description": "Repository root relative to workspace",
                    },
                    "args": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Git arguments after `git`, e.g. [\"add\", \".\"]",
                    },
                },
                "required": ["repo_subdir", "args"],
            },
        },
        {
            "name": "prepare_repo_branch_for_work",
            "description": (
                "After clone: fetch origin, check out the remote default branch, fast-forward pull from "
                "origin, then create and check out feature_branch. Prefer this over separate "
                "get_github_repository_metadata + multiple run_git calls. Returns default_branch for PR base."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo_subdir": {
                        "type": "string",
                        "description": "Repository root relative to workspace",
                    },
                    "feature_branch": {
                        "type": "string",
                        "description": "New branch to create from updated default (e.g. feature/add-readme)",
                    },
                },
                "required": ["repo_subdir", "feature_branch"],
            },
        },
        {
            "name": "push_feature_branch",
            "description": (
                "Rewrite origin for HTTPS token push (when GITHUB_TOKEN is set) and run "
                "`git push -u origin <branch>`. Prefer this over rewrite_origin_for_github_token_push "
                "plus a separate run_git push."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo_subdir": {
                        "type": "string",
                        "description": "Repository root relative to workspace",
                    },
                    "branch": {
                        "type": "string",
                        "description": "Branch name to push (must match your current branch)",
                    },
                },
                "required": ["repo_subdir", "branch"],
            },
        },
        {
            "name": "write_workspace_file",
            "description": (
                "Create or overwrite a file under the workspace. Parent directories are created."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "relative_path": {
                        "type": "string",
                        "description": "Path relative to workspace root",
                    },
                    "content": {"type": "string", "description": "Full file contents"},
                },
                "required": ["relative_path", "content"],
            },
        },
        {
            "name": "write_workspace_files",
            "description": (
                "Create or overwrite several files under the workspace in one call. "
                "Prefer this over multiple write_workspace_file calls when you touch more than one path."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "relative_path": {
                                    "type": "string",
                                    "description": "Path relative to workspace root",
                                },
                                "content": {"type": "string", "description": "Full file contents"},
                            },
                            "required": ["relative_path", "content"],
                        },
                        "description": "Up to 40 files per call",
                    },
                },
                "required": ["files"],
            },
        },
        {
            "name": "read_workspace_file",
            "description": (
                "Read a UTF-8 text file under the workspace (for inspecting code before editing). "
                "Prefer this over trying to read files through git. Large files are truncated."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "relative_path": {
                        "type": "string",
                        "description": "Path relative to workspace root",
                    },
                },
                "required": ["relative_path"],
            },
        },
        {
            "name": "rewrite_origin_for_github_token_push",
            "description": (
                "Rewrite git remote origin to use HTTPS with the token from the GITHUB_TOKEN "
                "environment variable so git push works non-interactively. Prefer push_feature_branch "
                "for the usual feature-branch push; use this only for custom flows."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo_subdir": {
                        "type": "string",
                        "description": "Repository root relative to workspace",
                    },
                },
                "required": ["repo_subdir"],
            },
        },
        {
            "name": "get_github_repository_metadata",
            "description": (
                "Last resort: GitHub API metadata (default_branch, etc.) from origin. **Do not** use "
                "for the normal PR flow if you already ran prepare_repo_branch_for_work (it returns "
                "default_branch). Only call if prepare failed or you are fixing a broken clone by hand."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo_subdir": {
                        "type": "string",
                        "description": "Repository root relative to workspace",
                    },
                },
                "required": ["repo_subdir"],
            },
        },
        {
            "name": "create_github_pull_request",
            "description": (
                "Open a pull request on github.com for the repo in repo_subdir (origin must be "
                "github.com). Same-repo workflow: head_branch is the branch name pushed to origin. "
                "base_branch must match default_branch from prepare_repo_branch_for_work."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "repo_subdir": {
                        "type": "string",
                        "description": "Repository root relative to workspace",
                    },
                    "head_branch": {
                        "type": "string",
                        "description": "Source branch name (exists on origin)",
                    },
                    "base_branch": {
                        "type": "string",
                        "description": "Target branch (e.g. main); use default_branch from prepare_repo_branch_for_work",
                    },
                    "title": {"type": "string", "description": "PR title"},
                    "body": {"type": "string", "description": "PR description (markdown)"},
                    "draft": {
                        "type": "boolean",
                        "description": "If true, open as draft PR",
                    },
                },
                "required": ["repo_subdir", "head_branch", "base_branch", "title"],
            },
        },
        {
            "name": "read_repo_registry",
            "description": (
                "Read the repo registry JSON file: maps short names (keys) to git remote URLs "
                "(HTTPS or git@github.com). Use before cloning when the user refers to a project by name."
            ),
            "input_schema": {"type": "object", "properties": {}, "required": []},
        },
        {
            "name": "upsert_repo_registry_entry",
            "description": "Add or replace one entry in the repo registry (short name -> remote URL).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Short key, e.g. my-calculator (no path separators)",
                    },
                    "remote_url": {
                        "type": "string",
                        "description": "Clone URL (https://... or git@github.com:...)",
                    },
                },
                "required": ["name", "remote_url"],
            },
        },
        {
            "name": "remove_repo_registry_entry",
            "description": "Remove one short name from the repo registry if present.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short key to remove"},
                },
                "required": ["name"],
            },
        },
    ]


# ---------------------------------------------------------------------------
# Path safety — all tool paths that touch disk should go through here
# ---------------------------------------------------------------------------


def _resolve_under_workspace(workspace: Path, rel: str) -> Path:
    rel_norm = rel.replace("\\", "/").lstrip("/")
    if ".." in Path(rel_norm).parts:
        raise ValueError("path must stay within workspace")
    path = (workspace / rel_norm).resolve()
    try:
        path.relative_to(workspace)
    except ValueError as e:
        raise ValueError("path escapes workspace") from e
    return path


# ---------------------------------------------------------------------------
# Repo registry — JSON file mapping short names to clone URLs (outside workspace)
# ---------------------------------------------------------------------------


def _registry_repos_from_doc(data: Any) -> dict[str, str]:
    """Normalize file contents to a str->str map."""
    if not isinstance(data, dict):
        return {}
    inner = data.get("repos")
    if isinstance(inner, dict):
        return {
            str(k): str(v)
            for k, v in inner.items()
            if isinstance(k, str) and isinstance(v, str) and not k.startswith("_")
        }
    # Flat legacy object of string keys only (no nested repos key).
    return {
        str(k): str(v)
        for k, v in data.items()
        if isinstance(k, str) and isinstance(v, str) and not str(k).startswith("_")
    }


def _load_repo_registry(path: Path) -> dict[str, Any]:
    """Load registry from disk; missing file yields empty repos."""
    if not path.exists():
        return {"ok": True, "repos": {}, "registry_path": str(path), "note": "file does not exist yet"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return {"ok": False, "error": str(e), "registry_path": str(path)}
    repos = _registry_repos_from_doc(data)
    return {"ok": True, "repos": repos, "registry_path": str(path)}


def _save_repo_registry(path: Path, repos: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"repos": dict(sorted(repos.items(), key=lambda kv: kv[0].lower()))}
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def _persist_created_repo_to_registry(
    registry_path: Path, created: dict[str, Any]
) -> dict[str, Any]:
    """Merge a newly created GitHub repo into the registry under its API name (HTTPS clone_url)."""
    if not created.get("ok"):
        return {"registry_saved": False, "registry_skip_reason": "create did not succeed"}
    key = created.get("name")
    url = created.get("clone_url")
    if not key or not isinstance(key, str):
        return {"registry_saved": False, "registry_skip_reason": "missing repo name in API response"}
    if not url or not isinstance(url, str):
        return {"registry_saved": False, "registry_skip_reason": "missing clone_url in API response"}
    name_err = _validate_registry_name(key)
    url_err = _validate_remote_url(url)
    if name_err or url_err:
        return {
            "registry_saved": False,
            "registry_skip_reason": name_err or url_err,
        }
    try:
        loaded = _load_repo_registry(registry_path)
        if not loaded.get("ok"):
            return {
                "registry_saved": False,
                "registry_error": loaded.get("error", "failed to read registry"),
            }
        repos: dict[str, str] = dict(loaded["repos"])
        repos[key] = url.strip()
        _save_repo_registry(registry_path, repos)
    except OSError as e:
        return {"registry_saved": False, "registry_error": str(e)}
    return {
        "registry_saved": True,
        "registry_key": key,
        "registry_path": str(registry_path),
    }


def _validate_registry_name(name: str) -> str | None:
    if not name or not name.strip():
        return "name must be non-empty"
    if "/" in name or "\\" in name or name.strip() != name:
        return "name must not contain path separators or leading/trailing whitespace"
    if name in (".", "..") or ".." in name:
        return "invalid name"
    return None


def _validate_remote_url(url: str) -> str | None:
    u = url.strip()
    if not u:
        return "remote_url must be non-empty"
    if u.startswith("https://") or u.startswith("http://") or u.startswith("git@"):
        return None
    return "remote_url should start with https://, http://, or git@"


# ---------------------------------------------------------------------------
# GitHub REST (api.github.com) — shared pieces for create repo / metadata / PRs
# ---------------------------------------------------------------------------


def _github_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _parse_github_owner_repo_from_remote(url: str) -> tuple[str, str] | None:
    """Return (owner, repo) for github.com remotes, or None if the URL is not a simple owner/repo pair."""
    u = url.strip()
    if u.startswith("git@"):
        if not u.startswith("git@github.com:"):
            return None
        path = u.split(":", 1)[1].removesuffix(".git")
        parts = path.split("/")
        if len(parts) == 2 and parts[0] and parts[1]:
            return parts[0], parts[1]
        return None
    parsed = urlparse(u)
    if (parsed.hostname or "").lower() != "github.com":
        return None
    path = parsed.path.strip("/").removesuffix(".git")
    parts = path.split("/")
    if len(parts) == 2 and parts[0] and parts[1]:
        return parts[0], parts[1]
    return None


def _github_create_repo(
    token: str, name: str, description: str | None, private: bool
) -> dict[str, Any]:
    """Create a repo for the authenticated user (not org-owned without a different endpoint)."""
    url = "https://api.github.com/user/repos"
    body: dict[str, Any] = {"name": name, "private": private, "auto_init": False}
    if description:
        body["description"] = description
    r = httpx.post(
        url,
        headers=_github_headers(token),
        json=body,
        timeout=60.0,
    )
    if r.is_error:
        return {"ok": False, "status": r.status_code, "body": r.text[:4000]}
    data = r.json()
    return {
        "ok": True,
        "name": data.get("name"),
        "html_url": data.get("html_url"),
        "clone_url": data.get("clone_url"),
        "ssh_url": data.get("ssh_url"),
        "default_branch": data.get("default_branch"),
    }


def _rewrite_origin_github_token(repo: Path, token: str) -> dict[str, Any]:
    """Embed the PAT in the HTTPS URL so git push does not prompt (GitHub accepts x-access-token)."""
    cur = _run_git_subprocess(repo, ["remote", "get-url", "origin"])
    if cur["returncode"] != 0:
        return {"error": "no origin remote or failed to read", **cur}
    url = (cur.get("stdout") or "").strip()
    if not url.startswith("https://github.com/"):
        return {
            "ok": False,
            "message": "origin is not an https://github.com URL; configure SSH or auth yourself",
            "origin": url,
        }
    if "x-access-token" in url:
        return {"ok": True, "message": "origin already uses x-access-token URL", "origin": url}
    rest = url.removeprefix("https://github.com/")
    new_url = f"https://x-access-token:{token}@github.com/{rest}"
    return _run_git_subprocess(repo, ["remote", "set-url", "origin", new_url])


def _run_git_subprocess(
    cwd: Path, args: list[str], timeout: int = 120
) -> dict[str, Any]:
    """Run git with cwd set; stdout/stderr are truncated to keep tool_result payloads small."""
    try:
        p = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return {
            "returncode": p.returncode,
            "stdout": (p.stdout or "")[-8000:],
            "stderr": (p.stderr or "")[-8000:],
        }
    except subprocess.TimeoutExpired:
        return {"returncode": -1, "stdout": "", "stderr": "git command timed out"}


def _origin_github_owner_repo(repo: Path) -> dict[str, Any]:
    """Resolve owner/repo slug for REST paths from `git remote get-url origin`."""
    cur = _run_git_subprocess(repo, ["remote", "get-url", "origin"])
    if cur["returncode"] != 0:
        return {"error": "could not read git remote origin", "git": cur}
    origin = (cur.get("stdout") or "").strip()
    if not origin:
        return {"error": "empty git remote origin URL", "git": cur}
    parsed = _parse_github_owner_repo_from_remote(origin)
    if not parsed:
        safe = urlparse(origin)
        hint = (
            f"https://github.com{safe.path}"
            if (safe.hostname or "").lower() == "github.com"
            else "non-github or unrecognized origin"
        )
        return {"error": "origin is not a recognized github.com owner/repo URL", "hint": hint}
    owner, repo_name = parsed
    return {"ok": True, "owner": owner, "repo": repo_name}


def _github_get_repository_metadata(token: str, owner: str, repo: str) -> dict[str, Any]:
    """GET /repos/{owner}/{repo} — mainly for default_branch before opening a PR."""
    api_url = f"https://api.github.com/repos/{owner}/{repo}"
    r = httpx.get(api_url, headers=_github_headers(token), timeout=60.0)
    if r.is_error:
        return {"ok": False, "status": r.status_code, "body": r.text[:4000]}
    data = r.json()
    return {
        "ok": True,
        "default_branch": data.get("default_branch"),
        "html_url": data.get("html_url"),
        "name": data.get("name"),
        "full_name": data.get("full_name"),
        "private": data.get("private"),
    }


_MAX_WRITE_BATCH = 40
_MAX_WRITE_FILE_BYTES = 750_000


def _tool_prepare_repo_branch_for_work(
    workspace: Path,
    repo_subdir: str,
    feature_branch: str,
    github_token: str | None,
) -> dict[str, Any]:
    """Fetch, update default branch, create feature branch — replaces several git + metadata tools."""
    if not github_token:
        return {"ok": False, "error": "GITHUB_TOKEN is required."}
    fb = (feature_branch or "").strip()
    if not fb:
        return {"ok": False, "error": "feature_branch must be non-empty"}
    repo = _resolve_under_workspace(workspace, repo_subdir)
    slug = _origin_github_owner_repo(repo)
    if slug.get("error"):
        return {"ok": False, **slug}
    meta = _github_get_repository_metadata(github_token, str(slug["owner"]), str(slug["repo"]))
    if not meta.get("ok"):
        return {"ok": False, "metadata": meta}
    base = str(meta.get("default_branch") or "main").strip() or "main"

    steps: list[dict[str, Any]] = []

    def _step(args: list[str]) -> dict[str, Any]:
        r = _run_git_subprocess(repo, args)
        steps.append({"args": args, **r})
        return r

    r0 = _step(["fetch", "origin"])
    if r0.get("returncode") != 0:
        return {"ok": False, "default_branch": base, "failed_at": "fetch", "steps": steps}

    r1 = _step(["checkout", base])
    if r1.get("returncode") != 0:
        r1b = _step(["checkout", "-B", base, f"origin/{base}"])
        if r1b.get("returncode") != 0:
            return {"ok": False, "default_branch": base, "failed_at": "checkout_default", "steps": steps}

    r2 = _step(["pull", "--ff-only", "origin", base])
    if r2.get("returncode") != 0:
        return {"ok": False, "default_branch": base, "failed_at": "pull", "steps": steps}

    r3 = _step(["checkout", "-b", fb])
    if r3.get("returncode") != 0:
        return {"ok": False, "default_branch": base, "failed_at": "checkout_new_branch", "steps": steps}

    return {
        "ok": True,
        "default_branch": base,
        "feature_branch": fb,
        "repository": meta.get("full_name"),
        "html_url": meta.get("html_url"),
        "steps": steps,
    }


def _tool_write_workspace_files(workspace: Path, files_raw: Any) -> dict[str, Any]:
    if not isinstance(files_raw, list):
        return {"ok": False, "error": "files must be a list"}
    if len(files_raw) > _MAX_WRITE_BATCH:
        return {"ok": False, "error": f"at most {_MAX_WRITE_BATCH} files per call"}
    written: list[str] = []
    for i, item in enumerate(files_raw):
        if not isinstance(item, dict):
            return {"ok": False, "error": f"files[{i}] must be an object"}
        rel = item.get("relative_path")
        content = item.get("content")
        if not isinstance(rel, str) or not isinstance(content, str):
            return {"ok": False, "error": f"files[{i}] needs string relative_path and content"}
        if len(content.encode("utf-8")) > _MAX_WRITE_FILE_BYTES:
            return {"ok": False, "error": f"files[{i}] exceeds max size"}
        path = _resolve_under_workspace(workspace, rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        written.append(rel)
    return {"ok": True, "written": written, "count": len(written)}


def _tool_push_feature_branch(
    workspace: Path,
    repo_subdir: str,
    branch: str,
    github_token: str | None,
) -> dict[str, Any]:
    br = (branch or "").strip()
    if not br:
        return {"ok": False, "error": "branch must be non-empty"}
    repo = _resolve_under_workspace(workspace, repo_subdir)
    cur = _run_git_subprocess(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    head = (cur.get("stdout") or "").strip()
    if cur.get("returncode") != 0:
        return {"ok": False, "error": "could not read current branch", "git": cur}
    if head != br:
        return {
            "ok": False,
            "error": f"current branch is {head!r}, expected {br!r}; checkout the feature branch first",
        }
    steps: list[dict[str, Any]] = []
    if github_token:
        rw = _rewrite_origin_github_token(repo, github_token)
        steps.append({"step": "rewrite_origin", **rw})
        if rw.get("returncode") is not None and rw.get("returncode") != 0:
            return {"ok": False, "failed_at": "rewrite_origin", "steps": steps}
        if rw.get("ok") is False and rw.get("returncode") is None:
            return {"ok": False, "failed_at": "rewrite_origin", "steps": steps}
    push = _run_git_subprocess(repo, ["push", "-u", "origin", br])
    steps.append({"step": "push", "args": ["push", "-u", "origin", br], **push})
    if push.get("returncode") != 0:
        return {"ok": False, "failed_at": "push", "steps": steps}
    return {"ok": True, "branch": br, "steps": steps}


def _github_create_pull_request(
    token: str,
    owner: str,
    repo: str,
    title: str,
    head_branch: str,
    base_branch: str,
    body: str | None,
    draft: bool,
) -> dict[str, Any]:
    """POST /repos/{owner}/{repo}/pulls — same-repo PR: head is a branch name on origin."""
    api_url = f"https://api.github.com/repos/{owner}/{repo}/pulls"
    payload: dict[str, Any] = {
        "title": title,
        "head": head_branch,
        "base": base_branch,
        "draft": bool(draft),
    }
    if body:
        payload["body"] = body
    r = httpx.post(api_url, headers=_github_headers(token), json=payload, timeout=60.0)
    if r.is_error:
        return {"ok": False, "status": r.status_code, "body": r.text[:4000]}
    data = r.json()
    return {
        "ok": True,
        "number": data.get("number"),
        "html_url": data.get("html_url"),
        "state": data.get("state"),
        "title": data.get("title"),
    }


# ---------------------------------------------------------------------------
# Tool dispatcher — maps Claude tool names to git / HTTP / filesystem actions
# ---------------------------------------------------------------------------


def _execute_tool(
    name: str,
    tool_input: dict[str, Any],
    workspace: Path,
    github_token: str | None,
    repo_registry_path: Path,
) -> dict[str, Any]:
    """Run one tool; return a JSON-serializable dict (becomes tool_result content for the API)."""
    try:
        if name == "read_repo_registry":
            return _load_repo_registry(repo_registry_path)

        if name == "upsert_repo_registry_entry":
            key = str(tool_input["name"])
            url = str(tool_input["remote_url"])
            err = _validate_registry_name(key) or _validate_remote_url(url)
            if err:
                return {"error": err}
            loaded = _load_repo_registry(repo_registry_path)
            if not loaded.get("ok"):
                return loaded
            repos: dict[str, str] = dict(loaded["repos"])
            repos[key] = url.strip()
            _save_repo_registry(repo_registry_path, repos)
            return {
                "ok": True,
                "registry_path": str(repo_registry_path),
                "updated": key,
                "repos": repos,
            }

        if name == "remove_repo_registry_entry":
            key = str(tool_input["name"])
            err = _validate_registry_name(key)
            if err:
                return {"error": err}
            loaded = _load_repo_registry(repo_registry_path)
            if not loaded.get("ok"):
                return loaded
            repos = dict(loaded["repos"])
            existed = key in repos
            repos.pop(key, None)
            _save_repo_registry(repo_registry_path, repos)
            return {
                "ok": True,
                "registry_path": str(repo_registry_path),
                "removed": existed,
                "repos": repos,
            }

        if name == "create_github_repository":
            if not github_token:
                return {"error": "GITHUB_TOKEN is not set in the environment."}
            created = _github_create_repo(
                github_token,
                str(tool_input["name"]),
                tool_input.get("description"),
                bool(tool_input.get("private", False)),
            )
            if created.get("ok"):
                reg = _persist_created_repo_to_registry(repo_registry_path, created)
                return {**created, **reg}
            return created

        if name == "git_clone_repository":
            # Clone into workspace/<target_dir>; wipe existing dir so re-runs are deterministic.
            target = _resolve_under_workspace(workspace, str(tool_input["target_dir"]))
            if target.exists():
                shutil.rmtree(target)
            parent = target.parent
            parent.mkdir(parents=True, exist_ok=True)
            url = str(tool_input["clone_url"])
            res = _run_git_subprocess(parent, ["clone", url, target.name])
            return {"path": str(target), **res}

        if name == "git_init_local":
            target = _resolve_under_workspace(workspace, str(tool_input["target_dir"]))
            target.mkdir(parents=True, exist_ok=True)
            res = _run_git_subprocess(target, ["init"])
            return {"path": str(target), **res}

        if name == "git_set_remote":
            repo = _resolve_under_workspace(workspace, str(tool_input["repo_subdir"]))
            url = str(tool_input["url"])
            return _run_git_subprocess(repo, ["remote", "add", "origin", url])

        if name == "run_git":
            repo = _resolve_under_workspace(workspace, str(tool_input["repo_subdir"]))
            args = [str(a) for a in tool_input["args"]]
            if not args:
                return {"error": "args cannot be empty"}
            sub = args[0]
            if sub not in ALLOWED_GIT_SUBCOMMANDS:
                return {"error": f"git subcommand not allowed: {sub}"}
            return _run_git_subprocess(repo, args)

        if name == "write_workspace_file":
            path = _resolve_under_workspace(workspace, str(tool_input["relative_path"]))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(tool_input["content"]), encoding="utf-8")
            return {"ok": True, "path": str(path)}

        if name == "write_workspace_files":
            return _tool_write_workspace_files(workspace, tool_input.get("files"))

        if name == "prepare_repo_branch_for_work":
            return _tool_prepare_repo_branch_for_work(
                workspace,
                str(tool_input["repo_subdir"]),
                str(tool_input["feature_branch"]),
                github_token,
            )

        if name == "push_feature_branch":
            return _tool_push_feature_branch(
                workspace,
                str(tool_input["repo_subdir"]),
                str(tool_input["branch"]),
                github_token,
            )

        if name == "rewrite_origin_for_github_token_push":
            if not github_token:
                return {"error": "GITHUB_TOKEN is not set in the environment."}
            repo = _resolve_under_workspace(workspace, str(tool_input["repo_subdir"]))
            return _rewrite_origin_github_token(repo, github_token)

        if name == "get_github_repository_metadata":
            if not github_token:
                return {"error": "GITHUB_TOKEN is not set in the environment."}
            repo = _resolve_under_workspace(workspace, str(tool_input["repo_subdir"]))
            slug = _origin_github_owner_repo(repo)
            if slug.get("error"):
                return slug
            return _github_get_repository_metadata(
                github_token, str(slug["owner"]), str(slug["repo"])
            )

        if name == "create_github_pull_request":
            if not github_token:
                return {"error": "GITHUB_TOKEN is not set in the environment."}
            repo = _resolve_under_workspace(workspace, str(tool_input["repo_subdir"]))
            slug = _origin_github_owner_repo(repo)
            if slug.get("error"):
                return slug
            pr = _github_create_pull_request(
                github_token,
                str(slug["owner"]),
                str(slug["repo"]),
                str(tool_input["title"]),
                str(tool_input["head_branch"]),
                str(tool_input["base_branch"]),
                tool_input.get("body"),
                bool(tool_input.get("draft", False)),
            )
            if pr.get("ok"):
                pr = {
                    **pr,
                    "owner": str(slug["owner"]),
                    "repo": str(slug["repo"]),
                }
            return pr

        if name == "read_workspace_file":
            _max_read = 400_000
            path = _resolve_under_workspace(workspace, str(tool_input["relative_path"]))
            if not path.is_file():
                return {"ok": False, "error": "path is not a file or does not exist", "path": str(path)}
            raw = path.read_bytes()
            truncated = len(raw) > _max_read
            if truncated:
                raw = raw[:_max_read]
            text = raw.decode("utf-8", errors="replace")
            return {"ok": True, "path": str(path), "truncated": truncated, "content": text}

        return {"error": f"unknown tool: {name}"}
    except Exception as e:
        # Surface unexpected bugs to the model as structured errors instead of crashing the CLI.
        return {"error": str(e)}


def _block_type(block: Any) -> str:
    return getattr(block, "type", None) or (block.get("type") if isinstance(block, dict) else "")


_ASSISTANT_TEXT_CAP = 50_000


def _assistant_text_from_content(content: Any) -> str:
    """Join assistant text blocks from a Messages API ``content`` list (SDK objects or dicts)."""
    parts: list[str] = []
    for block in content or []:
        if _block_type(block) != "text":
            continue
        t = getattr(block, "text", None)
        if t is None and isinstance(block, dict):
            t = block.get("text")
        if t and str(t).strip():
            parts.append(str(t).strip())
    out = "\n\n".join(parts).strip()
    if len(out) > _ASSISTANT_TEXT_CAP:
        return out[:_ASSISTANT_TEXT_CAP] + "\n…[truncated]"
    return out


# ---------------------------------------------------------------------------
# Agent loop — Anthropic Messages API with tool_use / tool_result turns
# ---------------------------------------------------------------------------


def run_coding_agent(
    user_prompt: str,
    workspace: Path,
    model: str,
    max_turns: int,
    github_token: str | None,
    repo_registry_path: Path,
    persona_system_suffix: str | None = None,
    persona_dict: dict[str, Any] | None = None,
    agent_progress: bool = True,
    progress_log_path: Path | None = None,
    progress_interval_sec: float = 30.0,
) -> dict[str, Any]:
    load_env()
    api_key = get_anthropic_api_key()
    if not api_key:
        print("ANTHROPIC_API_KEY is required.", file=sys.stderr)
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    tools = _tool_specs()
    messages: list[dict[str, Any]] = [{"role": "user", "content": user_prompt}]
    last_pr: dict[str, Any] | None = None
    system_text = SYSTEM_PROMPT
    if persona_system_suffix and persona_system_suffix.strip():
        system_text = SYSTEM_PROMPT.rstrip() + "\n\n---\n\n" + persona_system_suffix.strip()

    log_path = progress_log_path or (workspace / "dev-sim-agents-progress.log")
    if agent_progress:
        plog = AgentProgressLogger(log_path, agent_label="coding")
        plog.log_persona_start(persona_dict)
        progress_cm: Any = ProgressAnnouncer(
            plog,
            persona_dict,
            agent_label="coding",
            interval_sec=progress_interval_sec,
        )
    else:
        progress_cm = nullcontext()

    with progress_cm as announcer:
        message: Any = None
        for _ in range(max_turns):
            if announcer is not None:
                announcer.set_phase("awaiting_model")
            message = client.messages.create(
                model=model,
                max_tokens=8192,
                system=system_text,
                tools=tools,
                messages=messages,
            )

            # Normal completion: print assistant text and exit the loop.
            if message.stop_reason == "end_turn":
                assistant_text = _assistant_text_from_content(message.content)
                if assistant_text:
                    print(assistant_text)
                return {
                    "last_pr": last_pr,
                    "stop": "end_turn",
                    "assistant_text": assistant_text,
                }

            # e.g. max_tokens, refusal — print any text then stop (no tool_results to send).
            if message.stop_reason != "tool_use":
                assistant_text = _assistant_text_from_content(message.content)
                if assistant_text:
                    print(assistant_text)
                if message.stop_reason:
                    print(f"(stop_reason: {message.stop_reason})", file=sys.stderr)
                return {
                    "last_pr": last_pr,
                    "stop": str(message.stop_reason),
                    "assistant_text": assistant_text,
                }

            # Assistant asked for one or more tools: run them and send results in a single user message.
            if announcer is not None:
                announcer.set_phase("running_tools")
            tool_results: list[dict[str, Any]] = []

            for block in message.content:
                if _block_type(block) != "tool_use":
                    continue
                tid = getattr(block, "id", None) or (block.get("id") if isinstance(block, dict) else None)
                tname = getattr(block, "name", None) or (
                    block.get("name") if isinstance(block, dict) else None
                )
                raw_in = getattr(block, "input", None)
                if raw_in is None and isinstance(block, dict):
                    raw_in = block.get("input")
                tinput = raw_in if isinstance(raw_in, dict) else {}
                print(f"[tool] {tname}({json.dumps(tinput)[:500]}…)", file=sys.stderr)
                result = _execute_tool(
                    str(tname), tinput, workspace, github_token, repo_registry_path
                )
                if (
                    tname == "create_github_pull_request"
                    and isinstance(result, dict)
                    and result.get("ok")
                    and result.get("number") is not None
                ):
                    last_pr = {
                        "owner": str(result.get("owner", "")),
                        "repo": str(result.get("repo", "")),
                        "number": int(result["number"]),
                        "html_url": str(result.get("html_url") or ""),
                        "title": str(result.get("title") or ""),
                    }
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tid,
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )

            # Echo assistant message verbatim (required), then attach tool results by tool_use_id.
            messages.append({"role": "assistant", "content": message.content})
            messages.append({"role": "user", "content": tool_results})

        print(f"Stopped after {max_turns} turns (max_turns limit).", file=sys.stderr)
        tail = _assistant_text_from_content(message.content) if message is not None else ""
        return {"last_pr": last_pr, "stop": "max_turns", "assistant_text": tail}
