/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkerServerBase as WorkerServer } from "@workglow/util/worker";
import { globalServiceRegistry, WORKER_MANAGER } from "@workglow/util/worker";
import type { Capability } from "../capability/Capabilities";
import type { ModelEffortPolicy } from "../model/ModelEffort";
import type { ModelConfig, ModelPricing, ModelRecord } from "../model/ModelSchema";
import type {
  AiProviderPreviewRunFn,
  AiProviderRunFnRegistration,
  SessionDisposalResult,
} from "./AiProviderRegistry";
import { withStatedRetryAfter } from "../job/ProviderErrorSignals";
import { getAiProviderRegistry, workerKeyForServes } from "./AiProviderRegistry";

/**
 * Job queue concurrency: one limit for the primary ({@link QueuedAiProvider} hardware) queue,
 * or per-slot limits. Hugging Face Transformers ONNX uses `gpu` and `cpu` for its two queues.
 */
export type AiProviderQueueConcurrency = number | Record<string, number>;
export const DEFAULT_AI_PROVIDER_WORKER_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Resolves the primary (e.g. WebGPU) queue limit for {@link QueuedAiProvider}.
 * A numeric `concurrency` sets that queue; a record uses `gpu` (default 1).
 */
export function resolveAiProviderGpuQueueConcurrency(
  concurrency: AiProviderQueueConcurrency | undefined
): number {
  if (concurrency === undefined) {
    return 1;
  }
  if (typeof concurrency === "number") {
    return concurrency;
  }
  return concurrency.gpu ?? 1;
}

/**
 * Options for registering an AI provider on the main thread.
 *
 * - If the provider was constructed **with** run-fn registrations → **inline**
 *   registration (direct streaming run fns). No `worker` option.
 * - If the provider was constructed **without** registrations → **worker**
 *   registration (proxies). A `worker` (instance or lazy factory) is **required**.
 */
export interface AiProviderRegisterOptions {
  /**
   * Web Worker for worker-backed registration. Pass a `Worker` or a factory
   * `() => Worker` to defer instantiation until the first job (lazy worker).
   */
  worker?: Worker | (() => Worker);
  /**
   * Idle timeout for factory-backed worker registrations. `0` disables idle termination.
   * Defaults to 15 minutes for AI providers when `worker` is a factory.
   */
  workerIdleTimeoutMs?: number;
  /** Job queue configuration */
  queue?: {
    /**
     * Concurrent jobs on the provider's primary queued path (e.g. GPU), default 1.
     * Use a record for multiple queues — e.g. `{ gpu: 1, cpu: 4 }` for Hugging Face
     * Transformers ONNX (`cpu` defaults to 4 in production and 1 under test when omitted).
     */
    concurrency?: AiProviderQueueConcurrency;
    /** Set to false to skip automatic queue creation. Defaults to true. */
    autoCreate?: boolean;
  };
}

/**
 * Registration context passed to {@link AiProvider.onInitialize}, including whether
 * the provider is registering inline (run-fns present) or worker-backed (no run-fns).
 */
export interface AiProviderRegisterContext extends AiProviderRegisterOptions {
  readonly isInline: boolean;
}

/**
 * Wraps a worker-side run-fn so a failure leaves the worker still saying how
 * long the provider asked to wait. The worker sends an error back as a few
 * plain fields, and the response headers, `retryDate` and cause chain that
 * hold the wait are not among them; `retryAfterMs` is.
 */
function withRetryAfterOnThrow(
  runFn: (...args: any[]) => Promise<unknown>
): (...args: any[]) => Promise<void> {
  return async (...args: any[]): Promise<void> => {
    try {
      await runFn(...args);
    } catch (err) {
      throw withStatedRetryAfter(err);
    }
  };
}

/**
 * Abstract base class for AI providers.
 *
 * Each provider subclass declares static metadata (`name`, `displayName`,
 * `isLocal`, `supportsBrowser`). The actual run function implementations
 * are **injected via the constructor** as a list of capability-set
 * registrations so heavy ML library imports remain at the call site. This
 * allows the provider class to be imported on the main thread without pulling
 * in heavy dependencies when running in worker mode.
 *
 * The base class handles:
 * - Registering capability-set run functions with the AiProviderRegistry
 *   (inline or worker proxies)
 * - Registering functions on a WorkerServer (for worker-side code)
 * - Lifecycle management (initialize / dispose)
 *
 * @example
 * ```typescript
 * // Worker host (main thread) -- lightweight, no heavy task imports:
 * await new MyProvider().register({
 *   worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
 * });
 *
 * // Inline -- caller provides the run-fn registrations (imports heavy library):
 * import { MY_RUN_FNS } from "./MyJobRunFns";
 * await new MyProvider(MY_RUN_FNS).register();
 *
 * // Worker side -- caller provides the run-fn registrations:
 * import { MY_RUN_FNS } from "./MyJobRunFns";
 * new MyProvider(MY_RUN_FNS).registerOnWorkerServer(workerServer);
 * ```
 */
export abstract class AiProvider<TModelConfig extends ModelConfig = ModelConfig> {
  abstract readonly name: string;

  abstract readonly displayName: string;

  abstract readonly isLocal: boolean;

  abstract readonly supportsBrowser: boolean;

  /**
   * Whether this provider can run server-side (a Bun/Node host process).
   * Orthogonal to {@link isLocal}: a provider can be local (Ollama) yet
   * server-capable. builder maps `supportsBrowser` / `supportsServer` /
   * `isLocal` onto its own `browser | desktop | cloud` deployment taxonomy;
   * libs deliberately does not know those host names.
   */
  abstract readonly supportsServer: boolean;

  /**
   * Promise+emit capability-set run-fn registrations injected via the constructor.
   * Required for inline and worker-server registration. Not needed for worker-mode
   * registration on the main thread (proxies are derived from {@link workerRunFnSpecs}).
   */
  protected readonly promiseRunFns?: readonly AiProviderRunFnRegistration<any, any, TModelConfig>[];

  /**
   * Map of task type names to their preview run functions.
   * Only needed for tasks that provide lightweight previews via executePreview().
   */
  protected readonly previewTasks?: Record<string, AiProviderPreviewRunFn<any, any, TModelConfig>>;

  constructor(
    promiseRunFns?: readonly AiProviderRunFnRegistration<any, any, TModelConfig>[],
    previewTasks?: Record<string, AiProviderPreviewRunFn<any, any, TModelConfig>>
  ) {
    this.previewTasks = previewTasks;
    this.promiseRunFns = promiseRunFns;
  }

  /**
   * Infer the closed set of {@link Capability} values a model supports given its
   * record. The base implementation returns the model's stored `capabilities`
   * field (or `[]` if absent), letting providers opt out of inference and use
   * whatever the user set. Provider subclasses override this with real
   * heuristics (e.g., parse model id strings, hit provider catalog endpoints).
   *
   * Main-thread method only — workers do not run capability inference.
   */
  inferCapabilities(model: ModelRecord): readonly Capability[] {
    return (model.capabilities as readonly Capability[] | undefined) ?? [];
  }

  /**
   * Coarse thinking/reasoning levels this provider accepts for `model`, plus
   * the class default when `effort` is omitted. `undefined` means this
   * provider never maps `effort`. Main-thread; search run-fns call the
   * provider's pure `*EffortPolicy` helper instead of this method.
   */
  effortPolicy(_model: ModelConfig): ModelEffortPolicy | undefined {
    return undefined;
  }

  /**
   * Published list rate card for `model`.
   *
   * A card on the model's own record overrides this **field by field**, not
   * wholesale: every rate the record leaves unset is taken from here. See
   * `mergeModelPricing`. `undefined` means this provider publishes no list
   * pricing for the model.
   */
  modelPricing(_model: ModelConfig): ModelPricing | undefined {
    return undefined;
  }

  /**
   * Runtime availability probe for environment-dependent providers (e.g. Chrome
   * AI, which needs `window.ai`). Returns `true` by default; providers whose
   * reachability depends on the host environment override it. Replaces the
   * renderer's ad-hoc `isChromeBuiltinAiAvailable` call as the uniform check.
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Register this provider on the main thread.
   *
   * Inferred from constructor: **with** run-fns → direct streaming run functions;
   * **without** run-fns → worker proxies (requires `worker` in options).
   *
   * Creates a job queue unless `queue.autoCreate` is set to false.
   *
   * @param options - Registration options (worker for worker-backed, queue config)
   */
  async register(options: AiProviderRegisterOptions = {}): Promise<void> {
    const isInline = !!this.promiseRunFns;
    const context: AiProviderRegisterContext = { ...options, isInline };

    // Tear down any prior registration under this name BEFORE onInitialize so
    // we don't clobber the strategy resolver that QueuedAiProvider.onInitialize
    // re-registers below. registerRunFn() appends to a per-provider list with
    // no dedup; without this clear, every re-registration doubles the run-fn
    // count and leaks the previous strategy/queue/limiter via closures —
    // OOM-kills long-running test processes (locally and on CI).
    const registry = getAiProviderRegistry();
    if (registry.getProvider(this.name)) {
      registry.unregisterProvider(this.name);
      // unregisterProvider only clears registry maps; a worker-backed provider
      // also has a worker (and, for factory workers, an idle timer) registered
      // on the WorkerManager. Without removing it here, the re-registration
      // below throws "Worker <name> is already registered."
      await globalServiceRegistry.get(WORKER_MANAGER).terminateWorker(this.name);
    }

    await this.onInitialize(context);

    if (isInline) {
      if (!this.promiseRunFns) {
        throw new Error(
          `AiProvider "${this.name}": promiseRunFns must be provided via the constructor for inline registration.`
        );
      }
    } else {
      if (!options.worker) {
        throw new Error(
          `AiProvider "${this.name}": worker is required when no promiseRunFns are provided (worker-backed registration). ` +
            `Pass worker: new Worker(...) or worker: () => new Worker(...).`
        );
      }
    }

    if (!isInline && options.worker) {
      const workerManager = globalServiceRegistry.get(WORKER_MANAGER);
      if (typeof options.worker === "function") {
        workerManager.registerWorker(this.name, options.worker, {
          idleTimeoutMs: options.workerIdleTimeoutMs ?? DEFAULT_AI_PROVIDER_WORKER_IDLE_TIMEOUT_MS,
        });
      } else {
        workerManager.registerWorker(this.name, options.worker);
      }
      // Worker-mode: register proxy entries for each capability-set the provider
      // declares. The set is provided via the optional `workerRunFnSpecs` hook
      // since the run functions themselves live behind the worker boundary.
      const specs = this.workerRunFnSpecs();
      if (specs.length === 0) {
        throw new Error(
          `AiProvider "${this.name}": worker-mode registration requires at least one ` +
            `entry from workerRunFnSpecs(). Override workerRunFnSpecs() to declare ` +
            `the capability sets this provider serves over the worker boundary.`
        );
      }
      for (const spec of specs) {
        registry.registerAsWorkerRunFn(this.name, spec.serves);
      }
    } else {
      if (this.promiseRunFns) {
        for (const reg of this.promiseRunFns) {
          registry.registerRunFn(this.name, reg as AiProviderRunFnRegistration);
        }
      }
    }

    if (this.previewTasks) {
      for (const [taskType, fn] of Object.entries(this.previewTasks)) {
        registry.registerPreviewRunFn(this.name, taskType, fn as AiProviderPreviewRunFn);
      }
    }

    registry.registerProvider(this);

    try {
      await this.afterRegister(options);
    } catch (err) {
      // Clean up the partially-registered provider so the registry isn't left
      // in an inconsistent state (e.g., functions registered but no queue).
      // For worker-backed registration the worker (and its idle timer) was
      // already registered above, so remove it too or it leaks under this name.
      registry.unregisterProvider(this.name);
      if (!isInline && options.worker) {
        await globalServiceRegistry.get(WORKER_MANAGER).terminateWorker(this.name);
      }
      throw err;
    }
  }

  /**
   * Returns the capability-sets to register as worker proxies when the
   * provider is registered without inline run-fns. Subclasses with worker
   * support override this to advertise the same `serves` sets that the
   * worker-side {@link registerOnWorkerServer} call will register.
   *
   * The base implementation derives specs from `promiseRunFns` when present.
   */
  protected workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    return this.promiseRunFns?.map((r) => ({ serves: r.serves })) ?? [];
  }

  /**
   * Register this provider's run functions on a WorkerServer.
   * Call this inside a Web Worker to make the provider's functions
   * available for remote invocation from the main thread.
   *
   * Requires `promiseRunFns` to have been provided via the constructor. Each
   * registration is exposed under the deterministic key produced by
   * {@link workerKeyForServes} so the main-thread proxy resolves to the
   * matching run function.
   *
   * @param workerServer - The WorkerServer instance to register on
   */
  registerOnWorkerServer(workerServer: WorkerServer): void {
    if (!this.promiseRunFns) {
      throw new Error(
        `AiProvider "${this.name}": promiseRunFns must be provided via the constructor for worker server registration.`
      );
    }
    if (this.promiseRunFns) {
      for (const reg of this.promiseRunFns) {
        const key = workerKeyForServes(reg.serves);
        workerServer.registerRunFunction(key, withRetryAfterOnThrow(reg.runFn));
      }
    }
    if (this.previewTasks) {
      for (const [taskType, fn] of Object.entries(this.previewTasks)) {
        workerServer.registerPreviewFunction(taskType, fn);
      }
    }
  }

  /**
   * Hook for provider-specific initialization.
   * Called at the start of `register()`, before any functions are registered.
   * Override in subclasses to perform setup (e.g., configuring WASM backends).
   */
  protected async onInitialize(_options: AiProviderRegisterContext): Promise<void> {}

  /**
   * Dispose of provider resources.
   * Override in subclasses to clean up (e.g., clearing pipeline caches).
   */
  async dispose(): Promise<void> {}

  /**
   * Create a session for the given model configuration.
   * Returns an opaque session ID that can be passed to run/stream functions
   * to reuse provider-side resources (e.g., a loaded pipeline or KV cache).
   *
   * The base implementation returns a random UUID; provider subclasses
   * (e.g., HF Transformers, llama-cpp) override this to allocate real resources.
   */
  createSession(_model: ModelConfig): string {
    return crypto.randomUUID();
  }

  /**
   * Dispose of a previously created session.
   * Provider subclasses override this to release resources tied to the session.
   * The base implementation is a no-op.
   *
   * MUST be idempotent: tolerate ids that were never allocated or were already
   * disposed. Checkpoint supersede disposes a parent session directly while the
   * run's ResourceScope disposer for the same id still fires at run end, so a
   * second call for a gone id is expected (guard on your session map lookup).
   *
   * Returns what was released when the provider bills for storage (e.g.
   * Gemini's server-side cache, priced by token-hours only known at
   * disposal); providers with nothing to report return `undefined` or
   * nothing at all — the base no-op does the latter.
   */
  async disposeSession(_sessionId: string): Promise<SessionDisposalResult | undefined | void> {}

  /**
   * Called at the end of {@link register} after registry wiring.
   * {@link QueuedAiProvider} overrides this to create the default job queue; the base
   * implementation is a no-op so worker-only provider classes stay free of queue/storage.
   */
  protected async afterRegister(_options: AiProviderRegisterOptions): Promise<void> {}
}
