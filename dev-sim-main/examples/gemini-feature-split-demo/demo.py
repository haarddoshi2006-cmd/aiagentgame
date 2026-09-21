#!/usr/bin/env python3
"""Project idea -> LLM API -> SRS + feature markdown docs (multi-provider)."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_SPLITTER = ROOT.parent.parent / "llm" / "task_splitter.md"
OUT_DIR = ROOT / "docs"
DEFAULT_USER_AGENT = "curl/8.5.0"
DOTENV_CANDIDATES = [ROOT / ".env", ROOT.parent.parent / ".env"]

PROVIDERS = ("anthropic", "openai", "k2", "gemini")

PROVIDER_DEFAULTS: dict[str, dict[str, str]] = {
    "anthropic": {"model": "claude-sonnet-4-6", "env_key": "ANTHROPIC_API_KEY"},
    "openai":    {"model": "gpt-4o-mini",        "env_key": "OPENAI_API_KEY"},
    "k2":        {"model": "MBZUAI-IFM/K2-Think-v2", "env_key": "K2THINK_API_KEY"},
    "gemini":    {"model": "gemini-1.5-flash",    "env_key": "GEMINI_API_KEY"},
}

REQUIRED_TOP_KEYS = {"summary", "dependencies", "assumptions", "features"}
REQUIRED_FEATURE_KEYS = {
    "sprint", "name", "user_outcome",
    "frontend", "backend", "contract",
    "risks", "definition_of_done",
}


@dataclass
class FeaturePlan:
    sprint: int
    name: str
    user_outcome: str
    frontend: list[str]
    backend: list[str]
    contract: list[str]
    risks: list[str]
    definition_of_done: list[str]
    support: list[str]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate SRS + feature docs from a project idea via an LLM API."
    )
    parser.add_argument("--idea", help="Project idea text. Omit to be prompted.")
    parser.add_argument(
        "--provider",
        choices=PROVIDERS,
        default="anthropic",
        help="LLM provider to use (default: anthropic).",
    )
    parser.add_argument(
        "--model",
        help="Model ID override. Defaults per provider if not set.",
    )
    parser.add_argument(
        "--api-key",
        help="API key override. Defaults to the provider's env var if not set.",
    )
    parser.add_argument(
        "--splitter-prompt",
        default=str(DEFAULT_SPLITTER),
        help="Path to task splitter seed prompt markdown.",
    )
    parser.add_argument(
        "--user-agent",
        default=DEFAULT_USER_AGENT,
        help=f"HTTP User-Agent header (default: {DEFAULT_USER_AGENT}).",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Env / key helpers
# ---------------------------------------------------------------------------

def load_dotenv_files() -> None:
    for env_path in DOTENV_CANDIDATES:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                os.environ.setdefault(key, value)


def get_api_key(cli_value: str | None, provider: str) -> str:
    env_var = PROVIDER_DEFAULTS[provider]["env_key"]
    key = cli_value or os.getenv(env_var, "")
    if not key:
        raise RuntimeError(
            f"{provider} API key is required. Set {env_var} or pass --api-key."
        )
    return key


def get_idea(raw: str | None) -> str:
    if raw:
        return raw.strip()
    print("Enter project idea (single line or paragraph), then press Enter:")
    idea = input("> ").strip()
    if not idea:
        raise SystemExit("Project idea is required.")
    return idea


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

def build_llm_prompt(splitter_text: str, project_idea: str) -> str:
    schema = {
        "summary": "string",
        "dependencies": ["string"],
        "assumptions": ["string"],
        "features": [
            {
                "sprint": "number (1-indexed)",
                "name": "string",
                "user_outcome": "string",
                "frontend": ["string"],
                "backend": ["string"],
                "contract": ["string"],
                "risks": ["string"],
                "definition_of_done": ["string"],
                "support": ["string, optional"],
            }
        ],
    }
    return (
        f"{splitter_text}\n\n"
        "Now apply the prompt to this project idea:\n"
        f"{project_idea}\n\n"
        "Return ONLY valid JSON (no markdown fences, no prose outside JSON).\n"
        "Use this exact top-level shape:\n"
        f"{json.dumps(schema, indent=2)}\n"
    )


# ---------------------------------------------------------------------------
# Provider call adapters
# ---------------------------------------------------------------------------

def _openai_compat_call(
    url: str,
    model: str,
    api_key: str,
    prompt: str,
    user_agent: str,
    extra_headers: dict[str, str] | None = None,
) -> str:
    payload = {
        "model": model,
        "max_tokens": 4096,
        "temperature": 0.4,
        "messages": [
            {"role": "system", "content": "You are a product planning assistant. Output valid JSON only."},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "accept": "application/json",
        "User-Agent": user_agent,
    }
    if extra_headers:
        headers.update(extra_headers)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(_format_http_error(exc.code, detail, model, url)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"API connection failed ({url}).\n- Details: {exc}") from exc
    data = json.loads(raw)
    choices = data.get("choices", [])
    if not choices:
        raise RuntimeError(f"API returned no choices: {raw}")
    text = str(choices[0].get("message", {}).get("content", "")).strip()
    if not text:
        raise RuntimeError(f"API returned empty content: {raw}")
    return text


def call_anthropic(prompt: str, model: str, api_key: str, user_agent: str) -> str:
    url = "https://api.anthropic.com/v1/messages"
    payload = {
        "model": model,
        "max_tokens": 4096,
        "system": "You are a product planning assistant. Output valid JSON only.",
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "User-Agent": user_agent,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(_format_http_error(exc.code, detail, model, url)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Anthropic API connection failed.\n- Details: {exc}") from exc
    data = json.loads(raw)
    content = data.get("content", [])
    if not content:
        raise RuntimeError(f"Anthropic API returned no content: {raw}")
    text = str(content[0].get("text", "")).strip()
    if not text:
        raise RuntimeError(f"Anthropic API returned empty text: {raw}")
    return text


def call_openai(prompt: str, model: str, api_key: str, user_agent: str) -> str:
    return _openai_compat_call(
        "https://api.openai.com/v1/chat/completions",
        model, api_key, prompt, user_agent,
    )


def call_k2(prompt: str, model: str, api_key: str, user_agent: str) -> str:
    return _openai_compat_call(
        "https://api.k2think.ai/v1/chat/completions",
        model, api_key, prompt, user_agent,
    )


def call_gemini(prompt: str, model: str, api_key: str, user_agent: str) -> str:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 4096},
        "systemInstruction": {"parts": [{"text": "You are a product planning assistant. Output valid JSON only."}]},
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": user_agent},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(_format_http_error(exc.code, detail, model, url)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Gemini API connection failed.\n- Details: {exc}") from exc
    data = json.loads(raw)
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError) as exc:
        raise RuntimeError(f"Unexpected Gemini response shape: {raw}") from exc
    if not text:
        raise RuntimeError(f"Gemini API returned empty text: {raw}")
    return text


_PROVIDER_CALLERS = {
    "anthropic": call_anthropic,
    "openai": call_openai,
    "k2": call_k2,
    "gemini": call_gemini,
}


def call_provider(
    provider: str, prompt: str, model: str, api_key: str, user_agent: str
) -> str:
    return _PROVIDER_CALLERS[provider](prompt, model, api_key, user_agent)


# ---------------------------------------------------------------------------
# Error formatting
# ---------------------------------------------------------------------------

def _extract_json_error(detail: str) -> tuple[str, str]:
    try:
        parsed = json.loads(detail)
    except json.JSONDecodeError:
        return detail.strip() or "Unknown API error.", ""
    err = parsed.get("error", {})
    if isinstance(err, str):
        return err.strip() or "Unknown API error.", ""
    if not isinstance(err, dict):
        return detail.strip() or "Unknown API error.", ""
    message = str(err.get("message", "")).strip() or str(parsed.get("message", "")).strip()
    message = message or detail.strip() or "Unknown API error."
    err_type = str(err.get("type", parsed.get("type", ""))).strip()
    return message, err_type


def _extract_retry_seconds(message: str) -> str:
    match = re.search(r"retry in ([0-9]+(?:\.[0-9]+)?)s", message, re.IGNORECASE)
    return match.group(1) if match else ""


def _format_http_error(code: int, detail: str, model: str, url: str) -> str:
    message, err_type = _extract_json_error(detail)
    retry_seconds = _extract_retry_seconds(message)
    if code == 429:
        lines = [
            f"API quota/rate-limit reached (HTTP 429) — {url}",
            f"- Model: {model}",
            f"- Error type: {err_type or 'rate_limit_error'}",
            "- What to do: check your account limits, reduce request frequency.",
        ]
        if retry_seconds:
            lines.append(f"- Retry after about {retry_seconds} seconds.")
        lines.append(f"- API message: {message}")
        return "\n".join(lines)
    if code in (401, 403):
        return "\n".join([
            f"API auth/permission error (HTTP {code}) — {url}",
            "- Verify your API key and model access.",
            f"- API message: {message}",
        ])
    return "\n".join([
        f"API request failed (HTTP {code}) — {url}",
        f"- Error type: {err_type or 'unknown'}",
        f"- Message: {message}",
    ])


# ---------------------------------------------------------------------------
# Response parsing + schema validation
# ---------------------------------------------------------------------------

def parse_response(raw: str) -> dict[str, Any]:
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in model output.")
    return json.loads(raw[start: end + 1])


def validate_plan(plan: dict[str, Any]) -> None:
    missing_top = REQUIRED_TOP_KEYS - plan.keys()
    if missing_top:
        raise ValueError(f"Plan missing required top-level keys: {sorted(missing_top)}")
    features = plan["features"]
    if not isinstance(features, list) or not features:
        raise ValueError("'features' must be a non-empty list.")
    for i, feat in enumerate(features):
        missing = REQUIRED_FEATURE_KEYS - feat.keys()
        if missing:
            raise ValueError(
                f"Feature #{i + 1} missing required keys: {sorted(missing)}"
            )
        if not isinstance(feat.get("sprint"), (int, float)):
            raise ValueError(f"Feature #{i + 1} 'sprint' must be a number.")
        for list_key in ("frontend", "backend", "contract", "risks", "definition_of_done"):
            if not isinstance(feat.get(list_key), list):
                raise ValueError(f"Feature #{i + 1} '{list_key}' must be a list.")


# ---------------------------------------------------------------------------
# Doc writing
# ---------------------------------------------------------------------------

def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    return value.strip("-") or "feature"


def bullets(items: list[str]) -> str:
    return "\n".join(f"- {i}" for i in items) if items else "- (none)"


def to_feature_plan(item: dict[str, Any]) -> FeaturePlan:
    return FeaturePlan(
        sprint=int(item["sprint"]),
        name=str(item["name"]),
        user_outcome=str(item["user_outcome"]),
        frontend=[str(x) for x in item.get("frontend", [])],
        backend=[str(x) for x in item.get("backend", [])],
        contract=[str(x) for x in item.get("contract", [])],
        risks=[str(x) for x in item.get("risks", [])],
        definition_of_done=[str(x) for x in item.get("definition_of_done", [])],
        support=[str(x) for x in item.get("support", [])],
    )


def write_docs(plan: dict[str, Any], idea: str, out_dir: Path = OUT_DIR) -> None:
    srs_dir = out_dir / "srs"
    feature_dir = out_dir / "features"
    srs_dir.mkdir(parents=True, exist_ok=True)
    feature_dir.mkdir(parents=True, exist_ok=True)

    features = sorted(
        [to_feature_plan(f) for f in plan["features"]], key=lambda f: f.sprint
    )
    total = len(features)
    assumptions = [str(x) for x in plan.get("assumptions", [])]
    dependencies = [str(x) for x in plan.get("dependencies", [])]

    overview_lines = [
        "# Software Requirements Summary (SRS)",
        "",
        "## Project Idea",
        idea,
        "",
        "## Plan Summary",
        str(plan.get("summary", "")),
        "",
        "## Timeline",
        f"- Total sprints: **{total}**",
        "- Sprint-to-feature ratio: **1:1**",
        "",
        "## Assumptions",
        bullets(assumptions),
        "",
        "## Dependencies",
        bullets(dependencies),
        "",
        "## Features",
    ]
    for feature in features:
        slug = slugify(feature.name)
        overview_lines.append(
            f"- Sprint {feature.sprint}: "
            f"[{feature.name}](../features/{feature.sprint:02d}-{slug}.md)"
        )
    (srs_dir / "overview.md").write_text("\n".join(overview_lines) + "\n", encoding="utf-8")

    written: list[Path] = []
    for feature in features:
        slug = slugify(feature.name)
        path = feature_dir / f"{feature.sprint:02d}-{slug}.md"
        body = f"""# Sprint {feature.sprint} — {feature.name}

## User Outcome
{feature.user_outcome}

## Frontend
{bullets(feature.frontend)}

## Backend
{bullets(feature.backend)}

## Contract
{bullets(feature.contract)}

## Risks / Unknowns
{bullets(feature.risks)}

## Definition of Done
{bullets(feature.definition_of_done)}

## Supporting Work
{bullets(feature.support)}
"""
        path.write_text(body, encoding="utf-8")
        written.append(path)
    return written  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    args = parse_args()
    load_dotenv_files()

    provider = args.provider
    model = args.model or PROVIDER_DEFAULTS[provider]["model"]
    idea = get_idea(args.idea)
    api_key = get_api_key(args.api_key, provider)
    splitter_text = Path(args.splitter_prompt).read_text(encoding="utf-8")

    print(f"Provider: {provider}  |  Model: {model}")
    prompt = build_llm_prompt(splitter_text, idea)
    raw = call_provider(provider, prompt, model, api_key, args.user_agent)
    plan = parse_response(raw)
    validate_plan(plan)
    write_docs(plan, idea)

    print("Generated docs:")
    print(f"- {OUT_DIR / 'srs' / 'overview.md'}")
    print(f"- {OUT_DIR / 'features'}/")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
