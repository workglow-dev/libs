/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import type { McpServerConfig } from "@workglow/mcp/util";
import {
  getMcpServerConfig,
  getMcpServerTransport,
  getMcpTaskDeps,
  TypeMcpServer,
} from "@workglow/mcp/util";
import type {
  CachePolicy,
  IExecuteContext,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import {
  CreateWorkflow,
  Entitlements,
  mergeEntitlements,
  Task,
  TaskConfigSchema,
  Workflow,
} from "@workglow/task-graph";
import type { ServiceRegistry } from "@workglow/util";
import type { DataPortSchema, DataPortSchemaObject } from "@workglow/util/schema";
import type { McpListTaskInput } from "./McpListTask";
import { mcpList } from "./McpListTask";

const annotationsSchema = {
  type: "object",
  properties: {
    audience: {
      type: "array",
      items: { type: "string", enum: ["user", "assistant"] },
    },
    priority: { type: "number" },
    lastModified: { type: "string" },
  },
  additionalProperties: false,
} as const;

const toolContentSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        type: { type: "string", const: "text" },
        text: { type: "string" },
        annotations: annotationsSchema,
        _meta: { type: "object", additionalProperties: true },
      },
      required: ["type", "text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { type: "string", const: "image" },
        data: { type: "string" },
        mimeType: { type: "string" },
        annotations: annotationsSchema,
        _meta: { type: "object", additionalProperties: true },
      },
      required: ["type", "data", "mimeType"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { type: "string", const: "audio" },
        data: { type: "string" },
        mimeType: { type: "string" },
        annotations: annotationsSchema,
        _meta: { type: "object", additionalProperties: true },
      },
      required: ["type", "data", "mimeType"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { type: "string", const: "resource" },
        resource: {
          type: "object",
          properties: {
            uri: { type: "string" },
            text: { type: "string" },
            blob: { type: "string" },
            mimeType: { type: "string" },
            _meta: { type: "object", additionalProperties: true },
          },
          required: ["uri"],
          additionalProperties: false,
        },
        annotations: annotationsSchema,
        _meta: { type: "object", additionalProperties: true },
      },
      required: ["type", "resource"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { type: "string", const: "resource_link" },
        uri: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        mimeType: { type: "string" },
        annotations: annotationsSchema,
        icons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              src: { type: "string" },
              mimeType: { type: "string" },
              sizes: { type: "array", items: { type: "string" } },
              theme: { type: "string", enum: ["light", "dark"] },
            },
            additionalProperties: false,
          },
        },
        title: { type: "string" },
        _meta: { type: "object", additionalProperties: true },
      },
      required: ["type", "uri", "name"],
      additionalProperties: false,
    },
  ],
} as const;

const anyStructuredSchema = {
  type: "object",
  additionalProperties: true,
  title: "Structured",
  description:
    "The tool's structured result (its structuredContent, or a JSON object it returned as text)",
} as const;

const fallbackOutputSchema = {
  type: "object",
  properties: {
    content: {
      type: "array",
      items: toolContentSchema,
      title: "Content",
      description: "The content returned by the tool",
    },
    isError: {
      type: "boolean",
      title: "Is Error",
      description: "Whether the tool call resulted in an error",
    },
    structured: anyStructuredSchema,
  },
  required: ["content", "isError"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const ENVELOPE_PORTS: ReadonlySet<string> = new Set(["content", "isError", "structured"]);

/**
 * Whether a schema is already the port envelope (written by this function, or the
 * content/isError schema saved before `structured` existed) rather than a tool's own
 * output schema. A tool schema would have to declare an array `content` and a boolean
 * `isError` and nothing else to be mistaken for one.
 */
function isOutputEnvelope(schema: DataPortSchema): boolean {
  if (typeof schema !== "object" || !schema.properties) return false;
  const properties = schema.properties as Record<string, { type?: unknown } | undefined>;
  return (
    properties.content?.type === "array" &&
    properties.isError?.type === "boolean" &&
    Object.keys(properties).every((key) => ENVELOPE_PORTS.has(key))
  );
}

/**
 * The output ports for a tool: the protocol's `content` and `isError`, and the tool's
 * own fields under `structured`. Kept apart so a tool field can never collide with —
 * or be mistaken for — the protocol's, and so a tool that adds a field does not move
 * the ports a graph is wired to.
 *
 * Idempotent: given the envelope it returns it (completing one saved without
 * `structured`), so `config.outputSchema` can hold the ports a builder draws while a
 * raw tool schema stored there by an older build is still nested.
 */
export function mcpToolOutputPortSchema(schema: DataPortSchema | undefined): DataPortSchema {
  if (!schema) return fallbackOutputSchema;
  if (isOutputEnvelope(schema)) {
    const properties = (schema as { properties: Record<string, unknown> }).properties;
    return "structured" in properties
      ? schema
      : ({
          ...(schema as Record<string, unknown>),
          properties: { ...properties, structured: anyStructuredSchema },
        } as unknown as DataPortSchema);
  }
  return {
    ...fallbackOutputSchema,
    properties: { ...fallbackOutputSchema.properties, structured: schema },
  } as DataPortSchema;
}

const fallbackInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: true,
} as const satisfies DataPortSchema;

/** Config includes MCP connection fields (transport-dependent shape is registered per platform). */
export type McpToolCallTaskConfig = TaskConfig & {
  inputSchema?: DataPortSchema;
  outputSchema?: DataPortSchema;
} & Record<string, unknown>;
export type McpToolCallTaskInput = Record<string, unknown>;
export type McpToolCallTaskOutput = Record<string, unknown>;

export class McpToolCallTask extends Task<
  McpToolCallTaskInput,
  McpToolCallTaskOutput,
  McpToolCallTaskConfig
> {
  public static override type = "McpToolCallTask";
  public static override category = "MCP";
  public static override title = "MCP Call Tool";
  public static override description = "Calls a tool on an MCP server and returns the result";
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override customizable = true;
  public static override hasDynamicSchemas = true;
  public static override hasDynamicEntitlements: boolean = true;

  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [{ id: Entitlements.MCP_TOOL_CALL, reason: "Calls tools on MCP servers" }],
    };
  }

  public override entitlements(): TaskEntitlements {
    const base = McpToolCallTask.entitlements();
    const transport = getMcpServerTransport(this);
    if (transport === "stdio") {
      return mergeEntitlements(base, {
        entitlements: [
          { id: Entitlements.MCP_STDIO, reason: "Uses stdio transport to spawn local process" },
        ],
      });
    }
    return mergeEntitlements(base, {
      entitlements: [
        { id: Entitlements.NETWORK_HTTP, reason: "Connects to MCP server over HTTP" },
        { id: Entitlements.CREDENTIAL, reason: "May require authentication", optional: true },
      ],
    });
  }

  public static override inputSchema() {
    return fallbackInputSchema;
  }

  public static override outputSchema() {
    return fallbackOutputSchema;
  }

  public static override configSchema(): DataPortSchema {
    const { mcpServerConfigSchema } = getMcpTaskDeps();
    return {
      type: "object",
      properties: {
        ...TaskConfigSchema["properties"],
        server: TypeMcpServer(mcpServerConfigSchema),
        tool_name: {
          type: "string",
          title: "Tool Name",
          description: "The name of the tool to call",
          format: "string:mcp-toolname",
        },
      },
      required: ["server", "tool_name"],
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public override inputSchema(): DataPortSchema {
    return this.config?.inputSchema ?? fallbackInputSchema;
  }

  /**
   * `config.outputSchema` holds the ports (what discovery and a builder write); a raw
   * tool schema found there is nested under `structured`.
   */
  public override outputSchema(): DataPortSchema {
    return mcpToolOutputPortSchema(this.config?.outputSchema);
  }

  private _schemasDiscoveringPromise: Promise<void> | undefined;

  /**
   * Set once a listing has answered for this tool. Most tools declare no output
   * schema, so "both schemas known" never becomes true for them — and without
   * this every call listed the server's tools again: a second connection per
   * call, which for a stdio server is a second process spawned.
   */
  private _schemasDiscovered = false;

  async discoverSchemas(
    _signal?: AbortSignal,
    serverConfig?: McpServerConfig,
    registry?: ServiceRegistry
  ): Promise<void> {
    if (this._schemasDiscovered) return;
    if (this.config.inputSchema && this.config.outputSchema) return;
    if (this._schemasDiscoveringPromise) return this._schemasDiscoveringPromise;
    const resolved = serverConfig ?? getMcpServerConfig(this.config as Record<string, unknown>);
    if (!resolved.transport || !this.config.tool_name) return;

    this._schemasDiscoveringPromise = (async () => {
      try {
        const result = await mcpList(
          {
            server: resolved,
            list_type: "tools",
          } as McpListTaskInput,
          {},
          registry ? { registry } : {}
        );

        this._schemasDiscovered = true;
        const tool = result.tools?.find((t) => t.name === this.config.tool_name);
        if (tool) {
          if (!this.config.inputSchema) {
            this.config.inputSchema = tool.inputSchema as DataPortSchemaObject;
          }
          if (!this.config.outputSchema && tool.outputSchema) {
            this.config.outputSchema = mcpToolOutputPortSchema(
              tool.outputSchema as DataPortSchemaObject
            );
          }
          this.emitSchemaChange();
        }
      } finally {
        this._schemasDiscoveringPromise = undefined;
      }
    })();
    return this._schemasDiscoveringPromise;
  }

  override async execute(
    input: McpToolCallTaskInput,
    context: IExecuteContext
  ): Promise<McpToolCallTaskOutput> {
    const serverConfig = getMcpServerConfig(this.config as Record<string, unknown>);

    await this.discoverSchemas(context.signal, serverConfig, context.registry);

    const { mcpClientFactory } = getMcpTaskDeps();
    const { client } = await mcpClientFactory.create(
      serverConfig,
      context.signal,
      context.registry
    );
    try {
      const result = await client.callTool({
        name: asText(this.config.tool_name),
        arguments: input as Record<string, unknown>,
      });
      if (!("content" in result) || !Array.isArray(result.content)) {
        throw new Error("Expected tool result with content array");
      }
      const content = result.content;
      const isError = result.isError === true;

      // Prefer structuredContent when present (MCP spec: parsed output matching tool's output schema)
      const structuredContent =
        "structuredContent" in result &&
        result.structuredContent &&
        typeof result.structuredContent === "object" &&
        !Array.isArray(result.structuredContent)
          ? (result.structuredContent as Record<string, unknown>)
          : undefined;

      // When no structuredContent, try parsing single text item as JSON (many servers return JSON in text)
      let parsedFromText: Record<string, unknown> | undefined;
      if (!structuredContent && content.length === 1) {
        const item = content[0];
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "text" &&
          "text" in item
        ) {
          const text = String(item.text);
          const trimmed = text.trim();
          if (
            (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
            (trimmed.startsWith("[") && trimmed.endsWith("]"))
          ) {
            try {
              const parsed = JSON.parse(text) as unknown;
              if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                parsedFromText = parsed as Record<string, unknown>;
              }
            } catch {
              // Not valid JSON, ignore
            }
          }
        }
      }

      const structured = structuredContent ?? parsedFromText;
      return structured === undefined ? { content, isError } : { content, isError, structured };
    } finally {
      await client.close();
    }
  }
}

export const mcpToolCall = async (
  input: McpToolCallTaskInput,
  config: McpToolCallTaskConfig
): Promise<McpToolCallTaskOutput> => {
  return new McpToolCallTask(config).run(input);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    mcpToolCall: CreateWorkflow<McpToolCallTaskInput, McpToolCallTaskOutput, McpToolCallTaskConfig>;
  }
}

Workflow.prototype.mcpToolCall = CreateWorkflow(McpToolCallTask);
