"""Environment variables, model defaults, and dotenv loading for all agents.

Import `load_env()` once at process entry (e.g. CLI main) before reading secrets.
Use `resolve_*_model()` so CLI flags override env, and env overrides baked-in defaults.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

# --- Environment variable keys (single source of truth) ---

K_ANTHROPIC_API_KEY = "ANTHROPIC_API_KEY"
K_GITHUB_TOKEN = "GITHUB_TOKEN"
K_DEV_SIM_PERSONAS_DIR = "DEV_SIM_PERSONAS_DIR"  # directory with trait_pools.json (see personas_bridge)
K_ANTHROPIC_MODEL = "ANTHROPIC_MODEL"
K_ANTHROPIC_REVIEW_MODEL = "ANTHROPIC_REVIEW_MODEL"  # reserved for a review / second agent

# --- Defaults when the corresponding env var is unset ---

DEFAULT_CODING_MODEL = "claude-sonnet-4-6"
DEFAULT_REVIEW_MODEL = "claude-sonnet-4-6"
# PR review agent (K2 / OpenAI-compatible) — see dev_sim.review_agent
K2_DEFAULT_REVIEW_MODEL = "MBZUAI-IFM/K2-Think-v2"
K2_API_BASE = "https://api.k2think.ai/v1"
K_K2_API_KEY = "K2_API_KEY"
K_OPENAI_API_KEY = "OPENAI_API_KEY"
# Optional: OpenAI-compatible base URL (proxy or alternate K2 host)
K_OPENAI_BASE_URL = "OPENAI_BASE_URL"
K_K2_OPENAI_BASE_URL = "K2_OPENAI_BASE_URL"
# Optional: override K2 model id for review (defaults to K2_DEFAULT_REVIEW_MODEL)
K2_REVIEW_MODEL = "K2_REVIEW_MODEL"

DEFAULT_REPO_REGISTRY = "repo-registry.json"
# When coding persona role is omitted (CLI default or ``None`` in ``coding_persona_bundle``).
DEFAULT_CODING_PERSONA_ROLE = "backend"

# Backward-compatible alias (code may use either name)
DEFAULT_MODEL = DEFAULT_CODING_MODEL


def load_env() -> None:
    """Load `.env` from the current working directory and parents. Does not override existing env."""
    load_dotenv()


# --- Accessors (read os.environ; call `load_env()` first in the app entrypoint) ---


def get_anthropic_api_key() -> str | None:
    v = os.environ.get(K_ANTHROPIC_API_KEY)
    return v if v else None


def get_github_token() -> str | None:
    v = os.environ.get(K_GITHUB_TOKEN)
    return v if v else None


def get_k2_api_key() -> str | None:
    """K2-compatible API key: ``K2_API_KEY`` first, then ``OPENAI_API_KEY`` for proxies."""
    for key in (K_K2_API_KEY, K_OPENAI_API_KEY):
        v = os.environ.get(key)
        if v and str(v).strip():
            return str(v).strip()
    return None


def resolve_k2_api_base() -> str:
    """Base URL for the OpenAI-compatible K2 client (env override then default K2 host)."""
    for key in (K_K2_OPENAI_BASE_URL, K_OPENAI_BASE_URL):
        v = os.environ.get(key)
        if v and str(v).strip():
            return str(v).strip().rstrip("/")
    return str(K2_API_BASE).rstrip("/")


def resolve_k2_review_model(override: str | None) -> str:
    """K2/Think model id for PR review and sprint planning (OpenAI-compatible API at K2_API_BASE)."""
    if override and override.strip():
        return override.strip()
    for key in (K2_REVIEW_MODEL,):
        v = os.environ.get(key)
        if v and v.strip():
            return v.strip()
    return K2_DEFAULT_REVIEW_MODEL


def resolve_coding_model(cli_model: str | None) -> str:
    """
    Model id for the main coding / tool-calling agent.
    Precedence: CLI --model, then ANTHROPIC_MODEL, then DEFAULT_CODING_MODEL.
    """
    if cli_model and cli_model.strip():
        return cli_model.strip()
    return (os.environ.get(K_ANTHROPIC_MODEL) or DEFAULT_CODING_MODEL).strip() or DEFAULT_CODING_MODEL


def resolve_review_model(cli_model: str | None) -> str:
    """
    Model id for a code-review or secondary agent.
    Precedence: CLI --review-model (when wired), then ANTHROPIC_REVIEW_MODEL,
    then same fallback chain as coding (ANTHROPIC_MODEL, DEFAULT_REVIEW_MODEL).
    """
    if cli_model and cli_model.strip():
        return cli_model.strip()
    env_review = os.environ.get(K_ANTHROPIC_REVIEW_MODEL)
    if env_review and env_review.strip():
        return env_review.strip()
    env_coding = os.environ.get(K_ANTHROPIC_MODEL)
    if env_coding and env_coding.strip():
        return env_coding.strip()
    return DEFAULT_REVIEW_MODEL
