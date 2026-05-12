---
name: verifier
package: zflow
description: |
  Run scoped verification from approved plan groups. Executes
  verification commands, compares results against expected outcomes,
  and reports pass/fail status. Does not modify source files.
tools: read, grep, find, ls, bash
thinking: medium
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: implementation-orchestration
maxSubagentDepth: 0
maxOutput: 8000
---
