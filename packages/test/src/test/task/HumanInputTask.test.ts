/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpElicitationConnector } from "@workglow/mcp/tasks";
import {
  Dataflow,
  Task,
  TaskConfigurationError,
  TaskGraph,
  TaskStatus,
  Workflow,
} from "@workglow/task-graph";
import { HumanApprovalTask, HumanInputTask } from "@workglow/tasks";
import type { IHumanConnector, IHumanRequest, IHumanResponse } from "@workglow/util";
import { Container, HUMAN_CONNECTOR, ServiceRegistry } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { beforeEach, describe, expect, test, vi } from "vitest";

// ========================================================================
// Mock connector
// ========================================================================

function createMockConnector(handler: (request: IHumanRequest) => IHumanResponse): IHumanConnector {
  return {
    send: vi.fn(async (request: IHumanRequest, _signal: AbortSignal) => handler(request)),
  };
}

function createMultiTurnConnector(
  responses: IHumanResponse[]
): IHumanConnector & { followUp: NonNullable<IHumanConnector["followUp"]> } {
  let callIndex = 0;
  return {
    send: vi.fn(async () => responses[callIndex++]!),
    followUp: vi.fn(async () => responses[callIndex++]!),
  };
}

// ========================================================================
// Helper task for dataflow tests
// ========================================================================

class UpperCaseTask extends Task<{ text: string }, { text: string }> {
  public static override type = "HumanTest_UpperCaseTask";
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute(input: { text: string }) {
    return { text: input.text.toUpperCase() };
  }
}

// ========================================================================
// HumanInputTask — elicit kind (default)
// ========================================================================

describe("HumanInputTask — elicit", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry(new Container());
  });

  test("returns human response data with action as output", async () => {
    const contentSchema: DataPortSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    };

    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "accept",
      content: { name: "Alice" },
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);

    const task = new HumanInputTask({ contentSchema, message: "What is your name?" });
    const result = await task.run({}, { registry });

    expect(result).toEqual({ action: "accept", name: "Alice" });
    expect(connector.send).toHaveBeenCalledOnce();
  });

  test("decline action returns action without content", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "decline",
      content: undefined,
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanInputTask({});
    const result = await task.run({}, { registry });
    expect(result).toEqual({ action: "decline" });
  });

  test("cancel action returns action without content", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "cancel",
      content: undefined,
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanInputTask();
    const result = await task.run({}, { registry });
    expect(result).toEqual({ action: "cancel" });
  });

  test("merges input prompt into message", async () => {
    const connector = createMockConnector((req) => {
      expect(req.message).toBe("Base message\n\nDynamic prompt");
      return { requestId: req.requestId, action: "accept", content: {}, done: true };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanInputTask({ message: "Base message" });
    await task.run({ prompt: "Dynamic prompt" }, { registry });
  });

  test("merges input context into metadata", async () => {
    const connector = createMockConnector((req) => {
      expect(req.metadata).toEqual({ source: "test", extra: "data" });
      return { requestId: req.requestId, action: "accept", content: {}, done: true };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanInputTask({ metadata: { source: "test" } });
    await task.run({ context: { extra: "data" } }, { registry });
  });

  test("defaults targetHumanId to 'default'", async () => {
    const connector = createMockConnector((req) => {
      expect(req.targetHumanId).toBe("default");
      return { requestId: req.requestId, action: "accept", content: {}, done: true };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    await new HumanInputTask({}).run({}, { registry });
  });

  test("uses custom targetHumanId", async () => {
    const connector = createMockConnector((req) => {
      expect(req.targetHumanId).toBe("admin");
      return { requestId: req.requestId, action: "accept", content: {}, done: true };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    await new HumanInputTask({ targetHumanId: "admin" }).run({}, { registry });
  });

  test("throws when no IHumanConnector is registered", async () => {
    const emptyRegistry = new ServiceRegistry(new Container());
    const task = new HumanInputTask();
    await expect(task.run({}, { registry: emptyRegistry })).rejects.toThrow(Error);
  });

  test("multi-turn mode: loops until done=true", async () => {
    const connector = createMultiTurnConnector([
      { requestId: "r1", action: "accept", content: { step: 1 }, done: false },
      { requestId: "r1", action: "accept", content: { step: 2 }, done: false },
      { requestId: "r1", action: "accept", content: { step: 3, final: true }, done: true },
    ]);

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanInputTask({ mode: "multi-turn" });
    const result = await task.run({}, { registry });

    expect(result).toEqual({ action: "accept", step: 3, final: true });
    expect(connector.send).toHaveBeenCalledOnce();
    expect(connector.followUp).toHaveBeenCalledTimes(2);
  });

  test("multi-turn mode: throws if connector has no followUp", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "accept",
      content: {},
      done: false,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanInputTask({ mode: "multi-turn" });
    await expect(task.run({}, { registry })).rejects.toThrow(TaskConfigurationError);
  });

  test("respects abort signal", async () => {
    const abortController = new AbortController();
    const connector: IHumanConnector = {
      send: vi.fn(async (_req, signal: AbortSignal) => {
        return new Promise<IHumanResponse>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }),
    };

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanInputTask({});
    const runPromise = task.run({}, { registry, signal: abortController.signal });
    setTimeout(() => abortController.abort(), 10);
    await expect(runPromise).rejects.toThrow();
  });

  test("dynamic output schema includes action and contentSchema properties", () => {
    const contentSchema: DataPortSchema = {
      type: "object",
      properties: { color: { type: "string" } },
    };

    const task = new HumanInputTask({ contentSchema });
    const schema = task.outputSchema() as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("action");
    expect(schema.properties).toHaveProperty("color");
  });

  test("passes contentSchema to connector as contentSchema", async () => {
    const contentSchema: DataPortSchema = {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    };

    const connector = createMockConnector((req) => {
      expect(req.contentSchema).toEqual(contentSchema);
      expect(req.kind).toBe("elicit");
      expect(req.expectsResponse).toBe(true);
      return {
        requestId: req.requestId,
        action: "accept",
        content: { email: "a@b.c" },
        done: true,
      };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanInputTask({ contentSchema, message: "Enter email" });
    await task.run({}, { registry });
  });

  test("output flows to downstream task via dataflow", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "accept",
      content: { text: "hello" },
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);

    const humanTask = new HumanInputTask({
      contentSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
    });
    const upperTask = new UpperCaseTask({});

    const graph = new TaskGraph();
    graph.addTask(humanTask);
    graph.addTask(upperTask);
    graph.addDataflow(new Dataflow(humanTask.id, "text", upperTask.id, "text"));

    const result = await graph.run({}, { registry });
    expect(result).toBeInstanceOf(Array);
    expect(result[0].data).toEqual({ text: "HELLO" });
  });
});

// ========================================================================
// HumanInputTask — notify kind
// ========================================================================

describe("HumanInputTask — notify", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry(new Container());
  });

  test("notify kind sends and resolves immediately", async () => {
    const connector = createMockConnector((req) => {
      expect(req.kind).toBe("notify");
      expect(req.expectsResponse).toBe(false);
      expect(req.message).toBe("Deploy complete!");
      return { requestId: req.requestId, action: "accept", content: undefined, done: true };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);

    const task = new HumanInputTask({ kind: "notify", message: "Deploy complete!" });
    const result = await task.run({}, { registry });
    expect(result).toEqual({ action: "accept" });
  });

  test("notify kind passes contentData through", async () => {
    const connector = createMockConnector((req) => {
      expect(req.contentData).toEqual({ status: "success", count: 42 });
      return { requestId: req.requestId, action: "accept", content: undefined, done: true };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);

    const task = new HumanInputTask({ kind: "notify", message: "Update" });
    await task.run({ contentData: { status: "success", count: 42 } }, { registry });
  });
});

// ========================================================================
// HumanInputTask — display kind
// ========================================================================

describe("HumanInputTask — display", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry(new Container());
  });

  test("display kind sends content for visualization", async () => {
    const mapSchema: DataPortSchema = {
      type: "object",
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        label: { type: "string" },
      },
    };

    const connector = createMockConnector((req) => {
      expect(req.kind).toBe("display");
      expect(req.expectsResponse).toBe(false);
      expect(req.contentSchema).toEqual(mapSchema);
      expect(req.contentData).toEqual({ lat: 37.7749, lng: -122.4194, label: "SF" });
      return { requestId: req.requestId, action: "accept", content: undefined, done: true };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);

    const task = new HumanInputTask({
      kind: "display",
      contentSchema: mapSchema,
      message: "Location",
    });
    const result = await task.run(
      { contentData: { lat: 37.7749, lng: -122.4194, label: "SF" } },
      { registry }
    );
    expect(result).toEqual({ action: "accept" });
  });
});

// ========================================================================
// HumanApprovalTask
// ========================================================================

describe("HumanApprovalTask", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry(new Container());
  });

  test("an Accept is an approval: a confirm answer carries no content", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "accept",
      content: undefined,
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const task = new HumanApprovalTask({ message: "Deploy?" });
    const result = await task.run({}, { registry });
    expect(result).toEqual({ action: "accept", approved: true });
    expect(task.status).toBe(TaskStatus.COMPLETED);
  });

  test("passes on a reason when the host sends one with the answer", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "accept",
      content: { reason: "Looks good" },
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const result = await new HumanApprovalTask({}).run({}, { registry });
    expect(result).toEqual({ action: "accept", approved: true, reason: "Looks good" });
  });

  test("an explicit approved=false from the host is never read as a yes", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "accept",
      content: { approved: false, reason: "Not ready" },
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const result = await new HumanApprovalTask({}).run({}, { registry });
    expect(result).toEqual({ action: "accept", approved: false, reason: "Not ready" });
  });

  test("returns approved=false when human declines", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "decline",
      content: undefined,
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const result = await new HumanApprovalTask({}).run({}, { registry });
    expect(result.action).toBe("decline");
    expect(result.approved).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("returns approved=false when human cancels", async () => {
    const connector = createMockConnector((req) => ({
      requestId: req.requestId,
      action: "cancel",
      content: undefined,
      done: true,
    }));

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    const result = await new HumanApprovalTask({}).run({}, { registry });
    expect(result.action).toBe("cancel");
    expect(result.approved).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  test("asks as a confirm, which every host draws as an approval", async () => {
    const connector = createMockConnector((req) => {
      expect(req.kind).toBe("confirm");
      expect(req.mode).toBe("single");
      expect(req.contentData).toEqual({ change: "v2" });
      return { requestId: req.requestId, action: "accept", content: undefined, done: true };
    });

    registry.registerInstance(HUMAN_CONNECTOR, connector);
    await new HumanApprovalTask({}).run({ context: { change: "v2" } }, { registry });
  });

  test("static type and category", () => {
    expect(HumanApprovalTask.type).toBe("HumanApprovalTask");
    // "Human", not "Flow Control": both of these run perfectly well on their
    // own, and that category is read as "needs a graph around it" — the CLI's
    // `task list` and the MCP server's tool list both hide what it names.
    expect(HumanApprovalTask.category).toBe("Human");
    expect(HumanInputTask.category).toBe("Human");
  });

  test("output schema includes action, approved, and reason", () => {
    const schema = HumanApprovalTask.outputSchema() as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("action");
    expect(schema.properties).toHaveProperty("approved");
    expect(schema.properties).toHaveProperty("reason");
  });
});

// ========================================================================
// McpElicitationConnector
// ========================================================================

describe("McpElicitationConnector", () => {
  test("elicit kind: converts to MCP elicitInput call", async () => {
    const mockElicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { username: "alice" },
    });
    const mockServer = { elicitInput: mockElicitInput } as any;
    const connector = new McpElicitationConnector(mockServer);

    const request: IHumanRequest = {
      requestId: "req-1",
      targetHumanId: "default",
      kind: "elicit",
      message: "Enter your username",
      contentSchema: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      },
      contentData: undefined,
      expectsResponse: true,
      mode: "single",
      metadata: undefined,
    };

    const response = await connector.send(request, new AbortController().signal);

    expect(mockElicitInput).toHaveBeenCalledOnce();
    const [params] = mockElicitInput.mock.calls[0];
    expect(params.mode).toBe("form");
    expect(params.message).toBe("Enter your username");
    expect(params.requestedSchema.properties).toHaveProperty("username");

    expect(response.action).toBe("accept");
    expect(response.content).toEqual({ username: "alice" });
    expect(response.done).toBe(true);
  });

  test("notify kind: uses sendLoggingMessage", async () => {
    const mockSendLogging = vi.fn().mockResolvedValue(undefined);
    const mockServer = { sendLoggingMessage: mockSendLogging } as any;
    const connector = new McpElicitationConnector(mockServer);

    const response = await connector.send(
      {
        requestId: "req-n",
        targetHumanId: "default",
        kind: "notify",
        message: "Build finished!",
        contentSchema: { type: "object", properties: {} },
        contentData: { status: "success" },
        expectsResponse: false,
        mode: "single",
        metadata: undefined,
      },
      new AbortController().signal
    );

    expect(mockSendLogging).toHaveBeenCalledOnce();
    expect(response.action).toBe("accept");
    expect(response.done).toBe(true);
  });

  test("display kind: uses sendLoggingMessage with content", async () => {
    const mockSendLogging = vi.fn().mockResolvedValue(undefined);
    const mockServer = { sendLoggingMessage: mockSendLogging } as any;
    const connector = new McpElicitationConnector(mockServer);

    const response = await connector.send(
      {
        requestId: "req-d",
        targetHumanId: "default",
        kind: "display",
        message: "Map location",
        contentSchema: { type: "object", properties: { lat: { type: "number" } } },
        contentData: { lat: 37.7749 },
        expectsResponse: false,
        mode: "single",
        metadata: undefined,
      },
      new AbortController().signal
    );

    expect(mockSendLogging).toHaveBeenCalledOnce();
    const [logParams] = mockSendLogging.mock.calls[0];
    expect(logParams.data).toHaveProperty("content");
    expect(logParams.data.content).toEqual({ lat: 37.7749 });
    expect(response.action).toBe("accept");
  });

  test("decline maps correctly", async () => {
    const mockServer = {
      elicitInput: vi.fn().mockResolvedValue({ action: "decline" }),
    } as any;

    const connector = new McpElicitationConnector(mockServer);
    const response = await connector.send(
      {
        requestId: "req-2",
        targetHumanId: "default",
        kind: "elicit",
        message: "Confirm?",
        contentSchema: { type: "object", properties: {} },
        contentData: undefined,
        expectsResponse: true,
        mode: "single",
        metadata: undefined,
      },
      new AbortController().signal
    );

    expect(response.action).toBe("decline");
    expect(response.content).toBeUndefined();
  });

  test("followUp is not defined (MCP elicit/create is single-round-trip)", () => {
    const mockServer = {
      elicitInput: vi.fn(),
    } as any;

    const connector: IHumanConnector = new McpElicitationConnector(mockServer);
    expect(connector.followUp).toBeUndefined();
  });
});

// ========================================================================
// Workflow integration
// ========================================================================

describe("Workflow integration", () => {
  test("humanInput method exists on Workflow prototype", () => {
    expect(typeof Workflow.prototype.humanInput).toBe("function");
  });

  test("humanApproval method exists on Workflow prototype", () => {
    expect(typeof Workflow.prototype.humanApproval).toBe("function");
  });
});
