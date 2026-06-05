/**
 * grill-me-enhanced.ts — compaction-safe planning intake for change-plan/prepare.
 */

import {
  appendChangeIntakeLogEntry,
  createInitialChangeIntakeState,
  type ChangeIntakeDepthMode,
  type ChangeIntakeLogEntry,
  type ChangeIntakeState,
  writeChangeIntakeCheckpoint,
  writeChangeIntakeDecisionLog,
  writeChangeIntakeOnePagerInput,
  writeChangeIntakePrepareContext,
  writeChangeIntakeState,
} from "pi-zflow-artifacts"

import type { InterviewableContext } from "./structured-interview.js"

interface IntakePromptQuestion {
  id: string
  branch: string
  question: string
  recommendation: string
  carryForward: ChangeIntakeLogEntry["carryForward"]
}

export interface GrillMeEnhancedIntakeOptions {
  cwd?: string
  changeId: string
  sourceMode: "adhoc" | "runecontext"
  requestedDepth?: ChangeIntakeDepthMode
  changeDescription: string
  changeSeed: string
  changeReferencePath?: string
  planDocPath?: string | null
  existingPrepareContext?: string | null
  onProgress?: (message: string, type?: "info" | "warning" | "error") => void
}

export interface GrillMeEnhancedIntakeResult {
  state: ChangeIntakeState
  onePagerInput: string
  onePagerInputPath: string
  prepareContext: string
  prepareContextPath: string
  decisionLog: string
  decisionLogPath: string
  checkpointPaths: string[]
}

interface IntakeAnswerSet {
  summary: string
  goals: string
  scopeIn: string
  scopeOut: string
  constraints: string
  risks: string
  verification: string
  openQuestions: string
  alternatives: string
  rollout: string
}

const EMPTY_ANSWERS: IntakeAnswerSet = {
  summary: "",
  goals: "",
  scopeIn: "",
  scopeOut: "",
  constraints: "",
  risks: "",
  verification: "",
  openQuestions: "",
  alternatives: "",
  rollout: "",
}

function pickDynamicDepth(input: GrillMeEnhancedIntakeOptions): ChangeIntakeDepthMode {
  const text = `${input.changeDescription} ${input.changeReferencePath ?? ""}`.toLowerCase()
  const riskSignals = [
    "auth",
    "permission",
    "migration",
    "schema",
    "rollout",
    "breaking",
    "security",
    "runecontext",
    "cross-package",
    "cross repo",
  ]
  const score = riskSignals.reduce((acc, signal) => acc + (text.includes(signal) ? 1 : 0), 0)
  if (score >= 3) return "deep"
  if (score >= 1) return "standard"
  return input.changeReferencePath ? "standard" : "shallow"
}

export function resolveIntakeDepthMode(requested?: ChangeIntakeDepthMode): ChangeIntakeDepthMode {
  return requested ?? "dynamic"
}

function buildQuestions(
  depthMode: ChangeIntakeDepthMode,
  input: GrillMeEnhancedIntakeOptions,
): IntakePromptQuestion[] {
  const questions: IntakePromptQuestion[] = [
    {
      id: "summary",
      branch: "intent",
      question: "What is the clearest one-paragraph summary of the requested change?",
      recommendation: `Focus on ${input.changeDescription.trim() || input.changeSeed.trim()} and why it matters now.`,
      carryForward: "both",
    },
    {
      id: "goals",
      branch: "success-criteria",
      question: "What outcomes must be true for this change to be considered successful?",
      recommendation: "List concrete user-visible or operational success criteria, not implementation steps.",
      carryForward: "both",
    },
    {
      id: "scope",
      branch: "scope-boundaries",
      question: "What is definitely in scope, and what is explicitly out of scope?",
      recommendation: "Separate required work from nearby tempting follow-ons so the plan stays reviewable.",
      carryForward: "both",
    },
  ]

  if (depthMode !== "shallow") {
    questions.push(
      {
        id: "constraints",
        branch: "constraints",
        question: "What constraints, assumptions, or non-negotiables must the plan respect?",
        recommendation: "Capture repo, workflow, rollout, compatibility, or ownership constraints that could shape implementation.",
        carryForward: "both",
      },
      {
        id: "verification",
        branch: "verification",
        question: "How should the completed change be verified?",
        recommendation: "Prefer concrete commands, checks, or pass/fail signals over vague test expectations.",
        carryForward: "both",
      },
    )
  }

  if (depthMode === "deep" || depthMode === "exhaustive") {
    questions.push(
      {
        id: "risks",
        branch: "risk",
        question: "What risks, edge cases, or blocking unknowns should planning account for?",
        recommendation: "Name the few issues most likely to force replanning, not generic project risk boilerplate.",
        carryForward: "prepare-only",
      },
      {
        id: "alternatives",
        branch: "alternatives",
        question: "Were there any alternative approaches considered, rejected, or still worth tracking?",
        recommendation: "Capture only alternatives that materially change architecture, sequencing, or safety.",
        carryForward: "prepare-only",
      },
    )
  }

  if (depthMode === "exhaustive") {
    questions.push({
      id: "rollout",
      branch: "rollout",
      question: "Are there rollout, compatibility, stakeholder, or environment nuances that should be carried into prepare?",
      recommendation: "Record environment assumptions, phased rollout constraints, or stakeholder expectations that do not belong in the one-pager body.",
      carryForward: "prepare-only",
    })
  }

  questions.push({
    id: "openQuestions",
    branch: "open-questions",
    question: "What open questions remain, if any, that could materially change the plan?",
    recommendation: "Leave this blank if nothing is genuinely unresolved.",
    carryForward: "both",
  })

  return questions
}

function buildSingleQuestionPayload(question: IntakePromptQuestion, depthMode: ChangeIntakeDepthMode): string {
  return JSON.stringify({
    title: `grill-me-enhanced (${depthMode})`,
    description: `Answer one planning question at a time. Recommended answer: ${question.recommendation}`,
    questions: [
      {
        id: question.id,
        type: "text",
        question: question.question,
      },
    ],
  })
}

async function askQuestion(
  ctx: InterviewableContext,
  question: IntakePromptQuestion,
  depthMode: ChangeIntakeDepthMode,
): Promise<string> {
  const payload = buildSingleQuestionPayload(question, depthMode)
  let raw: string | undefined

  if (typeof ctx.interview === "function") {
    raw = await Promise.resolve(ctx.interview(payload))
  } else if (typeof ctx.ui?.interview === "function") {
    raw = await Promise.resolve(ctx.ui.interview(payload))
  } else if (typeof ctx.ui?.input === "function") {
    raw = await Promise.resolve(ctx.ui.input(question.question, question.recommendation))
    return raw?.trim() ?? ""
  } else {
    ctx.ui?.notify?.(
      `No interview UI available for question: ${question.question}`,
      "warning",
    )
    return ""
  }

  if (!raw) return ""
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed[question.id]
    return typeof value === "string" ? value.trim() : ""
  } catch {
    return raw.trim()
  }
}

function assignAnswer(target: IntakeAnswerSet, questionId: string, answer: string): void {
  switch (questionId) {
    case "summary":
      target.summary = answer
      break
    case "goals":
      target.goals = answer
      break
    case "scope": {
      const [scopeIn, ...rest] = answer.split(/\n(?:out of scope|scope out)\s*:?/i)
      target.scopeIn = (scopeIn ?? "").trim()
      target.scopeOut = rest.join("\n").trim()
      break
    }
    case "constraints":
      target.constraints = answer
      break
    case "risks":
      target.risks = answer
      break
    case "verification":
      target.verification = answer
      break
    case "openQuestions":
      target.openQuestions = answer
      break
    case "alternatives":
      target.alternatives = answer
      break
    case "rollout":
      target.rollout = answer
      break
  }
}

function buildCheckpointContent(input: {
  state: ChangeIntakeState
  question?: IntakePromptQuestion
  answer?: string
  answers: IntakeAnswerSet
  checkpointIndex: number
  changeDescription: string
}): string {
  return [
    `# grill-me-enhanced checkpoint ${String(input.checkpointIndex).padStart(4, "0")}`,
    "",
    `- Change ID: ${input.state.changeId}`,
    `- Depth mode: ${input.state.depthMode}`,
    `- Status: ${input.state.status}`,
    `- Asked questions: ${input.state.askedQuestionCount}`,
    `- Resolved decisions: ${input.state.resolvedDecisionCount}`,
    `- Unresolved questions: ${input.state.unresolvedQuestionCount}`,
    `- Last updated: ${input.state.lastUpdatedAt}`,
    "",
    "## Request",
    "",
    input.changeDescription,
    "",
    input.question
      ? [
        "## Latest question",
        "",
        `- Branch: ${input.question.branch}`,
        `- Question: ${input.question.question}`,
        `- Recommended answer: ${input.question.recommendation}`,
        "",
        "## Latest answer",
        "",
        input.answer?.trim() || "_No answer captured._",
        "",
      ].join("\n")
      : "",
    "## One-pager-worthy context so far",
    "",
    input.answers.summary || "_Summary pending._",
    "",
    input.answers.goals ? `### Goals\n\n${input.answers.goals}\n` : "",
    input.answers.scopeIn ? `### Scope in\n\n${input.answers.scopeIn}\n` : "",
    input.answers.scopeOut ? `### Scope out\n\n${input.answers.scopeOut}\n` : "",
    input.answers.constraints ? `### Constraints\n\n${input.answers.constraints}\n` : "",
    input.answers.openQuestions ? `### Open questions\n\n${input.answers.openQuestions}\n` : "",
    "## Prepare-only retained context so far",
    "",
    input.answers.risks || input.answers.alternatives || input.answers.rollout
      ? [
        input.answers.risks ? `### Risks\n\n${input.answers.risks}\n` : "",
        input.answers.alternatives ? `### Alternatives\n\n${input.answers.alternatives}\n` : "",
        input.answers.rollout ? `### Rollout / environment nuance\n\n${input.answers.rollout}\n` : "",
      ].filter(Boolean).join("\n")
      : "_No prepare-only context captured yet._",
  ].filter(Boolean).join("\n")
}

function buildDecisionLog(changeId: string, depthMode: ChangeIntakeDepthMode, answers: IntakeAnswerSet): string {
  return [
    `# grill-me-enhanced decision log — ${changeId}`,
    "",
    `- Depth mode: ${depthMode}`,
    "",
    answers.summary ? `## Summary\n\n${answers.summary}\n` : "",
    answers.goals ? `## Goals / success criteria\n\n${answers.goals}\n` : "",
    answers.scopeIn ? `## Scope in\n\n${answers.scopeIn}\n` : "",
    answers.scopeOut ? `## Scope out\n\n${answers.scopeOut}\n` : "",
    answers.constraints ? `## Constraints\n\n${answers.constraints}\n` : "",
    answers.verification ? `## Verification\n\n${answers.verification}\n` : "",
    answers.risks ? `## Risks\n\n${answers.risks}\n` : "",
    answers.alternatives ? `## Alternatives\n\n${answers.alternatives}\n` : "",
    answers.rollout ? `## Rollout / environment nuance\n\n${answers.rollout}\n` : "",
    answers.openQuestions ? `## Open questions\n\n${answers.openQuestions}\n` : "",
  ].filter(Boolean).join("\n")
}

function buildOnePagerInput(changeId: string, answers: IntakeAnswerSet): string {
  return [
    `# One-pager input — ${changeId}`,
    "",
    "## Summary",
    "",
    answers.summary || "_Use the original request summary and repository evidence._",
    "",
    "## Goals / Success Criteria",
    "",
    answers.goals || "_Infer from the request and codebase evidence._",
    "",
    "## Scope In",
    "",
    answers.scopeIn || "_Infer from the request and repository evidence._",
    "",
    "## Scope Out",
    "",
    answers.scopeOut || "_No explicit exclusions captured._",
    "",
    "## Constraints",
    "",
    answers.constraints || "_No extra constraints captured._",
    "",
    "## Verification approach",
    "",
    answers.verification || "_No additional verification guidance captured._",
    "",
    "## Open questions",
    "",
    answers.openQuestions || "- None captured during intake.",
  ].join("\n")
}

function buildPrepareContext(changeId: string, depthMode: ChangeIntakeDepthMode, answers: IntakeAnswerSet, existing?: string | null): string {
  return [
    `# Prepare context — ${changeId}`,
    "",
    `- Depth mode used for intake: ${depthMode}`,
    "",
    existing?.trim() ? ["## Existing retained context", "", existing.trim(), ""] .join("\n") : "",
    answers.summary ? `## Planning summary\n\n${answers.summary}\n` : "",
    answers.goals ? `## Success criteria\n\n${answers.goals}\n` : "",
    answers.scopeIn ? `## Scope in\n\n${answers.scopeIn}\n` : "",
    answers.scopeOut ? `## Scope out\n\n${answers.scopeOut}\n` : "",
    answers.constraints ? `## Constraints\n\n${answers.constraints}\n` : "",
    answers.risks ? `## Risks / edge cases\n\n${answers.risks}\n` : "",
    answers.alternatives ? `## Alternatives considered\n\n${answers.alternatives}\n` : "",
    answers.rollout ? `## Rollout / environment nuance\n\n${answers.rollout}\n` : "",
    answers.verification ? `## Verification guidance\n\n${answers.verification}\n` : "",
    answers.openQuestions ? `## Open questions\n\n${answers.openQuestions}\n` : "",
  ].filter(Boolean).join("\n")
}

export async function runGrillMeEnhancedIntake(
  ctx: InterviewableContext,
  options: GrillMeEnhancedIntakeOptions,
): Promise<GrillMeEnhancedIntakeResult> {
  const effectiveDepth = options.requestedDepth === "dynamic" || !options.requestedDepth
    ? pickDynamicDepth(options)
    : options.requestedDepth
  const questions = buildQuestions(effectiveDepth, options)
  const answers: IntakeAnswerSet = { ...EMPTY_ANSWERS }
  const checkpointPaths: string[] = []

  let state = createInitialChangeIntakeState({
    changeId: options.changeId,
    sourceMode: options.sourceMode,
    depthMode: effectiveDepth,
    planDocPath: options.planDocPath ?? null,
    prepareContextPath: null,
  })
  await writeChangeIntakeState(state, options.cwd)
  options.onProgress?.(`🧠 grill-me-enhanced intake started (${effectiveDepth}).`, "info")

  const initialCheckpoint = await writeChangeIntakeCheckpoint(
    options.changeId,
    1,
    buildCheckpointContent({
      state,
      answers,
      checkpointIndex: 1,
      changeDescription: options.changeDescription,
    }),
    options.cwd,
  )
  checkpointPaths.push(initialCheckpoint)
  state = {
    ...state,
    latestCheckpointPath: initialCheckpoint,
    lastUpdatedAt: new Date().toISOString(),
  }
  await appendChangeIntakeLogEntry(options.changeId, {
    id: "checkpoint-0001",
    timestamp: new Date().toISOString(),
    kind: "checkpoint",
    branch: "intake-start",
    summary: "Initialized grill-me-enhanced intake state.",
    carryForward: "both",
  }, options.cwd)
  await writeChangeIntakeState(state, options.cwd)

  let checkpointIndex = 2
  for (const question of questions) {
    options.onProgress?.(`🧩 grill-me-enhanced: ${question.branch}`, "info")
    await appendChangeIntakeLogEntry(options.changeId, {
      id: `${question.id}-question`,
      timestamp: new Date().toISOString(),
      kind: "question",
      branch: question.branch,
      summary: question.question,
      recommendation: question.recommendation,
      carryForward: question.carryForward,
    }, options.cwd)

    const answer = await askQuestion(ctx, question, effectiveDepth)
    assignAnswer(answers, question.id, answer)
    await appendChangeIntakeLogEntry(options.changeId, {
      id: `${question.id}-answer`,
      timestamp: new Date().toISOString(),
      kind: "answer",
      branch: question.branch,
      summary: answer || "No answer captured.",
      recommendation: question.recommendation,
      carryForward: question.carryForward,
    }, options.cwd)

    state = {
      ...state,
      askedQuestionCount: state.askedQuestionCount + 1,
      resolvedDecisionCount: state.resolvedDecisionCount + (answer ? 1 : 0),
      unresolvedQuestionCount: question.id === "openQuestions" && answer ? 1 : state.unresolvedQuestionCount,
      lastUpdatedAt: new Date().toISOString(),
    }
    const checkpointPath = await writeChangeIntakeCheckpoint(
      options.changeId,
      checkpointIndex,
      buildCheckpointContent({
        state,
        question,
        answer,
        answers,
        checkpointIndex,
        changeDescription: options.changeDescription,
      }),
      options.cwd,
    )
    checkpointPaths.push(checkpointPath)
    state = {
      ...state,
      latestCheckpointPath: checkpointPath,
      lastUpdatedAt: new Date().toISOString(),
    }
    await writeChangeIntakeState(state, options.cwd)
    checkpointIndex += 1
  }

  const decisionLog = buildDecisionLog(options.changeId, effectiveDepth, answers)
  const onePagerInput = buildOnePagerInput(options.changeId, answers)
  const prepareContext = buildPrepareContext(
    options.changeId,
    effectiveDepth,
    answers,
    options.existingPrepareContext ?? null,
  )

  const decisionLogPath = await writeChangeIntakeDecisionLog(options.changeId, decisionLog, options.cwd)
  const prepareContextPath = await writeChangeIntakePrepareContext(options.changeId, prepareContext, options.cwd)
  const onePagerInputPath = await writeChangeIntakeOnePagerInput(options.changeId, onePagerInput, options.cwd)

  state = {
    ...state,
    status: "ready-for-plan",
    prepareContextPath,
    lastUpdatedAt: new Date().toISOString(),
  }
  await writeChangeIntakeState(state, options.cwd)
  options.onProgress?.("✅ grill-me-enhanced intake artifacts written.", "info")

  return {
    state,
    onePagerInput,
    onePagerInputPath,
    prepareContext,
    prepareContextPath,
    decisionLog,
    decisionLogPath,
    checkpointPaths,
  }
}
