# Bootstrap / Preflight Checks Design

> **Design reference for machine prerequisite checks.**
> Intended for Phase 7 workflow commands (`/zflow-change-prepare`, `/zflow-change-implement`)
> and profile activation (`/zflow-profile switch`, `/zflow-profile validate`).
> These checks must be called before expensive operations to fail fast when
> required tooling or auth state is missing.

## Overview

Preflight checks validate that the current machine has the required tooling,
authentication state, and model availability for pi-zflow operations. They are
designed to be:

- **Selective**: check only what the requested operation needs
- **Fast**: complete within a few hundred milliseconds
- **Actionable**: failure messages name the missing tool, required version range,
  and how to install or resolve the issue
- **Non-blocking where appropriate**: soft failures alert but don't abort

## Check registry

### Required checks (always run)

| #   | Check                      | Command            | Purpose                                    |
| --- | -------------------------- | ------------------ | ------------------------------------------ |
| 1   | `rtk` availability         | `rtk --version`    | Command rewriting and output compaction    |
| 2   | `pi` model registry access | `pi --list-models` | Validating default profile lane resolution |

### Conditional checks (run when operation requires them)

| #   | Check                  | Command                                 | Condition                                  | Purpose                                         |
| --- | ---------------------- | --------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| 3   | `gh` availability      | `gh --version`                          | `/zflow-review-pr` with GitHub URL         | GitHub PR diff fetch and comment submission     |
| 4   | `gh` auth status       | `gh auth status`                        | Inline GitHub comment submission requested | Verifying authenticated GitHub CLI session      |
| 5   | `glab` availability    | `glab --version`                        | `/zflow-review-pr` with GitLab URL         | GitLab MR diff fetch and comment submission     |
| 6   | `glab` auth status     | `glab auth status`                      | Inline GitLab comment submission requested | Verifying authenticated GitLab CLI session      |
| 7   | `runectx` availability | `runectx --version` or `runectx status` | RuneContext integration requested          | RuneContext detection and change-doc resolution |

## Runtime prevention layer

In addition to the preflight checks above, `pi-mono-context-guard` provides an
always-active runtime prevention layer that operates at the tool-call interception
level. Unlike the bootstrap checks (run-once at startup), the context guard applies
continuously throughout a session.

The guard is **not a bootstrap check** — it does not need to be validated via
`checkBinary` because it is a Pi extension that activates on session start.
However, it is a **required runtime dependency** for pi-zflow sessions. If the
extension is not installed, a startup advisory should recommend it.

For a full description of the guard's behavior, configuration, and policy rules,
see [`docs/context-guard-policy.md`](context-guard-policy.md).

## Return type

```ts
interface BootstrapReport {
  rtk: BinaryCheckResult;
  gh: BinaryCheckResult;
  glab: BinaryCheckResult;
  ghAuth: AuthCheckResult | "not-required";
  glabAuth: AuthCheckResult | "not-required";
  runectx: BinaryCheckResult | "not-required";
  modelRegistry: ModelCheckResult;
  warnings: string[];
}

interface BinaryCheckResult {
  available: boolean;
  version?: string;
  path?: string;
  error?: string; // user-facing error message
}

interface AuthCheckResult {
  authenticated: boolean;
  user?: string;
  error?: string;
}

interface ModelCheckResult {
  available: boolean;
  resolvedLanes?: Record<string, string>;
  unavailableLanes?: string[];
  warnings?: string[];
}
```

## Core check functions

### `checkBinary(name, versionRange?)`

Check that a binary is available on `$PATH` and optionally meets a minimum version.

```ts
async function checkBinary(
  name: string,
  versionRange?: { min?: string; max?: string },
): Promise<BinaryCheckResult> {
  // 1. Run `which <name>` or `<name> --version`
  // 2. If not found → return { available: false, error: `<name> not found on $PATH. Install with: <install-hint>` }
  // 3. If version specified → parse output and compare
  // 4. Return { available: true, version, path }
}
```

### `checkGhAuth()`

Check that `gh` is authenticated.

```ts
async function checkGhAuth(): Promise<AuthCheckResult> {
  // 1. Run `gh auth status`
  // 2. If not authenticated → return { authenticated: false, error: `GitHub CLI not authenticated. Run: gh auth login` }
  // 3. Parse user from output
  // 4. Return { authenticated: true, user }
}
```

### `checkGlabAuth()`

Check that `glab` is authenticated.

```ts
async function checkGlabAuth(): Promise<AuthCheckResult> {
  // 1. Run `glab auth status`
  // 2. If not authenticated → return { authenticated: false, error: `GitLab CLI not authenticated. Run: glab auth login` }
  // 3. Parse user from output
  // 4. Return { authenticated: true, user }
}
```

### `validateDefaultProfileCandidates()`

Check that the proposed `default` profile lanes can resolve to available models.

```ts
async function validateDefaultProfileCandidates(): Promise<ModelCheckResult> {
  // 1. Run `pi --list-models` to discover available models
  // 2. Compare against required lanes from the default profile
  // 3. Return resolved lanes for matched providers, unavailable for unmatched
  // 4. If `pi --list-models` fails, return appropriate error
}
```

## Orchestrator: `runBootstrapChecks`

```ts
async function runBootstrapChecks(opts: {
  needsGithubComments?: boolean;
  needsGitlabComments?: boolean;
  needsRuneContext?: boolean;
}): Promise<BootstrapReport> {
  const warnings: string[] = [];

  // Always check
  const rtk = await checkBinary("rtk");
  if (!rtk.available) {
    warnings.push(
      "rtk not found: output compaction will not be available. Install with: npm install -g rtk",
    );
  }

  // Tool availability (always checked — needed for PR/MR flows)
  const gh = await checkBinary("gh");
  const glab = await checkBinary("glab");

  // Conditional auth checks
  const ghAuth = opts.needsGithubComments
    ? await checkGhAuth()
    : "not-required";

  const glabAuth = opts.needsGitlabComments
    ? await checkGlabAuth()
    : "not-required";

  // Conditional runectx check
  const runectx = opts.needsRuneContext
    ? await checkBinary("runectx")
    : "not-required";

  // Model registry
  const modelRegistry = await validateDefaultProfileCandidates();

  return {
    rtk,
    gh,
    glab,
    ghAuth,
    glabAuth,
    runectx,
    modelRegistry,
    warnings,
  };
}
```

## Failure handling rules

### `rtk` — soft failure

| Scenario              | Behavior                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `rtk` not installed   | Add warning to `BootstrapReport.warnings[]`. Continue execution. Output compaction is unavailable but the harness still works. |
| `rtk` version too old | Warning with upgrade hint. Do not block.                                                                                       |

### `gh` / `glab` — contextual failure

| Scenario                                               | Behavior                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Missing `gh` and PR review with GitHub URL requested   | Abort `/zflow-review-pr` with: "GitHub CLI (gh) not found. Install from: https://cli.github.com/"        |
| Missing `glab` and MR review with GitLab URL requested | Abort `/zflow-review-pr` with: "GitLab CLI (glab) not found. Install from: https://glab.readthedocs.io/" |
| `gh` missing but no GitHub PR requested                | No error. Add informational note that PR review for GitHub requires `gh`.                                |
| `gh` present but `gh auth status` fails                | Abort comment submission flow. Do not abort diff-only review.                                            |

### `runectx` — contextual failure

| Scenario                                         | Behavior                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `runectx` missing and RuneContext mode requested | Abort RuneContext-specific flows. Other operations proceed normally. |
| `runectx` missing but no RuneContext mode        | No error. Not checked.                                               |

### Model registry — blocking failure

| Scenario                            | Behavior                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi --list-models` fails            | Block profile activation. Error: "Cannot resolve default profile: model registry unavailable. Run `pi --list-models` manually to diagnose." |
| Required lane cannot resolve        | Block profile activation. Error lists which lanes failed and suggests available alternatives.                                               |
| Optional reviewer lanes unavailable | Warning only. Profile activates with reduced reviewer capacity.                                                                             |

## Integration points

### Phase 7 integration (`/zflow-change-prepare`, `/zflow-change-implement`)

```ts
// In bootstrap.ts (packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/)
async function beforeExpensiveOperation() {
  const report = await runBootstrapChecks({
    needsGithubComments: false, // set based on change doc config
    needsGitlabComments: false,
    needsRuneContext: detectRuneContextInCwd(),
  });

  if (report.warnings.length > 0) {
    logger.warn("Preflight warnings:", report.warnings);
  }
}
```

### Profile activation integration (`/zflow-profile switch`, `/zflow-profile validate`)

```ts
// In preflight.ts (packages/pi-zflow-profiles/extensions/zflow-profiles/)
async function beforeProfileActivation() {
  const report = await runBootstrapChecks({});
  // modelRegistry is the primary concern here
  if (!report.modelRegistry.available) {
    throw new Error("Cannot validate profile: model registry unavailable");
  }
  if (report.modelRegistry.unavailableLanes?.length) {
    logger.warn(
      "Some profile lanes cannot resolve:",
      report.modelRegistry.unavailableLanes,
    );
  }
}
```

## Deferred implementation detail

The actual implementation of `checkBinary`, `checkGhAuth`, `checkGlabAuth`,
`validateDefaultProfileCandidates`, and `runBootstrapChecks` will live in
Phase 7 when the workflow commands are implemented.

The file locations are:

- `packages/pi-zflow-change-workflows/extensions/zflow-change-workflows/bootstrap.ts`
- `packages/pi-zflow-profiles/extensions/zflow-profiles/preflight.ts`

Shared helper functions (`checkBinary`, `checkGhAuth`, `checkGlabAuth`) may
reside in `packages/pi-zflow-core/src/bootstrap-checks.ts` if shared between
both consumers.

This design document is the contract that those future implementations will
follow. Any deviations from this design must be documented in a change record
referencing this file.

## Related documents

- `docs/foundation-versions.md` — quick-reference bootstrap checklist
- `README.md` — project overview with foundation install record
- `implementation-phases/phase-0-foundation.md` — Task 0.5 requirements
