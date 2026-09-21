"""HTTP API for the CEO UI: forwards prompts to ``dev_sim`` (orchestrate uses lead coding + review; roster has two coders)."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from concurrent.futures import Future, ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from dotenv import load_dotenv

# Bulletproof: load nested + root ``.env`` before ``dev_sim`` imports (override empty shell vars).
load_dotenv(REPO_ROOT / ".dev-sim" / ".env", override=True)
load_dotenv(REPO_ROOT / ".env", override=True)

from dev_sim.agents_payload import get_session_agents
from dev_sim.config import load_env

load_env()

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dev_sim_bridge")
_current: Optional[Future[Any]] = None


def _maybe_push_after_settlement(project_name: str) -> dict[str, Any]:
    """Re-run GitHub export after tycoon settlement if CEO orchestrate wrote export context."""
    ctx_path = REPO_ROOT / ".dev-sim" / "last-export-context.json"
    if not ctx_path.is_file():
        return {"ok": True, "skipped": True, "reason": "No last-export-context.json (run CEO orchestrate once)."}
    try:
        raw_ctx = json.loads(ctx_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return {"ok": False, "error": f"last-export-context.json: {e}"}
    ws_raw = raw_ctx.get("workspace")
    po = str(raw_ctx.get("pr_owner") or "").strip()
    pr = str(raw_ctx.get("pr_repo") or "").strip()
    if not ws_raw or not po or not pr:
        return {"ok": True, "skipped": True, "reason": "Export context missing workspace or PR slug."}
    ws = Path(str(ws_raw)).expanduser()
    if not ws.is_dir():
        return {"ok": False, "error": "Export context workspace path is not a directory."}
    from dev_sim.config import get_github_token
    from dev_sim.push_target_repo import push_workspace_to_target

    return push_workspace_to_target(
        workspace=ws,
        pr_owner=po,
        pr_repo=pr,
        github_token=get_github_token() or "",
        project_name=project_name.strip() or "Sprint",
    )


def _cors_headers(handler: BaseHTTPRequestHandler) -> dict[str, str]:
    origin = handler.headers.get("Origin") or "*"
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
    }


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def _send(self, code: int, body: bytes, content_type: str = "application/json") -> None:
        h = {"Content-Type": content_type, "Content-Length": str(len(body))}
        h.update(_cors_headers(self))
        self.send_response(code)
        for k, v in h.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send(204, b"")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            payload = json.dumps({"ok": True, "service": "dev_sim_bridge"}).encode("utf-8")
            self._send(200, payload)
            return
        if parsed.path == "/api/economy":
            self._handle_economy_get()
            return
        if parsed.path == "/api/company":
            self._handle_company_get()
            return
        if parsed.path == "/api/agents":
            qs = parse_qs(parsed.query)
            raw = (qs.get("seed") or [None])[0]
            refresh_vals = qs.get("refresh") or []
            force_refresh = any(str(v).lower() in ("1", "true", "yes") for v in refresh_vals)
            seed: Optional[int]
            if raw is None or raw == "":
                seed = None
            else:
                try:
                    seed = int(raw)
                except ValueError:
                    self._send(400, json.dumps({"ok": False, "error": "invalid seed"}).encode("utf-8"))
                    return
            try:
                rs = None if seed is None else seed ^ 0x9E3779B9
                data = get_session_agents(coding_seed=seed, review_seed=rs, force_refresh=force_refresh)
            except Exception as e:  # noqa: BLE001
                self._send(500, json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}).encode("utf-8"))
                return
            self._send(200, json.dumps({"ok": True, **data}).encode("utf-8"))
            return
        self._send(404, json.dumps({"ok": False, "error": "not found"}).encode("utf-8"))

    def _handle_economy_get(self) -> None:
        """GET /api/economy — current persisted ledger (``company-state.json``) for UI sync."""
        path = REPO_ROOT / ".dev-sim" / "company-state.json"
        if not path.is_file():
            payload = {
                "ok": True,
                "balance": 100_000.0,
                "active_mrr": 0.0,
                "pending_recurring_mrr": 0.0,
                "tech_debt": 0.0,
                "hype_multiplier": 1.0,
                "sprint_month": 1,
                "valuation": 0.0,
                "source": "defaults",
            }
            self._send(200, json.dumps(payload).encode("utf-8"))
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            self._send(500, json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
            return
        if not isinstance(data, dict):
            self._send(500, json.dumps({"ok": False, "error": "invalid economy file"}).encode("utf-8"))
            return
        data.setdefault("pending_recurring_mrr", 0.0)
        out = {"ok": True, "source": str(path), **data}
        self._send(200, json.dumps(out).encode("utf-8"))

    def _handle_company_get(self) -> None:
        """GET /api/company — same shape as FastAPI (``CompanyState`` + ``persisted``) for ``main.js`` hydrate."""
        path = REPO_ROOT / ".dev-sim" / "company-state.json"
        persisted = path.is_file()
        os.chdir(REPO_ROOT)
        from dev_sim.economy import CompanyState

        company = CompanyState()
        if persisted:
            try:
                company = CompanyState.load_state(path)
            except (json.JSONDecodeError, OSError, TypeError, ValueError):
                persisted = False
        out: dict[str, Any] = asdict(company)
        out["persisted"] = persisted
        self._send(200, json.dumps(out).encode("utf-8"))

    def _handle_company_reset(self) -> None:
        """POST /api/company/reset — overwrite ``company-state.json`` with Day 1 defaults."""
        os.chdir(REPO_ROOT)
        from dev_sim.tycoon_sprint import reset_company_state_file

        try:
            company = reset_company_state_file()
        except (OSError, TypeError, ValueError) as e:
            self._send(500, json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
            return
        out: dict[str, Any] = asdict(company)
        out["persisted"] = True
        out["ok"] = True
        self._send(200, json.dumps(out).encode("utf-8"))

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._send(400, json.dumps({"ok": False, "error": "invalid JSON"}).encode("utf-8"))
            return

        if parsed.path == "/api/company/reset":
            self._handle_company_reset()
            return

        if parsed.path == "/api/simulate":
            self._handle_simulate(body)
            return

        if parsed.path != "/api/orchestrate":
            self._send(404, json.dumps({"ok": False, "error": "not found"}).encode("utf-8"))
            return

        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            self._send(400, json.dumps({"ok": False, "error": "missing prompt"}).encode("utf-8"))
            return

        ws_raw = body.get("workspace")
        workspace = Path(ws_raw).expanduser() if ws_raw else None

        try:
            exp_ot = float(body.get("expected_one_time", 0) or 0)
        except (TypeError, ValueError):
            self._send(400, json.dumps({"ok": False, "error": "expected_one_time must be a number"}).encode("utf-8"))
            return
        try:
            exp_mo = float(body.get("expected_monthly", 0) or 0)
        except (TypeError, ValueError):
            self._send(400, json.dumps({"ok": False, "error": "expected_monthly must be a number"}).encode("utf-8"))
            return
        if exp_ot < 0 or exp_mo < 0:
            self._send(400, json.dumps({"ok": False, "error": "expected returns must be >= 0"}).encode("utf-8"))
            return

        global _current
        if _current is not None and not _current.done():
            self._send(
                429,
                json.dumps({"ok": False, "error": "another orchestrate run is still in progress"}).encode("utf-8"),
            )
            return

        def job() -> dict[str, Any]:
            os.chdir(REPO_ROOT)
            from dev_sim_bridge.pipeline import run_planned_orchestrate_for_prompt

            coding_p = body.get("coding") if isinstance(body.get("coding"), dict) else None
            review_p = body.get("review") if isinstance(body.get("review"), dict) else None
            skip_planning = bool(body.get("skip_planning"))
            skip_k2_review = bool(body.get("skip_k2_review"))

            try:
                return run_planned_orchestrate_for_prompt(
                    prompt,
                    repo_root=REPO_ROOT,
                    workspace=workspace,
                    expected_one_time=exp_ot,
                    expected_monthly=exp_mo,
                    coding_persona=coding_p,
                    review_persona=review_p,
                    skip_planning=skip_planning,
                    skip_k2_review=skip_k2_review,
                )
            except Exception as e:  # noqa: BLE001 — surface to UI
                return {"ok": False, "error": f"{type(e).__name__}: {e}"}

        _current = _executor.submit(job)
        try:
            result = _current.result()
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
            return

        code = 200 if result.get("ok") else 422
        self._send(code, json.dumps(result).encode("utf-8"))

    def _handle_simulate(self, body: dict[str, Any]) -> None:
        """POST /api/simulate — mock K2 rubric + one :class:`~dev_sim.economy.CompanyState` settlement."""
        name = (body.get("project_name") or "").strip()
        if not name:
            self._send(400, json.dumps({"ok": False, "error": "missing project_name"}).encode("utf-8"))
            return

        spec = body.get("project_spec")
        if spec is not None and not isinstance(spec, str):
            spec = str(spec)
        spec_str = (spec or "").strip()

        try:
            expected_mrr = float(body.get("expected_mrr", 0))
        except (TypeError, ValueError):
            self._send(400, json.dumps({"ok": False, "error": "expected_mrr must be a number"}).encode("utf-8"))
            return
        if expected_mrr < 0:
            self._send(400, json.dumps({"ok": False, "error": "expected_mrr must be >= 0"}).encode("utf-8"))
            return

        raw_sum = body.get("team_stats_sum", 0)
        try:
            team_stats_sum = int(raw_sum)
        except (TypeError, ValueError):
            self._send(400, json.dumps({"ok": False, "error": "team_stats_sum must be an integer"}).encode("utf-8"))
            return
        if team_stats_sum < 0:
            self._send(400, json.dumps({"ok": False, "error": "team_stats_sum must be >= 0"}).encode("utf-8"))
            return

        os.chdir(REPO_ROOT)
        from dev_sim.tycoon_sprint import run_mock_sprint

        try:
            result = run_mock_sprint(name, spec_str, expected_mrr, team_stats_sum)
        except Exception as e:  # noqa: BLE001 — surface to UI / curl
            self._send(500, json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}).encode("utf-8"))
            return

        try:
            result = {**result, "targetPush": _maybe_push_after_settlement(name)}
        except Exception as e:  # noqa: BLE001
            result = {**result, "targetPush": {"ok": False, "error": f"{type(e).__name__}: {e}"}}

        self._send(200, json.dumps(result).encode("utf-8"))


def main(host: str = "127.0.0.1", port: int = 8765) -> None:
    os.chdir(REPO_ROOT)
    print("Loaded API Keys from .env", file=sys.stderr)
    httpd = ThreadingHTTPServer((host, port), BridgeHandler)
    print(f"dev_sim_bridge listening on http://{host}:{port}", file=sys.stderr)
    print(
        "  POST /api/orchestrate  JSON {\"prompt\": \"...\"}  "
        "(plan → sequential sprint orchestrate, same as dev-sim-run)",
        file=sys.stderr,
    )
    print(
        "  POST /api/simulate     JSON "
        '{"project_name":"...","expected_mrr":0,"team_stats_sum":0'
        ',"project_spec":"..." (optional)}',
        file=sys.stderr,
    )
    print("  GET  /api/health", file=sys.stderr)
    print("  GET  /api/economy   (company-state.json for HUD sync)", file=sys.stderr)
    print("  GET  /api/company   (CompanyState JSON + persisted, same as run_api.py)", file=sys.stderr)
    print("  POST /api/company/reset  (overwrite company-state.json with Day 1 defaults)", file=sys.stderr)
    print("  GET  /api/agents  optional ?seed=int", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", file=sys.stderr)
    finally:
        httpd.server_close()
        _executor.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    a = p.parse_args()
    main(host=a.host, port=a.port)
