import { defineExtension } from "pi"

export default defineExtension({
  name: "escape-openai-messages",
  hooks: {
    async beforeLLMRequest(req, ctx) {
      // Only for OpenAI-compatible APIs
      if (
        ctx.provider?.api === "openai-completions" &&
        // Allow override/opt-out via compat if set
        ctx.provider?.compat?.escapeNewlinesInMessages !== false
      ) {
        if (Array.isArray(req.body?.messages)) {
          for (const msg of req.body.messages) {
            if (typeof msg.content === "string") {
              msg.content = msg.content.replace(/\n/g, "\\n")
            }
          }
        }
      }
      return req
    }
  }
})
