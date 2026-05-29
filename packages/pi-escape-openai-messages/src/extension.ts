import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function activateEscapeOpenAIMessagesExtension(pi: ExtensionAPI) {
  pi.on?.("before_agent_start", async (event: any) => {
    // Patch system and user prompt fields if present
    if (
      event?.provider?.api === "openai-completions" &&
      event?.provider?.compat?.escapeNewlinesInMessages !== false &&
      event?.options?.messages && Array.isArray(event.options.messages)
    ) {
      for (const msg of event.options.messages) {
        if (typeof msg.content === "string") {
          msg.content = msg.content.replace(/\n/g, "\\n")
        }
      }
    }
    // (No return needed; mutation is in-place)
  })
}
