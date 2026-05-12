#!/usr/bin/env bash
# ============================================================================
# generic-codegen.sh — worktreeSetupHook template for code generation
# ============================================================================
# Template for repos that need code generation steps inside a fresh worktree
# (e.g., Prisma client, GraphQL types, protobuf stubs).
#
# Usage:
#   cp generic-codegen.sh .pi/zflow/worktree-setup-hook.sh
#   chmod +x .pi/zflow/worktree-setup-hook.sh
#   # Edit the GENERATE_CMDS array below
#   git add .pi/zflow/worktree-setup-hook.sh
# ============================================================================
set -euo pipefail

WORKTREE_ROOT="${1:?usage: $0 <worktree-root>}"
cd "$WORKTREE_ROOT"

# ---------------------------------------------------------------------------
# Config — add or remove generation commands as needed.
# Each command is run in order. If any fails, the hook fails.
# ---------------------------------------------------------------------------
GENERATE_CMDS=(
  # "npx prisma generate"
  # "npx graphql-codegen"
  # "npx protoc --ts_out src/generated --proto_path proto proto/*.proto"
  # "make generate"
)

# ---------------------------------------------------------------------------
# Hook logic
# ---------------------------------------------------------------------------
if [[ ${#GENERATE_CMDS[@]} -eq 0 ]]; then
  echo "[worktreeSetupHook] No generation commands configured."
  echo "[worktreeSetupHook] Edit GENERATE_CMDS in the hook script."
  echo "[worktreeSetupHook] Skipping code generation."
  exit 0
fi

for cmd in "${GENERATE_CMDS[@]}"; do
  echo "[worktreeSetupHook] Running: ${cmd}"
  eval "$cmd"
  echo "[worktreeSetupHook] Done: ${cmd}"
done

echo "[worktreeSetupHook] Code generation complete."
