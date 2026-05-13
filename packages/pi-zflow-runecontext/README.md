# pi-zflow-runecontext

RuneContext detection, change-doc flavor parsing, canonical doc resolution, execution-group derivation, and prompt-with-preview amendment write-back for the pi-zflow harness.

This is an **optional** package — RuneContext support is not required for non-RuneContext repos. If your project does not use RuneContext (no `runecontext.yaml` and no `runectx` CLI), pi-zflow operates in adhoc mode without this package.

> Part of the [pi-zflow](https://github.com/earendil-works/pi-zflow) monorepo.

---

## Installation

### As part of pi-zflow

If you installed pi-zflow via the monorepo bootstrap, this package is already available:

```
pnpm install   # installs all workspace packages
```

The `package.json` `"exports"` map is already configured — `import` from `"pi-zflow-runecontext"` resolves to `./src/index.ts`.

### Standalone

```
pnpm add pi-zflow-runecontext
```

Requires the following peer dependencies:

| Package         | Role                                     |
| --------------- | ---------------------------------------- |
| `pi-zflow-core` | Capability registry and shared constants |
| `yaml`          | YAML parsing for `status.yaml`           |

---

## Quick start

```ts
import {
  detectRuneContext,
  resolveRuneChange,
  readRuneContextDocs,
} from "pi-zflow-runecontext";

// 1. Detect whether the repo is RuneContext-managed
const detection = await detectRuneContext("/path/to/repo");
if (!detection.enabled) {
  console.log("Not a RuneContext repo:", detection.source);
  process.exit(0);
}

// 2. Resolve a change folder (explicit path or ambient CWD walking)
const change = await resolveRuneChange({
  repoRoot: "/path/to/repo",
  changePath: "packages/my-pkg/changes/CHANGE-001",
});

// 3. Read canonical docs from the resolved change
const docs = await readRuneContextDocs(change);
console.log(docs.proposal); // proposal.md content
console.log(docs.status.status); // parsed status value

// 4. Derive execution groups from canonical docs
import { deriveExecutionGroupsFromRuneDocs } from "pi-zflow-runecontext";
const groups = deriveExecutionGroupsFromRuneDocs(docs);
console.log(groups.groups.length, "execution groups derived");
```

### Amendment write-back

```ts
import {
  detectRuneContext,
  resolveRuneChange,
  createAmendment,
  approveAmendment,
  writeApprovedAmendment,
  mapHarnessStateToRuneStatus,
} from "pi-zflow-runecontext";

// 1. Detect and resolve
const detection = await detectRuneContext(repoRoot);
const change = await resolveRuneChange({ repoRoot });

// 2. Map a harness state and check write-back policy
const mapping = mapHarnessStateToRuneStatus("approved", {
  allowedStatuses: ["draft", "approved", "completed"],
});
if (mapping.policy === "prompt") {
  // 3. Create an amendment (unapproved)
  const amendment = createAmendment(
    change.changeId,
    change.changePath,
    {
      "status.yaml": "status: approved\n",
    },
    "approved",
  );

  // 4. Approve the amendment
  const approved = approveAmendment(amendment);

  // 5. Write back to disk
  const result = await writeApprovedAmendment(approved);
  console.log(result.summary);
}
```

### Using the service interface

```ts
import { createRuneContextService } from "pi-zflow-runecontext";

const svc = createRuneContextService();

const detection = await svc.detect(repoRoot);
const change = await svc.resolveChange({ repoRoot });
const docs = await svc.readDocs(change);
```

---

## API reference

### Detection

| Export              | Signature                                             | Description                                              |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `detectRuneContext` | `(repoRoot: string) => Promise<RuneContextDetection>` | Detect whether a repo is RuneContext-managed             |
| `fileExists`        | `(filePath: string) => Promise<boolean>`              | Check if a file exists on disk                           |
| `tryRunectxStatus`  | `(cwd: string) => boolean`                            | Attempt `runectx status`; returns `false` if unavailable |

### Resolution

| Export              | Signature                                                        | Description                          |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| `resolveRuneChange` | `(input: ResolveRuneChangeInput) => Promise<ResolvedRuneChange>` | Resolve and validate a change folder |

### Reading

| Export                | Signature                                           | Description                                    |
| --------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `readRuneContextDocs` | `(change: ResolvedRuneChange) => Promise<RuneDocs>` | Read all canonical docs from a resolved change |

### Precedence

| Export                     | Signature                                                            | Description                                                 |
| -------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `getRequirementsSource`    | `(mode: "runecontext" \| "adhoc") => RequirementsSource`             | Determine authoritative requirements source                 |
| `classifyArtifact`         | `(name: string, mode: "runecontext" \| "adhoc") => DerivationStatus` | Classify an artifact as canonical, derived, or runtime-only |
| `isCanonicalArtifact`      | `(name: string, mode: "runecontext" \| "adhoc") => boolean`          | Shorthand — check if artifact is canonical                  |
| `listCanonicalDocNames`    | `(mode: "runecontext" \| "adhoc") => string[]`                       | List canonical doc names for the given mode                 |
| `listDerivedArtifactNames` | `(mode: "runecontext" \| "adhoc") => string[]`                       | List derived artifact names for the given mode              |

### Derivation

| Export                              | Signature                                                                                     | Description                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `deriveExecutionGroupsFromRuneDocs` | `(docs: RuneDocs) => DerivedExecutionGroups`                                                  | Derive execution groups from canonical docs |
| `parseTasksMd`                      | `(content: string) => DerivedExecutionGroup[]`                                                | Parse `tasks.md` into structured groups     |
| `inferGroupsFromDocs`               | `(docs: Pick<RuneDocs, "proposal" \| "design" \| "verification">) => DerivedExecutionGroup[]` | Infer groups when `tasks.md` is absent      |

### Status mapping

| Export                        | Signature                                                                           | Description                                   |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `mapHarnessStateToRuneStatus` | `(state: HarnessState, vocabulary: StatusVocabulary) => StatusMappingResult`        | Map harness state to RuneContext status       |
| `buildRuntimeMetadata`        | `(state: HarnessState, extra?: Record<string, unknown>) => Record<string, unknown>` | Build runtime metadata object                 |
| `shouldOfferWriteBack`        | `(result: StatusMappingResult) => boolean`                                          | Check if write-back preview should be offered |

### Amendments

| Export                   | Signature                                                                                                                        | Description                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `createAmendment`        | `(changeId: string, changePath: string, docChanges: Record<string, string>, triggerState: HarnessState) => RuneContextAmendment` | Create an unapproved amendment   |
| `approveAmendment`       | `(amendment: RuneContextAmendment) => RuneContextAmendment`                                                                      | Mark an amendment as approved    |
| `writeApprovedAmendment` | `(amendment: RuneContextAmendment) => Promise<WriteBackResult>`                                                                  | Write approved amendment to disk |

### Guards

| Export                            | Signature                                                                          | Description                                              |
| --------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `isWriteAllowedInRuneContextTree` | `(filename: string) => boolean`                                                    | Check if a filename is allowed inside a RuneContext tree |
| `validateRuneContextWriteTarget`  | `(targetPath: string, changePath: string) => { allowed: boolean; reason: string }` | Full path-level write validation                         |
| `getForbiddenArtifacts`           | `() => string[]`                                                                   | List all forbidden runtime artifact names                |

### Errors

| Export                     | Description                                   |
| -------------------------- | --------------------------------------------- |
| `RuneContextError`         | Base error class for all RuneContext failures |
| `MissingRequiredFileError` | A required canonical doc is missing           |
| `ChangeResolutionError`    | Cannot resolve a change folder                |
| `AmbiguousStatusError`     | `status.yaml` schema is ambiguous             |
| `DetectionConflictError`   | Conflicting detection signals                 |

### Service interface

| Export                     | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `RuneContextService`       | Interface bundling the key functions for registry-based access |
| `createRuneContextService` | Factory function to build a `RuneContextService` instance      |

---

## Agent guidance

For AI agents working with this package, see the skill file at `extensions/pi-runecontext/` for behavioral guidance and constraints. The skill file documents:

- How RuneContext detection works (two-marker system)
- When to offer write-back previews vs runtime-only status
- Which artifacts are forbidden inside RuneContext trees
- How precedence resolves conflicts between canonical and derived artifacts

---

## Architecture notes

- **Detection** relies on two markers: `runecontext.yaml` file presence and `runectx status` CLI success. Neither is required; the first positive marker wins.
- **Change flavors** are "plain" (proposal + design + standards + verification + status) and "verified" (adds tasks.md + references.md).
- **Write-back is prompt-only by default** — amendments must be explicitly approved before writing to canonical docs.
- **Guards prevent runtime artifacts** (run.json, plan-state.json, review-findings.md, etc.) from being written inside the RuneContext change tree.

---

## License

MIT
