---
name: implement-hard
package: zflow
description: |
  Execute approved plan groups for complex or high-risk implementation
  work. Has delegation capability for sub-tasks and deeper context
  gathering. Follows the same discipline as implement-routine but with
  greater analytical depth.
tools: read, grep, find, ls, bash, edit, write, subagent
thinking: high
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: implementation-orchestration, code-skeleton, plan-drift-protocol
maxSubagentDepth: 1
maxOutput: 20000
---
