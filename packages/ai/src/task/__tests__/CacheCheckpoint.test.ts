/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  AiProviderRunFnRegistration,
  AiSessionContext,
  Capability,
  CheckpointEntry,
  ModelConfig,
} from "@workglow/ai";
import {
  AiChatTask,
  AiProvider,
  AiProviderRegistry,
  CACHE_STORAGE_TOKEN_HOURS_KEY,
  CAPABILITIES,
  CacheCheckpointTask,
  TextGenerationTask,
  ToolCallingTask,
  cacheCheckpoint,
  checkpointModelKey,
  deleteCheckpoint,
  getAiProviderRegistry,
  getCheckpoint,
  registerCheckpoint,
  requireCheckpointModelKey,
  setAiProviderRegistry,
} from "@workglow/ai";
import { clearCheckpoints as clearCheckpointsForTesting } from "@workglow/ai/test";
import type { IExecuteContext, StreamEvent, TaskOutput, Usage } from "@workglow/task-graph";
import { TaskGraph, TaskGraphRunner } from "@workglow/task-graph";
import { Container, HUMAN_CONNECTOR, ResourceScope, ServiceRegistry } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("cache.checkpoint capability", () => {
  it("is a recognized capability", () => {
    expect(CAPABILITIES["cache.checkpoint"]).toBeDefined();
  });
});

describe("CheckpointRegistry", () => {
  beforeEach(() => {
    clearCheckpointsForTesting();
  });

  const entry: CheckpointEntry = {
    provider: "TEST_PROVIDER",
    modelKey: "test:model:v1",
    prefix: {
      systemPrompt: "You are helpful.",
      tools: [{ name: "a", description: "A", inputSchema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    },
    modelId: undefined,
  };

  it("registers and retrieves an entry", () => {
    registerCheckpoint("ckpt-1", entry);
    expect(getCheckpoint("ckpt-1")).toEqual(entry);
  });

  it("returns undefined for unknown ids", () => {
    expect(getCheckpoint("nope")).toBeUndefined();
  });

  it("deletes entries", () => {
    registerCheckpoint("ckpt-1", entry);
    expect(deleteCheckpoint("ckpt-1")).toBe(true);
    expect(getCheckpoint("ckpt-1")).toBeUndefined();
    expect(deleteCheckpoint("ckpt-1")).toBe(false);
  });

  it("checkpointModelKey uses model_id and falls back to empty string", () => {
    expect(checkpointModelKey({ model_id: "m1" } as unknown as ModelConfig)).toBe("m1");
    expect(checkpointModelKey({} as ModelConfig)).toBe("");
  });
});

describe("requireCheckpointModelKey", () => {
  it("returns model_id for a valid model", () => {
    expect(
      requireCheckpointModelKey({ model_id: "m1" } as unknown as ModelConfig, "TestTask")
    ).toBe("m1");
  });

  it("throws TaskConfigurationError when model has no model_id", () => {
    expect(() => requireCheckpointModelKey({} as ModelConfig, "TestTask")).toThrow(/no model_id/i);
  });

  it("throws when model_id is a non-string value", () => {
    expect(() =>
      requireCheckpointModelKey({ model_id: 42 } as unknown as ModelConfig, "TestTask")
    ).toThrow(/no model_id/i);
  });

  it("carries the taskType in the error message", () => {
    let caught: unknown;
    try {
      requireCheckpointModelKey({} as ModelConfig, "SpecificTaskName");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("SpecificTaskName");
  });
});

const CKPT_PROVIDER = "checkpoint-test-provider";
const CACHE_CHECKPOINT: readonly Capability[] = ["cache.checkpoint"];

function checkpointModel(): ModelConfig {
  return {
    model_id: "test:ckpt-model:v1",
    title: "ckpt-model",
    description: "ckpt-model",
    capabilities: ["cache.checkpoint", "text.generation"],
    provider: CKPT_PROVIDER,
    provider_config: {},
    metadata: {},
  } as unknown as ModelConfig;
}

class CheckpointTestProvider extends AiProvider {
  readonly name = CKPT_PROVIDER;
  readonly displayName = "Checkpoint Test";
  readonly isLocal = true;
  readonly supportsBrowser = true;
  readonly supportsServer = true;
  constructor(runFns?: readonly AiProviderRunFnRegistration[]) {
    super(runFns);
  }
}

describe("CacheCheckpointTask", () => {
  let warmupCalls: { session: AiSessionContext | undefined }[];

  const warmupFn: AiProviderRunFn = async (_input, _model, _signal, emit, _schema, session) => {
    warmupCalls.push({ session });
    emit({
      type: "finish",
      data: { checkpoint: session?.sessionId ?? "" },
    } as unknown as StreamEvent<TaskOutput>);
  };

  beforeEach(async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    clearCheckpointsForTesting();
    warmupCalls = [];
    const provider = new CheckpointTestProvider([
      { serves: CACHE_CHECKPOINT as Capability[], runFn: warmupFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });
  });

  afterEach(() => {
    setAiProviderRegistry(new AiProviderRegistry());
  });

  it("exposes its task type and required capability", () => {
    expect(CacheCheckpointTask.type).toBe("CacheCheckpointTask");
    expect(CacheCheckpointTask.requires).toContain("cache.checkpoint");
  });

  it("warms once and outputs the minted checkpoint id", async () => {
    const scope = new ResourceScope();
    const out = await cacheCheckpoint(
      {
        model: checkpointModel(),
        systemPrompt: "You are helpful.",
        tools: [{ name: "a", description: "A", inputSchema: { type: "object" } }],
      },
      undefined,
      { resourceScope: scope }
    );
    expect(warmupCalls).toHaveLength(1);
    expect(out?.checkpoint).toBe(warmupCalls[0].session?.sessionId);
    const entry = getCheckpoint(out!.checkpoint);
    expect(entry?.provider).toBe(CKPT_PROVIDER);
    expect(entry?.prefix.systemPrompt).toBe("You are helpful.");
    expect(warmupCalls[0].session?.prefix?.tools).toHaveLength(1);
  });

  it("disposes the checkpoint when the run's ResourceScope completes", async () => {
    const scope = new ResourceScope();
    const out = await cacheCheckpoint(
      { model: checkpointModel(), systemPrompt: "You are helpful." },
      undefined,
      { resourceScope: scope }
    );
    expect(getCheckpoint(out!.checkpoint)).toBeDefined();
    const disposeSpy = vi.spyOn(getAiProviderRegistry(), "disposeSession");
    await scope.runComplete();
    expect(getCheckpoint(out!.checkpoint)).toBeUndefined();
    expect(disposeSpy).toHaveBeenCalledWith(CKPT_PROVIDER, out!.checkpoint);
  });

  it("without a shared scope the handle is gone once the run resolves", async () => {
    const out = await cacheCheckpoint({
      model: checkpointModel(),
      systemPrompt: "You are helpful.",
    });
    expect(out?.checkpoint).toBeTruthy();
    expect(getCheckpoint(out!.checkpoint)).toBeUndefined();
  });

  it("extends a parent checkpoint and supersedes it by default", async () => {
    const scope = new ResourceScope();
    const first = await cacheCheckpoint(
      {
        model: checkpointModel(),
        systemPrompt: "sys",
        messages: [{ role: "user", content: [{ type: "text", text: "one" }] }],
      },
      undefined,
      { resourceScope: scope }
    );
    const disposeSpy = vi.spyOn(getAiProviderRegistry(), "disposeSession");
    const second = await cacheCheckpoint(
      {
        model: checkpointModel(),
        checkpoint: first!.checkpoint,
        messages: [{ role: "user", content: [{ type: "text", text: "two" }] }],
      },
      undefined,
      { resourceScope: scope }
    );
    const entry = getCheckpoint(second!.checkpoint);
    expect(entry?.parentId).toBe(first!.checkpoint);
    expect(entry?.prefix.systemPrompt).toBe("sys");
    expect(entry?.prefix.messages).toHaveLength(2);
    expect(getCheckpoint(first!.checkpoint)).toBeUndefined();
    expect(disposeSpy).toHaveBeenCalledWith(CKPT_PROVIDER, first!.checkpoint);
  });

  it("keepParent preserves the parent entry", async () => {
    const scope = new ResourceScope();
    const first = await cacheCheckpoint(
      { model: checkpointModel(), systemPrompt: "sys" },
      undefined,
      { resourceScope: scope }
    );
    const second = await cacheCheckpoint(
      {
        model: checkpointModel(),
        checkpoint: first!.checkpoint,
        keepParent: true,
        messages: [{ role: "user", content: [{ type: "text", text: "tail" }] }],
      },
      undefined,
      { resourceScope: scope }
    );
    expect(getCheckpoint(first!.checkpoint)).toBeDefined();
    expect(getCheckpoint(second!.checkpoint)?.parentId).toBe(first!.checkpoint);
  });

  it("rejects an unknown parent checkpoint", async () => {
    await expect(
      cacheCheckpoint({ model: checkpointModel(), checkpoint: "missing-ckpt" })
    ).rejects.toThrow(/unknown cache checkpoint/i);
  });

  it("rejects a provider-mismatched parent checkpoint", async () => {
    registerCheckpoint("foreign", {
      provider: "OTHER_PROVIDER",
      modelKey: "",
      prefix: {},
      modelId: undefined,
    });
    await expect(
      cacheCheckpoint({ model: checkpointModel(), checkpoint: "foreign" })
    ).rejects.toThrow(/provider/i);
  });
});

describe("CacheCheckpointTask storage-cost emission at disposal", () => {
  // A provider whose disposal reports what a billed server-side cache
  // released (Gemini's shape): tokens held, and for how long.
  class BillingCheckpointProvider extends CheckpointTestProvider {
    override async disposeSession(_sessionId: string): Promise<{
      tokens: number | undefined;
      lifetimeMs: number;
    }> {
      return { tokens: 500_000, lifetimeMs: 3_600_000 };
    }
  }

  const billingWarmupFn: AiProviderRunFn = async (
    _input,
    _model,
    _signal,
    emit,
    _schema,
    session
  ) => {
    emit({
      type: "finish",
      data: { checkpoint: session?.sessionId ?? "" },
    } as unknown as StreamEvent<TaskOutput>);
  };

  afterEach(() => {
    setAiProviderRegistry(new AiProviderRegistry());
  });

  it("emits a cacheStorageTokenHours usage event sized from the disposed tokens and lifetime", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const provider = new BillingCheckpointProvider([
      { serves: CACHE_CHECKPOINT as Capability[], runFn: billingWarmupFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });

    const scope = new ResourceScope();
    const task = new CacheCheckpointTask();
    const usageEvents: { usage: Usage; modelId: string | undefined }[] = [];
    task.on("usage", (usage, modelId) => usageEvents.push({ usage, modelId }));

    await task.run({ model: checkpointModel(), systemPrompt: "sys" }, { resourceScope: scope });
    // The charge is not known until the cache is actually released.
    expect(usageEvents).toHaveLength(0);

    await scope.runComplete();

    expect(usageEvents).toHaveLength(1);
    // 500,000 tokens held for 3,600,000ms (1 hour) = 500,000 token-hours.
    expect(usageEvents[0].usage.extra?.[CACHE_STORAGE_TOKEN_HOURS_KEY]).toBeCloseTo(500_000, 6);
    expect(usageEvents[0].modelId).toBe(checkpointModel().model_id);
  });

  it("emits nothing when the provider reports no tokens at disposal", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const provider = new CheckpointTestProvider([
      { serves: CACHE_CHECKPOINT as Capability[], runFn: billingWarmupFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });

    const scope = new ResourceScope();
    const task = new CacheCheckpointTask();
    const usageEvents: unknown[] = [];
    task.on("usage", (usage) => usageEvents.push(usage));

    await task.run({ model: checkpointModel(), systemPrompt: "sys" }, { resourceScope: scope });
    await scope.runComplete();

    expect(usageEvents).toHaveLength(0);
  });

  it("a throwing usage listener does not prevent the checkpoint from being released", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const provider = new BillingCheckpointProvider([
      { serves: CACHE_CHECKPOINT as Capability[], runFn: billingWarmupFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });

    const scope = new ResourceScope();
    const task = new CacheCheckpointTask();
    task.on("usage", () => {
      throw new Error("listener exploded");
    });

    const out = await task.run(
      { model: checkpointModel(), systemPrompt: "sys" },
      { resourceScope: scope }
    );
    expect(getCheckpoint(out!.checkpoint)).toBeDefined();

    // The disposer must complete (and the registry entry must still be
    // removed) even though the usage listener threw.
    // Resolving IS the assertion: `runComplete()` returns `Promise<void>`, so
    // `toBeUndefined` says "settled, did not reject" on both runners, where
    // `resolves.not.toThrow()` only says it under Vitest.
    await expect(scope.runComplete()).resolves.toBeUndefined();
    expect(getCheckpoint(out!.checkpoint)).toBeUndefined();
  });

  it("charges a superseded parent to the task that minted it, not to whoever disposed it", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const provider = new BillingCheckpointProvider([
      { serves: CACHE_CHECKPOINT as Capability[], runFn: billingWarmupFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });

    const scope = new ResourceScope();

    const parentTask = new CacheCheckpointTask();
    const parentUsage: Usage[] = [];
    parentTask.on("usage", (usage) => parentUsage.push(usage));
    const parent = await parentTask.run(
      { model: checkpointModel(), systemPrompt: "sys" },
      { resourceScope: scope }
    );

    const childTask = new CacheCheckpointTask();
    const childUsage: Usage[] = [];
    childTask.on("usage", (usage) => childUsage.push(usage));
    await childTask.run(
      {
        model: checkpointModel(),
        checkpoint: parent!.checkpoint,
        messages: [{ role: "user", content: [{ type: "text", text: "tail" }] }],
      },
      { resourceScope: scope }
    );

    // The child's warm-up superseded and disposed the parent inline. That is a
    // different task from the parent's own scope disposer, and the charge must
    // still land on the parent — a chain used to report only its last link.
    expect(parentUsage).toHaveLength(1);
    expect(parentUsage[0].extra?.[CACHE_STORAGE_TOKEN_HOURS_KEY]).toBeCloseTo(500_000, 6);
    expect(childUsage).toHaveLength(0);

    await scope.runComplete();

    // The child is charged once, at run end, for its own lifetime.
    expect(parentUsage).toHaveLength(1);
    expect(childUsage).toHaveLength(1);
    expect(childUsage[0].extra?.[CACHE_STORAGE_TOKEN_HOURS_KEY]).toBeCloseTo(500_000, 6);
  });

  it("charges every link of a three-checkpoint chain exactly once", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const provider = new BillingCheckpointProvider([
      { serves: CACHE_CHECKPOINT as Capability[], runFn: billingWarmupFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });

    const scope = new ResourceScope();
    const charges: number[][] = [];
    let handle: string | undefined;

    for (let link = 0; link < 3; link++) {
      const task = new CacheCheckpointTask();
      const seen: number[] = [];
      charges.push(seen);
      task.on("usage", (usage) => {
        const hours = usage.extra?.[CACHE_STORAGE_TOKEN_HOURS_KEY];
        if (typeof hours === "number") seen.push(hours);
      });
      const out = await task.run(
        {
          model: checkpointModel(),
          ...(handle ? { checkpoint: handle } : { systemPrompt: "sys" }),
          messages: [{ role: "user", content: [{ type: "text", text: `turn ${link}` }] }],
        },
        { resourceScope: scope }
      );
      handle = out!.checkpoint;
    }

    // Each superseded parent is charged when its successor disposes it, not
    // deferred to run end — the survivor is the only one still outstanding.
    expect(charges.map((c) => c.length)).toEqual([1, 1, 0]);

    await scope.runComplete();

    // Three checkpoints, three charges — one each, none double-counted.
    expect(charges.map((c) => c.length)).toEqual([1, 1, 1]);
    for (const seen of charges) expect(seen[0]).toBeCloseTo(500_000, 6);
  });
});

describe("CacheCheckpointTask storage cost inside a graph", () => {
  // Same shape as the standalone suite above: disposal reports what a billed
  // server-side cache released.
  class BillingCheckpointProvider extends CheckpointTestProvider {
    override async disposeSession(_sessionId: string): Promise<{
      tokens: number | undefined;
      lifetimeMs: number;
    }> {
      return { tokens: 500_000, lifetimeMs: 3_600_000 };
    }
  }

  const billingWarmupFn: AiProviderRunFn = async (
    _input,
    _model,
    _signal,
    emit,
    _schema,
    session
  ) => {
    emit({
      type: "finish",
      data: { checkpoint: session?.sessionId ?? "" },
    } as unknown as StreamEvent<TaskOutput>);
  };

  afterEach(() => {
    setAiProviderRegistry(new AiProviderRegistry());
  });

  it("charges the run total for a checkpoint disposed at run end", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const provider = new BillingCheckpointProvider([
      { serves: CACHE_CHECKPOINT as Capability[], runFn: billingWarmupFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });

    const graph = new TaskGraph();
    graph.addTask(
      new CacheCheckpointTask({
        id: "warm",
        defaults: { model: checkpointModel(), systemPrompt: "sys" },
      })
    );

    // runGraph owns the ResourceScope, so it disposes the checkpoint — and
    // therefore learns its storage charge — after the run's usage has settled.
    await new TaskGraphRunner(graph).runGraph();

    expect(graph.runUsage?.extra?.[CACHE_STORAGE_TOKEN_HOURS_KEY]).toBeCloseTo(500_000, 6);
    const byModel = graph.usageAggregator.byModel().get(checkpointModel().model_id!);
    expect(byModel?.extra?.[CACHE_STORAGE_TOKEN_HOURS_KEY]).toBeCloseTo(500_000, 6);
  });
});

describe("ToolCallingTask checkpoint ports", () => {
  let toolCalls: { session: AiSessionContext | undefined }[];
  let withNativeTurn = false;

  const toolUseFn: AiProviderRunFn = async (_input, _model, _signal, emit, _schema, session) => {
    toolCalls.push({ session });
    if (withNativeTurn) {
      emit({ type: "text-delta", port: "reasoning", textDelta: "thought" } as any);
      emit({
        type: "object-delta",
        port: "nativeTurn",
        objectDelta: { provider: "p:m", payload: "SIGNED" },
      } as any);
    }
    emit({ type: "text-delta", port: "text", textDelta: "done" } as any);
    emit({ type: "finish", data: { text: "", toolCalls: [] } } as any);
  };

  function toolModel(): ModelConfig {
    return {
      ...checkpointModel(),
      capabilities: ["text.generation", "tool-use", "cache.checkpoint"],
    } as unknown as ModelConfig;
  }

  const aTool = { name: "a", description: "A", inputSchema: { type: "object" as const } };

  // Checkpoint ports require the provider to serve cache.checkpoint
  // (resolveCheckpointSession gates on it before dispatch).
  const ckptWarmFn: AiProviderRunFn = async (_input, _model, _signal, emit, _schema, session) => {
    emit({ type: "finish", data: { checkpoint: session?.sessionId ?? "" } } as any);
  };

  beforeEach(async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    clearCheckpointsForTesting();
    toolCalls = [];
    withNativeTurn = false;
    const provider = new CheckpointTestProvider([
      { serves: ["text.generation", "tool-use"] as Capability[], runFn: toolUseFn },
      { serves: ["cache.checkpoint"] as Capability[], runFn: ckptWarmFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });
  });

  it("consumes a checkpoint: session carries the id and prefix", async () => {
    registerCheckpoint("ckpt-parent", {
      provider: CKPT_PROVIDER,
      modelKey: "test:ckpt-model:v1",
      prefix: { systemPrompt: "sys", tools: [aTool], messages: [] },
      modelId: undefined,
    });
    const task = new ToolCallingTask();
    await task.run({ model: toolModel(), prompt: "hi", tools: [aTool], checkpoint: "ckpt-parent" });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].session?.sessionId).toBe("ckpt-parent");
    expect(toolCalls[0].session?.prefix?.systemPrompt).toBe("sys");
  });

  it("emitCheckpoint mints a new id, registers the turn, supersedes the parent", async () => {
    registerCheckpoint("ckpt-parent", {
      provider: CKPT_PROVIDER,
      modelKey: "test:ckpt-model:v1",
      prefix: { systemPrompt: "sys", tools: [aTool], messages: [] },
      modelId: undefined,
    });
    const scope = new ResourceScope();
    const task = new ToolCallingTask();
    const out = await task.run(
      {
        model: toolModel(),
        prompt: "hi",
        tools: [aTool],
        checkpoint: "ckpt-parent",
        emitCheckpoint: true,
      },
      { resourceScope: scope }
    );
    const emitted = (out as { checkpoint?: string }).checkpoint;
    expect(emitted).toBeTruthy();
    expect(toolCalls[0].session?.emitCheckpointId).toBe(emitted);
    expect(toolCalls[0].session?.supersedeParent).toBe(true);
    const entry = getCheckpoint(emitted!);
    expect(entry?.parentId).toBe("ckpt-parent");
    // parent superseded
    expect(getCheckpoint("ckpt-parent")).toBeUndefined();
    // new prefix = parent messages + user turn + assistant turn
    expect(entry?.prefix.messages?.at(-1)?.role).toBe("assistant");
    expect(entry?.prefix.messages?.at(-2)?.role).toBe("user");
  });

  it("records the turn's reasoning and native turn in the emitted checkpoint", async () => {
    withNativeTurn = true;
    const scope = new ResourceScope();
    const out = await new ToolCallingTask().run(
      { model: toolModel(), prompt: "hi", tools: [aTool], emitCheckpoint: true },
      { resourceScope: scope }
    );
    const entry = getCheckpoint((out as { checkpoint?: string }).checkpoint!);
    expect(entry?.prefix.messages?.at(-1)).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thought", provider: "p:m", payload: "SIGNED" },
        { type: "text", text: "done" },
      ],
    });
  });

  it("records a tool call's provider signature in the emitted checkpoint", async () => {
    const signedCall = async (_i: any, _m: any, _s: any, emit: any) => {
      emit({
        type: "object-delta",
        port: "toolCalls",
        objectDelta: [{ id: "c1", name: "a", input: {}, providerSignature: "SIG" }],
      });
      emit({ type: "finish", data: { text: "", toolCalls: [] } });
    };
    setAiProviderRegistry(new AiProviderRegistry());
    clearCheckpointsForTesting();
    await new CheckpointTestProvider([
      { serves: ["text.generation", "tool-use"] as Capability[], runFn: signedCall as any },
      { serves: ["cache.checkpoint"] as Capability[], runFn: ckptWarmFn },
    ]).register({ queue: { autoCreate: false } });
    const out = await new ToolCallingTask().run(
      { model: toolModel(), prompt: "hi", tools: [aTool], emitCheckpoint: true },
      { resourceScope: new ResourceScope() }
    );
    const entry = getCheckpoint((out as { checkpoint?: string }).checkpoint!);
    expect(entry?.prefix.messages?.at(-1)?.content).toEqual([
      { type: "tool_use", id: "c1", name: "a", input: {}, providerSignature: "SIG" },
    ]);
  });

  it("keepParentCheckpoint preserves the parent", async () => {
    registerCheckpoint("ckpt-parent", {
      provider: CKPT_PROVIDER,
      modelKey: "test:ckpt-model:v1",
      prefix: { systemPrompt: "sys", tools: [aTool], messages: [] },
      modelId: undefined,
    });
    const scope = new ResourceScope();
    const task = new ToolCallingTask();
    await task.run(
      {
        model: toolModel(),
        prompt: "hi",
        tools: [aTool],
        checkpoint: "ckpt-parent",
        emitCheckpoint: true,
        keepParentCheckpoint: true,
      },
      { resourceScope: scope }
    );
    expect(getCheckpoint("ckpt-parent")).toBeDefined();
    expect(toolCalls[0].session?.supersedeParent).toBeUndefined();
  });

  it("unknown checkpoint fails before dispatch", async () => {
    const task = new ToolCallingTask();
    await expect(
      task.run({ model: toolModel(), prompt: "hi", tools: [aTool], checkpoint: "missing" })
    ).rejects.toThrow(/unknown cache checkpoint/i);
    expect(toolCalls).toHaveLength(0);
  });

  it("without checkpoint ports the auto-fingerprint session still applies", async () => {
    const task = new ToolCallingTask();
    await task.run({ model: toolModel(), prompt: "hi", tools: [aTool] });
    expect(toolCalls[0].session?.sessionId).toBeTruthy();
    expect(toolCalls[0].session?.prefix).toBeUndefined();
  });
});

describe("TextGenerationTask checkpoint ports", () => {
  let genCalls: { session: AiSessionContext | undefined }[];

  const genFn: AiProviderRunFn = async (_input, _model, _signal, emit, _schema, session) => {
    genCalls.push({ session });
    emit({ type: "text-delta", port: "text", textDelta: "out" } as any);
    emit({ type: "finish", data: {} } as any);
  };

  // Checkpoint ports require the provider to serve cache.checkpoint
  // (resolveCheckpointSession gates on it before dispatch).
  const ckptWarmFn: AiProviderRunFn = async (_input, _model, _signal, emit, _schema, session) => {
    emit({ type: "finish", data: { checkpoint: session?.sessionId ?? "" } } as any);
  };

  beforeEach(async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    clearCheckpointsForTesting();
    genCalls = [];
    const provider = new CheckpointTestProvider([
      { serves: ["text.generation"] as Capability[], runFn: genFn },
      { serves: ["cache.checkpoint"] as Capability[], runFn: ckptWarmFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });
  });

  it("rejects checkpoint ports on a provider without cache.checkpoint support", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const provider = new CheckpointTestProvider([
      { serves: ["text.generation"] as Capability[], runFn: genFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });
    const task = new TextGenerationTask();
    await expect(
      task.run({ model: checkpointModel(), prompt: "hi", emitCheckpoint: true })
    ).rejects.toThrow(/does not support cache checkpoints/i);
  });

  it("consumes a checkpoint and emits a chained one", async () => {
    registerCheckpoint("gen-parent", {
      provider: CKPT_PROVIDER,
      modelKey: "test:ckpt-model:v1",
      prefix: { systemPrompt: "sys", messages: [] },
      modelId: undefined,
    });
    const scope = new ResourceScope();
    const task = new TextGenerationTask();
    const out = await task.run(
      {
        model: checkpointModel(),
        prompt: "continue",
        checkpoint: "gen-parent",
        emitCheckpoint: true,
      },
      { resourceScope: scope }
    );
    expect(genCalls[0].session?.sessionId).toBe("gen-parent");
    expect(genCalls[0].session?.prefix?.systemPrompt).toBe("sys");
    const emitted = (out as { checkpoint?: string }).checkpoint;
    expect(emitted).toBeTruthy();
    const entry = getCheckpoint(emitted!);
    expect(entry?.prefix.messages?.at(-1)?.role).toBe("assistant");
    expect(entry?.prefix.messages?.at(-1)?.content[0]).toEqual({ type: "text", text: "out" });
  });
});

describe("checkpoint chaining across tasks", () => {
  let sessions: (AiSessionContext | undefined)[];

  beforeEach(async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    clearCheckpointsForTesting();
    sessions = [];
    const warm: AiProviderRunFn = async (_i, _m, _s, emit, _o, session) => {
      sessions.push(session);
      emit({ type: "finish", data: { checkpoint: session?.sessionId ?? "" } } as any);
    };
    const gen: AiProviderRunFn = async (_i, _m, _s, emit, _o, session) => {
      sessions.push(session);
      emit({ type: "text-delta", port: "text", textDelta: "reply" } as any);
      emit({ type: "finish", data: {} } as any);
    };
    const provider = new CheckpointTestProvider([
      { serves: ["cache.checkpoint"] as Capability[], runFn: warm },
      { serves: ["text.generation"] as Capability[], runFn: gen },
    ]);
    await provider.register({ queue: { autoCreate: false } });
  });

  it("warm-up → consume → emit → consume chains prefixes and supersedes", async () => {
    const scope = new ResourceScope();
    const ckpt0 = (await cacheCheckpoint(
      { model: checkpointModel(), systemPrompt: "sys" },
      undefined,
      {
        resourceScope: scope,
      }
    ))!.checkpoint;

    const turn1 = await new TextGenerationTask().run(
      {
        model: checkpointModel(),
        prompt: "turn one",
        checkpoint: ckpt0,
        emitCheckpoint: true,
      },
      { resourceScope: scope }
    );
    const ckpt1 = (turn1 as { checkpoint?: string }).checkpoint!;
    expect(getCheckpoint(ckpt0)).toBeUndefined();
    const entry1 = getCheckpoint(ckpt1)!;
    expect(entry1.parentId).toBe(ckpt0);
    expect(entry1.prefix.messages).toHaveLength(2);

    await new TextGenerationTask().run(
      {
        model: checkpointModel(),
        prompt: "turn two",
        checkpoint: ckpt1,
      },
      { resourceScope: scope }
    );
    const consumed = sessions[sessions.length - 1];
    expect(consumed?.sessionId).toBe(ckpt1);
    expect(consumed?.prefix?.messages).toHaveLength(2);
  });

  it("a failed consuming call leaves the parent checkpoint valid", async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    const failing: AiProviderRunFn = async () => {
      throw new Error("provider exploded");
    };
    const warm: AiProviderRunFn = async (_i, _m, _s, emit, _o, session) => {
      emit({ type: "finish", data: { checkpoint: session?.sessionId ?? "" } } as any);
    };
    const provider = new CheckpointTestProvider([
      { serves: ["cache.checkpoint"] as Capability[], runFn: warm },
      { serves: ["text.generation"] as Capability[], runFn: failing },
    ]);
    await provider.register({ queue: { autoCreate: false } });

    const scope = new ResourceScope();
    const ckpt0 = (await cacheCheckpoint(
      { model: checkpointModel(), systemPrompt: "sys" },
      undefined,
      {
        resourceScope: scope,
      }
    ))!.checkpoint;
    await expect(
      new TextGenerationTask().run(
        {
          model: checkpointModel(),
          prompt: "boom",
          checkpoint: ckpt0,
          emitCheckpoint: true,
        },
        { resourceScope: scope }
      )
    ).rejects.toThrow();
    // finalize never ran: parent survives, no orphan child entry beyond the parent
    expect(getCheckpoint(ckpt0)).toBeDefined();
  });

  it("branching: two consumers of one kept parent see the same prefix", async () => {
    const scope = new ResourceScope();
    const ckpt0 = (await cacheCheckpoint(
      { model: checkpointModel(), systemPrompt: "sys" },
      undefined,
      {
        resourceScope: scope,
      }
    ))!.checkpoint;
    const runBranch = (prompt: string) =>
      new TextGenerationTask().run(
        {
          model: checkpointModel(),
          prompt,
          checkpoint: ckpt0,
          emitCheckpoint: true,
          keepParentCheckpoint: true,
        },
        { resourceScope: scope }
      );
    const [a, b] = await Promise.all([runBranch("branch a"), runBranch("branch b")]);
    expect(getCheckpoint(ckpt0)).toBeDefined();
    const ca = (a as { checkpoint?: string }).checkpoint!;
    const cb = (b as { checkpoint?: string }).checkpoint!;
    expect(ca).not.toBe(cb);
    expect(getCheckpoint(ca)?.parentId).toBe(ckpt0);
    expect(getCheckpoint(cb)?.parentId).toBe(ckpt0);
  });
});

describe("AiChatTask checkpoint consumption", () => {
  let chatCalls: { session: AiSessionContext | undefined }[];

  const chatFn: AiProviderRunFn = async (_input, _model, _signal, emit, _schema, session) => {
    chatCalls.push({ session });
    emit({ type: "text-delta", port: "text", textDelta: "reply" } as any);
    emit({ type: "finish", data: {} } as any);
  };

  const ckptWarmFn: AiProviderRunFn = async (_input, _model, _signal, emit, _schema, session) => {
    emit({ type: "finish", data: { checkpoint: session?.sessionId ?? "" } } as any);
  };

  function chatContext(): IExecuteContext {
    const controller = new AbortController();
    const registry = new ServiceRegistry(new Container());
    // Scripted connector: decline the follow-up turn so the loop ends after one iteration.
    registry.registerInstance(HUMAN_CONNECTOR, {
      async send(request: { requestId: string }) {
        return { action: "decline", content: undefined, done: true, requestId: request.requestId };
      },
    } as never);
    return {
      signal: controller.signal,
      updateProgress: async () => {},
      own: <T>(i: T) => i,
      registry,
      resourceScope: {
        register: (_key: string, _fn: () => Promise<void>) => {},
        dispose: async () => {},
      },
    } as unknown as IExecuteContext;
  }

  beforeEach(async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    clearCheckpointsForTesting();
    chatCalls = [];
    const provider = new CheckpointTestProvider([
      { serves: ["text.generation"] as Capability[], runFn: chatFn },
      { serves: ["cache.checkpoint"] as Capability[], runFn: ckptWarmFn },
    ]);
    await provider.register({ queue: { autoCreate: false } });
  });

  it("sends its own mutable session id with the prefix and ownedSession", async () => {
    registerCheckpoint("ckpt-parent", {
      provider: CKPT_PROVIDER,
      modelKey: "test:ckpt-model:v1",
      prefix: { systemPrompt: "sys", messages: [] },
      modelId: undefined,
    });
    const input = {
      model: checkpointModel(),
      prompt: "hi",
      checkpoint: "ckpt-parent",
      maxIterations: 2,
    };
    const task = new AiChatTask({ defaults: input } as never);
    for await (const _event of task.executeStream(input as never, chatContext())) {
      // drain the stream; assertions are on the captured session context
    }
    expect(chatCalls.length).toBeGreaterThan(0);
    const session = chatCalls[0].session;
    // The chat keeps its own session identity (never the immutable checkpoint
    // id) and flags it as caller-owned so local providers keep progressive
    // per-turn KV snapshotting — a checkpoint-seeded chat must never be slower
    // than a plain one.
    expect(session?.sessionId).toBeDefined();
    expect(session?.sessionId).not.toBe("ckpt-parent");
    expect(session?.ownedSession).toBe(true);
    expect(session?.prefix?.systemPrompt).toBe("sys");
    expect(session?.emitCheckpointId).toBeUndefined();
  });
});

/**
 * Fail-closed model-key guards (L2). Before the fix, `checkpointModelKey`
 * returned "" for a missing `model_id` and `validateParentCheckpoint`
 * short-circuited its mismatch check on either side being empty, so two
 * keyless models on the same provider could silently share a fungible
 * checkpoint slot. Every mint / validate site now routes through
 * `requireCheckpointModelKey`.
 */
describe("model-key fail-closed (L2)", () => {
  function keylessModel(): ModelConfig {
    // No `model_id` — the failure mode that used to slip through.
    return {
      title: "keyless",
      description: "keyless",
      capabilities: ["cache.checkpoint", "text.generation"],
      provider: CKPT_PROVIDER,
      provider_config: {},
      metadata: {},
    } as unknown as ModelConfig;
  }

  let warmupInvocations: number;

  beforeEach(async () => {
    setAiProviderRegistry(new AiProviderRegistry());
    clearCheckpointsForTesting();
    warmupInvocations = 0;
    const warm: AiProviderRunFn = async (_i, _m, _s, emit, _o, session) => {
      warmupInvocations += 1;
      emit({ type: "finish", data: { checkpoint: session?.sessionId ?? "" } } as any);
    };
    const gen: AiProviderRunFn = async (_i, _m, _s, emit) => {
      emit({ type: "text-delta", port: "text", textDelta: "x" } as any);
      emit({ type: "finish", data: {} } as any);
    };
    const provider = new CheckpointTestProvider([
      { serves: ["cache.checkpoint"] as Capability[], runFn: warm },
      { serves: ["text.generation"] as Capability[], runFn: gen },
    ]);
    await provider.register({ queue: { autoCreate: false } });
  });

  it("cacheCheckpoint rejects a keyless model before invoking the warmup run-fn", async () => {
    await expect(cacheCheckpoint({ model: keylessModel(), systemPrompt: "sys" })).rejects.toThrow(
      /no model_id/i
    );
    expect(warmupInvocations).toBe(0);
  });

  it("parent-checkpoint lookup rejects a keyless task model before dispatch", async () => {
    // A parent that WAS minted with a valid key — the failure mode is a
    // keyless task model trying to consume it.
    registerCheckpoint("ckpt-legit-parent", {
      provider: CKPT_PROVIDER,
      modelKey: "test:model:v1",
      prefix: { systemPrompt: "sys" },
      modelId: undefined,
    });
    const task = new TextGenerationTask();
    await expect(
      task.run({ model: keylessModel(), prompt: "hi", checkpoint: "ckpt-legit-parent" })
    ).rejects.toThrow(/no model_id/i);
  });

  it("cross-model contamination: a keyless-parent slot no longer matches a keyless task model", async () => {
    // Simulate the state a pre-fix mint would have left behind: a parent with
    // an empty modelKey. Under the old short-circuited guard, a keyless task
    // model would silently consume it. Under the fix, the task model itself
    // must have a key — the empty-vs-empty match is rejected before the
    // mismatch check runs.
    registerCheckpoint("ckpt-keyless-parent", {
      provider: CKPT_PROVIDER,
      modelKey: "",
      prefix: { systemPrompt: "sys" },
      modelId: undefined,
    });
    const task = new TextGenerationTask();
    await expect(
      task.run({
        model: keylessModel(),
        prompt: "hi",
        checkpoint: "ckpt-keyless-parent",
      })
    ).rejects.toThrow(/no model_id/i);
  });

  it("emit path rejects a keyless model before createSession mints a slot", async () => {
    const createSpy = vi.spyOn(getAiProviderRegistry(), "createSession");
    const task = new TextGenerationTask();
    await expect(
      task.run({ model: keylessModel(), prompt: "hi", emitCheckpoint: true })
    ).rejects.toThrow(/no model_id/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("validateParentCheckpoint still rejects a mismatched keyed parent vs a keyed task model", async () => {
    // Sanity-check the regular mismatch path — the fix must not break the
    // existing keyed-vs-keyed rejection path.
    registerCheckpoint("ckpt-parent-A", {
      provider: CKPT_PROVIDER,
      modelKey: "modelA",
      prefix: {},
      modelId: undefined,
    });
    const modelB: ModelConfig = {
      ...checkpointModel(),
      model_id: "modelB",
    } as ModelConfig;
    const task = new TextGenerationTask();
    await expect(
      task.run({ model: modelB, prompt: "hi", checkpoint: "ckpt-parent-A" })
    ).rejects.toThrow(/was created for model/i);
  });
});
