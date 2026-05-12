---
name: review-logic
package: zflow
description: |
  Review code changes for algorithmic soundness: state transitions,
  invariant preservation, off-by-one errors, termination properties,
  and logical completeness of conditional branches.
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
