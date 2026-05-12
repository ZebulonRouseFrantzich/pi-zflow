# `worktreeSetupHook` Templates

> Generic hook templates shipped with `pi-zflow-change-workflows`.
> Copy, adapt, and commit to your repo — never edit these templates in place.

## Available templates

| File                                                         | Repo class              | Description                                       |
| ------------------------------------------------------------ | ----------------------- | ------------------------------------------------- |
| [`generic-node-ci.sh`](./generic-node-ci.sh)                 | Plain TS/JS repo        | Runs `npm ci` (or package-manager equivalent)     |
| [`generic-pnpm-workspace.mjs`](./generic-pnpm-workspace.mjs) | pnpm workspace monorepo | `pnpm install --frozen-lockfile` + `pnpm rebuild` |
| [`generic-env-stub.sh`](./generic-env-stub.sh)               | Env stub required       | Copies `.env.example` → `.env`                    |
| [`generic-codegen.sh`](./generic-codegen.sh)                 | Code generation needed  | Runs Prisma, GraphQL, protobuf codegen            |

## How to use

```bash
# 1. Identify your repo class from the table above.
# 2. Copy the matching template into your repo:
mkdir -p .pi/zflow
cp packages/pi-zflow-change-workflows/templates/worktree-setup-hooks/generic-node-ci.sh .pi/zflow/worktree-setup-hook.sh
chmod +x .pi/zflow/worktree-setup-hook.sh

# 3. Edit the script to match your repo's exact setup (package manager, codegen commands, env file).
# 4. Commit the hook:
git add .pi/zflow/worktree-setup-hook.sh
git commit -m "add worktree setup hook"

# 5. Configure the hook in your pi-zflow config (pi-zflow.config.json or .pi/zflow/config.json):
#    {
#      "worktreeSetupHook": {
#        "script": ".pi/zflow/worktree-setup-hook.sh",
#        "runtime": "shell",
#        "timeoutMs": 60000,
#        "description": "Install dependencies"
#      }
#    }
```

## Writing a custom hook

If none of the generic templates fit your repo, write a custom hook:

1. Create an executable script (shell, Node.js, or TypeScript module).
2. The script receives one positional argument: the worktree root path.
3. Exit code 0 = success, non-zero = failure.
4. Commit the script to your repo.
5. Reference it in your pi-zflow config.

See [`docs/worktree-setup-hook-policy.md`](../../../../docs/worktree-setup-hook-policy.md) for the full contract.
