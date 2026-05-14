# Web-Access Policy

> **Scoping external research tools (`pi-web-access`) to authorized roles only.**
> Context cost is real — web access tools increase token usage and can cause agents to drift into unnecessary external research when the task only needs code changes.

## Core rule

External research access is scoped by role. Only planner, review, and dedicated research agents receive `pi-web-access` tools by default. Implementation and verification agents do not — they should focus on the codebase, the plan, and their verification scope.

## Tool inventory

The `pi-web-access` package provides these tools:

| Tool                 | Purpose                                              | Follow-up?                                            |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `web_search`         | Full-text web search for documentation, APIs, issues | No                                                    |
| `fetch_content`      | Fetch a single URL and return its content            | No                                                    |
| `code_search`        | Search code repositories (GitHub, GitLab, etc.)      | No                                                    |
| `get_search_content` | Fetch content from a search result URL               | Yes — only useful after `web_search` or `code_search` |

`get_search_content` is a follow-up tool that should only be available when `web_search`, `code_search`, or `fetch_content` is also available. It has no value in isolation.

## Roles that may receive web-access tools

| Role                      | Rationale                                                                    | Currently has?                   |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| `planner-frontier`        | Needs web research for design decisions, API validation, dependency research | ✅ `web_search`, `fetch_content` |
| `plan-review-correctness` | May need to verify external references, API docs, or library behavior        | ❌ (opt-in)                      |
| `plan-review-feasibility` | May need to check dependency availability or platform docs                   | ❌ (opt-in)                      |
| `plan-review-integration` | May need external API contract docs                                          | ❌ (opt-in)                      |
| `review-correctness`      | May need to check documentation or API specs during review                   | ❌ (opt-in)                      |
| `review-integration`      | May need external integration docs                                           | ❌ (opt-in)                      |
| `review-security`         | May need CVE database or security advisory lookups                           | ❌ (opt-in)                      |
| `review-logic`            | May need algorithm reference or spec docs                                    | ❌ (opt-in)                      |
| `review-system`           | May need system architecture reference docs                                  | ❌ (opt-in)                      |
| Dedicated research role   | Future role for deep research tasks                                          | N/A                              |

Review agents currently do not have web access by default. This is the safe starting state — add web access to a reviewer only when the review tier or context demands it.

## Roles that must NOT receive web-access tools by default

| Role                | Reason                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `implement-routine` | Should focus on code changes, not external research. Drift risk.                                  |
| `implement-hard`    | Should focus on code changes, not external research. Drift risk.                                  |
| `verifier`          | Should focus on verifying the implementation against the plan. External research is out of scope. |
| `repo-mapper`       | Explores the local repository only. External research is irrelevant.                              |
| `plan-validator`    | Validates structural plan quality. Does not need external info.                                   |
| `synthesizer`       | Consolidates reviewer findings into a report. Does not do original research.                      |

## Context cost rationale

Web access tools increase context usage in several ways:

1. **Search result pages** — `web_search` returns multiple result snippets that consume tokens
2. **Fetched content** — `fetch_content` loads the full page content, which can be thousands of tokens
3. **Drift risk** — agents with web access may spend turns researching external topics instead of implementing or verifying
4. **Follow-up queries** — research often leads to more research, amplifying the cost

For implementation agents, these costs are pure waste: the agent should be reading the codebase and the plan, not the internet.

## How to add web access to a role

To grant web access to an agent, add the desired tools to its `tools:` field in the agent markdown frontmatter:

```yaml
---
tools: read, grep, find, ls, bash, edit, write, web_search, fetch_content
---
```

For plan/review agents that also need follow-up fetching, include `get_search_content`:

```yaml
---
tools: read, grep, find, ls, web_search, fetch_content, get_search_content
---
```

### Rules for adding web access

1. **Do not add `get_search_content` without also adding `web_search` or `fetch_content`** — it has no value in isolation.
2. **Prefer additive grants** — start without web access, add only when the role's task explicitly requires external research.
3. **Document the reason** — when adding web access to a role that previously did not have it, include a note in the commit message explaining why.
4. **Review periodically** — as the agent catalog grows, audit which agents have web access and whether they still need it.
