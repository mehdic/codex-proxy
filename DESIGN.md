# Design notes

## Philosophy

`codex-proxy` is the Codex sibling of `claude-proxy`: use the official local CLI/app-server as the authority for authentication and model access, then expose a familiar local HTTP API to tools.

The proxy must not become a second OAuth application. It should not store ChatGPT/Codex tokens, scrape token files, or emulate private browser sessions.

## Why app-server

Codex app-server is the official interface used by rich Codex clients. It gives us:

- official Codex authentication path
- official model routing and entitlement handling
- streaming agent events
- threads/turns/items instead of a raw token endpoint

The cost is translation complexity: OpenAI chat completions are stateless and message-array oriented, while Codex is stateful and agent-oriented.

## Safety defaults

- localhost-only bind
- one ephemeral thread per request
- no auth persistence in this project
- conservative approvals/sandbox parameters where supported
- text-only MVP

## API compatibility target

The first compatibility target is enough for OpenAI-compatible clients that expect:

- `/v1/models`
- `/v1/chat/completions`
- SSE streaming chunks
- simple non-streaming text response

The Responses API endpoint exists as a minimal text bridge, not a full OpenAI Responses implementation yet.

## Non-goals for MVP

- account pooling
- multi-user auth
- remote hosting
- token/session import
- private Codex backend emulation
- tool call translation
- image input/output
- persistent Codex threads
