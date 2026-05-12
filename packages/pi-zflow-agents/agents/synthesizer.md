---
name: synthesizer
package: zflow
description: |
  Synthesise findings from multiple reviewers into a consolidated
  report. Deduplicates findings, records support/dissent, groups by
  severity, notes coverage gaps, and produces a go/no-go
  recommendation.
tools: read, grep, find, ls
thinking: medium
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: multi-model-code-review
maxSubagentDepth: 0
maxOutput: 12000
---
