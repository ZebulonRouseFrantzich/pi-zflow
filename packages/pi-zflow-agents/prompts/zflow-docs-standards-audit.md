# /zflow-docs-standards-audit

## When to use this helper

Use this prompt helper to audit a project's documentation against common standards and best practices. This is useful for identifying gaps in project documentation, ensuring consistency, and producing a documented set of conventions for the project.

This is a **standards auditing helper**, not the canonical automation flow. Standards definition and enforcement is a project-level concern; the pi-zflow package provides the tools, but the content is always project-specific.

## Usage

1. Invoke with `/zflow-docs-standards-audit` in the project root.
2. The assistant will:
   - Scan existing documentation files (README, CONTRIBUTING, docs/, etc.)
   - Check for common documentation elements (setup instructions, API docs, architecture overview, etc.)
   - Identify gaps and inconsistencies
   - Suggest improvements
3. The output is an audit report with actionable recommendations.

## Audit checklist

The audit checks for:

- **README**: project purpose, install instructions, quick start, configuration, license
- **Contributing guide**: how to contribute, code style, PR process
- **Architecture docs**: system overview, key decisions, data flow
- **API documentation**: public interfaces, usage examples
- **Change documentation**: changelog, migration guides, deprecation notices
- **Standards file**: project conventions (see `/zflow-standards-template`)

## Related

- Standards template: `/zflow-standards-template`
- Change preparation: `/zflow-draft-change-prepare`
