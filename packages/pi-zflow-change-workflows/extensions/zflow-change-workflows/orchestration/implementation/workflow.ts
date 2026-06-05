/**
 * workflow.ts — implementation-run startup and durable target resolution.
 */

import {
  createRun,
  setRunPhase,
  updateRun,
} from "pi-zflow-artifacts"
import {
  resolvePlanArtifactPath,
  resolvePlanStatePath,
} from "pi-zflow-artifacts/artifact-paths"
import { addStateIndexEntry } from "pi-zflow-artifacts/state-index"

import {
  parseExecutionGroupsMd,
  type DispatchExecutionGroup,
} from "../execution-groups.js"
import { discoverUnfinishedWork } from "../lifecycle/unfinished-work.js"

export interface ChangeImplementTarget {
  /** Runtime change ID used for `.zflow/plans/<changeId>`. */
  changeId: string
  /** Original command argument. */
  input: string
  /** Durable docs change ID, when input pointed at `docs/zflow-changes/<id>/...`. */
  durableChangeId?: string
  /** Manifest path used to resolve the runtime change ID, when applicable. */
  manifestPath?: string
}

async function fileExists(filePath: string): Promise<boolean> {
  const { default: fs } = await import("node:fs/promises")
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function migrateLegacyChangeArtifactsIfPresent(changeId: string, cwd?: string): Promise<boolean> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const { resolveGitDir, ensureRuntimeStateDir } = await import("pi-zflow-core/runtime-paths")

  const runtimeDir = ensureRuntimeStateDir(cwd)
  const newChangeDir = path.join(runtimeDir, "plans", changeId)
  if (await fileExists(path.join(newChangeDir, "plan-state.json"))) return false

  const gitDir = resolveGitDir(cwd ?? process.cwd())
  if (!gitDir) return false

  const legacyChangeDir = path.join(gitDir, "pi-zflow", "plans", changeId)
  if (!(await fileExists(path.join(legacyChangeDir, "plan-state.json")))) return false

  await fs.mkdir(path.dirname(newChangeDir), { recursive: true })
  await fs.cp(legacyChangeDir, newChangeDir, { recursive: true, force: false, errorOnExist: false })
  console.info(`[zflow] Migrated legacy plan artifacts for change "${changeId}" from .git/pi-zflow to .zflow.`)
  return true
}

async function findDurableManifestPath(inputPath: string, cwd?: string): Promise<string | null> {
  const { default: fs } = await import("node:fs/promises")
  const { default: path } = await import("node:path")
  const repoRoot = cwd ?? process.cwd()
  const cleaned = inputPath.trim().replace(/^@+/, "").replace(/[\\/]$/, "")
  if (!cleaned) return null
  const absolutePath = path.isAbsolute(cleaned) ? cleaned : path.join(repoRoot, cleaned)

  let searchPath = absolutePath
  if (path.basename(absolutePath).toLowerCase() === "plan.md") {
    searchPath = path.dirname(absolutePath)
  }

  const directManifest = path.join(searchPath, "manifest.json")
  if (await fileExists(directManifest)) return directManifest

  const parts = searchPath.split(path.sep)
  const zflowIndex = parts.lastIndexOf("zflow-changes")
  if (zflowIndex === -1 || !parts[zflowIndex + 1]) return null

  const changeDir = parts.slice(0, zflowIndex + 2).join(path.sep) || path.sep
  try {
    const entries = await fs.readdir(changeDir, { withFileTypes: true })
    const versionDirs = entries
      .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number.parseInt(b.slice(1), 10) - Number.parseInt(a.slice(1), 10))
    for (const version of versionDirs) {
      const candidate = path.join(changeDir, version, "manifest.json")
      if (await fileExists(candidate)) return candidate
    }
  } catch {
    return null
  }

  return null
}

/**
 * Resolve a `/zflow-change-implement` argument to the runtime plan change ID.
 *
 * Users commonly pass the durable docs path (`docs/zflow-changes/<name>/` or a
 * version directory) after reviewing the committed plan documents. The runtime
 * implementation state still lives under `.zflow/plans/<changeId>/`, so
 * this helper reads the durable `manifest.json` and follows
 * `previousRuntimeChangeId` when present.
 */
export async function resolveChangeImplementTarget(
  input: string,
  cwd?: string,
): Promise<ChangeImplementTarget> {
  const { default: fs } = await import("node:fs/promises")
  const cleaned = input.trim().replace(/^@+/, "").replace(/[\\/]$/, "")

  if (cleaned && await fileExists(resolvePlanStatePath(cleaned, cwd))) {
    return { changeId: cleaned, input }
  }

  const manifestPath = await findDurableManifestPath(input, cwd)
  if (manifestPath) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      changeId?: string
      previousRuntimeChangeId?: string
      sourceRuntimePath?: string
    }
    const candidates = [manifest.previousRuntimeChangeId, manifest.changeId].filter((value): value is string => Boolean(value))
    for (const candidate of candidates) {
      if (await fileExists(resolvePlanStatePath(candidate, cwd))) {
        return {
          changeId: candidate,
          input,
          durableChangeId: manifest.changeId,
          manifestPath,
        }
      }
    }
  }

  if ((cleaned || input).endsWith("plan.md") || (cleaned || input).includes("zflow-changes/")) {
    const { default: path } = await import("node:path")
    const absPath = path.isAbsolute(cleaned || input) ? (cleaned || input) : path.resolve(cwd ?? process.cwd(), cleaned || input)
    let dir = path.dirname(absPath)
    const isPlanMd = path.basename(absPath).toLowerCase() === "plan.md"
    if (isPlanMd) {
      const changeIdFromDir = path.basename(dir)
      if (changeIdFromDir && !changeIdFromDir.startsWith("docs") && !changeIdFromDir.startsWith(".")) {
        return { changeId: changeIdFromDir, input, durableChangeId: changeIdFromDir }
      }
    }
  }

  return { changeId: cleaned || input, input }
}

/**
 * Options for running a change implementation workflow.
 *
 * Most fields are optional because the function reads the plan state
 * to discover the approved version and execution groups.
 */
export interface ImplementWorkflowOptions {
  /** Change identifier (required). */
  changeId: string
  /** Working directory for resolving runtime state dir. */
  cwd?: string
  /** Plan version to execute. Defaults to approvedVersion from plan-state.json. */
  planVersion?: string
  /** Execution groups from the approved plan. If not provided, read from plan artifact. */
  executionGroups?: DispatchExecutionGroup[]
  /** Optional reviewer runner for dispatching real reviewer agents. */
  reviewerRunner?: unknown
  /** If true, skip final verification and mark review as advisory. */
  skipVerification?: boolean
  /** If true, skip code review. */
  skipReview?: boolean
  /** If true, proceed with a dirty primary worktree. Defaults to false (dirty tree = hard error). */
  force?: boolean
}

/**
 * Result of a change implementation workflow.
 */
export interface ImplementWorkflowResult {
  /** Unique run identifier. */
  runId: string
  /** Change identifier. */
  changeId: string
  /** Plan version that was executed. */
  planVersion: string
  /** Overall workflow status. */
  status:
    | "executing"
    | "verifying"
    | "cleanup-pending"
    | "completed"
    | "failed"
    | "drift-pending"
    | "apply-back-conflicted"
  /** Verification outcome. */
  verificationStatus: "passed" | "failed" | "skipped" | "pending"
  /** Path to the code review findings file, if review was run. */
  reviewFindingsPath?: string
  /** Path to the deviation summary file, if applicable. */
  deviationSummaryPath?: string
  /** Error message if the workflow failed. */
  error?: string
  /** Ordered list of step descriptions explaining what should happen next. */
  nextSteps: string[]
}

/**
 * Run the formal /zflow-change-implement workflow end-to-end.
 *
 * Steps (matching the master plan's execution order):
 * 1. Check unfinished runs in state-index.json
 * 2. Resolve change and approved plan (plan-state.json)
 * 3. Load canonical planning artifact paths
 * 4. Update plan state to executing, create run.json
 * 5. Validate non-overlapping file ownership (via prepareWorktreeImplementationRun)
 * 6. Verify primary worktree clean (via prepareWorktreeImplementationRun)
 * 7. Run worktree-setup hook if needed
 * 8. Build and return a WorktreeImplementationRunPlan for the caller to dispatch
 *
 * After the caller dispatches the worktree tasks and collects results:
 *   - `finalizeWorktreeImplementationRun()` applies patches back
 *   - `runVerification()` runs final verification
 *   - code review runs (optional)
 *
 * @param options - Workflow options.
 * @returns An ImplementWorkflowResult with the run metadata.
 */
/**
 * IMPLEMENTATION NOTE — Worktree dispatch gap
 *
 * FUTURE: This function currently creates run state but does NOT dispatch workers
 * via pi-subagents worktree:true or execute apply-back. The
 * prepareWorktreeImplementationRun() and finalizeWorktreeImplementationRun()
 * helpers exist in this file but are not yet connected to the command lifecycle.
 *
 * Work in progress (Phase 5/7):
 * - buildWorktreeDispatchPlan() produces task descriptors
 * - prepareWorktreeImplementationRun() produces a full plan with preflight + groups
 * - The command handler at /zflow-change-implement should call
 *   prepareWorktreeImplementationRun() → dispatch via pi-subagents →
 *   finalizeWorktreeImplementationRun() → runChangeImplementWorkflow() for
 *   remaining post-dispatch steps.
 */
export async function runChangeImplementWorkflow(
  options: ImplementWorkflowOptions,
): Promise<ImplementWorkflowResult> {
  const cwd = options.cwd
  const { default: fs } = await import("node:fs/promises")
  const force = options.force === true

  const unfinished = await discoverUnfinishedWork(options.changeId, cwd)
  if (unfinished.hasUnfinishedWork) {
    console.warn(
      `[zflow] Unfinished work detected for change "${options.changeId}". ` +
      "Call promptResumeChoices() before proceeding.",
    )
  }

  await migrateLegacyChangeArtifactsIfPresent(options.changeId, cwd)
  const planStatePath = resolvePlanStatePath(options.changeId, cwd)
  let planState: Record<string, unknown>

  try {
    const raw = await fs.readFile(planStatePath, "utf-8")
    planState = JSON.parse(raw)
  } catch {
    throw new Error(
      `No plan found for change "${options.changeId}". ` +
      "Run /zflow-change-prepare <change-path> first to create a plan.",
    )
  }

  const approvedVersion = planState.approvedVersion as string | null
  if (!approvedVersion) {
    throw new Error(
      `No approved plan version for change "${options.changeId}". ` +
      "Approve a plan version first via /zflow-change-prepare.",
    )
  }

  const planVersion = options.planVersion ?? approvedVersion

  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const execFileAsync = promisify(execFile)
  const { stdout: repoRootRaw } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: cwd ?? process.cwd(),
  })
  const repoRoot = repoRootRaw.trim()

  let worktreeDirty = false
  try {
    const { stdout: statusRaw } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot })
    const status = statusRaw.trim()
    if (status.length > 0) {
      worktreeDirty = true
      if (force) {
        console.warn(
          `[zflow] Worktree is dirty for change "${options.changeId}". ` +
          "Proceeding with dirty worktree because --force was passed.",
        )
      } else {
        throw new Error(
          `Primary worktree must be clean for change "${options.changeId}". ` +
          "Uncommitted changes may interfere with worktree dispatch. " +
          "Commit or stash your changes first, or re-run with --force to proceed despite dirty worktree.",
        )
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Primary worktree must be clean")) {
      throw err
    }
    console.warn("[zflow] Could not check worktree cleanliness — proceeding without check.")
  }

  planState.lifecycleState = "executing"
  planState.updatedAt = new Date().toISOString()
  await fs.writeFile(planStatePath, JSON.stringify(planState, null, 2), "utf-8")

  const artifactPaths: Record<string, string> = {
    design: resolvePlanArtifactPath(options.changeId, planVersion, "design", cwd),
    executionGroups: resolvePlanArtifactPath(options.changeId, planVersion, "execution-groups", cwd),
    standards: resolvePlanArtifactPath(options.changeId, planVersion, "standards", cwd),
    verification: resolvePlanArtifactPath(options.changeId, planVersion, "verification", cwd),
  }

  let executionGroupsContent = ""
  for (const [key, ap] of Object.entries(artifactPaths)) {
    try {
      await fs.access(ap)
      if (key === "executionGroups") {
        executionGroupsContent = await fs.readFile(ap, "utf-8")
        const parsed = parseExecutionGroupsMd(executionGroupsContent)
        if (parsed.length === 0) {
          const preview = executionGroupsContent.slice(0, 500).trim()
          throw new Error(
            `No execution groups found in ${ap}. ` +
            "The approved plan must contain at least one implementation group.\n\n" +
            "The execution-groups.md file exists but contains no parseable groups.\n" +
            `File content preview (first 500 chars):\n\`\`\`\n${preview}${executionGroupsContent.length > 500 ? "\n…(truncated)" : ""}\n\`\`\`\n\n` +
            "Expected format — each group must start with a heading like:\n" +
            "  ## Group 1: descriptive name\n" +
            "  ## G1 — descriptive name\n" +
            "  ## Execution Group 1: descriptive name\n\n" +
            "Followed by:\n" +
            "  **Files:** path/to/file.ts, another/file.ts\n" +
            "  **Agent:** zflow.implement-routine\n" +
            "  **Scoped verification:** the verification command for this group\n\n" +
            "Run /zflow-change-prepare to recreate the plan with valid execution groups.",
          )
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("No execution groups found")) {
        throw err
      }
      console.warn(`[zflow] Plan artifact "${key}" not found at: ${ap}`)
    }
  }

  const runId = `impl-${options.changeId}-${Date.now().toString(36)}`
  await createRun(runId, repoRoot, options.changeId, planVersion, cwd)

  await setRunPhase(runId, "executing", cwd)
  await updateRun(runId, {
    changeId: options.changeId,
    planVersion,
  } as any, cwd)

  await addStateIndexEntry({
    type: "run",
    id: runId,
    status: "executing",
    metadata: {
      changeId: options.changeId,
      planVersion,
      repoRoot,
      worktreeDirty,
    },
  }, cwd)

  const { getChangeLifecycle, upsertChangeLifecycle } = await import("pi-zflow-artifacts/state-index")
  const existingLifecycle = await getChangeLifecycle(options.changeId, cwd)
  await upsertChangeLifecycle({
    changeId: options.changeId,
    lastPhase: "executing",
    unfinishedRuns: existingLifecycle
      ? [...new Set([...existingLifecycle.unfinishedRuns, runId])]
      : [runId],
    retainedWorktrees: existingLifecycle?.retainedWorktrees ?? [],
    artifactPaths: existingLifecycle?.artifactPaths ?? [],
    cleanupMetadata: existingLifecycle?.cleanupMetadata ?? {},
  }, cwd)

  const nextSteps: string[] = [
    "1. Context-builder: review design, execution-groups, standards, and verification artifacts",
    "2. Worktree dispatch: dispatch execution groups to isolated worktrees with per-group agents",
    "3. Worker verification: each worker runs scoped verification before signalling completion",
    "4. Apply-back: merge completed worktree patches back to the primary worktree",
    "5. Final verification: run full verification suite on the primary worktree",
    "6. Code review: run /zflow-review-code to audit the implementation",
    "7. Fix loop: address any verification or review failures, then re-verify",
  ]
  await updateRun(runId, { nextSteps, metadata: { worktreeDirty } }, cwd)

  return {
    runId,
    changeId: options.changeId,
    planVersion,
    status: "executing",
    verificationStatus: options.skipVerification ? "skipped" : "pending",
    nextSteps,
  }
}

/**
 * Record or update ordered next steps in run.json.
 *
 * Reads the existing run.json, replaces `nextSteps`, and persists
 * atomically. This is a durable helper that downstream workflow steps
 * (verification, apply-back, code review) can call to keep the run
 * metadata honest as the implementation progresses.
 *
 * @param runId - Unique run identifier.
 * @param steps - Ordered array of step descriptions (one per element).
 * @param cwd - Working directory (optional, for resolving runtime state dir).
 */
export async function recordImplementationNextSteps(
  runId: string,
  steps: string[],
  cwd?: string,
): Promise<void> {
  await updateRun(runId, { nextSteps: steps }, cwd)
}
