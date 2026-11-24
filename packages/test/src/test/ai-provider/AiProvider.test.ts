/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRegisterContext,
  AiProviderRegisterOptions,
  AiProviderRunFn,
  AiProviderRunFnRegistration,
  Capability,
} from "@workglow/ai";
import {
  accumulatingEmit,
  AiJob,
  AiProvider,
  AiProviderRegistry,
  getAiProviderRegistry,
  QueuedAiProvider,
  setAiProviderRegistry,
} from "@workglow/ai";
import type { TaskOutput } from "@workglow/task-graph";
import {
  getTaskQueueRegistry,
  setTaskQueueRegistry,
  TaskQueueRegistry,
} from "@workglow/task-graph";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { globalServiceRegistry, WORKER_MANAGER } from "@workglow/util/worker";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const TEST_PROVIDER_NAME = "test-ai-provider";
const TEXT_GENERATION: readonly Capability[] = ["text.generation"];
const TEXT_EMBEDDING: readonly Capability[] = ["text.embedding"];

/** Build a one-shot run-fn yielding a single `finish` with `result`. */
function makeFinishStreamFn(result: TaskOutput): AiProviderRunFn {
  return async (_input, _model, _signal, emit) => {
    emit({ type: "finish", data: result });
  };
}

// A concrete test provider that accepts runFns via constructor (dependency injection)
class TestProvider extends AiProvider {
  readonly name = TEST_PROVIDER_NAME;
  readonly displayName = "Test AI Provider";
  readonly isLocal = false;
  readonly supportsBrowser = true;
  readonly supportsServer = true;

  public initializeCalled = false;
  public initializeOptions: AiProviderRegisterContext | null = null;
  public disposeCalled = false;

  constructor(fns?: readonly AiProviderRunFnRegistration[]) {
    super(fns);
  }

  protected override async onInitialize(options: AiProviderRegisterContext): Promise<void> {
    this.initializeCalled = true;
    this.initializeOptions = options;
  }

  override async dispose(): Promise<void> {
    this.disposeCalled = true;
  }
}

// A concrete test provider that auto-creates job queues (like the real providers)
class TestQueuedProvider extends QueuedAiProvider {
  readonly name = TEST_PROVIDER_NAME;
  readonly displayName = "Test AI Provider";
  readonly isLocal = false;
  readonly supportsBrowser = true;
  readonly supportsServer = true;

  constructor(fns?: readonly AiProviderRunFnRegistration[]) {
    super(fns);
  }
}

// A provider that advertises capability sets for worker-mode registration
// without binding the run functions on the main thread (worker host pattern).
class StaticTaskTypesProvider extends AiProvider {
  readonly name = "static-task-types-provider";
  readonly displayName = "Static Task Types";
  readonly isLocal = false;
  readonly supportsBrowser = true;
  readonly supportsServer = true;

  constructor(fns?: readonly AiProviderRunFnRegistration[]) {
    super(fns);
  }

  // Advertise capability sets equivalent to the legacy TextGenerationTask /
  // TextEmbeddingTask task types so worker-mode registration can install
  // matching proxies.
  protected override workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    if (this.promiseRunFns && this.promiseRunFns.length > 0) {
      return this.promiseRunFns.map((r) => ({ serves: r.serves }));
    }
    return [{ serves: TEXT_GENERATION }, { serves: TEXT_EMBEDDING }];
  }
}

describe("AiProvider", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  let aiProviderRegistry: AiProviderRegistry;

  beforeEach(async () => {
    await setTaskQueueRegistry(new TaskQueueRegistry());
    setAiProviderRegistry(new AiProviderRegistry());
    aiProviderRegistry = getAiProviderRegistry();
  });

  afterEach(async () => {
    await getTaskQueueRegistry().stopQueues();
    await getTaskQueueRegistry().clearQueues();
  });

  afterAll(async () => {
    await setTaskQueueRegistry(null);
  });

  describe("runFns coverage", () => {
    test("runFns expose every registered capability set", () => {
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({ result: "ok" }) },
        { serves: TEXT_EMBEDDING, runFn: makeFinishStreamFn({ result: "ok" }) },
      ]);

      const allCaps =
        (
          provider as unknown as {
            promiseRunFns?: readonly AiProviderRunFnRegistration[];
          }
        ).promiseRunFns?.flatMap((r) => r.serves) ?? [];
      expect(allCaps).toEqual(["text.generation", "text.embedding"]);
    });

    test("provider with empty runFns advertises nothing", () => {
      const provider = new TestProvider([]);
      const allCaps =
        (
          provider as unknown as {
            promiseRunFns?: readonly AiProviderRunFnRegistration[];
          }
        ).promiseRunFns?.flatMap((r) => r.serves) ?? [];
      expect(allCaps).toEqual([]);
    });

    test("worker-host provider (no promiseRunFns) advertises capabilities via workerRunFnSpecs", () => {
      const provider = new StaticTaskTypesProvider();
      const specs = (
        provider as unknown as {
          workerRunFnSpecs: () => readonly { serves: readonly Capability[] }[];
        }
      ).workerRunFnSpecs();
      expect(specs.map((s) => [...s.serves])).toEqual([[...TEXT_GENERATION], [...TEXT_EMBEDDING]]);
    });
  });

  describe("getRunFnFor (registry-level)", () => {
    test("registry exposes the run-fn for a supported capability set after register()", async () => {
      const runFn = makeFinishStreamFn({ result: "ok" });
      const provider = new TestProvider([{ serves: TEXT_GENERATION, runFn }]);
      await provider.register({ queue: { autoCreate: false } });

      expect(aiProviderRegistry.getRunFnFor(TEST_PROVIDER_NAME, TEXT_GENERATION)).toBe(runFn);
    });

    test("registry returns undefined for an unsupported capability set", async () => {
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({}) },
      ]);
      await provider.register({ queue: { autoCreate: false } });

      expect(aiProviderRegistry.getRunFnFor(TEST_PROVIDER_NAME, TEXT_EMBEDDING)).toBeUndefined();
    });

    test("registry returns undefined when no runFns were provided (worker host pattern)", () => {
      // Worker-host providers register proxies through register({ worker: ... }).
      // Without calling register(), the registry has no entries.
      const provider = new StaticTaskTypesProvider();
      // No register() call here — just confirm the registry is empty.
      expect(aiProviderRegistry.getRunFnFor(provider.name, TEXT_GENERATION)).toBeUndefined();
    });
  });

  describe("register (inline)", () => {
    test("should register all run functions with the AiProviderRegistry", async () => {
      const mockGenFn = makeFinishStreamFn({ text: "hello" });
      const mockEmbedFn = makeFinishStreamFn({ vector: [] });
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: mockGenFn },
        { serves: TEXT_EMBEDDING, runFn: mockEmbedFn },
      ]);

      await provider.register({ queue: { autoCreate: false } });

      const genFn = aiProviderRegistry.getRunFnFor(TEST_PROVIDER_NAME, TEXT_GENERATION);
      expect(genFn).toBe(mockGenFn);

      const embedFn = aiProviderRegistry.getRunFnFor(TEST_PROVIDER_NAME, TEXT_EMBEDDING);
      expect(embedFn).toBe(mockEmbedFn);
    });

    test("should call onInitialize with the register options", async () => {
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({}) },
      ]);

      const options: AiProviderRegisterOptions = { queue: { autoCreate: false } };
      await provider.register(options);

      expect(provider.initializeCalled).toBe(true);
      expect(provider.initializeOptions).toEqual({ ...options, isInline: true });
    });

    test("should register provider instance on the registry", async () => {
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({}) },
      ]);

      await provider.register({ queue: { autoCreate: false } });

      const retrieved = aiProviderRegistry.getProvider(TEST_PROVIDER_NAME);
      expect(retrieved).toBe(provider);
    });

    test("should not auto-create a job queue (base AiProvider)", async () => {
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({ text: "hello" }) },
      ]);

      await provider.register();

      const registeredQueue = getTaskQueueRegistry().getQueue(TEST_PROVIDER_NAME);
      expect(registeredQueue).toBeUndefined();
    });

    test("should register a strategy resolver by default (QueuedAiProvider)", async () => {
      const provider = new TestQueuedProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({ text: "hello" }) },
      ]);

      await provider.register();

      // QueuedAiProvider registers a strategy resolver (queue is created lazily on first use)
      const strategy = aiProviderRegistry.getStrategy({
        provider: TEST_PROVIDER_NAME,
      } as any);
      expect(strategy).toBeDefined();
      expect(strategy).not.toBe((aiProviderRegistry as any).defaultStrategy);
    });

    test("should skip queue creation when autoCreate is false", async () => {
      const provider = new TestQueuedProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({ text: "hello" }) },
      ]);

      await provider.register({ queue: { autoCreate: false } });

      const registeredQueue = getTaskQueueRegistry().getQueue(TEST_PROVIDER_NAME);
      expect(registeredQueue).toBeUndefined();
    });
  });

  describe("register (worker)", () => {
    test("should throw when worker is omitted for worker-backed registration", async () => {
      const provider = new StaticTaskTypesProvider();
      await expect(provider.register({})).rejects.toThrow(/worker is required/);
    });

    test("should pass the configured worker idle timeout to WorkerManager", async () => {
      const provider = new StaticTaskTypesProvider();
      const workerFactory = () => ({}) as Worker;
      const originalWorkerManager = globalServiceRegistry.get(WORKER_MANAGER);
      const mockWorkerManager = {
        registerWorker: vi.fn(),
      };

      globalServiceRegistry.registerInstance(WORKER_MANAGER, mockWorkerManager as any);

      try {
        await provider.register({
          worker: workerFactory,
          workerIdleTimeoutMs: 1234,
        });
      } finally {
        globalServiceRegistry.registerInstance(WORKER_MANAGER, originalWorkerManager);
      }

      expect(mockWorkerManager.registerWorker).toHaveBeenCalledWith(
        "static-task-types-provider",
        workerFactory,
        { idleTimeoutMs: 1234 }
      );
    });

    test("should default factory-backed AI workers to a 15 minute idle timeout", async () => {
      const provider = new StaticTaskTypesProvider();
      const workerFactory = () => ({}) as Worker;
      const originalWorkerManager = globalServiceRegistry.get(WORKER_MANAGER);
      const mockWorkerManager = {
        registerWorker: vi.fn(),
      };

      globalServiceRegistry.registerInstance(WORKER_MANAGER, mockWorkerManager as any);

      try {
        await provider.register({
          worker: workerFactory,
        });
      } finally {
        globalServiceRegistry.registerInstance(WORKER_MANAGER, originalWorkerManager);
      }

      expect(mockWorkerManager.registerWorker).toHaveBeenCalledWith(
        "static-task-types-provider",
        workerFactory,
        { idleTimeoutMs: 15 * 60 * 1000 }
      );
    });
  });

  describe("registerOnWorkerServer", () => {
    test("should register every run-fn under its workerKeyForServes key", async () => {
      const mockGenFn = vi.fn(makeFinishStreamFn({ text: "hello" }));
      const mockEmbedFn = vi.fn(makeFinishStreamFn({ vector: [] }));
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: mockGenFn },
        { serves: TEXT_EMBEDDING, runFn: mockEmbedFn },
      ]);

      const mockWorkerServer = {
        registerRunFunction: vi.fn(),
        registerPreviewFunction: vi.fn(),
      };

      provider.registerOnWorkerServer(mockWorkerServer as any);

      // workerKeyForServes(["text.generation"]) → "text.generation"
      // workerKeyForServes(["text.embedding"]) → "text.embedding"
      expect(mockWorkerServer.registerRunFunction).toHaveBeenCalledTimes(2);
      // Each is wrapped (a throw keeps the provider's stated retry-after across
      // the worker boundary), so the registration delegates rather than being
      // the run-fn itself.
      const registered = new Map<string, (...args: unknown[]) => Promise<void>>(
        mockWorkerServer.registerRunFunction.mock.calls.map(
          ([key, fn]) => [key, fn] as [string, (...args: unknown[]) => Promise<void>]
        )
      );
      expect([...registered.keys()].sort()).toEqual(["text.embedding", "text.generation"]);
      const signal = new AbortController().signal;
      await registered.get("text.generation")!({ prompt: "p" }, {}, signal, () => {});
      expect(mockGenFn).toHaveBeenCalledWith({ prompt: "p" }, {}, signal, expect.any(Function));
      expect(mockEmbedFn).not.toHaveBeenCalled();
    });

    test("should throw when runFns not provided for worker server registration", () => {
      const provider = new StaticTaskTypesProvider();

      const mockWorkerServer = {
        registerRunFunction: vi.fn(),
        registerPreviewFunction: vi.fn(),
      };

      expect(() => provider.registerOnWorkerServer(mockWorkerServer as any)).toThrow(
        /promiseRunFns must be provided via the constructor for worker server registration/
      );
    });
  });

  describe("dispose", () => {
    test("should call dispose on the provider", async () => {
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({}) },
      ]);

      await provider.register({ queue: { autoCreate: false } });
      await provider.dispose();

      expect(provider.disposeCalled).toBe(true);
    });
  });

  describe("getProvider / getProviders", () => {
    test("should retrieve a registered provider by name", async () => {
      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({}) },
      ]);

      await provider.register({ queue: { autoCreate: false } });

      expect(aiProviderRegistry.getProvider(TEST_PROVIDER_NAME)).toBe(provider);
    });

    test("should return undefined for an unregistered provider", () => {
      expect(aiProviderRegistry.getProvider("nonexistent")).toBeUndefined();
    });

    test("should return all registered providers", async () => {
      const provider1 = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({}) },
      ]);
      const mockEmbedFn = makeFinishStreamFn({});
      const provider2 = new StaticTaskTypesProvider([
        { serves: TEXT_GENERATION, runFn: mockEmbedFn },
        { serves: TEXT_EMBEDDING, runFn: mockEmbedFn },
      ]);

      aiProviderRegistry.registerProvider(provider1);
      aiProviderRegistry.registerProvider(provider2);

      const providers = aiProviderRegistry.getProviders();
      expect(providers.size).toBe(2);
      expect(providers.get(TEST_PROVIDER_NAME)).toBe(provider1);
      expect(providers.get("static-task-types-provider")).toBe(provider2);
    });

    test("getInstalledProviderIds returns sorted registered provider ids", async () => {
      expect(aiProviderRegistry.getInstalledProviderIds()).toEqual([]);

      const provider1 = new TestProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({}) },
      ]);
      const provider2 = new StaticTaskTypesProvider([
        { serves: TEXT_GENERATION, runFn: makeFinishStreamFn({}) },
      ]);

      await provider1.register({ queue: { autoCreate: false } });
      await provider2.register({ queue: { autoCreate: false } });

      expect(aiProviderRegistry.getInstalledProviderIds()).toEqual([
        "static-task-types-provider",
        TEST_PROVIDER_NAME,
      ]);
    });

    test("getProviderIdsForCapabilities returns empty when no run fns match", () => {
      // provider.model-search is a real capability but nothing has registered it.
      expect(aiProviderRegistry.getProviderIdsForCapabilities(["model.search"])).toEqual([]);
    });

    test("getProviderIdsForCapabilities returns sorted provider ids matching the requires set", async () => {
      const mockRun = makeFinishStreamFn({});
      const provider1 = new TestProvider([{ serves: TEXT_GENERATION, runFn: mockRun }]);
      const provider2 = new StaticTaskTypesProvider([
        { serves: TEXT_GENERATION, runFn: mockRun },
        { serves: TEXT_EMBEDDING, runFn: mockRun },
      ]);

      await provider1.register({ queue: { autoCreate: false } });
      await provider2.register({ queue: { autoCreate: false } });

      expect(aiProviderRegistry.getProviderIdsForCapabilities(TEXT_GENERATION)).toEqual([
        "static-task-types-provider",
        TEST_PROVIDER_NAME,
      ]);
      expect(aiProviderRegistry.getProviderIdsForCapabilities(TEXT_EMBEDDING)).toEqual([
        "static-task-types-provider",
      ]);
    });
  });

  describe("end-to-end: AiJob execution with provider", () => {
    test("should execute a job using a function registered via AiProvider", async () => {
      const mockRunFn: AiProviderRunFn = async (_input, _model, _signal, emit) => {
        emit({ type: "finish", data: { text: "generated text" } });
      };
      const runFnSpy = vi.fn(mockRunFn);

      const provider = new TestProvider([
        { serves: TEXT_GENERATION, runFn: runFnSpy as unknown as AiProviderRunFn },
      ]);

      await provider.register({ queue: { autoCreate: false } });

      const model = {
        model_id: "test:model:v1",
        title: "test-model",
        description: "test model",
        capabilities: ["text.generation"],
        provider: TEST_PROVIDER_NAME,
        provider_config: { model_id: "test-model" },
        metadata: {},
      };

      const controller = new AbortController();
      const job = new AiJob({
        queueName: TEST_PROVIDER_NAME,
        input: {
          aiProvider: TEST_PROVIDER_NAME,
          taskType: "TextGenerationTask",
          requires: TEXT_GENERATION,
          taskInput: { prompt: "test prompt", model },
        },
      });

      const { emit, result: getResult } = accumulatingEmit<TaskOutput>();
      await job.execute(
        job.input,
        {
          signal: controller.signal,
          updateProgress: async () => {},
        },
        emit
      );

      expect(getResult()).toEqual({ text: "generated text" });
      expect(runFnSpy).toHaveBeenCalledOnce();

      // Sanity: also drives through accumulatingEmit directly.
      const { emit: directEmit, result: getDirectResult } = accumulatingEmit<TaskOutput>();
      await runFnSpy(
        { prompt: "x", model } as any,
        model as any,
        new AbortController().signal,
        directEmit
      );
      expect(getDirectResult()).toEqual({ text: "generated text" });
    });
  });
});
