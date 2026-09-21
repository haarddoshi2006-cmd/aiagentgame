#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

if command -v pnpm >/dev/null 2>&1; then
  echo "[install] Installing dependencies with pnpm..."
  NODE_ENV=development PNPM_CONFIG_PRODUCTION=false pnpm install --config.confirmModulesPurge=false --prefer-offline
else
  echo "[install] pnpm not found; installing with npm..."
  npm install
fi
