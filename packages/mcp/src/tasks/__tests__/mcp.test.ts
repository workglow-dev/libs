/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  McpListTask,
  McpPromptGetTask,
  McpResourceReadTask,
  McpToolCallTask,
  mcpToolOutputPortSchema,
} from "@workglow/mcp/tasks";
import { mcpClientFactory } from "@workglow/mcp/util";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

function fn() {
  const calls: unknown[][] = [];
  const mock = (...args: unknown[]) => {
    calls.push(args);
    return mock._result;
  };
  mock.calls = calls;
  mock._result = undefined as unknown;
  mock.mockResolvedValue = (val: unknown) => {
    mock._result = Promise.resolve(val);
    return mock;
  };
  mock.mockRejectedValue = (val: unknown) => {
    mock._result = Promise.reject(val);
    return mock;
  };
  return mock;
}

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    callTool: fn(),
    readResource: fn(),
    getPrompt: fn(),
    listTools: fn().mockResolvedValue({ tools: [] }),
    listResources: fn().mockResolvedValue({ resources: [] }),
    listPrompts: fn().mockResolvedValue({ prompts: [] }),
    close: fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const originalCreate = mcpClientFactory.create;

const baseServer = { transport: "stdio" as const, command: "test-server" };

function mockFactory(mockClient: ReturnType<typeof createMockClient>) {
  mcpClientFactory.create = (() =>
    Promise.resolve({
      client: mockClient,
      transport: {},
    })) as unknown as typeof mcpClientFactory.create;
}

beforeEach(() => {
  mcpClientFactory.create = originalCreate;
});

afterEach(() => {
  mcpClientFactory.create = originalCreate;
});

describe("MCP", () => {
  let logger = getTestingLogger();
  setLogger(logger);

  describe("McpToolCallTask", () => {
    const toolCallConfig = { server: baseServer, tool_name: "greet" };

    test("calls a tool and returns content", async () => {
      const mockClient = createMockClient({
        callTool: fn().mockResolvedValue({
          content: [{ type: "text", text: "hello" }],
          isError: false,
        }),
      });
      mockFactory(mockClient);

      const task = new McpToolCallTask(toolCallConfig);
      const result = await task.run({ name: "world" });

      expect(result.content).toEqual([{ type: "text", text: "hello" }]);
      expect(result.isError).toBe(false);
      expect(mockClient.callTool.calls[0]).toEqual([
        { name: "greet", arguments: { name: "world" } },
      ]);
      // discoverSchemas (mcpList) + execute each create a client; both get closed
      expect(mockClient.close.calls.length).toBeGreaterThanOrEqual(1);
    });

    test("returns isError when tool reports error", async () => {
      const mockClient = createMockClient({
        callTool: fn().mockResolvedValue({
          content: [{ type: "text", text: "something went wrong" }],
          isError: true,
        }),
      });
      mockFactory(mockClient);

      const task = new McpToolCallTask({ server: baseServer, tool_name: "fail" });
      const result = await task.run({});

      expect(result.isError).toBe(true);
    });

    test("a tool's structured result cannot clear the protocol's isError", async () => {
      const mockClient = createMockClient({
        callTool: fn().mockResolvedValue({
          content: [{ type: "text", text: "permission denied" }],
          isError: true,
          // A tool whose own output happens to carry a field of the same name.
          structuredContent: { isError: false },
        }),
      });
      mockFactory(mockClient);

      const task = new McpToolCallTask({ server: baseServer, tool_name: "fail" });
      const result = await task.run({});

      expect(result.isError).toBe(true);
    });

    test("discovers a tool's schemas once, not on every call", async () => {
      let connections = 0;
      const mockClient = createMockClient({
        callTool: fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
        // Most tools declare no output schema.
        listTools: fn().mockResolvedValue({
          tools: [{ name: "greet", inputSchema: { type: "object", properties: {} } }],
        }),
      });
      mcpClientFactory.create = (() => {
        connections++;
        return Promise.resolve({ client: mockClient, transport: {} });
      }) as unknown as typeof mcpClientFactory.create;

      const task = new McpToolCallTask(toolCallConfig);
      await task.run({});
      const afterFirstCall = connections;
      await task.run({});
      await task.run({});

      expect(connections - afterFirstCall).toBe(2);
    });

    test("closes client even on error", async () => {
      const mockClient = createMockClient({
        callTool: fn().mockRejectedValue(new Error("connection lost")),
      });
      mockFactory(mockClient);

      const task = new McpToolCallTask({ server: baseServer, tool_name: "broken" });
      await expect(task.run({})).rejects.toThrow("connection lost");
      // discoverSchemas (mcpList) + execute each create a client; both get closed
      expect(mockClient.close.calls.length).toBeGreaterThanOrEqual(1);
    });

    test("utilizes structuredContent when present", async () => {
      const mockClient = createMockClient({
        callTool: fn().mockResolvedValue({
          content: [{ type: "text", text: '{"temperature": 22.5, "conditions": "Partly cloudy"}' }],
          structuredContent: { temperature: 22.5, conditions: "Partly cloudy", humidity: 65 },
          isError: false,
        }),
      });
      mockFactory(mockClient);

      const task = new McpToolCallTask(toolCallConfig);
      const result = await task.run({});

      expect(result.content).toBeDefined();
      expect(result.isError).toBe(false);
      expect(result.structured).toEqual({
        temperature: 22.5,
        conditions: "Partly cloudy",
        humidity: 65,
      });
      expect(result.temperature).toBeUndefined();
    });

    test("a tool field named content or isError cannot shadow the protocol's", async () => {
      const mockClient = createMockClient({
        callTool: fn().mockResolvedValue({
          content: [{ type: "text", text: "ok" }],
          structuredContent: { content: "tool's own", isError: "no" },
          isError: false,
        }),
      });
      mockFactory(mockClient);

      const result = await new McpToolCallTask(toolCallConfig).run({});
      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(result.isError).toBe(false);
      expect(result.structured).toEqual({ content: "tool's own", isError: "no" });
    });

    test("nests the tool's declared output schema under structured", () => {
      const toolSchema = {
        type: "object",
        properties: { temperature: { type: "number" } },
      } as const;
      const task = new McpToolCallTask({ ...toolCallConfig, outputSchema: toolSchema });
      const schema = task.outputSchema() as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties).sort()).toEqual(["content", "isError", "structured"]);
      expect(schema.properties.structured).toEqual(toolSchema);
    });

    // config.outputSchema is the node's ports, which a builder reads directly; a schema
    // that is already the envelope is not wrapped a second time.
    test("an output schema already in the envelope shape is kept, not wrapped again", () => {
      const toolSchema = {
        type: "object",
        properties: { temperature: { type: "number" } },
      } as const;
      const envelope = mcpToolOutputPortSchema(toolSchema);
      const task = new McpToolCallTask({ ...toolCallConfig, outputSchema: envelope });
      expect(task.outputSchema()).toEqual(envelope);
      expect(mcpToolOutputPortSchema(envelope)).toEqual(envelope);
    });

    test("the old content/isError-only schema reads as the envelope", () => {
      const old = new McpToolCallTask(toolCallConfig).outputSchema() as {
        properties: Record<string, unknown>;
      };
      const { structured: _, ...withoutStructured } = old.properties;
      const legacy = { ...old, properties: withoutStructured };
      const schema = mcpToolOutputPortSchema(legacy as never) as {
        properties: Record<string, { type?: unknown }>;
      };
      expect(Object.keys(schema.properties).sort()).toEqual(["content", "isError", "structured"]);
      expect(schema.properties.structured).not.toEqual(legacy);
    });

    test("a tool schema that merely has a content field is still nested", () => {
      const toolSchema = {
        type: "object",
        properties: { content: { type: "string" }, isError: { type: "boolean" } },
      } as const;
      const schema = mcpToolOutputPortSchema(toolSchema) as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties.structured).toEqual(toolSchema);
    });

    test("discovery stores the tool's output schema as ports, under structured", async () => {
      const toolSchema = { type: "object", properties: { temperature: { type: "number" } } };
      const mockClient = createMockClient({
        listTools: fn().mockResolvedValue({
          tools: [
            {
              name: "greet",
              inputSchema: { type: "object", properties: {} },
              outputSchema: toolSchema,
            },
          ],
        }),
      });
      mockFactory(mockClient);
      const task = new McpToolCallTask(toolCallConfig);
      await task.discoverSchemas();
      expect(task.config.outputSchema).toEqual(mcpToolOutputPortSchema(toolSchema));
    });

    test("parses JSON from single text content when no structuredContent", async () => {
      const mockClient = createMockClient({
        callTool: fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: '{"results":[{"title":"Model Context Protocol","url":"https://example.com"}]}',
            },
          ],
          isError: false,
        }),
      });
      mockFactory(mockClient);

      const task = new McpToolCallTask(toolCallConfig);
      const result = await task.run({});

      expect(result.content).toBeDefined();
      expect(result.isError).toBe(false);
      expect((result.structured as { results: unknown }).results).toEqual([
        { title: "Model Context Protocol", url: "https://example.com" },
      ]);
    });

    test("has correct static properties", () => {
      expect(McpToolCallTask.type).toBe("McpToolCallTask");
      expect(McpToolCallTask.category).toBe("MCP");
      expect(McpToolCallTask.cachePolicy.kind).toBe("none");
    });
  });

  describe("McpResourceReadTask", () => {
    test("reads a resource and returns contents", async () => {
      const mockClient = createMockClient({
        readResource: fn().mockResolvedValue({
          contents: [{ uri: "file:///test.txt", text: "file contents" }],
        }),
      });
      mockFactory(mockClient);

      const task = new McpResourceReadTask({
        server: baseServer,
        resource_uri: "file:///test.txt",
      });
      const result = await task.run({});

      expect(result.contents).toEqual([{ uri: "file:///test.txt", text: "file contents" }]);
      expect(mockClient.readResource.calls[0]).toEqual([{ uri: "file:///test.txt" }]);
      expect(mockClient.close.calls.length).toBe(1);
    });

    test("has correct static properties", () => {
      expect(McpResourceReadTask.type).toBe("McpResourceReadTask");
      expect(McpResourceReadTask.category).toBe("MCP");
      expect(McpResourceReadTask.cachePolicy.kind).toBe("none");
    });
  });

  describe("McpPromptGetTask", () => {
    test("gets a prompt and returns messages", async () => {
      const mockClient = createMockClient({
        getPrompt: fn().mockResolvedValue({
          messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
          description: "A greeting prompt",
        }),
      });
      mockFactory(mockClient);

      const task = new McpPromptGetTask({
        server: baseServer,
        prompt_name: "greeting",
        inputSchema: {
          type: "object",
          properties: { lang: { type: "string" } },
          additionalProperties: false,
        },
      });
      const result = await task.run({ lang: "en" });

      expect(result.messages).toEqual([{ role: "user", content: { type: "text", text: "Hello" } }]);
      expect(result.description).toBe("A greeting prompt");
      expect(mockClient.getPrompt.calls[0]).toEqual([
        { name: "greeting", arguments: { lang: "en" } },
      ]);
      expect(mockClient.close.calls.length).toBe(1);
    });

    test("has correct static properties", () => {
      expect(McpPromptGetTask.type).toBe("McpPromptGetTask");
      expect(McpPromptGetTask.category).toBe("MCP");
      expect(McpPromptGetTask.cachePolicy.kind).toBe("none");
    });
  });

  describe("McpListTask", () => {
    test("lists tools", async () => {
      const tools = [{ name: "greet", description: "Greets", inputSchema: {} }];
      const mockClient = createMockClient({
        listTools: fn().mockResolvedValue({ tools }),
      });
      mockFactory(mockClient);

      const task = new McpListTask();
      const result = await task.run({ server: baseServer, list_type: "tools" });

      expect((result as { tools: unknown }).tools).toEqual(tools);
      expect(mockClient.listTools.calls.length).toBe(1);
      expect(mockClient.close.calls.length).toBe(1);
    });

    test("lists resources", async () => {
      const resources = [{ uri: "file:///a.txt", name: "a.txt" }];
      const mockClient = createMockClient({
        listResources: fn().mockResolvedValue({ resources }),
      });
      mockFactory(mockClient);

      const task = new McpListTask();
      const result = await task.run({ server: baseServer, list_type: "resources" });

      expect((result as { resources: unknown }).resources).toEqual(resources);
    });

    test("lists prompts", async () => {
      const prompts = [{ name: "greeting", description: "Greets" }];
      const mockClient = createMockClient({
        listPrompts: fn().mockResolvedValue({ prompts }),
      });
      mockFactory(mockClient);

      const task = new McpListTask();
      const result = await task.run({ server: baseServer, list_type: "prompts" });

      expect((result as { prompts: unknown }).prompts).toEqual(prompts);
    });

    test("has correct static properties", () => {
      expect(McpListTask.type).toBe("McpListTask");
      expect(McpListTask.category).toBe("MCP");
      expect(McpListTask.cachePolicy.kind).toBe("none");
      expect(McpListTask.hasDynamicSchemas).toBe(true);
    });

    test("dynamic output schema changes based on list_type", () => {
      const task = new McpListTask();

      task.setInput({ list_type: "tools" });
      const toolsSchema = task.outputSchema();
      expect(toolsSchema).toHaveProperty("properties.tools");
      expect(toolsSchema).not.toHaveProperty("properties.resources");
      expect(toolsSchema).not.toHaveProperty("properties.prompts");

      task.setInput({ list_type: "resources" });
      const resourcesSchema = task.outputSchema();
      expect(resourcesSchema).toHaveProperty("properties.resources");
      expect(resourcesSchema).not.toHaveProperty("properties.tools");

      task.setInput({ list_type: "prompts" });
      const promptsSchema = task.outputSchema();
      expect(promptsSchema).toHaveProperty("properties.prompts");
      expect(promptsSchema).not.toHaveProperty("properties.tools");
    });

    test("returns all output types in static schema when no list_type set", () => {
      const schema = McpListTask.outputSchema();
      expect(schema).toHaveProperty("properties.tools");
      expect(schema).toHaveProperty("properties.resources");
      expect(schema).toHaveProperty("properties.prompts");
    });
  });
});
