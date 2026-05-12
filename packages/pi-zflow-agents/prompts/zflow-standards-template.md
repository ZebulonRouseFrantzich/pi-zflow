# /zflow-standards-template

## When to use this helper

Use this prompt helper to draft a `standards.md` file for a project. A standards file documents the conventions, patterns, and practices that agents should follow when implementing changes. The planner (or a human) produces this early in a project and refines it as the project evolves.

This is a **template helper**, not the canonical automation flow. Standards are project-specific; the template provides a starting structure that should be adapted to each project's needs.

## Usage

1. Invoke with `/zflow-standards-template` to generate a standards skeleton.
2. Customize each section to match project conventions.
3. Place the resulting file at the project root as `standards.md` or reference it from the project's `AGENTS.md`.

## Template structure

The generated standards file covers:

### Code style and conventions

- Language-specific style guide references
- Naming conventions (files, variables, functions, classes)
- Import ordering and module structure
- Error handling patterns
- Testing conventions

### Architecture patterns

- Component/module organization
- Data flow patterns
- State management approach
- API design conventions
- Database/migration patterns

### Documentation requirements

- When to document (new modules, public APIs, non-obvious logic)
- Doc comment format
- README updates expected per change
- Changelog conventions

### Dependency management

- Adding new dependencies: process and approval
- Version pinning policy
- Dependency update frequency

### Security and safety

- Secrets handling
- Input validation expectations
- Permission boundaries
- Logging and monitoring

### Verification expectations

- Test coverage requirements
- Linting and formatting
- Review checklist items
- Performance benchmarks

## Related

- Documentation audit: `/zflow-docs-standards-audit`
- Change preparation: `/zflow-draft-change-prepare`
