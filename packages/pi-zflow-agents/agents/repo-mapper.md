---
name: repo-mapper
package: zflow
description: |
  Generate high-level repository maps for orientation, planning
  context, and agent handoff. Produces concise tree-structured
  overviews of project directory layout with annotations.
tools: read, grep, find, ls, bash
thinking: low
model: placeholder
fallbackModels:
  - placeholder
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
skills: repository-map
maxSubagentDepth: 0
maxOutput: 6000
---
