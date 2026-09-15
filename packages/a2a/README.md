# @workglow/a2a

Agent2Agent (A2A) protocol tasks and plumbing for Workglow.

## Features

- Call a remote A2A agent as a graph node (`./tasks`)
- Serve one saved `AgentTask` configuration to A2A peers (`./server`)
- Describe a servable agent, derive its Agent Card, and bind A2A parts to named ports (`./util`)

The wire is owned by `@a2a-js/sdk`; this package is the adapter between it and
`AgentTask`.

## Installation

```bash
bun add @workglow/a2a
```

## Usage

Calling a remote agent:

```typescript
import { A2AAgentTask } from "@workglow/a2a/tasks";

const reply = await new A2AAgentTask({
  defaults: { agentUrl: "http://127.0.0.1:8789", prompt: "hello", contextId: undefined },
}).run();
// reply.text, reply.contextId (feed into the next run), reply.taskState
```

Serving one agent:

```typescript
import { startA2AHttpServer } from "@workglow/a2a/server";

const handle = await startA2AHttpServer({
  port: 8789,
  host: "127.0.0.1",
  token: "…", // or null to serve unauthenticated; refused on a wildcard bind
  descriptor: {
    id: "researcher",
    name: "Researcher",
    description: "Answers questions with citations.",
    version: "1.0.0",
    skills: [{ id: "answer", name: "Answer", description: "Answer a question.", tags: [], examples: [], inputSchema: undefined }],
    agentInput: { model: "…", systemPrompt: "…", tools: [] },
  },
});
console.log(handle.cardUrl);
```

One endpoint publishes one agent: an Agent Card describes a single agent, so
serving several means several endpoints. The card is served open at
`/.well-known/agent-card.json` and states the bearer scheme the endpoint
enforces; the JSON-RPC endpoint sits behind the same `Host` check, bearer token
and body cap as `@workglow/mcp`'s server.

Peers are opaque to each other: a caller sees messages, task status and
artifacts, never the callee's tools, model or transcript. `input-required`
is never published — a turn that would ask a person fails instead.

## Working against `@a2a-js/sdk`

The SDK is proto-derived, and a few things follow from that which a hand-written
literal gets wrong:

- `TaskState` and `Role` are numeric enums. Use `taskStateToJSON` where a state
  crosses a port; the wire is still strings, which the SDK's `toJSON` handles.
- A `Message` carries `parts`, and every proto field is required. Build events
  with the `AgentEvent` factories and fill them all in.
- A `TaskStatusUpdateEvent` has no `final` flag; a terminal `state` ends a task.
- The card is served through `AgentCard.toJSON`, not `JSON.stringify`: the
  in-memory card spells security schemes as `$case` unions, which the SDK's own
  client reads back as no scheme at all.
- The SDK reads an absent `A2A-Version` header as `0.3`, which the card does not
  publish, so such a request is refused with the protocol's own error.
- `InMemoryTaskStore` evicts nothing and `TaskStore` has no delete, so a
  long-running host grows without bound.

## License

Apache-2.0
