/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toAtifTrajectory } from "../agent/atif";
import { resolveAgentModel } from "../agent/models";
import { registerAgentProvider } from "../agent/providers";
import type { AgentRunEvent } from "../agent/runCodingAgent";
import { runCodingAgent } from "../agent/runCodingAgent";
import { decideReply, startAnthropicMock } from "../mock/anthropicMock";

describe("decideReply", () => {
  const options = { port: 0, commands: ["echo one", "echo two"] };
  const tools = [
    {
      name: "bash",
      input_schema: {
        properties: { command: { type: "string" }, description: { type: "string" } },
        required: ["command", "description"],
      },
    },
  ];

  it("runs the next command through the harness's bash tool, filling its required fields", () => {
    expect(decideReply({ tools, messages: [{ role: "user", content: "x" }] }, options)).toEqual({
      kind: "tool",
      name: "bash",
      input: { command: "echo one", description: "Run the next step" },
    });
    const later = decideReply(
      {
        tools,
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: [] },
          { role: "user", content: [] },
        ],
      },
      options
    );
    expect(later).toMatchObject({ kind: "tool", input: { command: "echo two" } });
  });

  it("answers in text once the script is spent, or when no bash tool is offered", () => {
    const spent = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: [],
    }));
    expect(decideReply({ tools, messages: spent }, options).kind).toBe("text");
    expect(decideReply({ messages: [] }, options).kind).toBe("text");
  });
});

/**
 * The whole loop against the scripted Anthropic API: the real provider, the
 * real AgentTask and the real tools, with no key and no network.
 */
describe("startAnthropicMock", () => {
  it("rejects when its port is already taken, rather than throwing later", async () => {
    const first = await startAnthropicMock({ port: 0, commands: [] });
    try {
      const { port } = first.address() as AddressInfo;
      await expect(startAnthropicMock({ port, commands: [] })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      first.close();
    }
  });
});

describe("runCodingAgent against the mock model", () => {
  let server: Server;
  let work: string;
  const previous = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };

  beforeAll(async () => {
    server = await startAnthropicMock({
      port: 0,
      commands: ["printf 'Hello, world!\\n' > hello.txt", "cat hello.txt", "exit 4"],
    });
    const { port } = server.address() as AddressInfo;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = "mock";
    await registerAgentProvider("ANTHROPIC");
    work = mkdtempSync(join(tmpdir(), "agent-eval-run-"));
  });

  afterAll(() => {
    server.close();
    rmSync(work, { recursive: true, force: true });
    process.env.ANTHROPIC_BASE_URL = previous.url;
    process.env.ANTHROPIC_API_KEY = previous.key;
    if (previous.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
    if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  });

  it("runs the tools, records every round, and prices the run", async () => {
    const events: AgentRunEvent[] = [];
    const result = await runCodingAgent({
      instruction: "Create hello.txt",
      modelId: "anthropic/claude-sonnet-5-5",
      model: resolveAgentModel("anthropic/claude-sonnet-5-5"),
      tools: {
        cwd: work,
        spillDir: join(work, ".spill"),
        defaultCommandTimeoutSec: 30,
        images: true,
      },
      settings: {
        maxRounds: 10,
        maxToolResultChars: 60_000,
        maxHistoryChars: undefined,
        toolConcurrency: undefined,
        maxTokens: undefined,
        temperature: undefined,
        maxDurationMs: undefined,
        roundTimeoutMs: undefined,
        maxRoundRetries: undefined,
        systemPromptAppend: undefined,
        concise: true,
        announceTimeLeft: false,
        reviewPrompt: undefined,
      },
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    expect(readFileSync(join(work, "hello.txt"), "utf8")).toBe("Hello, world!\n");
    const { summary } = result;
    expect(summary.outcome).toBe("answered");
    expect(summary.rounds).toBe(4);
    expect(summary.tools).toEqual({
      calls: 3,
      errors: 1,
      byName: { bash: { calls: 3, errors: 1 } },
    });
    expect(summary.usage.promptTokens).toBeGreaterThan(0);
    expect(summary.usage.outputTokens).toBe(4 * 24);
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("finish");
    expect(events.filter((event) => event.type === "round")).toHaveLength(4);

    const trajectory = toAtifTrajectory("s", "0.1.0", result.messages, result.steps, summary);
    expect(trajectory.steps.map((step) => step.source)).toEqual([
      "user",
      "agent",
      "agent",
      "agent",
      "agent",
    ]);
    expect(trajectory.steps[1]?.tool_calls?.[0]?.function_name).toBe("bash");
    expect(trajectory.steps[3]?.observation?.results[0]?.content).toMatch(/exited with code 4/);
    expect(trajectory.final_metrics.total_steps).toBe(5);
  });

  it("counts the round and the retries of a call that never succeeded", async () => {
    // Every request is refused as overloaded; `x-should-retry: false` keeps the SDK
    // from retrying on its own, so each attempt is one the loop made.
    const overloaded = createServer((_request, response) => {
      response.writeHead(529, { "content-type": "application/json", "x-should-retry": "false" });
      response.end(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } })
      );
    });
    await new Promise<void>((resolve) => overloaded.listen(0, "127.0.0.1", resolve));
    const mockUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(overloaded.address() as AddressInfo).port}`;
    try {
      const result = await runCodingAgent({
        instruction: "Create hello.txt",
        modelId: "anthropic/claude-sonnet-5-5",
        model: resolveAgentModel("anthropic/claude-sonnet-5-5"),
        tools: {
          cwd: work,
          spillDir: join(work, ".spill"),
          defaultCommandTimeoutSec: 30,
          images: true,
        },
        settings: {
          maxRounds: 10,
          maxToolResultChars: 60_000,
          maxHistoryChars: undefined,
          toolConcurrency: undefined,
          maxTokens: undefined,
          temperature: undefined,
          maxDurationMs: undefined,
          roundTimeoutMs: undefined,
          maxRoundRetries: 1,
          systemPromptAppend: undefined,
          concise: true,
          announceTimeLeft: false,
          reviewPrompt: undefined,
        },
        signal: new AbortController().signal,
      });
      expect(result.summary.outcome).toBe("error");
      expect(result.summary.rounds).toBe(1);
      expect(result.summary.retries).toBe(1);
      // The failed round has no step: its usage and cost are unknown, not zero.
      expect(result.summary.costUsd).toBeUndefined();
      expect(result.summary.usage.unreportedRounds).toBe(1);
    } finally {
      process.env.ANTHROPIC_BASE_URL = mockUrl;
      overloaded.close();
    }
  });

  it("does not count a retry the run was stopped before starting", async () => {
    const overloaded = createServer((_request, response) => {
      response.writeHead(529, { "content-type": "application/json", "x-should-retry": "false" });
      response.end(
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } })
      );
    });
    await new Promise<void>((resolve) => overloaded.listen(0, "127.0.0.1", resolve));
    const mockUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(overloaded.address() as AddressInfo).port}`;
    try {
      const result = await runCodingAgent({
        instruction: "Create hello.txt",
        modelId: "anthropic/claude-sonnet-5-5",
        model: resolveAgentModel("anthropic/claude-sonnet-5-5"),
        tools: {
          cwd: work,
          spillDir: join(work, ".spill"),
          defaultCommandTimeoutSec: 30,
          images: true,
        },
        settings: {
          maxRounds: 10,
          maxToolResultChars: 60_000,
          maxHistoryChars: undefined,
          toolConcurrency: undefined,
          maxTokens: undefined,
          temperature: undefined,
          maxDurationMs: undefined,
          roundTimeoutMs: undefined,
          maxRoundRetries: 5,
          systemPromptAppend: undefined,
          concise: true,
          announceTimeLeft: false,
          reviewPrompt: undefined,
        },
        signal: new AbortController().signal,
        // Inside the first retry's wait, which is at least a second.
        stopAfterMs: 400,
      });
      expect(result.summary.outcome).toBe("budget");
      expect(result.summary.rounds).toBe(1);
      expect(result.summary.retries).toBe(0);
    } finally {
      process.env.ANTHROPIC_BASE_URL = mockUrl;
      overloaded.close();
    }
  });

  it("stops outright at its hard limit, mid-call, and still returns its record", async () => {
    // A provider that accepts the request and never answers: the loop's own
    // budget would wait on it, since it stops only between rounds.
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const mockUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const started = Date.now();
    try {
      const events: AgentRunEvent[] = [];
      const result = await runCodingAgent({
        instruction: "Create hello.txt",
        modelId: "anthropic/claude-sonnet-5-5",
        model: resolveAgentModel("anthropic/claude-sonnet-5-5"),
        tools: {
          cwd: work,
          spillDir: join(work, ".spill"),
          defaultCommandTimeoutSec: 30,
          images: true,
        },
        settings: {
          maxRounds: 10,
          maxToolResultChars: 60_000,
          maxHistoryChars: undefined,
          toolConcurrency: undefined,
          maxTokens: undefined,
          temperature: undefined,
          maxDurationMs: undefined,
          roundTimeoutMs: undefined,
          maxRoundRetries: undefined,
          systemPromptAppend: undefined,
          concise: true,
          announceTimeLeft: false,
          reviewPrompt: undefined,
        },
        signal: new AbortController().signal,
        stopAfterMs: 500,
        onEvent: (event) => events.push(event),
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.summary.outcome).toBe("budget");
      expect(result.summary.rounds).toBe(1);
      expect(result.summary.error).toMatch(/hard time limit/);
      expect(events.at(-1)?.type).toBe("finish");
    } finally {
      process.env.ANTHROPIC_BASE_URL = mockUrl;
      silent.closeAllConnections();
      silent.close();
    }
  });

  it("stops at the round cap", async () => {
    const result = await runCodingAgent({
      instruction: "Create hello.txt",
      modelId: "anthropic/claude-sonnet-5-5",
      model: resolveAgentModel("anthropic/claude-sonnet-5-5"),
      tools: {
        cwd: work,
        spillDir: join(work, ".spill"),
        defaultCommandTimeoutSec: 30,
        images: true,
      },
      settings: {
        maxRounds: 2,
        maxToolResultChars: 60_000,
        maxHistoryChars: undefined,
        toolConcurrency: undefined,
        maxTokens: undefined,
        temperature: undefined,
        maxDurationMs: undefined,
        roundTimeoutMs: undefined,
        maxRoundRetries: undefined,
        systemPromptAppend: undefined,
        concise: true,
        announceTimeLeft: false,
        reviewPrompt: undefined,
      },
      signal: new AbortController().signal,
    });
    expect(result.summary.outcome).toBe("max-rounds");
    expect(result.summary.rounds).toBe(2);
    expect(result.summary.finalText).toBe("");
  });

  it("asks for one review before finishing when given a review prompt", async () => {
    const result = await runCodingAgent({
      instruction: "Create hello.txt",
      modelId: "anthropic/claude-sonnet-5-5",
      model: resolveAgentModel("anthropic/claude-sonnet-5-5"),
      tools: {
        cwd: work,
        spillDir: join(work, ".spill"),
        defaultCommandTimeoutSec: 30,
        images: true,
      },
      settings: {
        maxRounds: 10,
        maxToolResultChars: 60_000,
        maxHistoryChars: undefined,
        toolConcurrency: undefined,
        maxTokens: undefined,
        temperature: undefined,
        maxDurationMs: undefined,
        roundTimeoutMs: undefined,
        maxRoundRetries: undefined,
        systemPromptAppend: undefined,
        concise: true,
        announceTimeLeft: false,
        reviewPrompt: "Check your work.",
      },
      signal: new AbortController().signal,
    });
    expect(result.summary.outcome).toBe("answered");
    expect(result.summary.rounds).toBe(5);
    expect(
      result.messages.filter(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("Check your work.")
      )
    ).toHaveLength(1);
  });
});
