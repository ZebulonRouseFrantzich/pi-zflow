# pi-escape-openai-messages

A Pi extension that escapes literal newlines (`\n`) in all message content fields sent to OpenAI-compatible API providers.
This fixes compatibility with Llama.cpp, LM Studio, and other backend servers that only accept escaped newlines in JSON strings.

## How it works

If the target provider uses `openai-completions`, this extension automatically rewrites all `.messages[].content` fields so that raw newlines are escaped.

## Opt-out

Providers can disable this for themselves by setting `compat.escapeNewlinesInMessages: false` in their provider config.
