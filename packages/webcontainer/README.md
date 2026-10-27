# @workglow/webcontainer

Tools and an `AgentTask` runner that let a coding agent write and run a small web project **inside
the browser tab**, in a [WebContainer](https://webcontainers.io) (Node.js compiled to run in the
page). The model never gets a shell on a real machine: its tools address the container only.

```sh
bun add @workglow/webcontainer @webcontainer/api
```

A runnable page lives in [`examples/webcontainer-agent`](../../examples/webcontainer-agent).

## Entry points

| Import | What it holds |
| --- | --- |
| `@workglow/webcontainer/sandbox` | `SandboxPort` and `resolveSandboxPath`; `createSandboxTools` and `listSandboxFiles`; `runSandboxAgent`; `SANDBOX_SYSTEM_PROMPT`. Nothing here imports the WebContainer API, so it runs over any `SandboxPort`. |
| `@workglow/webcontainer/container` | `bootWebContainer()` and `webContainerPort()`, the adapter from `@webcontainer/api` to `SandboxPort`. The only module that loads it. |

## Embedding

```ts
const { port } = await bootWebContainer();               // or your own SandboxPort
await registerAnthropicInline();                          // providers are the host's to register
const sandboxTools = createSandboxTools(port, { onPreview: (url) => (iframe.src = url) });
const run = await runSandboxAgent({
  sandboxTools,                                           // kept across turns so previews stay live
  instruction: "a markdown previewer",
  model: { provider: "ANTHROPIC", provider_config: { model_name, api_key } },
  sandbox: port,
});
// ...later
sandboxTools.dispose(); // when the sandbox is abandoned: stops servers the project left running
```

Create the tools once per sandbox and pass them to every turn: servers outlive a turn so the
preview stays live across follow-ups, and a run given them never stops them, even when it fails or
is stopped. The tools are `write_file`, `read_file`, `list_files`, `run_command` and `stop_servers`.

`runSandboxAgent` takes a `tools` option to pass `SandboxToolOptions` (the command allow-list,
file and output limits, timeouts), and `systemPrompt`, `maxRounds` and `maxDurationMs` for the turn.
To use the tools in an `AgentTask` you build yourself, pass `sandboxTools.tools` as its `tools`.

## Why it is safe to run model-written code

| Layer | What it gives |
| --- | --- |
| WebContainer | The code runs in the tab's sandbox: no host filesystem, no host processes, no native binaries. Its network is the browser's, so it is subject to the browser's rules, not the machine's. |
| Tools are host functions over `SandboxPort` | The model can only call the five tools. Paths are resolved inside the project root (`..` that leaves it is refused). |
| `run_command` has no shell | Program and arguments are separate, and the program must be on an allow-list (`DEFAULT_ALLOWED_COMMANDS`), so `a && b`, pipes and redirects do not exist. |
| Bounds | File size, output size (the tail is kept), a foreground timeout that kills the process, a cap on background servers, bounded listings, and `maxRounds` / `maxDurationMs` on the turn. |
| Key handling | The API key stays in the host page's memory and goes only to the provider's SDK call. Sandbox code runs in a separate origin and cannot read it. |

That containment is why the run uses `approval: "never"`: there is nothing outside the sandbox for
a person to approve. A host that gives the agent a tool reaching past the sandbox should not reuse
that setting for it.

What it does **not** protect against: the sandbox can still make outbound requests the browser
allows, and a model can spend your tokens. Use a key with a spend limit.

## Requirements

- The page must be **cross-origin isolated** (`Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Opener-Policy: same-origin`), because a WebContainer needs `SharedArrayBuffer`.
  Whatever serves the host app must set both. Preview iframes need `allow="cross-origin-isolated"`.
- A Chromium-based browser or Firefox; Safari support is newer and less complete.
- One WebContainer per page.
- Cloud providers called from a browser need a CORS-enabled endpoint. Anthropic and OpenAI accept
  browser calls with their SDKs' browser flag, which the provider packages set.

## Concurrency

The container announces a listening port without saying which process owns it, so background
`run_command` calls start one at a time, and `stop_servers` also cancels starts still in flight. The
tools are safe under `AgentTask`'s `toolConcurrency`.
