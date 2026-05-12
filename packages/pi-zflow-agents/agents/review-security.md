---
name: review-security
package: zflow
description: |
  Review code changes for security concerns: injection vectors,
  authentication/authorisation gaps, secrets exposure, input
  validation failures, and privilege escalation paths.
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
