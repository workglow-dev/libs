/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelConfig, ToolDefinition } from "@workglow/ai";
import {
  AgentTask,
  AiProviderRegistry,
  DirectExecutionStrategy,
  getAiProviderRegistry,
  registerAiTasks,
  setAiProviderRegistry,
  ToolCallError,
} from "@workglow/ai";
import type { StreamEvent, TaskEntitlements, TaskGraphJson } from "@workglow/task-graph";
import { createGraphFromGraphJSON, Entitlements, Task, TaskRegistry } from "@workglow/task-graph";
import { HumanInputTask } from "@workglow/tasks";
import type { IHumanConnector, IHumanRequest, IHumanResponse } from "@workglow/util";
import { Container, HUMAN_CONNECTOR, ServiceRegistry } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MOCK_PROVIDER = "mock-agent-provider";

const MODEL: ModelConfig = {
  model_id: "mock/agent-1",
  provider: MOCK_PROVIDER,
  title: "",
  description: "",
  capabilities: ["tool-use"],
  provider_config: {},
  metadata: {},
};

// ========================================================================
// A scripted model: one entry per round, the last repeating forever
// ========================================================================

interface ScriptedRound {
  readonly text?: string;
  /** Report the text on the finish event only, as a non-streaming provider does. */
  readonly withoutDeltas?: boolean;
  readonly calls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
  }>;
}

function scriptModel(rounds: readonly ScriptedRound[]): () => number {
  let called = 0;
  const runFn: AiProviderRunFn = async (_input, _model, _signal, emit) => {
    const round = rounds[Math.min(called, rounds.length - 1)]!;
    called++;
    if (round.text && !round.withoutDeltas) {
      emit({ type: "text-delta", port: "text", textDelta: round.text });
    }
    if (round.calls?.length) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...round.calls] });
    }
    emit({ type: "finish", data: round.withoutDeltas ? { text: round.text ?? "" } : {} });
  };
  getAiProviderRegistry().registerRunFn(MOCK_PROVIDER, { serves: ["tool-use"], runFn });
  return () => called;
}

// ========================================================================
// Two task-backed tools: one that reaches nothing, one that reaches the network
// ========================================================================

let echoRuns = 0;
let fetchRuns = 0;

class AgentTest_EchoTask extends Task<{ text: string }, { echoed: string }> {
  public static override type = "AgentTest_EchoTask";
  public static override description = "Echoes text back";
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { echoed: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute(input: { text: string }) {
    echoRuns++;
    return { echoed: input.text.toUpperCase() };
  }
}

class AgentTest_FetchTask extends Task<{ url: string }, { body: string }> {
  public static override type = "AgentTest_FetchTask";
  public static override description = "Fetches a URL";
  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [{ id: Entitlements.NETWORK_HTTP, reason: "Fetches data from URLs" }],
    };
  }
  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { body: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute(input: { url: string }) {
    fetchRuns++;
    return { body: `body of ${input.url}` };
  }
}

const ECHO_TOOL: ToolDefinition = {
  name: "AgentTest_EchoTask",
  description: "Echoes text back",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

const FETCH_TOOL: ToolDefinition = {
  name: "AgentTest_FetchTask",
  description: "Fetches a URL",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
};

function connector(handler: (request: IHumanRequest) => IHumanResponse): {
  readonly connector: IHumanConnector;
  readonly requests: IHumanRequest[];
} {
  const requests: IHumanRequest[] = [];
  return {
    requests,
    connector: {
      async send(request: IHumanRequest): Promise<IHumanResponse> {
        requests.push(request);
        return handler(request);
      },
    },
  };
}

function toolResults(messages: readonly { role: string; content: readonly unknown[] }[]) {
  return messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content as ReadonlyArray<Record<string, unknown>>);
}

describe("AgentTask", () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    echoRuns = 0;
    fetchRuns = 0;
    setAiProviderRegistry(new AiProviderRegistry());
    getAiProviderRegistry().setDefaultStrategy(new DirectExecutionStrategy());
    registry = new ServiceRegistry(new Container());
    TaskRegistry.registerTask(AgentTest_EchoTask);
    TaskRegistry.registerTask(AgentTest_FetchTask);
  });

  afterEach(() => {
    TaskRegistry.unregisterTask(AgentTest_EchoTask.type);
    TaskRegistry.unregisterTask(AgentTest_FetchTask.type);
    getAiProviderRegistry().unregisterProvider(MOCK_PROVIDER);
  });

  it("runs the tool the model asks for and feeds the result back", async () => {
    const called = scriptModel([
      {
        text: "Looking. ",
        calls: [{ id: "c1", name: "AgentTest_EchoTask", input: { text: "hi" } }],
      },
      { text: "It said HI." },
    ]);

    const output = await new AgentTask().run(
      { model: MODEL, prompt: "echo hi", tools: [ECHO_TOOL], approval: "never" },
      { registry }
    );

    expect(called()).toBe(2);
    expect(echoRuns).toBe(1);
    expect(output.rounds).toBe(2);
    expect(output.stopReason).toBe("answered");
    // The turn's whole narration, not only its last round.
    expect(output.text).toBe("Looking. It said HI.");
    expect(output.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const [result] = toolResults(output.messages);
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "c1", is_error: undefined });
    expect(JSON.stringify(result)).toContain("HI");
  });

  it("streams the model's text to a subscriber as it arrives, across rounds", async () => {
    scriptModel([
      {
        text: "Looking. ",
        calls: [{ id: "c1", name: "AgentTest_EchoTask", input: { text: "hi" } }],
      },
      { text: "It said HI." },
    ]);

    const task = new AgentTask();
    const deltas: string[] = [];
    task.subscribe("stream_chunk", (event) => {
      if (event.type === "text-delta") deltas.push(event.textDelta);
    });
    await task.run(
      { model: MODEL, prompt: "echo hi", tools: [ECHO_TOOL], approval: "never" },
      { registry }
    );

    // Both rounds reach the caller, in order — not one payload at the end.
    expect(deltas).toEqual(["Looking. ", "It said HI."]);
  });

  it("reports the answer of a provider that streams nothing", async () => {
    scriptModel([{ text: "All at once.", withoutDeltas: true }]);

    const output = await new AgentTask().run(
      { model: MODEL, prompt: "hi", tools: [ECHO_TOOL], approval: "never" },
      { registry }
    );

    expect(output.text).toBe("All at once.");
    expect(output.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("snapshots the transcript as it grows, without touching the output port", async () => {
    scriptModel([
      {
        text: "Looking. ",
        calls: [{ id: "c1", name: "AgentTest_EchoTask", input: { text: "hi" } }],
      },
      { text: "It said HI." },
    ]);

    const task = new AgentTask();
    const sizes: number[] = [];
    task.subscribe("stream_chunk", (event) => {
      if (event.type === "snapshot") {
        sizes.push(((event.data as { messages: unknown[] }).messages ?? []).length);
      }
    });
    const output = await task.run(
      { model: MODEL, prompt: "echo hi", tools: [ECHO_TOOL], approval: "never" },
      { registry }
    );

    // The user message, the assistant's call, the tool's result, the answer —
    // each visible as it lands rather than all at the end.
    expect(sizes).toEqual([1, 2, 3, 4]);
    // And the port is unharmed: an object-delta carrying an array would have
    // been folded as an upsert list and appended these into one of length ten.
    expect(output.messages).toHaveLength(4);
  });

  it("hands a host function the call it is serving", async () => {
    scriptModel([{ calls: [{ id: "call_7", name: "ask", input: {} }] }, { text: "thanks" }]);
    let seen: { toolUseId: string; aborted: boolean } | undefined;

    await new AgentTask().run(
      {
        model: MODEL,
        prompt: "ask",
        tools: [
          {
            name: "ask",
            description: "Asks something",
            inputSchema: { type: "object", properties: {} },
            execute: async (_input, context) => {
              // A transcript keys its cards on this id; an answer arriving
              // against the wrong one is worse than no answer.
              seen = { toolUseId: context.toolUseId, aborted: context.signal.aborted };
              return "asked";
            },
          },
        ],
      },
      { registry }
    );

    expect(seen).toEqual({ toolUseId: "call_7", aborted: false });
  });

  it("lets a tool report a failure in its own words", async () => {
    scriptModel([{ calls: [{ id: "c1", name: "refuse", input: {} }] }, { text: "understood" }]);

    const output = await new AgentTask().run(
      {
        model: MODEL,
        prompt: "go",
        tools: [
          {
            name: "refuse",
            description: "Refuses",
            inputSchema: { type: "object", properties: {} },
            execute: async () => {
              throw new ToolCallError("The user declined. Ask what they would rather do.");
            },
          },
        ],
      },
      { registry }
    );

    const result = toolResults(output.messages)[0];
    expect(result).toMatchObject({ tool_use_id: "c1", is_error: true });
    // Verbatim: no "refuse failed:" wrapper around wording the tool chose.
    expect(JSON.stringify(result)).toContain("The user declined. Ask what they would rather do.");
    expect(JSON.stringify(result)).not.toContain("refuse failed");
  });

  it("wraps a throw nobody planned, so a bug still reads as one", async () => {
    scriptModel([{ calls: [{ id: "c1", name: "boom", input: {} }] }, { text: "ok" }]);

    const output = await new AgentTask().run(
      {
        model: MODEL,
        prompt: "go",
        tools: [
          {
            name: "boom",
            description: "Throws",
            inputSchema: { type: "object", properties: {} },
            execute: async () => {
              throw new Error("undefined is not a function");
            },
          },
        ],
      },
      { registry }
    );

    expect(JSON.stringify(toolResults(output.messages)[0])).toContain("boom failed");
  });

  it("runs a function tool that arrived through graph JSON", async () => {
    scriptModel([{ calls: [{ id: "c1", name: "ping", input: {} }] }, { text: "pong" }]);
    let ran = 0;
    registerAiTasks();

    // A host whose tools are closures builds its graph in memory and never
    // serializes it; this is the path that carries them, and a validator that
    // refused a function value would break it a long way from here.
    const graph = createGraphFromGraphJSON({
      tasks: [
        {
          id: "agent",
          type: "AgentTask",
          defaults: {
            model: MODEL,
            prompt: "hi",
            approval: "never",
            tools: [
              {
                name: "ping",
                description: "p",
                inputSchema: { type: "object", properties: {} },
                execute: async () => {
                  ran++;
                  return "pong";
                },
              },
            ],
          },
        },
      ],
      dataflows: [],
    } as unknown as TaskGraphJson);
    const output = await graph.run();

    expect(ran).toBe(1);
    expect(JSON.stringify(output)).toContain("pong");
  });

  it("answers an unknown tool rather than dropping the call", async () => {
    scriptModel([
      { calls: [{ id: "c1", name: "no_such_tool", input: {} }] },
      { text: "Sorry about that." },
    ]);

    const output = await new AgentTask().run(
      { model: MODEL, prompt: "go", tools: [ECHO_TOOL], approval: "never" },
      { registry }
    );

    // Every tool_use is answered: a provider rejects the next round otherwise.
    const uses = output.messages.flatMap((message) =>
      message.content.filter((block) => block.type === "tool_use")
    );
    const results = toolResults(output.messages);
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool_use_id: "c1", is_error: true });
    expect(JSON.stringify(results[0])).toContain("Unknown tool");
  });

  it("bounds the unknown-tool answer by the same budget as a tool's output", async () => {
    scriptModel([{ calls: [{ id: "c1", name: "nope", input: {} }] }, { text: "sorry" }]);
    // Naming every registered tool is what makes this message unbounded, and it
    // would be re-sent on every round the model keeps guessing.
    const many: ToolDefinition[] = Array.from({ length: 40 }, (_, index) => ({
      ...ECHO_TOOL,
      name: `a_tool_with_a_fairly_long_name_${index}`,
      taskType: AgentTest_EchoTask.type,
    }));

    const output = await new AgentTask().run(
      {
        model: MODEL,
        prompt: "go",
        tools: many,
        approval: "never",
        maxToolResultChars: 80,
      },
      { registry }
    );

    const text = (
      (toolResults(output.messages)[0] as { content: { text: string }[] }).content[0] as {
        text: string;
      }
    ).text;
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(200);
  });

  it("answers arguments that fail the tool's own schema", async () => {
    scriptModel([
      { calls: [{ id: "c1", name: "AgentTest_EchoTask", input: { text: 42 } }] },
      { text: "Fixed." },
    ]);

    const output = await new AgentTask().run(
      { model: MODEL, prompt: "go", tools: [ECHO_TOOL], approval: "never" },
      { registry }
    );

    expect(echoRuns).toBe(0);
    expect(toolResults(output.messages)[0]).toMatchObject({ tool_use_id: "c1", is_error: true });
  });

  it("records no assistant message for a round that said nothing", async () => {
    scriptModel([{}]);

    const output = await new AgentTask().run(
      { model: MODEL, prompt: "silence", tools: [ECHO_TOOL], approval: "never" },
      { registry }
    );

    expect(output.stopReason).toBe("answered");
    expect(output.text).toBe("");
    // An empty assistant message is not a reply, and a provider replaying this
    // history as a prefix rejects one.
    expect(output.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("stops at maxRounds when the model never stops calling tools", async () => {
    const called = scriptModel([
      { calls: [{ id: "c", name: "AgentTest_EchoTask", input: { text: "again" } }] },
    ]);

    const output = await new AgentTask().run(
      { model: MODEL, prompt: "loop", tools: [ECHO_TOOL], maxRounds: 3, approval: "never" },
      { registry }
    );

    expect(called()).toBe(3);
    expect(output.rounds).toBe(3);
    expect(output.stopReason).toBe("max-rounds");
  });

  it("renames a tool-call id the conversation already used", async () => {
    scriptModel([
      { calls: [{ id: "call_0", name: "AgentTest_EchoTask", input: { text: "now" } }] },
      { text: "done" },
    ]);

    const output = await new AgentTask().run(
      {
        model: MODEL,
        prompt: "again",
        tools: [ECHO_TOOL],
        approval: "never",
        messages: [
          { role: "user", content: [{ type: "text", text: "earlier" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_0", name: "AgentTest_EchoTask", input: {} }],
          },
          {
            role: "tool",
            content: [
              { type: "tool_result", tool_use_id: "call_0", content: [], is_error: undefined },
            ],
          },
        ],
      },
      { registry }
    );

    const results = toolResults(output.messages);
    expect(results).toHaveLength(2);
    // The new call was renamed off the old one, and its result followed it.
    expect(results[1]).not.toMatchObject({ tool_use_id: "call_0" });
    const renamed = (results[1] as { tool_use_id: string }).tool_use_id;
    const uses = output.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_use")
      .map((block) => (block as { id: string }).id);
    expect(uses).toEqual(["call_0", renamed]);
  });

  describe("approval", () => {
    it("confirms a tool that reaches beyond running a model", async () => {
      scriptModel([
        {
          calls: [
            { id: "c1", name: "AgentTest_FetchTask", input: { url: "https://example.test" } },
          ],
        },
        { text: "got it" },
      ]);
      const human = connector((request) => ({
        requestId: request.requestId,
        action: "accept",
        content: undefined,
        done: true,
      }));
      registry.registerInstance(HUMAN_CONNECTOR, human.connector);

      await new AgentTask().run(
        { model: MODEL, prompt: "fetch", tools: [FETCH_TOOL] },
        { registry }
      );

      expect(fetchRuns).toBe(1);
      expect(human.requests).toHaveLength(1);
      expect(human.requests[0]!.kind).toBe("confirm");
      // The card says where it reaches and with what, not just which tool.
      expect(human.requests[0]!.contentData).toMatchObject({ tool: "AgentTest_FetchTask" });
      expect(String(human.requests[0]!.contentData?.reach)).toContain("network:http");
      expect(String(human.requests[0]!.contentData?.arguments)).toContain("example.test");
    });

    it("does not confirm a tool that reaches nothing beyond it", async () => {
      scriptModel([
        { calls: [{ id: "c1", name: "AgentTest_EchoTask", input: { text: "hi" } }] },
        { text: "done" },
      ]);
      const human = connector((request) => ({
        requestId: request.requestId,
        action: "accept",
        content: undefined,
        done: true,
      }));
      registry.registerInstance(HUMAN_CONNECTOR, human.connector);

      await new AgentTask().run({ model: MODEL, prompt: "echo", tools: [ECHO_TOOL] }, { registry });

      expect(echoRuns).toBe(1);
      expect(human.requests).toHaveLength(0);
    });

    it("does not run a declined tool, and tells the model why", async () => {
      scriptModel([
        {
          calls: [
            { id: "c1", name: "AgentTest_FetchTask", input: { url: "https://example.test" } },
          ],
        },
        { text: "understood" },
      ]);
      const human = connector((request) => ({
        requestId: request.requestId,
        action: "decline",
        content: undefined,
        done: true,
      }));
      registry.registerInstance(HUMAN_CONNECTOR, human.connector);

      const output = await new AgentTask().run(
        { model: MODEL, prompt: "fetch", tools: [FETCH_TOOL] },
        { registry }
      );

      expect(fetchRuns).toBe(0);
      const result = toolResults(output.messages)[0];
      expect(result).toMatchObject({ tool_use_id: "c1", is_error: true });
      expect(JSON.stringify(result)).toContain("did not approve");
    });

    it("refuses rather than runs when asking itself fails", async () => {
      scriptModel([
        {
          calls: [
            { id: "c1", name: "AgentTest_FetchTask", input: { url: "https://example.test" } },
          ],
        },
        { text: "ok" },
      ]);
      // The terminal connector raises exactly like this when no run UI is
      // mounted; one badly wired host must not end the conversation.
      registry.registerInstance(HUMAN_CONNECTOR, {
        send: async () => {
          throw new Error("no run UI is mounted");
        },
      });

      const output = await new AgentTask().run(
        { model: MODEL, prompt: "fetch", tools: [FETCH_TOOL] },
        { registry }
      );

      expect(fetchRuns).toBe(0);
      expect(output.stopReason).toBe("answered");
      expect(JSON.stringify(toolResults(output.messages)[0])).toContain("asking for one failed");
    });

    it("refuses rather than runs when there is nobody to ask", async () => {
      scriptModel([
        {
          calls: [
            { id: "c1", name: "AgentTest_FetchTask", input: { url: "https://example.test" } },
          ],
        },
        { text: "ok" },
      ]);

      const output = await new AgentTask().run(
        { model: MODEL, prompt: "fetch", tools: [FETCH_TOOL] },
        { registry }
      );

      expect(fetchRuns).toBe(0);
      expect(JSON.stringify(toolResults(output.messages)[0])).toContain("no way to ask");
    });

    it("does not call an unregistered task type a host function on the card", async () => {
      scriptModel([
        { calls: [{ id: "c1", name: "AgentTest_MisspelledTask", input: {} }] },
        { text: "ok" },
      ]);
      const human = connector((request) => ({
        requestId: request.requestId,
        action: "accept",
        content: undefined,
        done: true,
      }));
      registry.registerInstance(HUMAN_CONNECTOR, human.connector);

      await new AgentTask().run(
        {
          model: MODEL,
          prompt: "go",
          tools: [
            {
              name: "AgentTest_MisspelledTask",
              description: "A task type nobody registered",
              inputSchema: { type: "object", properties: {} },
              requiresApproval: true,
            },
          ],
        },
        { registry }
      );

      const reach = String(human.requests[0]!.contentData?.reach);
      expect(reach).toContain("AgentTest_MisspelledTask");
      expect(reach).not.toContain("host function");
    });

    it('runs an unapproved-reach tool when approval is "never"', async () => {
      scriptModel([
        {
          calls: [
            { id: "c1", name: "AgentTest_FetchTask", input: { url: "https://example.test" } },
          ],
        },
        { text: "ok" },
      ]);

      await new AgentTask().run(
        { model: MODEL, prompt: "fetch", tools: [FETCH_TOOL], approval: "never" },
        { registry }
      );

      expect(fetchRuns).toBe(1);
    });

    it("honours requiresApproval in both directions", async () => {
      scriptModel([
        { calls: [{ id: "c1", name: "AgentTest_EchoTask", input: { text: "hi" } }] },
        { text: "done" },
      ]);
      const human = connector((request) => ({
        requestId: request.requestId,
        action: "accept",
        content: undefined,
        done: true,
      }));
      registry.registerInstance(HUMAN_CONNECTOR, human.connector);

      await new AgentTask().run(
        {
          model: MODEL,
          prompt: "echo",
          tools: [{ ...ECHO_TOOL, requiresApproval: true }],
        },
        { registry }
      );
      expect(human.requests).toHaveLength(1);

      await new AgentTask().run(
        {
          model: MODEL,
          prompt: "fetch",
          tools: [{ ...FETCH_TOOL, requiresApproval: false }],
        },
        { registry }
      );
      expect(human.requests).toHaveLength(1);
    });
  });

  it("resolves a renamed tool through its taskType", async () => {
    scriptModel([
      { calls: [{ id: "c1", name: "shout", input: { text: "hi" } }] },
      { text: "done" },
    ]);

    await new AgentTask().run(
      {
        model: MODEL,
        prompt: "shout",
        tools: [{ ...ECHO_TOOL, name: "shout", taskType: AgentTest_EchoTask.type }],
        approval: "never",
      },
      { registry }
    );

    expect(echoRuns).toBe(1);
  });

  it("reaches the human connector through a tool that asks a person", async () => {
    scriptModel([
      { calls: [{ id: "c1", name: "HumanInputTask", input: { prompt: "What is your name?" } }] },
      { text: "Thanks, Alice." },
    ]);
    const human = connector((request) => ({
      requestId: request.requestId,
      action: "accept",
      content: { name: "Alice" },
      done: true,
    }));
    registry.registerInstance(HUMAN_CONNECTOR, human.connector);
    TaskRegistry.registerTask(HumanInputTask);

    try {
      const output = await new AgentTask().run(
        {
          model: MODEL,
          prompt: "ask my name",
          tools: [
            {
              name: "HumanInputTask",
              description: "Asks the user something",
              inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
              config: {
                contentSchema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
          ],
        },
        { registry }
      );

      // No new vocabulary: the tool asked through the same IHumanConnector a
      // workflow would, and its answer came back as an ordinary tool result.
      const elicits = human.requests.filter((request) => request.kind === "elicit");
      expect(elicits).toHaveLength(1);
      expect(elicits[0]!.message).toBe("What is your name?");
      // The form came from the tool's `config`, which the model never sees.
      expect(elicits[0]!.contentSchema).toMatchObject({ properties: { name: { type: "string" } } });
      expect(JSON.stringify(toolResults(output.messages)[0])).toContain("Alice");
    } finally {
      TaskRegistry.unregisterTask(HumanInputTask.type);
    }
  });

  it("runs a host function tool without a task behind it", async () => {
    let seen: Record<string, unknown> | undefined;
    scriptModel([{ calls: [{ id: "c1", name: "add", input: { a: 2, b: 3 } }] }, { text: "five" }]);

    const output = await new AgentTask().run(
      {
        model: MODEL,
        prompt: "add",
        tools: [
          {
            name: "add",
            description: "Adds two numbers",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
            },
            execute: async (input) => {
              seen = input;
              return { sum: (input.a as number) + (input.b as number) };
            },
          },
        ],
      },
      { registry }
    );

    expect(seen).toEqual({ a: 2, b: 3 });
    expect(JSON.stringify(toolResults(output.messages)[0])).toContain("5");
  });

  // ======================================================================
  // Per-tool lifecycle events
  // ======================================================================

  describe("tool-call events", () => {
    /** Collects the lifecycle events a run reports, in the order they arrive. */
    function lifecycle(task: AgentTask): Array<Extract<StreamEvent, { type: "tool-call" }>> {
      const seen: Array<Extract<StreamEvent, { type: "tool-call" }>> = [];
      task.subscribe("stream_chunk", (event) => {
        if (event.type === "tool-call") seen.push(event);
      });
      return seen;
    }

    /**
     * The settled member, picked out by the field only it carries. Extracting
     * on `status: "completed"` yields `never` instead — that member's status is
     * the wider `"completed" | "failed"`, which no narrower constraint matches.
     */
    type SettledToolCall = Extract<StreamEvent, { type: "tool-call"; result: string }>;

    /** `status:id` for each event — the whole sequence in one readable line. */
    function trace(seen: ReadonlyArray<Extract<StreamEvent, { type: "tool-call" }>>): string[] {
      return seen.map((event) => `${event.status}:${event.toolCallId}`);
    }

    it("reports a call pending, then running, then completed", async () => {
      scriptModel([
        { calls: [{ id: "c1", name: "AgentTest_EchoTask", input: { text: "hi" } }] },
        { text: "It said HI." },
      ]);
      const task = new AgentTask();
      const seen = lifecycle(task);

      const output = await task.run(
        { model: MODEL, prompt: "echo hi", tools: [ECHO_TOOL], approval: "never" },
        { registry }
      );

      expect(trace(seen)).toEqual(["pending:c1", "running:c1", "completed:c1"]);
      expect(seen.every((event) => event.name === "AgentTest_EchoTask")).toBe(true);
      expect(seen[0]).toMatchObject({ status: "pending", input: { text: "hi" } });

      // The settled text IS the string the model reads back, not a second copy
      // of it that could drift from the result or miss its clamp.
      const settled = seen[2] as SettledToolCall;
      const block = toolResults(output.messages)[0] as {
        readonly content: ReadonlyArray<{ readonly text?: string }>;
      };
      expect(block.content[0]?.text).toBe(settled.result);
      expect(settled.result).toContain("HI");
    });

    it("announces every call the model asked for before running any of them", async () => {
      scriptModel([
        {
          calls: [
            { id: "c1", name: "AgentTest_EchoTask", input: { text: "a" } },
            { id: "c2", name: "AgentTest_EchoTask", input: { text: "b" } },
          ],
        },
        { text: "done" },
      ]);
      const task = new AgentTask();
      const seen = lifecycle(task);

      await task.run(
        { model: MODEL, prompt: "echo twice", tools: [ECHO_TOOL], approval: "never" },
        { registry }
      );

      // The model asked for both at once, so both cards can be drawn at once;
      // the calls then run one at a time, each settling before the next starts.
      expect(trace(seen)).toEqual([
        "pending:c1",
        "pending:c2",
        "running:c1",
        "completed:c1",
        "running:c2",
        "completed:c2",
      ]);
    });

    it("settles a call the tool refused as failed, in the tool's own words", async () => {
      scriptModel([{ calls: [{ id: "c1", name: "decline", input: {} }] }, { text: "ok" }]);
      const task = new AgentTask();
      const seen = lifecycle(task);

      await task.run(
        {
          model: MODEL,
          prompt: "go",
          approval: "never",
          tools: [
            {
              name: "decline",
              description: "Declines",
              inputSchema: { type: "object", properties: {} },
              execute: async () => {
                throw new ToolCallError("Not this time.");
              },
            },
          ],
        },
        { registry }
      );

      expect(trace(seen)).toEqual(["pending:c1", "running:c1", "failed:c1"]);
      expect(seen[2]).toMatchObject({ status: "failed", result: "Not this time." });
    });

    it("settles a call nobody approved as failed, without running it", async () => {
      scriptModel([
        {
          calls: [
            { id: "c1", name: "AgentTest_FetchTask", input: { url: "https://example.test" } },
          ],
        },
        { text: "ok" },
      ]);
      const human = connector((request) => ({
        requestId: request.requestId,
        action: "decline",
        content: undefined,
        done: true,
      }));
      registry.registerInstance(HUMAN_CONNECTOR, human.connector);
      const task = new AgentTask();
      const seen = lifecycle(task);

      await task.run({ model: MODEL, prompt: "fetch", tools: [FETCH_TOOL] }, { registry });

      expect(trace(seen)).toEqual(["pending:c1", "running:c1", "failed:c1"]);
      expect(fetchRuns).toBe(0);
    });

    it("settles a call for a tool that does not exist", async () => {
      scriptModel([{ calls: [{ id: "c1", name: "nope", input: {} }] }, { text: "ok" }]);
      const task = new AgentTask();
      const seen = lifecycle(task);

      await task.run(
        { model: MODEL, prompt: "go", tools: [ECHO_TOOL], approval: "never" },
        { registry }
      );

      // Every call passes the same three states, the ones this loop answers
      // itself included: a host draws one card lifecycle, not two.
      expect(trace(seen)).toEqual(["pending:c1", "running:c1", "failed:c1"]);
      expect((seen[2] as SettledToolCall).result).toContain("Unknown tool");
    });
  });
});
