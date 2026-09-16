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
| `./protocol` | The v0.9 wire types, batch validation, JSON-pointer data model patching, the fold from a message stream to surface state, and the binding layer a renderer resolves values through |
| `./catalog` | The component allowlist, the check that enforces it, the client-side functions it declares, and the prompt text that teaches an agent to write against it |
| `./tasks` | `A2UISurfaceTask`, and the `IA2UIConnector` seam a host implements |

There is no renderer here, on purpose: a renderer is a framework choice, and
every one of them needs the same things above. What is here is everything a
renderer needs that is **not** a framework choice — including the part that is
easy to get subtly wrong:

```typescript
import { expandChildren, resolveValue } from "@workglow/a2ui/protocol";

// A template drawn once per item, each copy reading its own item.
const slots = expandChildren(component.children, { dataModel, basePath: "" });
for (const slot of slots) {
  const props = resolveProps(byId(slot.componentId), { dataModel, basePath: slot.basePath });
}
```

`basePath` is what makes a repeated row read the Nth item rather than the
first. A renderer that resolves every path against the root renders a list
where every row shows the same data — which looks like a rendering bug and is
a resolution one.

## Drawing a surface

```typescript
import { A2UI_BASIC_CATALOG_ID } from "@workglow/a2ui/catalog";
import { A2UI_CONNECTOR, A2UISurfaceTask } from "@workglow/a2ui/tasks";

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

**A function the catalog does not declare is refused too.** A call can sit at
any depth — a button's action context, one option's label, an argument of
another call — so the check walks rather than reading the top level. Unchecked,
such a call resolves to nothing and draws an empty label, which reads as
missing data rather than as a surface asking for something no host implements.

**A batch is checked after folding, never per message.** The protocol's own
incremental idiom defines a container before the children it names and patches a
data model at a path nothing has written yet, so a per-message check reports
every well-formed batch as broken.
