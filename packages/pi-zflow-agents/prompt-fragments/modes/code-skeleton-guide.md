## Code Skeleton Guidance

Use the `code-skeleton` skill when you need to understand module structure
without reading full source.

### When to produce skeletons

- Planning changes that touch multiple modules
- Handing off context to another agent
- After compaction, to re-establish module understanding
- During review preparation, to map changed modules

### Skeleton format (per file, ≤30 lines)

```text
### `path/to/module.ts`

**Exports:**
- `function createFoo(config: FooConfig): Foo` — one-line purpose
- `interface Foo { ... }` — key fields

**Imports from this module:**
- `src/index.ts` — uses createFoo

**Patterns:**
- Async initialiser pattern
- Error handling: Result<T, Error>
```

### When NOT to use skeletons

- When implementation details matter (use full `read`)
- When the file is <50 lines
- When you already have the file content in context

Keep skeletons compact. If a skeleton exceeds 30 lines, the file may have too
many responsibilities.
