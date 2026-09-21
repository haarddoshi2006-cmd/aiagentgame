"""Two child loggers under ``dev_sim.agents`` for roster vs run progress.

* ``dev_sim.agents.personas`` — full persona snapshots when ``GET /api/agents`` resolves.
* ``dev_sim.agents.progress`` — agent session markers and periodic progress (orchestrate / CLI).

Handlers attach to the child loggers only (``propagate = False``) so records do not duplicate on the root logger.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

_PARENT = "dev_sim.agents"
_PERSONAS = f"{_PARENT}.personas"
_PROGRESS = f"{_PARENT}.progress"

_FILE_FORMAT = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")

_lock = threading.Lock()
_personas_target: str | None = None
_progress_target: str | None = None


def personas_child_logger() -> logging.Logger:
    log = logging.getLogger(_PERSONAS)
    log.setLevel(logging.INFO)
    log.propagate = False
    return log


def progress_child_logger() -> logging.Logger:
    log = logging.getLogger(_PROGRESS)
    log.setLevel(logging.INFO)
    log.propagate = False
    return log


def _ensure_parent() -> logging.Logger:
    log = logging.getLogger(_PARENT)
    log.setLevel(logging.INFO)
    log.propagate = False
    return log


def ensure_personas_logfile(workspace: Path) -> None:
    """Append ``dev_sim.agents.personas`` records to ``<workspace>/dev-sim-agents-personas.log``."""
    global _personas_target
    ws = workspace.expanduser().resolve()
    ws.mkdir(parents=True, exist_ok=True)
    path = (ws / "dev-sim-agents-personas.log").resolve()
    key = str(path)
    with _lock:
        if _personas_target == key:
            return
        _ensure_parent()
        log = personas_child_logger()
        for h in list(log.handlers):
            log.removeHandler(h)
            try:
                h.close()
            except OSError:
                pass
        fh = logging.FileHandler(path, encoding="utf-8")
        fh.setFormatter(_FILE_FORMAT)
        log.addHandler(fh)
        _personas_target = key


def ensure_progress_logfile(log_path: Path, *, mirror_stderr: bool = True) -> None:
    """Route ``dev_sim.agents.progress`` to ``log_path`` (and optionally stderr)."""
    global _progress_target
    path = log_path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    key = str(path)
    with _lock:
        if _progress_target == key:
            log = progress_child_logger()
            if mirror_stderr and not any(
                isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler)
                for h in log.handlers
            ):
                sh = logging.StreamHandler()
                sh.setFormatter(
                    logging.Formatter("%(asctime)s [progress] %(message)s", datefmt="%H:%M:%S")
                )
                sh.setLevel(logging.INFO)
                log.addHandler(sh)
            return

        _ensure_parent()
        log = progress_child_logger()
        for h in list(log.handlers):
            log.removeHandler(h)
            try:
                h.close()
            except OSError:
                pass
        fh = logging.FileHandler(path, encoding="utf-8")
        fh.setFormatter(_FILE_FORMAT)
        log.addHandler(fh)
        if mirror_stderr:
            sh = logging.StreamHandler()
            sh.setFormatter(
                logging.Formatter("%(asctime)s [progress] %(message)s", datefmt="%H:%M:%S")
            )
            sh.setLevel(logging.INFO)
            log.addHandler(sh)
        _progress_target = key


def log_get_api_agents_payload(
    agents: dict[str, Any],
    *,
    workspace: Path | None = None,
    event: str = "GET /api/agents",
) -> None:
    """Log the coding, coding_b, and review persona dicts (e.g. after each ``GET /api/agents``)."""
    ws = workspace if workspace is not None else Path.cwd() / ".dev-sim-workspace"
    ensure_personas_logfile(ws)
    body = json.dumps(agents, indent=2, ensure_ascii=False)
    personas_child_logger().info("%s\n%s", event, body)


__all__ = [
    "ensure_personas_logfile",
    "ensure_progress_logfile",
    "log_get_api_agents_payload",
    "personas_child_logger",
    "progress_child_logger",
]
