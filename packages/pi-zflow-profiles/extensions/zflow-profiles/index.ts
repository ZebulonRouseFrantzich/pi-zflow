/**
 * pi-zflow-profiles extension entrypoint
 *
 * Registers `/zflow-profile` commands and profile/lane resolution services.
 *
 * TODO(phase-2): Implement profile management.
 *   - claim("profiles", ...) via getZflowRegistry()
 *   - provide("profiles", profileService) with:
 *     - profile loading from `.pi/zflow-profiles.json` and `~/.pi/agent/zflow-profiles.json`
 *     - lane resolution to provider/model bindings
 *     - active profile cache at `<user-state-dir>/active-profile.json`
 *     - lane health checks
 *   - Guard against duplicate loads: check registry.has("profiles") before claiming
 *   - Register `/zflow-profile ...` commands
 *   - See profiles.ts, model-resolution.ts, health.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function activateZflowProfilesExtension(pi: ExtensionAPI): void {
  // Registration logic will be added in Phase 2
}
