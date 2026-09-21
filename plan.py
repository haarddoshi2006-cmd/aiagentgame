#!/usr/bin/env python3
"""Run from repo root without install: ``python plan.py ...`` (adds ``src`` to path)."""

from pathlib import Path
import sys

_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT / "src"))

from dev_sim.planner import main  # noqa: E402

if __name__ == "__main__":
    main()
