#!/usr/bin/env python3
"""Run the FastAPI economy API: ``GET /api/company``, ``POST /api/simulate`` (port 8000).

Execute from the **repository root** so imports resolve::

    python run_api.py

Requires: ``pip install -e .`` or ``PYTHONPATH=src`` plus repo root on path for ``shared``.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
_SRC = ROOT / "src"
_src_s, _root_s = str(_SRC), str(ROOT)
if _src_s not in sys.path:
    sys.path.insert(0, _src_s)
if _root_s not in sys.path:
    sys.path.append(_root_s)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "dev_sim.api:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
        reload_dirs=[str(_SRC)],
    )
