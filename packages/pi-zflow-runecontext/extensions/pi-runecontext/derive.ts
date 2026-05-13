/**
 * derive.ts — Execution-group derivation from canonical RuneContext docs.
 *
 * Implements Phase 3 Task 3.5:
 * Generate dispatch-oriented execution groups from canonical RuneContext
 * docs without introducing new requirements.
 *
 * Derivation sources (in priority order):
 *   1. `tasks.md` if present (the `RuneDocs.tasks` field)
 *   2. otherwise `proposal.md`, `design.md`, and `verification.md`
 *
 * Key constraints:
 *   - Every file operation in derived groups must map back to canonical
 *     requirements.
 *   - Do not add requirements absent from canonical docs.
 *   - Preserve explicit dependencies and verification where provided.
 *   - If canonical docs are under-specified, mark uncertainty rather than
 *     inventing unsupported requirements.
 *
 * @module pi-zflow-runecontext/derive
 */

import type { RuneDocs } from "./read-docs.js"

// ── Types ────────────────────────────────────────────────────────

/**
 * A single derived execution group (e.g. "setup", "implementation", "verification").
 */
export interface DerivedExecutionGroup {
  /** Name of the execution group (e.g. "setup", "implementation", "verification"). */
  name: string
  /** Description derived from canonical docs. */
  description: string
  /** List of tasks or steps within this group. */
  tasks: DerivedTask[]
  /** Whether this group's content is fully specified by canonical docs or partially inferred. */
  confidence: "full" | "partial"
}

/**
 * A single derived task within an execution group.
 */
export interface DerivedTask {
  /** Task title or summary. */
  title: string
  /** Source document(s) this task was derived from. */
  sources: string[]
  /** Whether this task came directly from tasks.md or was inferred. */
  origin: "tasks.md" | "inferred"
  /** Verification criteria if specified in canonical docs. */
  verification?: string
}

/**
 * The complete set of derived execution groups for a change.
 */
export interface DerivedExecutionGroups {
  /** The mode that produced these groups. */
  mode: "runecontext" | "adhoc"
  /** Whether tasks.md was available (direct source) vs inferred from other docs. */
  sourceDocument: "tasks.md" | "proposal+design+verification"
  /** The derived execution groups. */
  groups: DerivedExecutionGroup[]
}

// ── Constants ────────────────────────────────────────────────────

/** Minimum number of significant words for a heading to be usable as a group name. */
const MIN_HEADING_WORDS = 1

/** Markdown heading pattern — matches ## or ### headings. */
const HEADING_RE = /^(#{2,3})\s+(.+)$/gm

/** Markdown list-item pattern — matches lines starting with - or * (including task lists). */
const LIST_ITEM_RE = /^\s*[-*]\s+(.+)$/gm

// ── tasks.md parser ──────────────────────────────────────────────

/**
 * Parse the structured content of a `tasks.md` file into derived execution groups.
 *
 * Recognises `##` and `###` markdown headings as group boundaries.
 * Items under each heading (lines starting with `-` or `*`) are treated
 * as tasks. If no structured headings are found, the entire document is
 * treated as a single group named "tasks".
 *
 * @param content - Raw markdown content of tasks.md.
 * @returns An array of derived execution groups with full confidence.
 */
export function parseTasksMd(content: string): DerivedExecutionGroup[] {
  // Normalise line endings
  const normalised = content.replace(/\r\n/g, "\n")

  // Collect all heading positions
  const headings: Array<{ level: string; name: string; startIndex: number }> = []
  let match: RegExpExecArray | null

  HEADING_RE.lastIndex = 0
  while ((match = HEADING_RE.exec(normalised)) !== null) {
    // Trim the heading text and use as group name
    const name = match[2].trim()
    headings.push({
      level: match[1],
      name,
      startIndex: match.index,
    })
  }

  // If no headings found, treat whole document as a single group
  if (headings.length === 0) {
    const tasks = extractListItems(normalised)
    return [
      {
        name: "tasks",
        description: "Tasks extracted from tasks.md",
        tasks: tasks.map((item) => ({
          title: item.text,
          sources: ["tasks.md"],
          origin: "tasks.md" as const,
          ...(item.verification ? { verification: item.verification } : {}),
        })),
        confidence: "full",
      },
    ]
  }

  // Build groups: extract content between each heading and the next
  const groups: DerivedExecutionGroup[] = []

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const nextIndex =
      i + 1 < headings.length ? headings[i + 1].startIndex : normalised.length

    const sectionContent = normalised.slice(h.startIndex, nextIndex)
    const items = extractListItems(sectionContent)

    groups.push({
      name: h.name,
      description: `Tasks from the "${h.name}" section of tasks.md`,
      tasks: items.map((item) => ({
        title: item.text,
        sources: ["tasks.md"],
        origin: "tasks.md" as const,
        ...(item.verification ? { verification: item.verification } : {}),
      })),
      confidence: "full",
    })
  }

  return groups
}

// ── Inference helpers (when tasks.md is absent) ─────────────────

/**
 * Infer execution groups from proposal.md, design.md, and verification.md
 * when `tasks.md` is not available.
 *
 * Scans each document for section headings (## / ###) and creates groups
 * based on the document structure. All inferred tasks are marked with
 * "partial" confidence and "inferred" origin.
 *
 * If a document has no section headings, a single group is created for it
 * using a descriptive name derived from the document role.
 *
 * @param docs - The canonical docs (proposal, design, verification).
 * @returns An array of inferred execution groups (partial confidence).
 */
export function inferGroupsFromDocs(
  docs: Pick<RuneDocs, "proposal" | "design" | "verification">,
): DerivedExecutionGroup[] {
  const groups: DerivedExecutionGroup[] = []

  // Helper: extract groups from a single document
  const extractFromDoc = (
    content: string,
    docName: string,
    defaultGroupName: string,
    defaultDescription: string,
  ): DerivedExecutionGroup[] => {
    const normalised = content.replace(/\r\n/g, "\n")
    const docGroups: DerivedExecutionGroup[] = []

    const headings: Array<{ name: string; startIndex: number }> = []
    let match: RegExpExecArray | null

    HEADING_RE.lastIndex = 0
    while ((match = HEADING_RE.exec(normalised)) !== null) {
      const name = match[2].trim()
      if (name) {
        headings.push({ name, startIndex: match.index })
      }
    }

    if (headings.length === 0) {
      // No headings — single inferred group from the entire document
      const paragraphs = extractParagraphSummary(normalised)
      if (paragraphs.length > 0) {
        docGroups.push({
          name: defaultGroupName,
          description: defaultDescription,
          tasks: paragraphs.map((p) => ({
            title: p,
            sources: [docName],
            origin: "inferred",
          })),
          confidence: "partial",
        })
      }
    } else {
      for (let i = 0; i < headings.length; i++) {
        const h = headings[i]
        const nextIndex =
          i + 1 < headings.length ? headings[i + 1].startIndex : normalised.length

        const sectionContent = normalised.slice(h.startIndex, nextIndex)
        const items = extractListItems(sectionContent)
        const paragraphs = extractParagraphSummary(sectionContent)

        // Combine list items and paragraph summaries as tasks
        const taskTitles: string[] = []
        if (items.length > 0) {
          taskTitles.push(...items.map((i) => i.text))
        } else {
          taskTitles.push(...paragraphs)
        }

        if (taskTitles.length > 0) {
          docGroups.push({
            name: h.name,
            description: `Inferred from "${h.name}" section of ${docName}`,
            tasks: taskTitles.map((title) => ({
              title,
              sources: [docName],
              origin: "inferred",
            })),
            confidence: "partial",
          })
        }
      }
    }

    return docGroups
  }

  // Extract from each document
  const proposalGroups = extractFromDoc(
    docs.proposal,
    "proposal.md",
    "proposal",
    "Tasks inferred from the proposal document",
  )
  groups.push(...proposalGroups)

  const designGroups = extractFromDoc(
    docs.design,
    "design.md",
    "design",
    "Tasks inferred from the design document",
  )
  groups.push(...designGroups)

  const verificationGroups = extractFromDoc(
    docs.verification,
    "verification.md",
    "verification",
    "Tasks inferred from the verification document",
  )
  groups.push(...verificationGroups)

  // If nothing was inferred at all, add a single uncertain group
  if (groups.length === 0) {
    groups.push({
      name: "uncertain",
      description:
        "No structured content found in canonical docs — tasks cannot be derived",
      tasks: [],
      confidence: "partial",
    })
  }

  return groups
}

// ── Main derivation entry point ──────────────────────────────────

/**
 * Derive execution groups from canonical RuneContext documents.
 *
 * This is the primary entry point for downstream dispatchers to obtain
 * dispatch-oriented execution groups from canonical RuneContext docs.
 *
 * If `tasks.md` is available (verified flavor), groups are parsed directly
 * with full confidence. Otherwise, groups are inferred from proposal.md,
 * design.md, and verification.md with partial confidence.
 *
 * @param docs - The canonical RuneContext documents (from readRuneContextDocs).
 * @returns Derived execution groups with traceability metadata.
 */
export function deriveExecutionGroupsFromRuneDocs(
  docs: RuneDocs,
): DerivedExecutionGroups {
  if (docs.tasks !== null) {
    // tasks.md present — direct parsing, full confidence
    const groups = parseTasksMd(docs.tasks)

    return {
      mode: "runecontext",
      sourceDocument: "tasks.md",
      groups,
    }
  }

  // tasks.md absent — infer from proposal + design + verification
  const groups = inferGroupsFromDocs({
    proposal: docs.proposal,
    design: docs.design,
    verification: docs.verification,
  })

  return {
    mode: "runecontext",
    sourceDocument: "proposal+design+verification",
    groups,
  }
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Extract markdown list items (`-` or `*`) from a section of content.
 *
 * Returns the item text with optional verification criteria extracted
 * from parenthesised notes or trailing verification references.
 */
function extractListItems(
  content: string,
): Array<{ text: string; verification?: string }> {
  const items: Array<{ text: string; verification?: string }> = []

  LIST_ITEM_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LIST_ITEM_RE.exec(content)) !== null) {
    let raw = match[1].trim()

    // Strip leading task-list markers: "- [ ]" or "- [x]"
    raw = raw.replace(/^\[[\sxX]\]\s*/, "").trim()

    if (raw.length === 0) continue

    // Check for inline verification reference: "(verify: ...)" or "// verify: ..."
    const verificationMatch = raw.match(
      /[\(\[][Vv]erify[a-z]*[:\s]+([^\)\]]+)[\)\]]/,
    )
    if (verificationMatch) {
      items.push({
        text: raw.replace(/[\(\[][Vv]erify[a-z]*[:\s]+[^\)\]]+[\)\]]/, "").trim(),
        verification: verificationMatch[1].trim(),
      })
    } else {
      items.push({ text: raw })
    }
  }

  return items
}

/**
 * Extract a short summary of the first few non-empty lines from content
 * that are not headings, code fences, or blank lines.
 *
 * Used to produce task titles when a section has no list items.
 * Returns an array of sentence-like fragments.
 */
function extractParagraphSummary(content: string): string[] {
  const lines = content.split("\n")
  const results: string[] = []
  let inCodeFence = false
  let currentParagraph = ""

  for (const line of lines) {
    const trimmed = line.trim()

    // Track code fences
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue

    // Skip headings, blank lines, and horizontal rules
    if (
      trimmed === "" ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("---") ||
      trimmed.startsWith("___") ||
      trimmed.startsWith("***")
    ) {
      // Flush accumulated paragraph
      if (currentParagraph) {
        results.push(currentParagraph)
        currentParagraph = ""
      }
      continue
    }

    // Skip list items (they're handled separately) and images
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("![")) {
      continue
    }

    // Accumulate paragraph text
    if (currentParagraph) {
      currentParagraph += " " + trimmed
    } else {
      currentParagraph = trimmed
    }

    // If the line ends sentence-like, flush it
    if (/[.!?:;]$/.test(trimmed) && currentParagraph.length > 20) {
      results.push(currentParagraph)
      currentParagraph = ""
    }
  }

  // Flush any remaining paragraph
  if (currentParagraph) {
    results.push(currentParagraph)
  }

  // Limit to reasonable number of inferred tasks
  return results.slice(0, 10)
}
