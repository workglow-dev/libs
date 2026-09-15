# @workglow/a2ui

[A2UI](https://a2ui.org) (Agent-to-UI) protocol support for Workglow: the wire
types, the checks that make an agent-authored surface safe to draw, and a task
that draws one.

A2UI lets an agent send a *declarative description* of an interface — a flat
list of components addressed by id, plus a JSON data model they read through —
which the host renders with its own widgets. Nothing the agent sends executes.

## What is here

| Subpath | What it holds |
| --- | --- |
| `./protocol` | The v0.9 wire types, batch validation, JSON-pointer data model patching, and the fold from a message stream to surface state |
| `./catalog` | The component allowlist, the check that enforces it, and the prompt text that teaches an agent to write against it |
| `./tasks` | `A2UISurfaceTask`, and the `IA2UIConnector` seam a host implements |

There is no renderer here, on purpose: a renderer is a framework choice, and
every one of them needs the same three things above.

## Drawing a surface

```typescript
import { A2UI_CONNECTOR } from "@workglow/a2ui/tasks";
import { A2UISurfaceTask } from "@workglow/a2ui/tasks";

registry.registerInstance(A2UI_CONNECTOR, myRenderer);

const result = await new A2UISurfaceTask().run({
  messages: [
    { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: A2UI_BASIC_CATALOG_ID } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: [
          { id: "root", component: "Column", children: ["hello"] },
          { id: "hello", component: "Text", text: "Hello" },
        ],
      },
    },
  ],
});
// result.status, result.eventName, result.context
```

## Offering it to an agent

```typescript
import {
  A2UI_BASIC_CATALOG,
  A2UI_RENDER_TOOL_NAME,
  a2uiRenderToolInputSchema,
  describeA2UICatalog,
} from "@workglow/a2ui/catalog";

systemPrompt += `\n\n${describeA2UICatalog(A2UI_BASIC_CATALOG)}`;
tools.push({
  name: A2UI_RENDER_TOOL_NAME,
  description: A2UI_RENDER_TOOL_DESCRIPTION,
  inputSchema: a2uiRenderToolInputSchema(A2UI_BASIC_CATALOG),
});
```

The prompt text is generated from the same table the validator enforces, so an
agent is never told about a property that would be refused.

## Two properties worth knowing

**The catalog is the allowlist, and something has to enforce it.** A2UI is safe
because an agent may only name components the host already implements — which is
only true where a host refuses the ones it does not. `batchCatalogIssues` is that
refusal: unknown components, unknown properties, values outside a closed set,
child ids nothing defines, and URL schemes a renderer must not fetch. A renderer
that silently skips an unknown component makes an over-reaching agent look like a
quiet one.

**A batch is checked after folding, never per message.** The protocol's own
incremental idiom defines a container before the children it names and patches a
data model at a path nothing has written yet, so a per-message check reports
every well-formed batch as broken.
