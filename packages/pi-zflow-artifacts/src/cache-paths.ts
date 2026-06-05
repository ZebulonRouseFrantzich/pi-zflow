/**
 * cache-paths.ts — Storage path helpers for cache telemetry artifacts.
 */

import * as path from "node:path"
import { resolveRuntimeStateDir, resolveUserStateDir } from "pi-zflow-core/runtime-paths"

export function resolveRuntimeCacheDir(cwd?: string): string {
  return path.join(resolveRuntimeStateDir(cwd), "cache")
}

export function resolveSessionCacheTracePath(cwd?: string): string {
  return path.join(resolveRuntimeCacheDir(cwd), "session-cache-trace.jsonl")
}

export function resolveCacheSummaryPath(cwd?: string): string {
  return path.join(resolveRuntimeCacheDir(cwd), "cache-summary.json")
}

export function resolveUserCacheDir(): string {
  return path.join(resolveUserStateDir(), "cache")
}

export function resolveUserCacheTracePath(): string {
  return path.join(resolveUserCacheDir(), "cache-trace.jsonl")
}
