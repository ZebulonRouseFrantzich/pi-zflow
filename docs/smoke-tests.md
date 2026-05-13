# Smoke Tests — Agent and Chain Validation

> Manual smoke-test procedures for every major chain and key agent in the
> pi-zflow suite. Run these to prove chain composition and agent behaviour
> before later phases depend on them.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Standalone Agent Smoke Tests](#standalone-agent-smoke-tests)
   - [zflow.repo-mapper](#zflowrepo-mapper)
   - [zflow.plan-validator](#zflowplan-validator)
   - [zflow.implement-routine](#zflowimplement-routine)
   - [zflow.synthesizer](#zflowsynthesizer)
4. [Chain Smoke Tests](#chain-smoke-tests)
   - [scout-plan-validate](#scout-plan-validate)
   - [parallel-review](#parallel-review)
   - [implement-and-review](#implement-and-review)
   - [plan-and-implement](#plan-and-implement)
   - [plan-review-swarm](#plan-review-swarm)
5. [Quick Validation Recipe](#quick-validation-recipe)
6. [Troubleshooting](#troubleshooting)

---

## Overview

These smoke tests verify that:

- `zflow.*` agents are discoverable by `pi-subagents` after installation
- Each agent responds with the expected role-appropriate behaviour
- Chain definitions resolve and can invoke their constituent stages
- Output flows correctly between chain stages
- Builtin agent overrides (`scout`, `context-builder`) apply correctly
- The manifest and output conventions work end-to-end

Each test can be run manually from the command line. The "quick validation"
recipe at the end runs a representative subset.

## Prerequisites

Before running any smoke test:

1. **Install agents and chains** — run the setup command:

   ```bash
   pi /zflow-setup-agents
   ```

   This copies agent markdown to `~/.pi/agent/agents/zflow/` and chain markdown
   to `~/.pi/agent/chains/`.

2. **Verify installation** — confirm agents are discoverable:

   ```bash
   ls ~/.pi/agent/agents/zflow/         # should list .md files
   ls ~/.pi/agent/chains/               # should list .chain.md files
   ```

3. **Activate a profile** — ensure `pi-zflow-profiles` has a resolved profile:

   ```bash
   pi /zflow-profile status
   # or, for the default profile:
   pi /zflow-profile activate default
   ```

4. **Confirm model availability** — the profile's lanes must resolve to
   actual models. Check lane status:

   ```bash
   pi /zflow-profile status --verbose
   ```

   If lanes show as `unresolved-required`, activation fails and no agent
   can launch. See [Troubleshooting](#troubleshooting).

5. **Working directory** — run all smoke tests from within a git repository
   that `pi-subagents` can access for context gathering. A small test fixture
   is recommended; any local pi-zflow checkout works.

---

## Standalone Agent Smoke Tests

### zflow.repo-mapper

Verify the repository mapper can produce a structural map of the workspace.

**Prerequisites:** Agents installed and profile active (see above).

**Procedure:**

```bash
pi --subagent run zflow.repo-mapper \
  --max-output 6000 \
  --model <model-from-profile>
```

Replace `<model-from-profile>` with the resolved model from the active profile
for the lane assigned to `repo-mapper` (e.g. `openai/gpt-5.4`).

Alternatively, if your profile is active, launch with the profile binding:

```bash
pi --subagent run zflow.repo-mapper
```

(Pi will use the binding from the profile automatically.)

**Expected behaviour:**

- The agent reads the repository structure using `read`, `grep`, `find`, `ls`.
- It produces a structured markdown map covering:
  - Top-level directory layout
  - Package structure (if monorepo)
  - Key entry points, types, and public API surfaces
  - Dependencies between modules
- The output is markdown with clear sections, not raw file dumps.

**How to verify success:**

- Output is valid markdown with at least the sections listed above.
- No errors about missing tools or permissions.
- Agent terminates normally (no infinite loops).
- Output does not exceed `6000` tokens (`--max-output` is respected).

---

### zflow.plan-validator

Verify the plan validator can analyse a set of planning artifacts and return
a structured PASS/FAIL/CONDITIONAL-PASS report.

**Prerequisites:** Agents installed, profile active, and a plan fixture exists.

**Create a minimal fixture:**

```bash
mkdir -p /tmp/zflow-smoke/plans/test-change/v1

cat > /tmp/zflow-smoke/plans/test-change/v1/design.md << 'EOF'
# Design: Test change
EOF

cat > /tmp/zflow-smoke/plans/test-change/v1/execution-groups.md << 'EOF'
# Execution Groups

## group-1
- files: ["src/main.ts"]
- assignedAgent: zflow.implement-routine
- dependencies: []
- reviewTags: ["standard"]
- verification: ["echo 'hello'"]
EOF

cat > /tmp/zflow-smoke/plans/test-change/v1/standards.md << 'EOF'
# Standards
- Use strict TypeScript.
EOF

cat > /tmp/zflow-smoke/plans/test-change/v1/verification.md << 'EOF'
# Verification
- Run: npm test
EOF
```

**Procedure:**

```bash
pi --subagent run zflow.plan-validator \
  --max-output 6000 \
  --prompt "Validate planning artifacts at /tmp/zflow-smoke/plans/test-change/v1/"
```

**Expected behaviour:**

- The validator reads the four artifact files.
- It checks structural rules: all four exist, file counts, dependencies, etc.
- It returns a structured report: `PASS`, `FAIL`, or `CONDITIONAL-PASS`
  with specific findings for any issues detected.

**How to verify success:**

- The output is a structured validation report.
- With a complete minimal fixture the result should be `PASS` or `CONDITIONAL-PASS`.
- If an artifact is missing or malformed, the report should say `FAIL` with
  a clear explanation.

---

### zflow.implement-routine

Verify a routine implementation agent can read context and produce a basic
implementation plan without actually modifying files (dry-run mode).

**Prerequisites:** Agents installed and profile active.

**Procedure:**

```bash
pi --subagent run zflow.implement-routine \
  --max-output 8000 \
  --prompt "Read README.md in /home/zeb/code/pi/pi-zflow and describe what you would change to add a smoke-tests badge to the top. Do NOT edit any files — only report what you would do."
```

**Expected behaviour:**

- The agent reads the README and understands the context.
- It reports a planned approach with specific file changes, in order.
- It does **not** write or edit any files.

**How to verify success:**

- Response is a structured implementation sketch with file paths and changes.
- No actual file modifications occur.
- Agent does not call `write`, `edit`, or mutation-capable `bash`.
- Output is within `8000` tokens.

---

### zflow.synthesizer

Verify the synthesizer can merge multiple structured reviewer finding reports
into a consolidated output.

**Prerequisites:** Agents installed and profile active.

**Create a synthetic findings fixture:**

```bash
mkdir -p /tmp/zflow-smoke/review
cat > /tmp/zflow-smoke/review/correctness-findings.md << 'EOF'
# Findings: correctness
Severity: critical
Location: src/core.ts:42
Evidence: Missing null check on user input
Recommendation: Add a null guard before processing
---
Severity: minor
Location: src/core.ts:88
Evidence: Unused import
Recommendation: Remove unused import
EOF

cat > /tmp/zflow-smoke/review/integration-findings.md << 'EOF'
# Findings: integration
Severity: major
Location: src/api.ts:15
Evidence: New endpoint does not validate Content-Type header
Recommendation: Add Content-Type validation middleware
EOF
```

**Procedure:**

```bash
pi --subagent run zflow.synthesizer \
  --max-output 12000 \
  --prompt "Synthesise the review findings from /tmp/zflow-smoke/review/correctness-findings.md and /tmp/zflow-smoke/review/integration-findings.md into a consolidated report. These represent the results of a code review by correctness and integration reviewers."
```

**Expected behaviour:**

- The synthesizer reads both finding files.
- It deduplicates overlapping findings.
- It groups findings by severity.
- It records which reviewers participated and notes coverage gaps.
- It produces a go/no-go recommendation.

**How to verify success:**

- Output is a consolidated markdown report with deduplicated findings.
- Severity groupings are present (critical, major, minor, nit).
- A coverage section notes which reviewers participated.
- A final recommendation (go / no-go / conditional-go) is present.

---

## Chain Smoke Tests

### scout-plan-validate

Run the exploration → planning → validation → plan review pipeline.

**Prerequisites:**

- Agents installed and profile active (see above)
- All lanes for the required agents must be resolvable:
  - `scout` (builtin, lane: `scout-cheap`)
  - `zflow.planner-frontier` (lane: `planning-frontier` or `planning-standard`)
  - `zflow.plan-validator` (lane: `planning-standard` or `fast-validation`)

**Create a minimal change fixture:**

```bash
mkdir -p /tmp/zflow-smoke/change
cat > /tmp/zflow-smoke/change/change.md << 'EOF'
# Change Request: Add version endpoint

Add a `/version` endpoint to the main server that returns the current
package version from package.json. The endpoint should:
- Respond to GET /version
- Return JSON: { "version": "<version>" }
- Be available without authentication
- Have a minimal test
EOF
```

**Procedure:**

```bash
pi --chain scout-plan-validate \
  change=/tmp/zflow-smoke/change/change.md
```

**Expected behaviour:**

1. **scout** explores the codebase, reads relevant files (package.json, server
   entry point, test files), produces `context.md`.
2. **zflow.planner-frontier** reads the scout output, produces four plan
   artifacts (design, execution-groups, standards, verification) using
   `zflow_write_plan_artifact`.
3. **zflow.plan-validator** reads the artifacts and returns PASS/FAIL.
4. (Optional) If the plan is complex or high-risk, plan reviewers run.

**How to verify success:**

- Chain completes without errors.
- Scout produces a structured context handoff (`context.md`).
- Four plan artifacts exist under `<runtime-state-dir>/plans/`.
- Plan validator output is visible and shows PASS or CONDITIONAL-PASS.
- No source files are modified by any stage.

---

### parallel-review

Run a multi-angle code review against synthetic changes.

**Prerequisites:** Agents installed and profile active.

**Create a synthetic diff fixture:**

```bash
mkdir -p /tmp/zflow-smoke/diff
cat > /tmp/zflow-smoke/diff/changes.diff << 'EOF'
diff --git a/src/api.ts b/src/api.ts
index 1234567..abcdef0 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -10,6 +10,13 @@ import { Router } from "express"
 const router = Router()

+router.get("/version", (req, res) => {
+  const pkg = require("../package.json")
+  res.json({ version: pkg.version })
+})
+
 export function startServer(port: number) {
   console.log(`Starting on port ${port}`)
EOF
```

Also create planning documents that the reviewers read:

```bash
mkdir -p /tmp/zflow-smoke/plan
cat > /tmp/zflow-smoke/plan/design.md << 'EOF'
# Design: Add version endpoint

Add a /version endpoint to the Express server that returns the package version.
The implementation reads package.json via require() and returns JSON.

Affected files: src/api.ts
EOF

cat > /tmp/zflow-smoke/plan/execution-groups.md << 'EOF'
# Execution Groups

## group-1
- files: ["src/api.ts"]
- assignedAgent: zflow.implement-routine
- dependencies: []
- reviewTags: ["standard"]
EOF

cat > /tmp/zflow-smoke/plan/standards.md << 'EOF'
# Standards
EOF

cat > /tmp/zflow-smoke/plan/verification.md << 'EOF'
# Verification
EOF
```

**Procedure:**

```bash
pi --chain parallel-review \
  diff=/tmp/zflow-smoke/diff/changes.diff \
  plan-dir=/tmp/zflow-smoke/plan
```

**Expected behaviour:**

1. **zflow.review-correctness** — reviews for logic errors, edge cases,
   type safety. Notes that `require("../package.json")` is synchronous and
   may not be the best pattern for an API endpoint, but not a correctness
   error per se.
2. **zflow.review-integration** — reviews API contracts and module coupling.
3. **zflow.review-security** — reviews security concerns (the unauthenticated
   endpoint is intended behaviour per the change request, but notes it).
4. (Optional) **zflow.review-logic** and **zflow.review-system** run if
   configured.
5. **zflow.synthesizer** — consolidates all findings into a final report.

**How to verify success:**

- Chain completes without errors.
- At least three reviewer outputs are produced (correctness, integration,
  security).
- Findings use severity: critical / major / minor / nit.
- Each finding includes location (file:line) and evidence.
- Synthesizer output is present as a consolidated report with deduplicated
  findings, coverage notes, and a go/no-go recommendation.
- No files were modified by any stage.

---

### implement-and-review

Run the implementation → verification → review pipeline (single group).

**Prerequisites:** Agents installed and profile active.

**Create a minimal implementation fixture:**

```bash
mkdir -p /tmp/zflow-smoke/implement-plan
cat > /tmp/zflow-smoke/implement-plan/design.md << 'EOF'
# Design: Smoke test fixture
EOF

cat > /tmp/zflow-smoke/implement-plan/execution-groups.md << 'EOF'
# Execution Groups

## group-1
- files: ["/tmp/zflow-smoke/hello.txt"]
- assignedAgent: zflow.implement-routine
- dependencies: []
- reviewTags: ["standard"]
- verification: ["cat /tmp/zflow-smoke/hello.txt"]
EOF

cat > /tmp/zflow-smoke/implement-plan/standards.md << 'EOF'
# Standards
EOF

cat > /tmp/zflow-smoke/implement-plan/verification.md << 'EOF'
# Verification
- Command: cat /tmp/zflow-smoke/hello.txt
- Expected: Hello, world!
EOF
```

**Procedure:**

```bash
pi --chain implement-and-review \
  plan-dir=/tmp/zflow-smoke/implement-plan \
  group-id=group-1
```

**Expected behaviour:**

1. **zflow.implement-routine** (or the assigned agent from the plan) reads
   the plan, creates `/tmp/zflow-smoke/hello.txt`, writes "Hello, world!",
   runs the verification step `cat /tmp/zflow-smoke/hello.txt`.
2. **zflow.verifier** runs the verification command exactly as specified and
   checks the output against expected value.
3. **zflow.review-correctness** and **zflow.review-integration** review the
   changes.
4. **zflow.synthesizer** consolidates findings.

**How to verify success:**

- Chain completes without errors.
- Implementation agent creates the expected file with correct content.
- Verifier reports PASS with evidence.
- Reviewers produce structured findings (even a trivial change gets reviewed).
- Synthesizer produces a consolidated report.

---

### plan-and-implement

Run the full end-to-end workflow (scout → plan → validate → implement →
verify → review → synthesize). This is the longest test.

**Prerequisites:** All agents installed and profile lanes resolvable.

**Create a minimal change request fixture:**

```bash
mkdir -p /tmp/zflow-smoke/full-change
cat > /tmp/zflow-smoke/full-change/change.md << 'EOF'
# Change Request: Add CI workflow badge

Add a simple CI workflow status badge to the root README.md. The badge
should use GitHub Actions badge syntax and reference the repository's
main workflow.
EOF
```

**Procedure:**

```bash
pi --chain plan-and-implement \
  change=/tmp/zflow-smoke/full-change/change.md \
  repo-path=/home/zeb/code/pi/pi-zflow
```

**Expected behaviour:**

1. **scout** explores the repository, reads README.md, identifies existing
   badge patterns and workflow files.
2. **zflow.planner-frontier** produces four plan artifacts.
3. **zflow.plan-validator** validates the artifacts.
4. **zflow.implement-routine** makes the changes (adds the badge).
5. **zflow.verifier** runs scoped verification.
6. **zflow.review-correctness** and **zflow.review-integration** review.
7. **zflow.synthesizer** consolidates findings.

**How to verify success:**

- Chain completes without errors.
- Scout produces context handoff.
- Four plan artifacts exist.
- Implementation makes the intended change.
- Verifier results are reported.
- Reviewer findings are structured.
- Synthesizer produces a go/no-go recommendation.
- **(Important)** Run `git checkout -- README.md` after to undo the change.

---

### plan-review-swarm

Run a full plan-review swarm against planning artifacts.

**Prerequisites:** Agents installed and profile active.

**Create minimal planning artifacts:**

```bash
mkdir -p /tmp/zflow-smoke/plan-review

cat > /tmp/zflow-smoke/plan-review/design.md << 'EOF'
# Design: Add rate limiting middleware

Add rate limiting to the Express API using `express-rate-limit`.
The middleware should apply globally with a default of 100 requests
per 15 minutes per IP.

Affected files:
- src/server.ts (apply middleware)
- package.json (add dependency)
EOF

cat > /tmp/zflow-smoke/plan-review/execution-groups.md << 'EOF'
# Execution Groups

## group-1
- files: ["package.json", "src/server.ts"]
- assignedAgent: zflow.implement-routine
- dependencies: []
- reviewTags: ["standard"]
- verification: ["npm test", "curl -v http://localhost:3000/"]
EOF

cat > /tmp/zflow-smoke/plan-review/standards.md << 'EOF'
# Standards
- Use strict TypeScript.
- Follow existing middleware patterns in src/middleware/.
EOF

cat > /tmp/zflow-smoke/plan-review/verification.md << 'EOF'
# Verification
- npm test passes
- Rate limit headers appear on response
EOF
```

**Procedure:**

```bash
pi --chain plan-review-swarm \
  plan-dir=/tmp/zflow-smoke/plan-review
```

**Expected behaviour:**

1. **zflow.plan-review-correctness** — reviews logic correctness: whether
   the design addresses the request, edge cases, dependency soundness.
2. **zflow.plan-review-integration** — reviews cross-module impacts: whether
   the middleware integrates cleanly with existing server setup.
3. **zflow.plan-review-feasibility** — reviews practical feasibility: whether
   referenced files/paths exist, effort is realistic.
4. **zflow.plan-validator** — runs structural validation.
5. **zflow.synthesizer** — consolidates findings.

**How to verify success:**

- Chain completes without errors.
- All three plan-review agents produce structured findings with severities.
- Plan validator returns PASS or CONDITIONAL-PASS (not FAIL for a well-formed
  plan).
- Synthesizer produces a consolidated plan-review report with coverage notes
  and a go/no-go/conditional-go recommendation.
- No source files are modified.

---

## Quick Validation Recipe

Run this single script to validate the key agents and one chain in sequence.
It exercises the most important behaviours without the full setup of every test.

```bash
#!/usr/bin/env bash
# Phase 4 smoke-test quick validation
# Run from the pi-zflow repository root.
set -euo pipefail

echo "=== Phase 4 Quick Smoke Tests ==="

# 0. Prerequisites check
echo "--- 0. Checking prerequisites ---"
if ! command -v pi &>/dev/null; then
  echo "ERROR: pi CLI not found. Is pi installed?"
  exit 1
fi
if [ ! -d ~/.pi/agent/agents/zflow ]; then
  echo "Installing zflow agents..."
  pi /zflow-setup-agents
fi
echo "Agents installed: $(ls ~/.pi/agent/agents/zflow/*.md 2>/dev/null | wc -l) files"
echo "Chains installed: $(ls ~/.pi/agent/chains/*.chain.md 2>/dev/null | wc -l) files"

# 1. zflow.repo-mapper — verify agent is discoverable and responsive
echo ""
echo "--- 1. Smoke test: zflow.repo-mapper ---"
pi --subagent run zflow.repo-mapper --max-output 1000 \
  --prompt "List top-level files and directories in /home/zeb/code/pi/pi-zflow. Return only a bullet list." \
  2>&1 | head -20

echo ""
echo "--- 2. Smoke test: zflow.plan-validator (fixture) ---"
# Use fixture from /tmp/zflow-smoke/plans/ (create if missing)
if [ ! -f /tmp/zflow-smoke/plans/test-change/v1/design.md ]; then
  mkdir -p /tmp/zflow-smoke/plans/test-change/v1
  for art in design execution-groups standards verification; do
    echo "# $art" > "/tmp/zflow-smoke/plans/test-change/v1/${art}.md"
  done
fi
pi --subagent run zflow.plan-validator --max-output 2000 \
  --prompt "Validate planning artifacts at /tmp/zflow-smoke/plans/test-change/v1/" \
  2>&1 | head -20

echo ""
echo "--- 3. Smoke test: zflow.synthesizer ---"
if [ ! -f /tmp/zflow-smoke/review/correctness-findings.md ]; then
  mkdir -p /tmp/zflow-smoke/review
  cat > /tmp/zflow-smoke/review/correctness-findings.md << 'EOFF'
# Findings: correctness
Severity: critical
Location: src/core.ts:42
Evidence: Missing null check
Recommendation: Add null guard
EOFF
  cat > /tmp/zflow-smoke/review/integration-findings.md << 'EOFF'
# Findings: integration
Severity: major
Location: src/api.ts:15
Evidence: Missing validation
Recommendation: Add middleware
EOFF
fi
pi --subagent run zflow.synthesizer --max-output 2000 \
  --prompt "Synthesise findings from /tmp/zflow-smoke/review/correctness-findings.md and /tmp/zflow-smoke/review/integration-findings.md" \
  2>&1 | head -20

echo ""
echo "=== All quick smoke tests completed ==="
```

To use this recipe:

```bash
chmod +x /path/to/recipe.sh
./recipe.sh
```

**What it validates:**

- `pi` CLI is available and agents are installed
- `zflow.repo-mapper` is discoverable and responds
- `zflow.plan-validator` can read artifacts and return a report
- `zflow.synthesizer` can merge multiple findings into a report

**What it does NOT validate (run the full tests for these):**

- Chain execution end-to-end (quick validation skips chains by design —
  they require more prerequisites and take longer to run)
- Builtin agent overrides (`scout`, `context-builder`) — these require
  a full chain invocation
- Optional reviewers (`review-logic`, `review-system`)

---

## Troubleshooting

### Agent not found

```
Error: Unknown agent: zflow.repo-mapper
```

**Cause:** Agents not installed or `pi-subagents` cannot discover them.

**Fix:**

```bash
pi /zflow-setup-agents
ls ~/.pi/agent/agents/zflow/
```

If the directory is empty, re-run the install command. If it does not exist,
check that `pi-zflow-agents` extension is loaded:

```bash
pi extension list | grep zflow-agents
```

### Model/lane not resolved

```
Error: No model available for lane <lane-name>
```

**Cause:** The active profile's lane cannot be resolved to a concrete model,
or no profile is active.

**Fix:**

```bash
pi /zflow-profile status --verbose
pi /zflow-profile activate default   # or another valid profile
```

Ensure the profile's `preferredModels` lists models that are available and
authenticated in the current Pi environment.

### Chain stage not found

```
Error: Unknown stage: zflow.planner-frontier
```

**Cause:** The chain file references an agent that is not installed.

**Fix:** Install agents and verify the agent exists:

```bash
pi /zflow-setup-agents
ls ~/.pi/agent/agents/zflow/planner-frontier.md
```

Also check the chain file's frontmatter for the correct stage names.

### Output exceeds limit

```
Warning: Output truncated (maxOutput: 6000)
```

**Cause:** The agent generated more tokens than `maxOutput` allows. This is
expected for large codebases or verbose agents.

**Fix:** For smoke testing, increase `--max-output` or provide a more focused
prompt. For production, tune the agent's frontmatter or profile binding
`maxOutput` setting.

### Permission or path issues

```
Error: EACCES: permission denied
```

**Cause:** The agent tried to write to a path it does not have permission for,
or `pi-subagents` sandboxing blocked the access.

**Fix:** Run from within the project directory. If the error references
`~/.pi/agent/artifacts/`, check that the runtime-state directory exists and is
writable:

```bash
ls -la ~/.pi/agent/
```

### Profile binding takes precedence but is wrong

If a profile binding overrides an agent's `maxSubagentDepth` or `tools` with
unexpected values, the launch config validation may fail.

**Fix:** Inspect the active profile:

```bash
cat ~/.pi/agent/zflow/active-profile.json | jq '.agentBindings["zflow.implement-routine"]'
```

Correct the binding in the profile definition, or override at launch time with
explicit flags.

### Plan validator returns FAIL unexpectedly

**Cause:** The plan artifacts may not meet structural rules (missing artifacts,
files-per-group exceeded, inconsistent dependencies).

**Fix:** Read the validator's output for specific findings. The most common
issue with the minimal fixture above is that the `design.md` or `standards.md`
content is too minimal — the validator may interpret this as missing required
detail. Add more structured content following the plan artifact templates.

## See also

- `docs/subagents-integration.md` — detailed pi-subagents integration guide
- `packages/pi-zflow-agents/README.md` — agent and chain overview
- `docs/phase-0-smoke-test-report.md` — Phase 0 foundation smoke tests
- `docs/foundation-versions.md` — version pins and compatibility
