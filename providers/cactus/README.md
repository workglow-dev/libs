# @workglow/cactus

[needle-rs](https://github.com/Geekgineer/needle-rs) tool-calling provider for [@workglow/ai](https://www.npmjs.com/package/@workglow/ai).

Wraps the 537 KB needle-rs WASM runtime and Cactus Needle models. Runs in browser (Cache Storage) and Node/Bun (filesystem). Specialized tool-routing only — no free-form chat.

Catalog:

- **Needle 3** (`needle-v3`) — single 35.3 MB `.cact` image from [`Cactus-Compute/needle3`](https://huggingface.co/Cactus-Compute/needle3). Reasons in a `<think>` block before emitting the call; weights are Apache-2.0.
- **Needle 2** (`needle-v2`) — single 13.7 MB `.cact` image from [`Cactus-Compute/needle2`](https://huggingface.co/Cactus-Compute/needle2)
- **Needle 26M** (`needle-26m`) — INT4 SafeTensors (22 MB) from [`Abdalrahman/needle-rs-safetensors`](https://huggingface.co/Abdalrahman/needle-rs-safetensors)

Each generation has its own WASM class — `NeedleV3Wasm`, `NeedleV2Wasm`, `NeedleWasm` — and the loader picks it from the catalog entry's `generation`. v2 and v3 both ship a `.cact` file but the containers are not interchangeable: loading one with the other's class fails on the header tag rather than misreading it.

## Capabilities

- `tool-use` — function/tool calling via `engine.run_stream`, falling back to `engine.run`. The streaming callback differs by generation — v1 and v2 pass `(tokenId, piece)`, v3 passes the decoded delta alone — and both shapes are handled.
- `model.search`, `model.info` — catalog of Needle 3, Needle 2 and Needle 26M
- `model.download`, `model.download-remove` — fetch + cache catalog assets (one `.cact` for v2 and v3; weights, vocab, and config for v1)

## Entry points

- `@workglow/cactus/ai` — main-thread shell: `registerCactus`, schema, constants, provider classes
- `@workglow/cactus/ai-runtime` — worker server and inline runtime: `registerCactusWorker`, `registerCactusInline`, runtime helpers
