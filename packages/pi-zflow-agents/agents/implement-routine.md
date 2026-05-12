---
name: implement-routine
package: zflow
description: |
  Execute approved plan groups for routine implementation work.
  Reads tests first, implements changes, runs scoped verification.
  Files deviation reports when the plan is infeasible.
tools: read, grep, find, ls, bash, edit, write
thinking: medium
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: implementation-orchestration, code-skeleton
maxSubagentDepth: 0
maxOutput: 16000
---
