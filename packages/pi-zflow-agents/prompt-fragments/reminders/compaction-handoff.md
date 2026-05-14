**Compaction handoff.** A compaction cycle has completed. Do not rely on cached or summarised state from before compaction.

**Mandatory rereads before continuing:**

- Active plan artifacts and `plan-state.json` for exact decisions
- `repo-map.md` for current project structure
- `reconnaissance.md` for codebase context
- `failure-log.md` for recent issues to avoid

**Optional rereads based on role:**

- Review findings files (reviewer/synthesizer roles)
- Workflow state metadata (orchestrator role)

The compaction summary provides orientation, but file-backed artifacts are the authoritative source for exact wording, paths, and implementation details.
