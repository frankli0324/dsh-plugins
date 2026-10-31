# dsh-harness-codex

DSH LLM adapter that drives codex via the app-server control socket
(WebSocket-over-UDS, one JSON message per frame). Spawned as
`<command> app-server --listen unix://<socket>` with `-c` parameters that
define a custom provider pointing at dsh's gateway relay. No wrapper
contract — a plain `codex` binary works.

## Protocol reference

The adapter implements the codex app-server protocol of codex
`rust-v0.162.1`. A vendored snapshot of the protocol types used to live in
`vendor/codex-app-server-protocol/`; it is no longer shipped. For the
authoritative shapes, see the upstream source:

<https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs/app-server-protocol>

[dsh-event-lifecycle.md](./dsh-event-lifecycle.md) documents how codex
notifications map onto dsh events.
