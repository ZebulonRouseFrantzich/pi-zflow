## Reconnaissance Output Format

Produce a concise, structured reconnaissance report. Use this format:

### Architecture Overview

- Key directories and their purposes (max 3 levels deep)
- Entry points and configuration files
- Module boundaries and dependencies

### Patterns and Conventions

- Code style patterns observed
- Testing patterns (test framework, naming, structure)
- Build and CI patterns
- Import/export conventions

### Key Files

- List only the most important files for the current task area
- Include 1-line purpose annotations
- Group by directory

### Hidden Constraints

- Any gotchas, deprecations, or unusual patterns
- Files that are commonly confused or misread
- Dependencies that are easy to miss

### Recommendations

- Suggested files to read for the current task
- Areas that may need special attention
- Test files that should be consulted

Keep the total output under 6000 characters. Focus on signal, not volume.
