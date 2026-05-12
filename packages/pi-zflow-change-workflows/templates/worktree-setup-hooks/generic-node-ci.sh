#!/usr/bin/env bash
# ============================================================================
# generic-node-ci.sh — worktreeSetupHook template for plain TS/JS repos
# ============================================================================
# Template for repos that only need `npm ci` or `pnpm install --frozen-lockfile`
# inside a fresh worktree. Copy to your repo as `.pi/zflow/worktree-setup-hook.sh`
# and adjust the `install_cmd` below if needed.
#
# Usage:
#   cp generic-node-ci.sh .pi/zflow/worktree-setup-hook.sh
#   chmod +x .pi/zflow/worktree-setup-hook.sh
#   # Optionally edit install_cmd to match your package manager
#   git add .pi/zflow/worktree-setup-hook.sh
# ============================================================================
set -euo pipefail

# The worktree root is passed as the first positional argument.
WORKTREE_ROOT="${1:?usage: $0 <worktree-root>}"
cd "$WORKTREE_ROOT"

# ---------------------------------------------------------------------------
# Config — change this to match your repo's package manager.
# ---------------------------------------------------------------------------
# Supported values:
#   "npm ci --production=false"
#   "pnpm install --frozen-lockfile"
#   "yarn install --frozen-lockfile"
#   "npm install --ignore-scripts && npm rebuild"
INSTALL_CMD="npm ci --production=false"

echo "[worktreeSetupHook] Installing dependencies in ${WORKTREE_ROOT}..."
eval "$INSTALL_CMD"

echo "[worktreeSetupHook] Dependencies installed successfully."
