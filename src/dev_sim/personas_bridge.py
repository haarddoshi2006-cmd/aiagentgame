"""Load persona pools and compose system prompts for coding (Claude) and review (K2).

Pools and generator live under ``personas/`` at the repo root by default, or
``DEV_SIM_PERSONAS_DIR`` if set. The Hatch wheel does not ship ``personas/``;
set the env var when running from an installed package without a checkout.
"""

from __future__ import annotations

import importlib.util
import json
import os
import random
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from dev_sim.config import DEFAULT_CODING_PERSONA_ROLE

_PERSONA_MODULE: ModuleType | None = None


def reset_persona_module_cache() -> None:
    """For tests: clear cached import after changing ``DEV_SIM_PERSONAS_DIR``."""
    global _PERSONA_MODULE
    _PERSONA_MODULE = None
    name = "devsim_generate_persona"
    if name in sys.modules:
        del sys.modules[name]


def apply_personas_dir_from_cli(personas_dir_arg: Path | None) -> None:
    """Set ``DEV_SIM_PERSONAS_DIR`` before any pool load (CLI flag)."""
    if personas_dir_arg is not None:
        os.environ["DEV_SIM_PERSONAS_DIR"] = str(personas_dir_arg.expanduser().resolve())


def personas_dir() -> Path:
    """Directory containing ``trait_pools.json`` and ``generate_persona.py``."""
    env = os.environ.get("DEV_SIM_PERSONAS_DIR")
    if env:
        return Path(env).expanduser().resolve()
    # src/dev_sim/personas_bridge.py -> parents[2] = repo root
    return (Path(__file__).resolve().parents[2] / "personas").resolve()


def load_pools() -> dict[str, Any]:
    """Load ``trait_pools.json`` (must be version >= 2)."""
    path = personas_dir() / "trait_pools.json"
    if not path.is_file():
        print(f"personas_bridge: missing trait_pools at {path}", file=sys.stderr)
        sys.exit(2)
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version", 0) < 2:
        print("personas_bridge: trait_pools.json version must be >= 2", file=sys.stderr)
        sys.exit(2)
    return data


def _load_generate_persona_module() -> ModuleType:
    global _PERSONA_MODULE
    if _PERSONA_MODULE is not None:
        return _PERSONA_MODULE
    mod_path = personas_dir() / "generate_persona.py"
    if not mod_path.is_file():
        print(f"personas_bridge: missing {mod_path}", file=sys.stderr)
        sys.exit(2)
    spec = importlib.util.spec_from_file_location("devsim_generate_persona", mod_path)
    if spec is None or spec.loader is None:
        print("personas_bridge: could not load generate_persona.py", file=sys.stderr)
        sys.exit(2)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    _PERSONA_MODULE = mod
    return mod


def generate_persona_for_role(role: str, *, seed: int | None = None) -> dict[str, Any]:
    """Sample one persona dict for ``frontend``, ``backend``, or ``tech_lead``."""
    mod = _load_generate_persona_module()
    pools = load_pools()
    rng = random.Random(seed) if seed is not None else random.Random()
    return mod.generate_one(pools, role, rng)


def persona_slice_coding(persona: dict[str, Any]) -> str:
    mod = _load_generate_persona_module()
    return mod.persona_slice_for_coding(persona)


def persona_slice_review(persona: dict[str, Any]) -> str:
    mod = _load_generate_persona_module()
    return mod.persona_slice_for_review(persona)


def compose_coding_system(base_operational: str, persona: dict[str, Any]) -> str:
    """Append coding persona slice after the app-owned operational system prompt."""
    return base_operational.rstrip() + "\n\n---\n\n" + persona_slice_coding(persona)


def compose_review_system(review_json_base: str, persona: dict[str, Any]) -> str:
    """Prepend tech-lead persona before the K2 JSON review contract (base last)."""
    return persona_slice_review(persona).rstrip() + "\n\n---\n\n" + review_json_base.strip()


def coding_persona_suffix(role: str | None, seed: int | None) -> str:
    """Return persona slice for ``backend`` or ``frontend`` (defaults to coding role from config)."""
    effective = role or DEFAULT_CODING_PERSONA_ROLE
    persona = generate_persona_for_role(effective, seed=seed)
    return persona_slice_coding(persona)


def coding_persona_bundle(
    role: str | None, seed: int | None
) -> tuple[str, dict[str, Any]]:
    """Single RNG sample: ``(persona_slice_for_coding, persona_dict)``; role defaults from config."""
    effective = role or DEFAULT_CODING_PERSONA_ROLE
    persona = generate_persona_for_role(effective, seed=seed)
    return persona_slice_coding(persona), persona


def review_persona_prefix(seed: int | None) -> str:
    """Tech-lead persona slice for K2 review (always ``tech_lead`` role)."""
    persona = generate_persona_for_role("tech_lead", seed=seed)
    return persona_slice_review(persona)


def review_persona_bundle(seed: int | None) -> tuple[str, dict[str, Any]]:
    """Tech-lead: ``(persona_slice_for_review, persona_dict)``."""
    persona = generate_persona_for_role("tech_lead", seed=seed)
    return persona_slice_review(persona), persona
