"""Periodic persona-styled progress announcements and file logging for agents."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from dev_sim.agent_run_logging import ensure_progress_logfile, progress_child_logger

# Rotating lines per communication_style (Simians trait vocabulary).
_ANNOUNCEMENT_BANKS: dict[str, list[str]] = {
    "terse": [
        "Still on it.",
        "Working.",
        "In progress—back soon.",
        "Not stuck; just grinding.",
        "One more pass on this.",
    ],
    "verbose": [
        "Quick update: still pushing on the current step—thanks for your patience while I work through the details.",
        "I'm still actively on this task; no blockers from my side, just making sure the next change is solid.",
        "Still here—going carefully so we don't leave loose ends in the repo or the PR.",
        "Progress continues; I'm being deliberate about validation before the next commit or tool call.",
    ],
    "diplomatic": [
        "Still moving forward—appreciate the wait; I'm keeping quality and team norms in mind.",
        "Making steady progress; I'll surface anything risky before we ship.",
        "Continuing work on this; aiming for a clean handoff when the step is done.",
    ],
    "blunt": [
        "Still working. Not done yet.",
        "This is taking a bit—model/tools are slow, not excuses.",
        "Still in the middle of it. No fluff.",
    ],
    "socratic": [
        "Still working—asking myself if the next change actually answers the user's intent.",
        "In progress: sanity-checking assumptions before the next edit.",
        "Still on task—what would break if we rushed this? Taking the careful path.",
    ],
    "encouraging": [
        "Still going—we've got this; next milestone is in sight.",
        "Making progress—small steady steps add up.",
        "Still on it—thanks for hanging in; almost through this chunk.",
    ],
    "default": [
        "Still working on the task.",
        "Progress continues.",
        "In progress—will update when this step finishes.",
    ],
}

_PHASE_HINTS: dict[str, str] = {
    "starting": "just getting rolling",
    "awaiting_model": "waiting on the model",
    "running_tools": "running tools locally",
    "fetching_pr": "pulling PR context",
    "reviewing": "review is in flight",
    "wrapping_up": "wrapping up",
}


def _persona_style(persona: dict[str, Any] | None) -> str:
    if not persona:
        return "default"
    s = persona.get("communication_style")
    if isinstance(s, str) and s in _ANNOUNCEMENT_BANKS:
        return s
    return "default"


def _display_name(persona: dict[str, Any] | None) -> str:
    if not persona:
        return "Agent"
    return str(persona.get("display_name") or "Agent")


def format_progress_announcement(
    persona: dict[str, Any] | None,
    *,
    agent_label: str,
    tick: int,
    phase: str,
) -> str:
    """One in-character progress line (no LLM)."""
    name = _display_name(persona)
    style = _persona_style(persona)
    bank = _ANNOUNCEMENT_BANKS.get(style, _ANNOUNCEMENT_BANKS["default"])
    line = bank[tick % len(bank)]
    phase_note = _PHASE_HINTS.get(phase, phase)
    role = ""
    if persona and persona.get("role"):
        role = f" ({persona['role']})"
    return f"[{name}{role} | {agent_label}] {line} ({phase_note})."


class AgentProgressLogger:
    """
    Logs session markers and periodic announcements on ``dev_sim.agents.progress``.

    Full persona JSON for the UI roster is logged separately by ``GET /api/agents``
    (``dev_sim.agents.personas``). Here we only emit a one-line session marker plus
    ``ProgressAnnouncer`` lines to the shared progress log file.
    """

    def __init__(
        self,
        log_path: Path,
        *,
        agent_label: str = "agent",
        mirror_stderr: bool = True,
    ) -> None:
        self.log_path = log_path
        self.agent_label = agent_label
        self._lock = threading.Lock()
        ensure_progress_logfile(log_path, mirror_stderr=mirror_stderr)
        self._logger = progress_child_logger()

    def log_persona_start(self, persona: dict[str, Any] | None) -> None:
        """Log a compact session marker (full persona JSON is on ``dev_sim.agents.personas`` from GET)."""
        with self._lock:
            if persona:
                self._logger.info(
                    "session_start label=%s id=%s display_name=%s role=%s",
                    self.agent_label,
                    persona.get("id", ""),
                    persona.get("display_name", ""),
                    persona.get("role", ""),
                )
            else:
                self._logger.info(
                    "session_start label=%s (no persona dict; announcements use default tone)",
                    self.agent_label,
                )

    def announce(self, message: str) -> None:
        with self._lock:
            self._logger.info("%s", message)


class ProgressAnnouncer:
    """
    Emits ``format_progress_announcement`` every ``interval_sec`` on a daemon thread until stopped.

    Update ``phase`` from the main thread for slightly richer parentheticals.
    """

    def __init__(
        self,
        logger: AgentProgressLogger,
        persona: dict[str, Any] | None,
        *,
        agent_label: str,
        interval_sec: float = 30.0,
    ) -> None:
        self._plog = logger
        self._persona = persona
        self._agent_label = agent_label
        self._interval = interval_sec
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tick = 0
        self._phase_lock = threading.Lock()
        self._phase = "starting"

    def set_phase(self, phase: str) -> None:
        with self._phase_lock:
            self._phase = phase

    def _loop(self) -> None:
        while not self._stop.wait(timeout=self._interval):
            with self._phase_lock:
                phase = self._phase
            msg = format_progress_announcement(
                self._persona,
                agent_label=self._agent_label,
                tick=self._tick,
                phase=phase,
            )
            self._tick += 1
            self._plog.announce(msg)

    def __enter__(self) -> ProgressAnnouncer:
        self._thread = threading.Thread(target=self._loop, name="dev-sim-progress", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)


__all__ = [
    "AgentProgressLogger",
    "ProgressAnnouncer",
    "format_progress_announcement",
]
