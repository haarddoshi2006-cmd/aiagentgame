# K2 Think Feature Split Demo

Basic demo: user enters a project idea, K2 Think API splits it into vertical-slice features, then the script writes:

- `docs/srs/overview.md`
- `docs/features/<sprint>-<feature>.md`

## Requirements

- Python 3.10+
- K2 Think API key (`K2THINK_API_KEY`)

## Quick start

From this folder:

```bash
chmod +x demo.py
export K2THINK_API_KEY="your_api_key_here"
./demo.py --idea "A B2B invoice approval web app"
```

The script auto-loads `.env` from either:

- `examples/gemini-feature-split-demo/.env`
- repository root `.env` (for this repo: `/home/mayira/dev-sim/.env`)

Optional explicit arguments:

```bash
./demo.py --idea "A B2B invoice approval web app" --api-key "$K2THINK_API_KEY" --model MBZUAI-IFM/K2-Think-v2
```

If Cloudflare blocks the default client signature, override the user-agent:

```bash
./demo.py --idea "calculator" --user-agent "curl/8.5.0"
```

## Inputs / prompt source

The script uses `../../llm/task_splitter.md` as the seed instruction and appends your project idea plus a strict JSON output contract.

Override prompt path:

```bash
./demo.py --idea "..." --splitter-prompt /absolute/path/to/task_splitter.md
```

## Output

- SRS overview: `docs/srs/overview.md`
- Per-feature docs: `docs/features/01-*.md`, `02-*.md`, ...

## Notes

- This is intentionally basic: no schema validation library, no retries.
- The script calls `https://api.k2think.ai/v1/chat/completions` directly via HTTPS.
- It extracts the first JSON object from model text output.
- If API key is missing or invalid, the request fails immediately.
- Common API failures (`429`, `401`, `403`) are shown with concise human guidance.
