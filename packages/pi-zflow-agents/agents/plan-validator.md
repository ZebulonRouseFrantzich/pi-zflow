---
name: plan-validator
package: zflow
description: |
  Validate planning artifacts for completeness, internal consistency,
  and adherence to artifact structure rules. Checks that execution
  groups respect file-count and phase-count limits, dependencies are
  consistent, and verification steps are concrete.
tools: read, grep, find, ls
thinking: high
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: change-doc-workflow
maxSubagentDepth: 0
maxOutput: 8000
---
