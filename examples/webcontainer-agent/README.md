# WebContainer agent

A demo page for [`@workglow/webcontainer`](../../packages/webcontainer): a coding agent that writes
a small web project and runs it **inside the browser tab**, in a WebContainer. The model's tools
address the container only, never a real machine.

```sh
bun run dev        # http://localhost:3810
```

Pick a provider, paste an API key, say what to build. The agent writes files, runs `npm`/`node`,
starts a server, and the preview URL appears in the iframe. A follow-up message edits the same
project, restarting the server when its own code changed.

The safety model, the tool set, embedding instructions and the browser requirements (cross-origin
isolation, one container per page) are documented in the package README. `vite.config.ts` here sets
the two isolation headers for dev and preview.

| File | Role |
| --- | --- |
| `src/app/main.ts` | The page: boots the container, creates the tools once, runs a turn per message, draws the file tree and preview. |
| `src/app/models.ts` | Provider picker (Anthropic, OpenAI, Google) and the model config; the key stays in page memory. |
