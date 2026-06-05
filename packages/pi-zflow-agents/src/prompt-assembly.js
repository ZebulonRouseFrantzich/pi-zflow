/**
 * prompt-assembly.ts — Prompt-fragment assembly for subagent launches.
 *
 * Assembles the minimum prompt context needed for each role and workflow
 * state without creating a giant always-loaded prompt bundle.
 *
 * ## Assembly rules
 *
 * - Role prompt (agent body) is always included.
 * - Mode fragment is included only when the workflow state requires it.
 * - Runtime reminders are included only when the corresponding event/state
 *   is active.
 * - Root-orchestrator constitution is NOT included for subagents; only
 *   distilled role-relevant invariants are passed when needed.
 * - Active safety/state constraints are appended near the end of the
 *   assembled prompt.
 * - Examples and input artifacts are clearly separated from normative
 *   instructions.
 * - Contradictory mode fragments cannot be simultaneously active.
 *
 * @module pi-zflow-agents/prompt-assembly
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// ── Package root resolution ─────────────────────────────────────
/**
 * Resolve the package root directory.
 *
 * When loaded from the source tree (via tsx), uses import.meta.url.
 * Consumers may override `customPackageRoot` in `PromptAssemblyInput`
 * for testing or when the module is installed to a different path.
 *
 * The package root is expected to contain `agents/`, `prompt-fragments/`,
 * etc. as sibling directories relative to `src/`.
 */
function resolvePackageRoot(customPath) {
    if (customPath)
        return customPath;
    const thisFile = fileURLToPath(import.meta.url);
    // src/prompt-assembly.ts → packages/pi-zflow-agents
    return resolve(dirname(thisFile), "..");
}
// ── Path helpers ────────────────────────────────────────────────
/** Get the agent short name from a full runtime name like "zflow.planner-frontier". */
function agentShortName(fullName) {
    // Strip "zflow." prefix if present to get the file name
    return fullName.replace(/^zflow\./, "");
}
/** Build the agent markdown file path. */
function agentFilePath(packageRoot, agentName) {
    return resolve(packageRoot, "agents", `${agentShortName(agentName)}.md`);
}
/** Build the mode fragment file path. */
function modeFilePath(packageRoot, mode) {
    return resolve(packageRoot, "prompt-fragments", "modes", `${mode}.md`);
}
/** Build the reminder fragment file path. */
function reminderFilePath(packageRoot, reminder) {
    return resolve(packageRoot, "prompt-fragments", "reminders", `${reminder}.md`);
}
// ── File loading helpers ────────────────────────────────────────
/** Load a file's content, returning the full text. Throws if not found. */
function loadFile(path) {
    if (!existsSync(path)) {
        throw new Error(`Prompt assembly: file not found at "${path}"`);
    }
    return readFileSync(path, "utf-8");
}
/**
 * Extract YAML frontmatter from a markdown file, returning the body text.
 *
 * Handles standard `---` delimited frontmatter. Returns the full text
 * if no frontmatter is found.
 */
function extractMarkdownBody(text) {
    if (text.startsWith("---")) {
        const endIndex = text.indexOf("---", 3);
        if (endIndex !== -1) {
            // Return everything after the closing ---, trimmed
            return text.slice(endIndex + 3).trimStart();
        }
    }
    return text;
}
// ── Mode conflict detection ─────────────────────────────────────
/**
 * Mutually exclusive mode groups. Modes within the same group cannot
 * be simultaneously active.
 */
const MODE_CONFLICT_GROUPS = {
    "change-lifecycle": ["change-prepare", "change-implement"],
    "session-mode": ["plan-mode"],
};
/**
 * Check if a mode conflicts with any other modes that might already be active.
 * Currently checks against the single requested mode.
 *
 * Returns an error message if a conflict is detected, or null if safe.
 */
export function checkModeConflicts(requestedMode, activeModes) {
    for (const [, group] of Object.entries(MODE_CONFLICT_GROUPS)) {
        if (group.includes(requestedMode)) {
            const conflicts = group.filter((m) => m !== requestedMode && activeModes.includes(m));
            if (conflicts.length > 0) {
                return `Mode "${requestedMode}" conflicts with active mode(s): ${conflicts.join(", ")}. They belong to the same mutually exclusive group.`;
            }
        }
    }
    return null;
}
// ── Fragment loaders ────────────────────────────────────────────
/** Load and return a mode fragment content. */
function loadModeFragment(packageRoot, mode) {
    const filePath = modeFilePath(packageRoot, mode);
    const content = loadFile(filePath);
    return { content, filePath };
}
/** Load multiple reminder fragments, returning only those requested. */
function loadReminderFragments(packageRoot, activeIds) {
    const result = {};
    for (const id of activeIds) {
        const filePath = reminderFilePath(packageRoot, id);
        if (existsSync(filePath)) {
            result[id] = { content: loadFile(filePath), filePath };
        }
        // Silently skip reminders whose files don't exist
    }
    return result;
}
// ── Main assembly function ──────────────────────────────────────
/**
 * Assemble a subagent prompt from the agent role prompt, optional mode
 * fragment, and active reminders.
 *
 * The assembled prompt structure is:
 *
 * 1. Role prompt (from agent markdown body)
 * 2. Mode fragment (if active, after a clear separator)
 * 3. Reminder fragments (if active, after a clear separator)
 * 4. Skills reference (if skills provided)
 * 5. Distilled orchestrator invariants (if provided)
 * 6. Artifact paths context (if provided)
 *
 * Examples in the artifacts context are clearly separated from normative
 * instructions.
 */
export function assemblePrompt(input) {
    const packageRoot = resolvePackageRoot(input.customPackageRoot);
    const debug = {
        agentFile: "",
        reminderFiles: [],
    };
    // 1. Load and extract role prompt
    const agentPath = agentFilePath(packageRoot, input.agentName);
    debug.agentFile = agentPath;
    const agentRaw = loadFile(agentPath);
    const rolePrompt = extractMarkdownBody(agentRaw);
    // 2. Optionally load mode fragment
    let modeFragment;
    if (input.mode) {
        const conflicts = checkModeConflicts(input.mode, input.mode ? [input.mode] : []);
        if (conflicts) {
            throw new Error(conflicts);
        }
        const { content, filePath } = loadModeFragment(packageRoot, input.mode);
        modeFragment = content;
        debug.modeFile = filePath;
    }
    // 3. Load requested reminder fragments
    const includedReminders = {};
    if (input.activeReminders && input.activeReminders.length > 0) {
        const loaded = loadReminderFragments(packageRoot, input.activeReminders);
        for (const [id, { content, filePath }] of Object.entries(loaded)) {
            includedReminders[id] = content;
            debug.reminderFiles.push(filePath);
        }
    }
    // 4. Build artifact paths context if provided
    let artifactContext;
    if (input.artifactPaths && Object.keys(input.artifactPaths).length > 0) {
        const lines = ["## Canonical paths", ""];
        for (const [key, path] of Object.entries(input.artifactPaths)) {
            lines.push(`- **${key}**: \`${path}\``);
        }
        artifactContext = lines.join("\n");
    }
    // 5. Build skills reference
    let skillsContext;
    if (input.skills && input.skills.length > 0) {
        skillsContext = [
            "## Relevant skills",
            "",
            "The following skills are active for this agent:",
            "",
            ...input.skills.map((s) => `- \`${s}\``),
            "",
            "Refer to the skill documents for detailed guidance.",
        ].join("\n");
    }
    // 6. Build distilled orchestrator invariants
    let orchestratorInvariants;
    if (input.distilledOrchestratorInvariants &&
        input.distilledOrchestratorInvariants.length > 0) {
        orchestratorInvariants = [
            "## Orchestrator invariants (distilled for this role)",
            "",
            ...input.distilledOrchestratorInvariants.map((s) => `- ${s}`),
        ].join("\n");
    }
    // 7. Assemble the full prompt
    const sections = [];
    // Role prompt always first
    sections.push(rolePrompt.trim());
    // Mode fragment if active
    if (modeFragment) {
        sections.push("");
        sections.push("---");
        sections.push("");
        sections.push(modeFragment.trim());
    }
    // Reminders if active
    if (Object.keys(includedReminders).length > 0) {
        sections.push("");
        sections.push("---");
        sections.push("");
        sections.push("## Active reminders");
        sections.push("");
        for (const content of Object.values(includedReminders)) {
            sections.push(content.trim());
            sections.push("");
        }
    }
    // Skills reference
    if (skillsContext) {
        sections.push("");
        sections.push("---");
        sections.push("");
        sections.push(skillsContext);
    }
    // Distilled orchestrator invariants near the end
    if (orchestratorInvariants) {
        sections.push("");
        sections.push("---");
        sections.push("");
        sections.push(orchestratorInvariants);
    }
    // Artifact paths last (concrete paths, lowest ambiguity risk)
    if (artifactContext) {
        sections.push("");
        sections.push("---");
        sections.push("");
        sections.push(artifactContext);
    }
    return {
        prompt: sections.join("\n").trim(),
        rolePrompt: rolePrompt.trim(),
        modeFragment: modeFragment?.trim(),
        includedReminders,
        artifactContext,
        skillsContext,
        orchestratorInvariants,
        debug,
    };
}
// ── Discovery helpers ───────────────────────────────────────────
/**
 * List available mode fragment IDs found on disk.
 *
 * Useful for debugging, validation, and tooling that needs to enumerate
 * which modes can be assembled.
 */
export function listAvailableModes(customPackageRoot) {
    const packageRoot = resolvePackageRoot(customPackageRoot);
    const modesDir = resolve(packageRoot, "prompt-fragments", "modes");
    if (!existsSync(modesDir))
        return [];
    const files = readdirSync(modesDir);
    return files
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""))
        .filter((m) => isValidMode(m));
}
/** Type guard for WorkflowMode. */
function isValidMode(m) {
    const valid = [
        "change-prepare",
        "change-implement",
        "plan-mode",
        "review-pr",
        "zflow-clean",
    ];
    return valid.includes(m);
}
/**
 * List available reminder fragment IDs found on disk.
 *
 * Useful for debugging, validation, and tooling that needs to enumerate
 * which reminders can be injected.
 */
export function listAvailableReminders(customPackageRoot) {
    const packageRoot = resolvePackageRoot(customPackageRoot);
    const remindersDir = resolve(packageRoot, "prompt-fragments", "reminders");
    if (!existsSync(remindersDir))
        return [];
    const files = readdirSync(remindersDir);
    return files
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""))
        .filter((r) => isValidReminder(r));
}
/** Type guard for ReminderId. */
function isValidReminder(r) {
    const valid = [
        "approved-plan-loaded",
        "compaction-handoff",
        "drift-detected",
        "external-file-change",
        "plan-mode-active",
        "tool-denied",
        "verification-status",
    ];
    return valid.includes(r);
}
