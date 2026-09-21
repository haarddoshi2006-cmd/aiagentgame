"""python -m dev_sim_bridge → HTTP bridge server."""

from __future__ import annotations

import argparse

from dev_sim_bridge.server import main as serve


def main() -> None:
    p = argparse.ArgumentParser(description="HTTP bridge for Simians CEO UI → dev_sim agents")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    a = p.parse_args()
    serve(host=a.host, port=a.port)


if __name__ == "__main__":
    main()
