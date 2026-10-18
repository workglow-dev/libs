# WebContainer agent

A coding agent that writes a small web project and runs it **inside the browser tab**, in a
[WebContainer](https://webcontainers.io) (Node.js compiled to run in the page). The model never
gets a shell on a real machine: its four tools address the container only.

```sh
bun run dev        # http://localhost:3810
```

Pick a provider, paste an API key, say what to build. The agent writes files, runs `npm`/`node`,
starts a server, and the preview URL appears in the iframe. A follow-up message edits the same
project.

## Why it is safe to run model-written code

| Layer                                       | What it gives                                                                                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebContainer                                | The code runs in the tab's sandbox: no host filesystem, no host processes, no native binaries. Its network is the browser's, so it is subject to the browser's rules, not the machine's. |
| Tools are host functions over `SandboxPort` | The model can only `write_file`, `read_file`, `list_files` and `run_command`. Paths are resolved inside the project root (`..` that leaves it is refused).                               |
| `run_command` has no shell                  | Program and arguments are separate, and the program must be on an allow-list (`DEFAULT_ALLOWED_COMMANDS`), so `a && b`, pipes and redirects do not exist.                                |
| Bounds                                      | File size, output size (the tail is kept), a foreground timeout that kills the process, a cap on background servers, and `maxRounds` / `maxDurationMs` on the turn.                      |
| Key handling                                | The API key lives in the page's memory and goes only to the provider's SDK call. Sandbox code runs in a separate origin and cannot read it.                                              |

That containment is why the run uses `approval: "never"` — there is nothing outside the sandbox for
a person to approve. A host that gives the agent a tool reaching past the sandbox should not reuse
that setting for it.

What it does **not** protect against: the sandbox can still make outbound requests the browser
allows, and a model can spend your tokens. Use a key with a spend limit.

## Layout

Everything under `src/core` is framework-free, so builder (or embarc) can import it without the demo UI.

| File                       | Role                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `core/sandboxPort.ts`      | `SandboxPort`: the slice of a sandbox the tools use, plus `resolveSandboxPath`.                                |
| `core/sandboxTools.ts`     | `createSandboxTools(port, options)` → `ToolDefinition[]` + `dispose()`.                                        |
| `core/runSandboxAgent.ts`  | One `AgentTask` turn over those tools; reports tool calls, previews and message snapshots.                     |
| `core/sandboxPrompt.ts`    | The system prompt that describes what a WebContainer is and is not.                                            |
| `core/webContainerPort.ts` | `bootWebContainer()` and the adapter from `@webcontainer/api` to `SandboxPort`. The only file that imports it. |
| `app/`                     | The demo page: provider picker, log, file tree, preview iframe.                                                |

Embedding it:

```ts
const { port } = await bootWebContainer(); // or your own SandboxPort
await registerAnthropicInline(); // providers are the host's to register
const run = await runSandboxAgent({
  instruction: "a markdown previewer",
  model: { provider: "ANTHROPIC", provider_config: { model_name, api_key } },
  sandbox: port,
  onEvent: (e) => e.type === "preview" && (iframe.src = e.url),
});
// ...later
run.dispose(); // stops servers the project left running
```

## Requirements

- The page must be **cross-origin isolated** (`Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Opener-Policy: same-origin`), because a WebContainer needs `SharedArrayBuffer`.
  `vite.config.ts` sets both for dev and preview; whatever serves a built app, or the host app
  that embeds this, must set them too. Preview iframes need `allow="cross-origin-isolated"`.
- A Chromium-based browser or Firefox; Safari support is newer and less complete.
- One WebContainer per page.
- Cloud providers called from a browser need a CORS-enabled endpoint. Anthropic and OpenAI accept
  browser calls with their SDKs' browser flag, which the provider packages set.

## Tests

`bun run test` covers the tools against an in-memory `SandboxPort` (path escape, allow-list,
timeout kill, background server lifecycle). The real container is exercised by running the page.
