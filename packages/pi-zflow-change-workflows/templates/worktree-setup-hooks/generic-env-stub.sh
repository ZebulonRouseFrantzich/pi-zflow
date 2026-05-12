#!/usr/bin/env bash
# ============================================================================
# generic-env-stub.sh — worktreeSetupHook template for env stub generation
# ============================================================================
# Template for repos that need an `.env` file (copied from `.env.example`)
# before the app can start, lint, or pass type checks in a fresh worktree.
#
# Usage:
#   cp generic-env-stub.sh .pi/zflow/worktree-setup-hook.sh
#   chmod +x .pi/zflow/worktree-setup-hook.sh
#   # Optionally edit ENV_SOURCE / ENV_TARGET below
#   git add .pi/zflow/worktree-setup-hook.sh
# ============================================================================
set -euo pipefail

WORKTREE_ROOT="${1:?usage: $0 <worktree-root>}"
cd "$WORKTREE_ROOT"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ENV_SOURCE=".env.example"
ENV_TARGET=".env"

# ---------------------------------------------------------------------------
# Hook logic
# ---------------------------------------------------------------------------
if [[ ! -f "$ENV_SOURCE" ]]; then
  echo "[worktreeSetupHook] ERROR: ${ENV_SOURCE} not found in worktree."
  echo "[worktreeSetupHook] Create ${ENV_SOURCE} or update ENV_SOURCE in the hook script."
  exit 1
fi

if [[ -f "$ENV_TARGET" ]]; then
  echo "[worktreeSetupHook] ${ENV_TARGET} already exists — skipping."
  exit 0
fi

cp "$ENV_SOURCE" "$ENV_TARGET"
echo "[worktreeSetupHook] Created ${ENV_TARGET} from ${ENV_SOURCE}."
echo "[worktreeSetupHook] WARNING: ${ENV_TARGET} contains stub values. Review and update before production use."
