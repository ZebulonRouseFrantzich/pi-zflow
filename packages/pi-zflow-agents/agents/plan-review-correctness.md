---
name: plan-review-correctness
package: zflow
description: |
  Review planning artifacts for logical correctness. Checks that the
  design accurately addresses the change request, execution groups
  produce the intended outcome, dependencies are sound, and edge
  cases are accounted for in the plan.
tools: read, grep, find, ls
thinking: high
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: change-doc-workflow, runecontext-workflow
maxSubagentDepth: 0
maxOutput: 10000
---
