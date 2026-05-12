---
name: review-correctness
package: zflow
description: |
  Review code changes for correctness: logic errors, edge cases, type
  safety, concurrency issues, and regressions. Produces structured
  findings with file/line references and severity classification.
tools: read, grep, find, ls
thinking: high
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: multi-model-code-review
maxSubagentDepth: 0
maxOutput: 10000
---
