---
name: plan-review-integration
package: zflow
description: |
  Review planning artifacts for integration soundness. Checks that the
  plan accounts for cross-module impacts, API contracts, data flow
  between changed areas, and consistency with existing project
  architecture.
tools: read, grep, find, ls
thinking: high
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: change-doc-workflow, repository-map
maxSubagentDepth: 0
maxOutput: 10000
---
