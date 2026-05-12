# Default Profile Feasibility Report

> **Phase 0, Task 0.8** — Validated on 2026-05-12.
> Proves that the proposed initial `default` profile lanes can resolve to real models on the target machine.

## Machine model registry

Ran `pi --list-models` to discover all available providers and models.

### Available providers

| Provider | Available models |
|---|---|
| `openai-codex` | `gpt-5.1`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` |
| `opencode-go` | `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5`, `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, `mimo-v2.5`, `mimo-v2.5-pro`, `minimax-m2.5`, `minimax-m2.7`, `qwen3.5-plus`, `qwen3.6-plus` |

## Proposed default profile lanes

### Lane: `planning-frontier`

**Purpose**: Strategic planning, architecture design, complex reasoning.

| Preference | Provider | Model | Resolves? |
|---|---|---|---|
| Primary | `openai-codex` | `gpt-5.4` | ✅ Available (272K context, supports thinking) |
| Fallback | `opencode-go` | `mimo-v2.5-pro` | ✅ Available (1M context, supports thinking) |

### Lane: `worker-cheap`

**Purpose**: Implementation, editing, straightforward file manipulation.

| Preference | Provider | Model | Resolves? |
|---|---|---|---|
| Primary | `openai-codex` | `gpt-5.4-mini` | ✅ Available (272K context, supports thinking) |
| Fallback | `opencode-go` | `deepseek-v4-flash` | ✅ Available (1M context, supports thinking) |

### Lane: `review-system` (optional)

**Purpose**: Code review, plan review, PR review. Graceful degradation if unavailable.

| Preference | Provider | Model | Resolves? |
|---|---|---|---|
| Primary | `openai-codex` | `gpt-5.3-codex` | ✅ Available (272K context, supports thinking) |
| Fallback | `opencode-go` | `qwen3.6-plus` | ✅ Available (262K context, supports thinking) |

## Feasibility verdict

```
Profile:     default
Status:      ✅ ALL LANES RESOLVABLE
Date:        2026-05-12
```

### Resolved lanes

| Lane | Primary resolution | Fallback resolution | Status |
|---|---|---|---|
| `planning-frontier` | `openai-codex/gpt-5.4` | `opencode-go/mimo-v2.5-pro` | ✅ |
| `worker-cheap` | `openai-codex/gpt-5.4-mini` | `opencode-go/deepseek-v4-flash` | ✅ |
| `review-system` | `openai-codex/gpt-5.3-codex` | `opencode-go/qwen3.6-plus` | ✅ (optional) |

### Optional/unavailable

No unavailable optional lanes — all reviewed lanes resolve.

### Warnings

| Severity | Warning |
|---|---|
| ⚠️ info | All primary lanes use `openai-codex` provider. Consider recommending `@benvargas/pi-openai-verbosity` for reduced verbosity. |

### Codex verbosity planning

Since the primary `planning-frontier` and `worker-cheap` lanes both use `openai-codex`:
- Default verbosity profile recommended: `concise` for `openai-codex` lanes
- `@benvargas/pi-openai-verbosity` package should be recommended at profile resolution time
- This is documented in the profile fixture at `packages/pi-zflow-profiles/config/profiles.example.json` under `recommendations.packages[]`

## Profile fixture

The initial baseline profile is defined at:

```
packages/pi-zflow-profiles/config/profiles.example.json
```

This file is the single source of truth for the initial `default` profile lane preferences
and will be consumed by `pi-zflow-profiles` during implementation (Phase 2).

## Conclusion

**Phase 0 does not block.** All required lanes resolve successfully against the live model registry.
The `default` profile is feasible on this machine. Profile extension development can proceed in Phase 2.

If the model registry changes (e.g., provider deprecation, new models added), re-run this validation
and update the profile fixture accordingly.
