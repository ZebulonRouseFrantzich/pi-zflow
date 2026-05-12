---
name: review-integration
package: zflow
description: |
  Review code changes for integration soundness: API contracts,
  cross-module coupling, data flow between changed areas, and
  consistency with existing interfaces and patterns.
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
