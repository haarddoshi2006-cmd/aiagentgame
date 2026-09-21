#!/usr/bin/env bash
# Creates ./_demo_repo with three commits from three distinct author identities.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="${ROOT}/_demo_repo"

rm -rf "$REPO"
mkdir -p "$REPO"
cd "$REPO"

git init --initial-branch=feature/checkout-slice >/dev/null

# Optional: make main the default name on older git
git config user.name "dev-sim demo"
git config user.email "demo@local.dev"

commit_as() {
  local name="$1"
  local email="$2"
  local msg="$3"
  shift 3
  export GIT_AUTHOR_NAME="$name"
  export GIT_AUTHOR_EMAIL="$email"
  export GIT_COMMITTER_NAME="$name"
  export GIT_COMMITTER_EMAIL="$email"
  git add -A
  git commit -m "$msg" "$@"
  unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
}

mkdir -p src/components src/routes docs/standups

# --- Sam (frontend): terse, types-first ---
cat > src/components/CheckoutForm.tsx <<'EOF'
export type CheckoutPayload = Readonly<{
  cardLast4: string;
  amountCents: number;
}>;

/** UI-only; server contract lives in API route. */
export function CheckoutForm(_props: { onSubmit: (p: CheckoutPayload) => void }) {
  return null;
}
EOF

commit_as \
  "Sam Okonkwo" \
  "sam-okonkwo@agents.local" \
  "refactor(ui): narrow CheckoutForm props

- Export CheckoutPayload for shared validation with API
- Stub render; wiring in next slice"

# --- Priya (backend): diplomatic, incremental ---
cat > src/routes/checkout.ts <<'EOF'
import type { CheckoutPayload } from "../components/CheckoutForm.js";

export function validateCheckoutBody(body: unknown): CheckoutPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.cardLast4 !== "string" || b.cardLast4.length !== 4) return null;
  if (typeof b.amountCents !== "number" || b.amountCents <= 0) return null;
  return { cardLast4: b.cardLast4, amountCents: b.amountCents };
}
EOF

commit_as \
  "Priya Nair" \
  "priya-nair@agents.local" \
  "feat(api): validate checkout payload

- Mirror CheckoutPayload from FE types
- Return null on bad input; handler can map to 400"

# --- Riley (scrum_master): process artifact, not code ---
cat > docs/standups/2026-04-18.md <<'EOF'
# Stand-up — checkout slice

**Yesterday:** Scope agreed; FE/API boundary at `CheckoutPayload`.

**Today:** Unblocked after Sam + Priya land types + validation; QA can stub happy path.

**Blockers:** None. **Weather:** partly cloudy (team energy ok, deadline tight).
EOF

commit_as \
  "Riley Kim" \
  "riley-kim@agents.local" \
  "docs: stand-up — checkout slice unblocked"

echo ""
echo "Demo repo ready: $REPO"
echo "Try: cd \"$REPO\" && git log --format=fuller --reverse"
