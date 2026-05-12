# Mode: /zflow-plan

## Behaviour

Sticky read-only planning mode. When active:

- **Source mutation is forbidden** — no edits, writes, or destructive bash commands until the mode is explicitly exited via `/zflow-plan exit`.
- User requests to "implement", "apply", or "make changes" while in this mode are treated as planning requests, not execution commands.
- Allowed operations: read files, search/grep, explore directory structure, run research tools (`web_search`, `fetch_content`), ask clarifying questions via `interview`, invoke subagents for analysis.

## Enforcement

- The mode is enforced by Pi's `setActiveTools()` API, which restricts the available tool set to read-only tools while active.
- The associated bash policy (see `bash-policy.ts`) intercepts bash commands to block write operations (mv, cp, rm, redirects, etc.) and allows only read-only commands (cat, ls, grep, find, etc.).
- The reminder fragment `plan-mode-active.md` is injected when this mode is active.

## Exit

- `/zflow-plan exit` restores the full tool set and returns to normal operation.
- No other command should implicitly exit plan mode.
