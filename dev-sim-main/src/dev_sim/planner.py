"""Planning agent: one-shot decomposition of a project idea into ordered sprints.

Uses the Anthropic Messages API (same stack as the coding agent).
Call ``run_planning_agent(idea)`` to get a list of sprint dicts ready for
``run_coding_agent(sprint["prompt"], ...)``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import anthropic

from dev_sim.config import get_anthropic_api_key, load_env, resolve_coding_model

_DEFAULT_PROMPT_PATH = Path(__file__).resolve().parent.parent.parent / "llm" / "planning_prompt.md"


def _load_system_prompt(path: Path | None) -> str:
    candidates = [path] if path else [_DEFAULT_PROMPT_PATH, Path.cwd() / "llm" / "planning_prompt.md"]
    for p in candidates:
        if p and p.exists():
            return p.read_text(encoding="utf-8")
    raise FileNotFoundError(
        f"planning_prompt.md not found. Checked: {[str(c) for c in candidates]}"
    )


def _build_user_message(idea: str) -> str:
    return f"""{idea}

---

Respond with **two sections in this exact order**:

**Section 1 — JSON sprint list (output this first):**

```json
[
  {{
    "number": 1,
    "title": "Short sprint title",
    "prompt": "Full prompt for the coding agent — self-contained with all project context (stack, auth, endpoints, data models, acceptance criteria) so it can implement without reading other sprints."
  }}
]
```

**Section 2 — Human-readable plan:**
After the JSON block, write the full human-readable plan as described in your instructions.
"""


def _strip_outer_markdown_fence(s: str) -> str:
    """Remove a leading ``` / ```json … fence and trailing ``` so JSON can parse."""
    t = (s or "").strip().lstrip("\ufeff")
    if not t.startswith("```"):
        return t
    rest = t[3:].lstrip()
    low = rest[:12].lower()
    if low.startswith("json"):
        rest = rest[4:].lstrip()
    nl = rest.find("\n")
    if nl != -1:
        rest = rest[nl + 1 :]
    end = rest.rfind("```")
    if end != -1:
        rest = rest[:end].rstrip()
    return rest.strip()


# ```lang\n...``` bodies in order; lang may be empty (```\n) or "json" / "ts" / etc.
_FENCE_RE = re.compile(
    r"^```[ \t]*([A-Za-z0-9#+._-]*)\r?\n(.*?)^```[ \t]*$",
    re.IGNORECASE | re.MULTILINE | re.DOTALL,
)


def _all_fenced_bodies(t: str) -> list[str]:
    """All markdown fenced code bodies, in file order; inner content is stripped."""
    t = t or ""
    if not t.strip():
        return []
    return [m.group(2).strip() for m in _FENCE_RE.finditer(t) if m.group(2) is not None]


def _try_load_json(s: str) -> Any | None:
    s = (s or "").strip()
    if not s or s[0] not in "[{":
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None


def _raw_decode_array_scan(t: str) -> Any | None:
    """Try ``JSONDecoder.raw_decode`` starting at every ``[`` (K2 may prefix prose to the plan)."""
    dec = json.JSONDecoder()
    i = 0
    while True:
        start = t.find("[", i)
        if start == -1:
            return None
        try:
            v, _ = dec.raw_decode(t, start)
            if isinstance(v, (list, dict)) and (not isinstance(v, list) or v):
                return v
        except json.JSONDecodeError:
            pass
        i = start + 1


def _raw_decode_object_scan(t: str) -> Any | None:
    """Same for ``{``; picks up an object with ``"sprints": [ ...]`` in long output."""
    dec = json.JSONDecoder()
    i = 0
    while True:
        start = t.find("{", i)
        if start == -1:
            return None
        try:
            v, _ = dec.raw_decode(t, start)
            if isinstance(v, (list, dict)) and (not isinstance(v, list) or v):
                return v
        except json.JSONDecodeError:
            pass
        i = start + 1


def _decode_json_after_substring(s: str, marker: str) -> Any | None:
    """Decode a JSON value starting at the first ``[`` or ``{`` after *marker* (e.g. `````json``)."""
    dec = json.JSONDecoder()
    idx = s.find(marker)
    if idx == -1:
        return None
    sub = s[idx + len(marker) :].lstrip()
    for ch in ("[", "{"):
        j = sub.find(ch)
        if j == -1:
            continue
        try:
            v, _ = dec.raw_decode(sub, j)
        except json.JSONDecodeError:
            continue
        if not isinstance(v, (list, dict)):
            return None
        if isinstance(v, list) and len(v) == 0:
            continue
        return v
    return None


def _decode_plan_json(text: str) -> Any:
    """Parse planner output into a JSON value (array/object); tolerates prose, fences, wrappers.

    Tries, in order: full-document JSON; any fenced block that is JSON; first ```json
    block; then scan every ``[`` / ``{`` in the file for a valid top-level value.
    """
    t0 = (text or "").strip().lstrip("\ufeff")
    if not t0:
        raise ValueError("Planner returned empty content after stripping fences.")

    t = _strip_outer_markdown_fence(t0)
    for candidate in (t, t0):
        if not candidate:
            continue
        loaded = _try_load_json(candidate)
        if loaded is not None:
            return loaded
        for marker in ("```json", "```JSON"):
            j = _decode_json_after_substring(candidate, marker)
            if j is not None:
                return j

    # Every fenced code block — K2 may include prose before the JSON, or use ```/```json
    seen: set[str] = set()
    for body in _all_fenced_bodies(t0):
        if not body or body in seen:
            continue
        seen.add(body)
        b = body.strip()
        if not b:
            continue
        if b[0:1] in "[{":
            hit = _try_load_json(b)
            if hit is not None:
                return hit
        for start_ch in ("[", "{"):
            s = 0
            dec = json.JSONDecoder()
            while (s := b.find(start_ch, s)) != -1:
                try:
                    v, _ = dec.raw_decode(b, s)
                    if isinstance(v, (list, dict)) and (not isinstance(v, list) or v):
                        return v
                except json.JSONDecodeError:
                    pass
                s += 1
        v2 = _raw_decode_array_scan(b) or _raw_decode_object_scan(b)
        if v2 is not None:
            return v2

    # Full message: first well-formed top-level array/object
    for scanner in (_raw_decode_array_scan, _raw_decode_object_scan):
        v = scanner(t0)
        if v is not None:
            return v

    raise ValueError("No valid JSON sprint list found in planner response")


def _sprint_rows_from_parsed(parsed: Any) -> list[Any]:
    """Accept [...] or {{\"sprints\": [...]}} / single sprint dict."""
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("sprints", "plan", "items", "tasks", "data", "result"):
            v = parsed.get(key)
            if isinstance(v, list):
                return v
        if any(
            k in parsed
            for k in (
                "prompt",
                "title",
                "description",
                "task",
                "instruction",
            )
        ):
            return [parsed]
    raise ValueError(
        "Planner JSON must be an array of sprint objects, or an object with a "
        "sprints/plan/items/tasks array, or a single sprint object."
    )


def _coerce_int(n: Any, default: int) -> int:
    try:
        return int(n)
    except (TypeError, ValueError):
        return default


def _normalize_sprint_entries(rows: list[Any], idea: str) -> list[dict[str, Any]]:
    """Ensure each sprint has number, title, and a non-empty prompt for orchestration."""
    out: list[dict[str, Any]] = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        n = _coerce_int(row.get("number"), i + 1)
        title = str(row.get("title") or row.get("name") or f"Sprint {n}").strip() or f"Sprint {n}"
        prompt = row.get("prompt")
        if prompt is None or (isinstance(prompt, str) and not prompt.strip()):
            for alt in (
                "description",
                "task",
                "body",
                "details",
                "scope",
                "implementation",
                "user_story",
                "instruction",
            ):
                v = row.get(alt)
                if isinstance(v, str) and v.strip():
                    prompt = v.strip()
                    break
                if isinstance(v, list):
                    joined = "\n".join(str(x).strip() for x in v if str(x).strip())
                    if joined:
                        prompt = joined
                        break
        prompt_s = (str(prompt) if prompt is not None else "").strip()
        if not prompt_s:
            prompt_s = (
                f"## {title}\n\nImplement this slice of the product. Use sensible defaults for "
                f"unspecified stack and scope.\n\n## Original product request\n{idea.strip()}"
            )
        out.append({"number": n, "title": title, "prompt": prompt_s})

    if not out:
        raise ValueError("No valid sprint objects after normalizing planner output.")
    return out


def _prose_fallback_sprint_list(idea: str, raw: str) -> list[dict[str, Any]]:
    """The planner may return a design/TS/markdown plan with no JSON sprint array. Feed it as a single PR-sized prompt."""
    text = (raw or "").strip()[:200_000]
    if not text and idea:
        text = (idea or "").strip()
    prompt = (
        f"## Product request (CEO / user)\n{(idea or '').strip() or '(none)'}\n\n"
        f"## Planner / design text from the model (may be markdown or TypeScript-like; "
        f"implement a sensible slice using this as context, not as literal schema)\n\n"
        f"{text}"
    )
    return _normalize_sprint_entries(
        [
            {
                "number": 1,
                "title": "Sprint 1 (from planner output, no array JSON found)",
                "prompt": prompt,
            }
        ],
        idea,
    )


def _parse_and_normalize_sprints(text: str, idea: str) -> list[dict[str, Any]]:
    try:
        parsed = _decode_plan_json(text)
    except (ValueError, TypeError):
        return _prose_fallback_sprint_list(idea, (text or "").strip())

    try:
        rows = _sprint_rows_from_parsed(parsed)
    except (ValueError, TypeError):
        return _prose_fallback_sprint_list(idea, (text or "").strip())

    if not rows:
        return _prose_fallback_sprint_list(idea, (text or "").strip())

    try:
        norm = _normalize_sprint_entries(rows, idea)
    except (ValueError, TypeError):
        return _prose_fallback_sprint_list(idea, (text or "").strip())
    if not norm:
        return _prose_fallback_sprint_list(idea, (text or "").strip())
    return norm


def planning_decompose(
    idea: str,
    *,
    model: str | None = None,
    planning_prompt_path: Path | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Return ``(sprints, raw_model_text)`` for UI + sprint board sync.

    Uses the Anthropic Messages API (``ANTHROPIC_API_KEY``). *model* follows
    :func:`resolve_coding_model` (same family as the coding agent).
    """
    api_key = get_anthropic_api_key()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required for planning.")

    resolved_model = resolve_coding_model(model)
    system_prompt = _load_system_prompt(planning_prompt_path)

    client = anthropic.Anthropic(api_key=api_key)
    try:
        resp = client.messages.create(
            model=resolved_model,
            max_tokens=8192,
            system=system_prompt,
            messages=[{"role": "user", "content": _build_user_message(idea)}],
        )
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"Planning request failed: {e}") from e

    parts: list[str] = []
    for block in resp.content:
        t = getattr(block, "text", None)
        if t is None and isinstance(block, dict):
            t = block.get("text")
        if t:
            parts.append(str(t))
    text = "".join(parts).strip()
    if not text:
        raise RuntimeError("Planning returned an empty response.")

    print(text, file=sys.stderr)
    return _parse_and_normalize_sprints(text, idea), text


def run_planning_agent(
    idea: str,
    *,
    model: str | None = None,
    planning_prompt_path: Path | None = None,
) -> list[dict[str, Any]]:
    """Decompose *idea* into an ordered list of sprint dicts.

    Each dict has ``number`` (int), ``title`` (str), and ``prompt`` (str).
    The planner makes a single one-shot call — no tool loop.
    """
    sprints, _ = planning_decompose(idea, model=model, planning_prompt_path=planning_prompt_path)
    return sprints


def main() -> None:
    load_env()
    parser = argparse.ArgumentParser(
        description="Decompose a project idea into ordered coding-agent sprints (Claude planning).",
    )
    parser.add_argument("idea", nargs="?", help="Free-form project description")
    parser.add_argument("-f", "--idea-file", type=Path, help="Read idea from file")
    parser.add_argument(
        "-m",
        "--model",
        default=None,
        help="Claude model id for planning (default: ANTHROPIC_MODEL env, then built-in)",
    )
    parser.add_argument(
        "--planning-prompt",
        type=Path,
        default=None,
        help="Path to planning system prompt (default: llm/planning_prompt.md)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Write sprint JSON to this file instead of stdout",
    )
    args = parser.parse_args()

    if not get_anthropic_api_key():
        print("ANTHROPIC_API_KEY is required for planning.", file=sys.stderr)
        sys.exit(1)

    if args.idea_file:
        idea = args.idea_file.read_text(encoding="utf-8").strip()
    elif args.idea:
        idea = args.idea.strip()
    else:
        print("Provide an idea as an argument or use --idea-file.", file=sys.stderr)
        sys.exit(2)

    try:
        sprints, _ = planning_decompose(
            idea,
            model=args.model,
            planning_prompt_path=args.planning_prompt,
        )
    except Exception as e:  # noqa: BLE001
        print(str(e), file=sys.stderr)
        sys.exit(1)

    out = json.dumps(sprints, indent=2, ensure_ascii=False)
    if args.output:
        args.output.write_text(out, encoding="utf-8")
        print(f"Sprints written to {args.output}", file=sys.stderr)
    else:
        print(out)


if __name__ == "__main__":
    main()
