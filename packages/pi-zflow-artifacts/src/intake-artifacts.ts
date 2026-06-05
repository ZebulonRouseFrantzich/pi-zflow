/**
 * intake-artifacts.ts — runtime-state helpers for grill-me-enhanced intake.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

import { resolveChangeDir, resolvePlanVersionDir } from "./artifact-paths.js"

export type ChangeIntakeDepthMode = "dynamic" | "shallow" | "standard" | "deep" | "exhaustive"

export interface ChangeIntakeState {
  changeId: string
  sourceMode: "adhoc" | "runecontext"
  depthMode: ChangeIntakeDepthMode
  status: "active" | "paused" | "ready-for-plan" | "ready-for-prepare"
  askedQuestionCount: number
  resolvedDecisionCount: number
  unresolvedQuestionCount: number
  latestCheckpointPath: string | null
  planDocPath: string | null
  prepareContextPath: string | null
  lastUpdatedAt: string
}

export interface ChangeIntakeLogEntry {
  id: string
  timestamp: string
  kind: "question" | "answer" | "repo-evidence" | "decision" | "checkpoint"
  branch: string
  summary: string
  recommendation?: string | null
  evidencePaths?: string[]
  carryForward: "one-pager" | "prepare-only" | "both" | "none"
}

export interface ChangeIntakeArtifacts {
  state: ChangeIntakeState | null
  decisionLog: string | null
  onePagerInput: string | null
  prepareContext: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  await fs.writeFile(tmpPath, content, "utf-8")
  await fs.rename(tmpPath, filePath)
}

export function resolveChangeIntakeDir(changeId: string, cwd?: string): string {
  return path.join(resolveChangeDir(changeId, cwd), "intake")
}

export function resolveChangeIntakeStatePath(changeId: string, cwd?: string): string {
  return path.join(resolveChangeIntakeDir(changeId, cwd), "intake-state.json")
}

export function resolveChangeIntakeLogPath(changeId: string, cwd?: string): string {
  return path.join(resolveChangeIntakeDir(changeId, cwd), "interview-log.jsonl")
}

export function resolveChangeIntakeCheckpointsDir(changeId: string, cwd?: string): string {
  return path.join(resolveChangeIntakeDir(changeId, cwd), "checkpoints")
}

export function resolveChangeIntakeDecisionLogPath(changeId: string, cwd?: string): string {
  return path.join(resolveChangeIntakeDir(changeId, cwd), "decision-log.md")
}

export function resolveChangeIntakePrepareContextPath(changeId: string, cwd?: string): string {
  return path.join(resolveChangeIntakeDir(changeId, cwd), "prepare-context.md")
}

export function resolveChangeIntakeOnePagerInputPath(changeId: string, cwd?: string): string {
  return path.join(resolveChangeIntakeDir(changeId, cwd), "one-pager-input.md")
}

export function resolveVersionedIntakeContextPath(
  changeId: string,
  planVersion: string,
  cwd?: string,
): string {
  return path.join(resolvePlanVersionDir(changeId, planVersion, cwd), "intake-context.md")
}

export async function writeChangeIntakeState(
  state: ChangeIntakeState,
  cwd?: string,
): Promise<string> {
  const filePath = resolveChangeIntakeStatePath(state.changeId, cwd)
  await writeAtomic(filePath, JSON.stringify(state, null, 2))
  return filePath
}

export async function readChangeIntakeState(
  changeId: string,
  cwd?: string,
): Promise<ChangeIntakeState | null> {
  const filePath = resolveChangeIntakeStatePath(changeId, cwd)
  if (!await fileExists(filePath)) return null
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as ChangeIntakeState
}

export async function appendChangeIntakeLogEntry(
  changeId: string,
  entry: ChangeIntakeLogEntry,
  cwd?: string,
): Promise<string> {
  const filePath = resolveChangeIntakeLogPath(changeId, cwd)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8")
  return filePath
}

export async function writeChangeIntakeCheckpoint(
  changeId: string,
  index: number,
  content: string,
  cwd?: string,
): Promise<string> {
  const filePath = path.join(
    resolveChangeIntakeCheckpointsDir(changeId, cwd),
    `checkpoint-${String(index).padStart(4, "0")}.md`,
  )
  await writeAtomic(filePath, content)
  return filePath
}

export async function writeChangeIntakeDecisionLog(
  changeId: string,
  content: string,
  cwd?: string,
): Promise<string> {
  const filePath = resolveChangeIntakeDecisionLogPath(changeId, cwd)
  await writeAtomic(filePath, content)
  return filePath
}

export async function writeChangeIntakePrepareContext(
  changeId: string,
  content: string,
  cwd?: string,
): Promise<string> {
  const filePath = resolveChangeIntakePrepareContextPath(changeId, cwd)
  await writeAtomic(filePath, content)
  return filePath
}

export async function writeChangeIntakeOnePagerInput(
  changeId: string,
  content: string,
  cwd?: string,
): Promise<string> {
  const filePath = resolveChangeIntakeOnePagerInputPath(changeId, cwd)
  await writeAtomic(filePath, content)
  return filePath
}

export async function readChangeIntakeArtifacts(
  changeId: string,
  cwd?: string,
): Promise<ChangeIntakeArtifacts> {
  const state = await readChangeIntakeState(changeId, cwd)
  const decisionLogPath = resolveChangeIntakeDecisionLogPath(changeId, cwd)
  const onePagerInputPath = resolveChangeIntakeOnePagerInputPath(changeId, cwd)
  const prepareContextPath = resolveChangeIntakePrepareContextPath(changeId, cwd)

  return {
    state,
    decisionLog: await fileExists(decisionLogPath) ? await fs.readFile(decisionLogPath, "utf-8") : null,
    onePagerInput: await fileExists(onePagerInputPath) ? await fs.readFile(onePagerInputPath, "utf-8") : null,
    prepareContext: await fileExists(prepareContextPath) ? await fs.readFile(prepareContextPath, "utf-8") : null,
  }
}

export async function writeVersionedIntakeContext(
  changeId: string,
  planVersion: string,
  content: string,
  cwd?: string,
): Promise<string> {
  const filePath = resolveVersionedIntakeContextPath(changeId, planVersion, cwd)
  await writeAtomic(filePath, content)
  return filePath
}

export function createInitialChangeIntakeState(input: {
  changeId: string
  sourceMode: "adhoc" | "runecontext"
  depthMode: ChangeIntakeDepthMode
  planDocPath?: string | null
  prepareContextPath?: string | null
}): ChangeIntakeState {
  return {
    changeId: input.changeId,
    sourceMode: input.sourceMode,
    depthMode: input.depthMode,
    status: "active",
    askedQuestionCount: 0,
    resolvedDecisionCount: 0,
    unresolvedQuestionCount: 0,
    latestCheckpointPath: null,
    planDocPath: input.planDocPath ?? null,
    prepareContextPath: input.prepareContextPath ?? null,
    lastUpdatedAt: nowIso(),
  }
}
