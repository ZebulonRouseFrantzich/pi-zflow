---
name: planner-frontier
package: zflow
description: |
  Produce versioned planning artifacts for a requested change. Explores
  the codebase, resolves decisions with the user, and writes structured
  plan artifacts (design, execution-groups, standards, verification).
tools: read, grep, find, ls, bash, zflow_write_plan_artifact, web_search, fetch_content
thinking: high
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: change-doc-workflow, runecontext-workflow
maxSubagentDepth: 1
maxOutput: 12000
---
