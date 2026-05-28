/**
 * review-manifest.ts — reviewer tier selection and swarm manifest helpers.
 */

import type { ReviewerManifest } from "pi-zflow-review"
import {
  createManifest,
  recordSkipped as recordSkippedFn,
} from "pi-zflow-review"

import type { ReviewSwarmConfig } from "./launch-plan.js"

// ── Reviewer-manifest helpers ───────────────────────────────────

/**
 * Create a reviewer manifest for a review swarm.
 *
 * Automatically determines which reviewers should be skipped based
 * on the tier and the available reviewer set.
 *
 * @param config - Review swarm configuration.
 * @returns A new `ReviewerManifest` with reviewers in requested state.
 */
export function createSwarmManifest(
  config: ReviewSwarmConfig,
): ReviewerManifest {
  const { mode, tier, requestedReviewers, skips } = config

  // Build the initial manifest
  const manifest = createManifest(mode, tier, requestedReviewers)

  // Apply any skips
  if (skips) {
    let current = manifest
    for (const skip of skips) {
      current = recordSkippedFn(current, skip.name, skip.reason)
    }
    return current
  }

  return manifest
}

/**
 * Determine which reviewers to include for a given tier.
 *
 * This implements the tier→reviewer mapping from the plan:
 *
 * | Tier              | Reviewers                                            |
 * | ----------------- | ---------------------------------------------------- |
 * | `standard`        | correctness, integration, security                   |
 * | `logic`           | correctness, integration, security, logic             |
 * | `system`          | correctness, integration, security, system            |
 * | `logic,system`    | correctness, integration, security, logic, system    |
 *
 * @param tier - The tier classification from the plan's reviewTags.
 * @returns Array of agent runtime names for this tier.
 */
export function getReviewersForTier(tier: string): string[] {
  const base = [
    "zflow.review-correctness",
    "zflow.review-integration",
    "zflow.review-security",
  ]

  if (tier === "standard" || !tier) {
    return [...base]
  }

  const tags = tier.split(",").map((t) => t.trim())
  if (tags.includes("logic")) {
    base.push("zflow.review-logic")
  }
  if (tags.includes("system")) {
    base.push("zflow.review-system")
  }

  return base
}

/**
 * Get plan-review reviewers for a given tier.
 *
 * | Tier              | Reviewers                                            |
 * | ----------------- | ---------------------------------------------------- |
 * | `standard`        | correctness, integration                             |
 * | `logic`           | correctness, integration                             |
 * | `system`          | correctness, integration, feasibility                |
 * | `logic,system`    | correctness, integration, feasibility                |
 *
 * @param tier - The tier classification from the plan's reviewTags.
 * @returns Array of plan-review agent runtime names for this tier.
 */
export function getPlanReviewersForTier(tier: string): string[] {
  const base = [
    "zflow.plan-review-correctness",
    "zflow.plan-review-integration",
  ]

  if (tier === "system" || tier === "logic,system") {
    base.push("zflow.plan-review-feasibility")
  }

  return base
}
