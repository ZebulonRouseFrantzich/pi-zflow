---
name: plan-review-feasibility
package: zflow
description: |
  Review planning artifacts for practical feasibility. Checks that
  the proposed approach is implementable given the actual codebase
  structure, available tools, and project constraints. May verify
  file paths and module existence.
tools: read, grep, find, ls, bash
thinking: high
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: change-doc-workflow, code-skeleton, repository-map
maxSubagentDepth: 0
maxOutput: 10000
---
