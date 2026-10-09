/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  AiSessionContext,
  CheckpointPrefix,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
} from "@workglow/ai";
import {
  accumulatingEmit,
  AiProviderRegistry,
  getAiProviderRegistry,
  setAiProviderRegistry,
} from "@workglow/ai";
import type { LlamaCppModelRecord } from "@workglow/node-llama-cpp/ai";
import { LOCAL_LLAMACPP } from "@workglow/node-llama-cpp/ai";
import {
  deleteLlamaCppSession,
  llamaCppSessions,
  llamaCppTextContexts,
  registerLlamaCppInline,
  releaseLlamaCppTransientSessions,
} from "@workglow/node-llama-cpp/ai-runtime";
import type { StreamEvent, TaskOutput } from "@workglow/task-graph";
import { expectNoFinishAccumulation } from "@workglow/test-contract/ai-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkState = {
  failure: undefined as "chat-constructor" | "generate-sync" | "preload" | undefined,
  chatDisposeCount: 0,
  sessionDisposeCount: 0,
  chatSequences: [] as unknown[],
  generatedHistories: [] as any[][],
  preloadPrompts: [] as string[],
  sessionHistories: [] as any[][],
};

/** Nominal token counts the fake SDK "encodes" per preload / generated turn. */
const PREFIX_TOKENS = 7;
const TURN_TOKENS = 3;

function advanceFakeSequence(sequence: unknown, tokens: number): void {
  const seq = sequence as { nextTokenIndex?: number };
  if (typeof seq?.nextTokenIndex === "number") seq.nextTokenIndex += tokens;
}

vi.mock("node-llama-cpp", () => ({
  LlamaChat: class {
    readonly sequence: unknown;
    private disposed = false;

    constructor(options: { readonly contextSequence: unknown }) {
      if (sdkState.failure === "chat-constructor") {
        throw new Error("chat constructor failed");
      }
      this.sequence = options.contextSequence;
      sdkState.chatSequences.push(this.sequence);
    }

    generateResponse(
      history: any[],
      options: {
        readonly onResponseChunk: (chunk: {
          type: undefined;
          segmentType: undefined;
          text: string;
        }) => void;
        readonly signal: AbortSignal;
      }
    ): Promise<{
      readonly response: string;
      readonly functionCalls: ReadonlyArray<{
        readonly functionName: string;
        readonly params: Record<string, unknown>;
      }>;
      readonly lastEvaluation: { readonly cleanHistory: any[] };
    }> {
      sdkState.generatedHistories.push(structuredClone(history));
      if (sdkState.failure === "generate-sync") {
        throw new Error("generation failed synchronously");
      }
      if (options.signal.aborted) {
        return Promise.reject(options.signal.reason);
      }
      advanceFakeSequence(this.sequence, TURN_TOKENS);
      options.onResponseChunk({ type: undefined, segmentType: undefined, text: "calling" });
      const cleanHistory = [
        ...history,
        {
          type: "model",
          response: [
            "calling",
            {
              type: "functionCall",
              name: "lookup",
              description: "Look up a query",
              params: { query: "weather" },
            },
          ],
        },
      ];
      return Promise.resolve({
        response: "calling",
        functionCalls: [{ functionName: "lookup", params: { query: "weather" } }],
        lastEvaluation: { cleanHistory },
      });
    }

    async dispose(): Promise<void> {
      if (this.disposed) return;
      this.disposed = true;
      sdkState.chatDisposeCount += 1;
    }
  },
  LlamaChatSession: class {
    readonly sequence: unknown;
    private history: any[];
    private disposed = false;

    constructor(options: { readonly contextSequence: unknown; readonly systemPrompt?: string }) {
      this.sequence = options.contextSequence;
      this.history =
        options.systemPrompt === undefined ? [] : [{ type: "system", text: options.systemPrompt }];
    }

    async preloadPrompt(prompt: string): Promise<void> {
      sdkState.preloadPrompts.push(prompt);
      if (sdkState.failure === "preload") {
        throw new Error("preload failed");
      }
      advanceFakeSequence(this.sequence, PREFIX_TOKENS);
    }

    getChatHistory(): any[] {
      return structuredClone(this.history);
    }

    setChatHistory(history: any[]): void {
      this.history = structuredClone(history);
      sdkState.sessionHistories.push(structuredClone(history));
    }

    async dispose(): Promise<void> {
      if (this.disposed) return;
      this.disposed = true;
      sdkState.sessionDisposeCount += 1;
    }
  },
}));

const model: LlamaCppModelRecord = {
  model_id: "llamacpp:test-tool-checkpoint",
  title: "Test tool checkpoint model",
  description: "Provider-level checkpoint lifecycle fixture",
  capabilities: ["text.generation", "tool-use", "cache.checkpoint"],
  provider: LOCAL_LLAMACPP,
  provider_config: {
    model_path: "/tmp/test-tool-checkpoint.gguf",
  },
  metadata: {},
};

const tool = {
  name: "lookup",
  description: "Look up a query",
  inputSchema: {
    type: "object" as const,
    properties: { query: { type: "string" as const } },
    required: ["query"],
  },
};

const prefix: CheckpointPrefix = {
  systemPrompt: "Use the lookup tool.",
  tools: [tool],
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Remember this checkpoint prefix." }],
    },
  ],
};

function getRunFn(capabilities: readonly string[]): AiProviderRunFn {
  const runFn = getAiProviderRegistry().getRunFnFor(
    LOCAL_LLAMACPP,
    capabilities as Parameters<ReturnType<typeof getAiProviderRegistry>["getRunFnFor"]>[1]
  );
  expect(runFn).toBeDefined();
  return runFn!;
}

async function run(
  runFn: AiProviderRunFn,
  input: Record<string, unknown>,
  sessionContext: AiSessionContext | undefined,
  emitOverride?: Parameters<AiProviderRunFn>[3],
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  const { emit } = accumulatingEmit<TaskOutput>();
  await runFn(input, model, signal, emitOverride ?? emit, undefined, sessionContext);
}

async function warmCheckpoint(checkpointId: string): Promise<void> {
  await run(getRunFn(["cache.checkpoint"]), {}, { sessionId: checkpointId, prefix });
}

async function callTool(sessionContext: AiSessionContext | undefined): Promise<void> {
  await callToolWithPrompt("Find the weather.", sessionContext);
}

async function callToolWithPrompt(
  prompt: string,
  sessionContext: AiSessionContext | undefined,
  emitOverride?: Parameters<AiProviderRunFn>[3],
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  const input: ToolCallingTaskInput = {
    model,
    prompt,
    tools: [tool],
    toolChoice: "required",
    maxTokens: 16,
  };
  await run(
    getRunFn(["text.generation", "tool-use"]),
    input as unknown as Record<string, unknown>,
    sessionContext,
    emitOverride,
    signal
  );
}

/**
 * Runs one tool call through the run-fn and returns every event it emitted plus
 * what the terminal accumulator made of them — the same fold `TaskRunner` does.
 */
async function recordToolCall(sessionContext: AiSessionContext | undefined): Promise<{
  readonly events: StreamEvent<never>[];
  readonly output: ToolCallingTaskOutput;
}> {
  const events: StreamEvent<never>[] = [];
  const accumulator = accumulatingEmit<ToolCallingTaskOutput>();
  await callToolWithPrompt("Find the weather.", sessionContext, (event) => {
    events.push(event as StreamEvent<never>);
    accumulator.emit(event as StreamEvent<ToolCallingTaskOutput>);
  });
  return { events, output: accumulator.result() };
}

interface FakeSequence {
  readonly id: number;
  nextTokenIndex: number;
  readonly eraseContextTokenRanges: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
}

describe("LlamaCpp tool-calling checkpoint lifecycle", () => {
  const sequences: FakeSequence[] = [];

  beforeEach(async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    await registerLlamaCppInline({ queue: { autoCreate: false } });
    sdkState.failure = undefined;
    sdkState.chatDisposeCount = 0;
    sdkState.sessionDisposeCount = 0;
    sdkState.chatSequences.length = 0;
    sdkState.generatedHistories.length = 0;
    sdkState.preloadPrompts.length = 0;
    sdkState.sessionHistories.length = 0;
    sequences.length = 0;
    llamaCppSessions.clear();
    llamaCppTextContexts.clear();
    llamaCppTextContexts.set(model.provider_config.model_path, {
      get sequencesLeft() {
        return 4;
      },
      getSequence() {
        const sequence: FakeSequence = {
          id: sequences.length,
          nextTokenIndex: 0,
          eraseContextTokenRanges: vi.fn(async (ranges: Array<{ start: number; end: number }>) => {
            for (const { start, end } of ranges) {
              sequence.nextTokenIndex -= end - start;
            }
          }),
          dispose: vi.fn(async () => {}),
        };
        sequences.push(sequence);
        return sequence;
      },
    } as never);
  });

  afterEach(async () => {
    await releaseLlamaCppTransientSessions();
    llamaCppTextContexts.clear();
  });

  // Both `finish` emits are covered: the session-less path and the session path
  // (a fingerprint session and a consumed checkpoint both finish from the latter).
  it.each<readonly [string, AiSessionContext | undefined]>([
    ["without a session", undefined],
    ["with a progressive session", { sessionId: "tool-progressive" }],
    [
      "consuming a checkpoint",
      {
        sessionId: "checkpoint-parent",
        emitCheckpointId: "checkpoint-child",
        supersedeParent: true,
        prefix,
      },
    ],
  ])("streams text and a tool call %s, and finish carries neither", async (_, sessionContext) => {
    if (sessionContext?.prefix) await warmCheckpoint(sessionContext.sessionId!);

    const { events, output } = await recordToolCall(sessionContext);

    expectNoFinishAccumulation(events);
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
    expect(output.text).toBe("calling");
    expect(output.toolCalls).toEqual([
      { id: "call_0", name: "lookup", input: { query: "weather" } },
    ]);
  });

  it("consumes a warmed checkpoint session and retains it under the emitted id", async () => {
    await warmCheckpoint("checkpoint-parent");
    const warmed = llamaCppSessions.get("checkpoint-parent");
    expect(warmed).toBeDefined();

    await callTool({
      sessionId: "checkpoint-parent",
      emitCheckpointId: "checkpoint-child",
      supersedeParent: true,
      prefix,
    });

    expect(sdkState.chatSequences).toEqual([warmed!.sequence]);
    expect(sdkState.generatedHistories).toEqual([
      [
        {
          type: "system",
          text:
            "Use the lookup tool.\n\n" +
            "You must call at least one tool from the provided tool list when answering.",
        },
        { type: "user", text: "Remember this checkpoint prefix." },
        { type: "user", text: "Find the weather." },
      ],
    ]);
    expect(llamaCppSessions.has("checkpoint-parent")).toBe(false);
    expect(llamaCppSessions.get("checkpoint-child")?.sequence).toBe(warmed!.sequence);
  });

  it("reconstructs missing checkpoint state from the prefix before retaining the emit", async () => {
    await warmCheckpoint("checkpoint-missing");
    await deleteLlamaCppSession("checkpoint-missing");
    sdkState.preloadPrompts.length = 0;
    sdkState.sessionHistories.length = 0;

    await callTool({
      sessionId: "checkpoint-missing",
      emitCheckpointId: "checkpoint-rebuilt",
      supersedeParent: true,
      prefix,
    });

    // Fallback preloads an EMPTY prompt after setChatHistory + functions —
    // the raw "role: text" text renderer was removed by the checkpoint-prefix
    // fix so tool_use / tool_result blocks survive re-encoding.
    expect(sdkState.preloadPrompts).toEqual([""]);
    // The fallback's setChatHistory carries the prefix rendered through the
    // pure chat-history helper (no trailing empty-user placeholder).
    expect(sdkState.sessionHistories[0]).toEqual([
      { type: "system", text: "Use the lookup tool." },
      { type: "user", text: "Remember this checkpoint prefix." },
    ]);
    expect(sdkState.generatedHistories).toEqual([
      [
        {
          type: "system",
          text:
            "Use the lookup tool.\n\n" +
            "You must call at least one tool from the provided tool list when answering.",
        },
        { type: "user", text: "Remember this checkpoint prefix." },
        { type: "user", text: "Find the weather." },
      ],
    ]);
    expect(llamaCppSessions.has("checkpoint-missing")).toBe(false);
    expect(llamaCppSessions.get("checkpoint-rebuilt")?.sequence).toBe(sdkState.chatSequences[0]);
  });

  it("preserves prior tool_use / tool_result blocks in the reconstructed checkpoint prefix", async () => {
    // Emulate a checkpoint whose prefix already carries a prior tool exchange
    // (assistant tool_use + tool result). Before the fix, the raw text
    // renderer flattened messages to `role: text` and dropped these blocks
    // entirely, so a fallback re-encode would silently lose the exchange.
    const priorToolPrefix: CheckpointPrefix = {
      systemPrompt: "You are a helpful assistant.",
      tools: [tool],
      messages: [
        { role: "user", content: [{ type: "text", text: "What's the weather?" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_prior", name: "lookup", input: { query: "weather" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_prior",
              is_error: false,
              content: [{ type: "text", text: "sunny" }],
            },
          ],
        },
      ],
    };
    await run(
      getRunFn(["cache.checkpoint"]),
      {},
      {
        sessionId: "ckpt-with-tools",
        prefix: priorToolPrefix,
      }
    );
    await deleteLlamaCppSession("ckpt-with-tools");
    sdkState.preloadPrompts.length = 0;
    sdkState.sessionHistories.length = 0;

    await callToolWithPrompt("Any updates?", {
      sessionId: "ckpt-with-tools",
      prefix: priorToolPrefix,
    });

    expect(sdkState.preloadPrompts).toEqual([""]);
    // The reconstructed fallback history must include the prior tool_use as a
    // `functionCall` inside the model turn, with the tool's result merged in.
    const fallbackHistory = sdkState.sessionHistories[0];
    expect(fallbackHistory).toEqual([
      { type: "system", text: "You are a helpful assistant." },
      { type: "user", text: "What's the weather?" },
      {
        type: "model",
        response: [
          "Let me check.",
          {
            type: "functionCall",
            name: "lookup",
            description: undefined,
            params: { query: "weather" },
            result: "sunny",
          },
        ],
      },
    ]);
  });

  it("retains the emitted tool turn in session history and replays it on consumption", async () => {
    await warmCheckpoint("checkpoint-parent");
    await callTool({
      sessionId: "checkpoint-parent",
      emitCheckpointId: "checkpoint-child",
      supersedeParent: true,
      prefix,
    });

    const emitted = llamaCppSessions.get("checkpoint-child");
    expect(emitted).toBeDefined();
    expect(emitted!.session.getChatHistory().at(-1)).toEqual({
      type: "model",
      response: [
        "calling",
        {
          type: "functionCall",
          name: "lookup",
          description: "Look up a query",
          params: { query: "weather" },
        },
      ],
    });

    const emittedPrefix: CheckpointPrefix = {
      ...prefix,
      messages: [
        ...prefix.messages!,
        { role: "user", content: [{ type: "text", text: "Find the weather." }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            {
              type: "tool_use",
              id: "call_0",
              name: "lookup",
              input: { query: "weather" },
            },
          ],
        },
      ],
    };
    sdkState.generatedHistories.length = 0;

    await callToolWithPrompt("Use the previous tool turn.", {
      sessionId: "checkpoint-child",
      prefix: emittedPrefix,
    });

    expect(sdkState.generatedHistories[0]).toEqual([
      {
        type: "system",
        text:
          "Use the lookup tool.\n\n" +
          "You must call at least one tool from the provided tool list when answering.",
      },
      { type: "user", text: "Remember this checkpoint prefix." },
      { type: "user", text: "Find the weather." },
      {
        type: "model",
        response: [
          "calling",
          {
            type: "functionCall",
            name: "lookup",
            description: undefined,
            params: { query: "weather" },
            result: undefined,
          },
        ],
      },
      { type: "user", text: "Use the previous tool turn." },
    ]);
  });

  it("keeps calls without session context ephemeral", async () => {
    await callTool(undefined);

    expect(llamaCppSessions.size).toBe(0);
    expect(sequences).toHaveLength(1);
    expect(sdkState.chatDisposeCount).toBe(1);
    expect(sequences[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes checkpoint resources when generation throws synchronously", async () => {
    await warmCheckpoint("checkpoint-parent");
    sdkState.failure = "generate-sync";
    sdkState.chatDisposeCount = 0;
    sdkState.sessionDisposeCount = 0;

    await expect(
      callTool({
        sessionId: "checkpoint-parent",
        emitCheckpointId: "checkpoint-child",
        prefix,
      })
    ).rejects.toThrow("generation failed synchronously");

    expect(sdkState.chatDisposeCount).toBe(1);
    expect(sdkState.sessionDisposeCount).toBe(1);
    expect(sequences[0].dispose).toHaveBeenCalledTimes(1);
    expect(llamaCppSessions.has("checkpoint-parent")).toBe(false);
    expect(llamaCppSessions.has("checkpoint-child")).toBe(false);
  });

  it("settles generation and disposes resources when delta emission throws", async () => {
    await warmCheckpoint("checkpoint-parent");
    sdkState.chatDisposeCount = 0;
    sdkState.sessionDisposeCount = 0;

    await expect(
      callToolWithPrompt(
        "Find the weather.",
        {
          sessionId: "checkpoint-parent",
          emitCheckpointId: "checkpoint-child",
          prefix,
        },
        (event) => {
          if (event.type === "text-delta") throw new Error("delta emit failed");
        }
      )
    ).rejects.toThrow("delta emit failed");

    expect(sdkState.chatDisposeCount).toBe(1);
    expect(sdkState.sessionDisposeCount).toBe(1);
    expect(sequences[0].dispose).toHaveBeenCalledTimes(1);
    expect(llamaCppSessions.has("checkpoint-child")).toBe(false);
  });

  it("disposes checkpoint resources when generation aborts", async () => {
    await warmCheckpoint("checkpoint-parent");
    sdkState.chatDisposeCount = 0;
    sdkState.sessionDisposeCount = 0;
    const controller = new AbortController();
    controller.abort(new Error("generation aborted"));

    await expect(
      callToolWithPrompt(
        "Find the weather.",
        {
          sessionId: "checkpoint-parent",
          emitCheckpointId: "checkpoint-child",
          prefix,
        },
        undefined,
        controller.signal
      )
    ).rejects.toThrow("generation aborted");

    expect(sdkState.chatDisposeCount).toBe(1);
    expect(sdkState.sessionDisposeCount).toBe(1);
    expect(sequences[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the consumed session and sequence when LlamaChat construction fails", async () => {
    await warmCheckpoint("checkpoint-parent");
    sdkState.failure = "chat-constructor";
    sdkState.sessionDisposeCount = 0;

    await expect(
      callTool({
        sessionId: "checkpoint-parent",
        emitCheckpointId: "checkpoint-child",
        prefix,
      })
    ).rejects.toThrow("chat constructor failed");

    expect(sdkState.sessionDisposeCount).toBe(1);
    expect(sequences[0].dispose).toHaveBeenCalledTimes(1);
    expect(llamaCppSessions.has("checkpoint-child")).toBe(false);
  });

  it("disposes a reconstructed session and sequence when prefix preload fails", async () => {
    sdkState.failure = "preload";

    await expect(warmCheckpoint("checkpoint-failed")).rejects.toThrow("preload failed");

    expect(sdkState.sessionDisposeCount).toBe(1);
    expect(sequences[0].dispose).toHaveBeenCalledTimes(1);
    expect(llamaCppSessions.has("checkpoint-failed")).toBe(false);
  });

  it("serializes concurrent consumers of the same checkpoint — winner reuses the warmed sequence, loser re-encodes on its own", async () => {
    await warmCheckpoint("checkpoint-shared");
    const warmed = llamaCppSessions.get("checkpoint-shared");
    expect(warmed).toBeDefined();
    // Isolate the assertions below to the consumer path — the warm-up's
    // own preload / setChatHistory would otherwise be counted twice.
    sdkState.preloadPrompts.length = 0;
    sdkState.sessionHistories.length = 0;

    // Two concurrent consumers of the same immutable checkpoint id.
    // Before the fix, both took the same reference to `warmed` and both
    // called generateResponse on the shared LlamaContextSequence — a live
    // sequence advances in place, so the second consumer's turn was
    // corrupted. With stealLlamaCppSession, exactly one wins; the other
    // observes `undefined` and re-encodes via the missing-state fallback.
    await Promise.all([
      callToolWithPrompt("Consumer A prompt.", { sessionId: "checkpoint-shared", prefix }),
      callToolWithPrompt("Consumer B prompt.", { sessionId: "checkpoint-shared", prefix }),
    ]);

    // Exactly two LlamaChat generations happened — one on the warmed
    // sequence (winner) and one on a re-encoded sequence (loser).
    expect(sdkState.chatSequences).toHaveLength(2);
    expect(sdkState.chatSequences).toContain(warmed!.sequence);
    // The loser's sequence is a fresh one, not the warmed shared one.
    const distinctSequences = new Set(sdkState.chatSequences);
    expect(distinctSequences.size).toBe(2);
    // Exactly one finisher restored its rewound session under the checkpoint
    // id (the other disposed instead of overwriting the restored entry).
    expect(llamaCppSessions.has("checkpoint-shared")).toBe(true);
    // Exactly one loser preloaded via the fallback (empty preload after
    // setChatHistory + functions); the winner did not preload.
    expect(sdkState.preloadPrompts).toEqual([""]);
  });

  it("restores the consumed checkpoint so a second consumption reuses the warmed state", async () => {
    await warmCheckpoint("checkpoint-reuse");
    const warmed = llamaCppSessions.get("checkpoint-reuse");
    expect(warmed).toBeDefined();
    const warmedSequence = warmed!.sequence as FakeSequence;
    expect(warmedSequence.nextTokenIndex).toBe(PREFIX_TOKENS);
    sdkState.preloadPrompts.length = 0;
    sdkState.sessionHistories.length = 0;

    await callToolWithPrompt("First consumption.", { sessionId: "checkpoint-reuse", prefix });

    // Restored under the checkpoint id: same sequence, KV rewound back to the
    // prefix boundary, session history reset to the prefix rendering.
    expect(llamaCppSessions.get("checkpoint-reuse")?.sequence).toBe(warmedSequence);
    expect(warmedSequence.eraseContextTokenRanges).toHaveBeenCalledWith([
      { start: PREFIX_TOKENS, end: PREFIX_TOKENS + TURN_TOKENS },
    ]);
    expect(warmedSequence.nextTokenIndex).toBe(PREFIX_TOKENS);
    expect(sdkState.sessionHistories.at(-1)).toEqual([
      { type: "system", text: "Use the lookup tool." },
      { type: "user", text: "Remember this checkpoint prefix." },
    ]);

    await callToolWithPrompt("Second consumption.", { sessionId: "checkpoint-reuse", prefix });

    // The second consumption generated on the same warmed sequence and no
    // prefix re-encode (preload) ever happened.
    expect(sdkState.chatSequences).toEqual([warmedSequence, warmedSequence]);
    expect(sdkState.preloadPrompts).toEqual([]);
    expect(llamaCppSessions.get("checkpoint-reuse")?.sequence).toBe(warmedSequence);
  });

  it("keeps the parent's warmed state on a non-superseding emit (emitted id gets no local state)", async () => {
    await warmCheckpoint("checkpoint-keep");
    const warmed = llamaCppSessions.get("checkpoint-keep");
    expect(warmed).toBeDefined();

    // keepParentCheckpoint flow: the task layer omits supersedeParent.
    await callTool({
      sessionId: "checkpoint-keep",
      emitCheckpointId: "checkpoint-branch",
      prefix,
    });

    // The parent keeps its warmed state; the emitted id carries no local KV
    // state (its consumers take the documented re-encode fallback).
    expect(llamaCppSessions.get("checkpoint-keep")?.sequence).toBe(warmed!.sequence);
    expect(llamaCppSessions.has("checkpoint-branch")).toBe(false);
  });

  it('treats an explicit "" systemPrompt as absent — the prefix system prompt still applies', async () => {
    await warmCheckpoint("checkpoint-empty-system");

    const input: ToolCallingTaskInput = {
      model,
      prompt: "Find the weather.",
      systemPrompt: "",
      tools: [tool],
      toolChoice: "required",
      maxTokens: 16,
    };
    await run(
      getRunFn(["text.generation", "tool-use"]),
      input as unknown as Record<string, unknown>,
      {
        sessionId: "checkpoint-empty-system",
        prefix,
      }
    );

    // `systemPrompt: ""` must fall through to the checkpoint prefix's system
    // prompt (`||`, not `??`) — matching the other providers.
    expect(sdkState.generatedHistories[0][0]).toEqual({
      type: "system",
      text:
        "Use the lookup tool.\n\n" +
        "You must call at least one tool from the provided tool list when answering.",
    });
  });

  it("keeps ownedSession entries when two concurrent runs race for the same id", async () => {
    // Regression: the ownedSession path (AiChatTask's per-turn mutable
    // session) must NOT be stolen — only immutable checkpoints. Two racing
    // ownedSession consumers still see the same cached session.
    const state = {
      mode: "progressive" as const,
      sequence: { dispose: vi.fn(async () => {}) } as unknown,
      session: {
        setChatHistory: () => {},
        getChatHistory: () => [],
        preloadPrompt: async () => {},
        dispose: async () => {
          sdkState.sessionDisposeCount += 1;
        },
      } as unknown,
      modelKey: "test",
    };
    llamaCppSessions.set("owned-session", state);

    // Two racers with `ownedSession: true` (a checkpoint-seeded AiChat) —
    // both observe the same cached state, and the entry survives.
    await Promise.all([
      callToolWithPrompt("Owned A.", {
        sessionId: "owned-session",
        prefix,
        ownedSession: true,
      }),
      callToolWithPrompt("Owned B.", {
        sessionId: "owned-session",
        prefix,
        ownedSession: true,
      }),
    ]);

    // The map entry is preserved for the owning caller.
    expect(llamaCppSessions.has("owned-session")).toBe(true);
    expect(llamaCppSessions.get("owned-session")).toBe(state);
  });
});
