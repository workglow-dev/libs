/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServiceRegistry } from "@workglow/util";
import { deepEqual, EventEmitter, getLogger, uuid4 } from "@workglow/util";
import type { DataPortSchema, SchemaNode } from "@workglow/util/schema";
import { compileSchema } from "@workglow/util/schema";
import type { CachePolicy } from "../cache/CachePolicy";
import { DATAFLOW_ALL_PORTS } from "../task-graph/Dataflow";
import { TaskGraph } from "../task-graph/TaskGraph";
import type { IExecuteContext, IExecutePreviewContext, IRunConfig, ITask } from "./ITask";
import type { Usage } from "./StreamTypes";
import { mergeUsage } from "./StreamTypes";
import { collectCacheVersion, isDeterministicId, resolveCachePolicy } from "./TaskCacheOps";
import { smartClone, stripSymbols } from "./TaskCloneOps";
import { EMPTY_ENTITLEMENTS, type TaskEntitlements } from "./TaskEntitlements";
import type { TaskError } from "./TaskError";
import { TaskAbortedError, TaskConfigurationError, TaskInvalidInputError } from "./TaskError";
import type {
  TaskEventListener,
  TaskEventListeners,
  TaskEventParameters,
  TaskEvents,
} from "./TaskEvents";
import type { JsonTaskItem, TaskGraphItemJson, TaskGraphJsonOptions } from "./TaskJSON";
import { buildTaskJson } from "./TaskJsonOps";
import { TaskRunner } from "./TaskRunner";
import type { TaskConfig, TaskIdType, TaskInput, TaskOutput, TaskTypeName } from "./TaskTypes";
import { TaskConfigSchema, TaskStatus } from "./TaskTypes";

/**
 * Base class for all tasks that implements the ITask interface.
 * This abstract class provides common functionality for both simple and compound tasks.
 *
 * The Task class is responsible for:
 * 1. Defining what a task is (inputs, outputs, configuration)
 * 2. Providing the execution logic (via execute and executePreview)
 * 3. Delegating the running logic to a TaskRunner
 */
export class Task<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends TaskConfig = TaskConfig,
> implements ITask<Input, Output, Config> {
  // ========================================================================
  // Static properties - should be overridden by subclasses
  // ========================================================================

  public static type: TaskTypeName = "Task";

  public static category: string = "Hidden";

  public static title: string = "";

  public static description: string = "";

  public static cacheable: boolean = true;

  /**
   * Version number for this task class, used to bust the output cache when the task's
   * implementation changes. Increment when a change would produce different outputs for
   * the same inputs. Combined with ancestor versions via getCacheVersion().
   * Subclasses should override this when their execute() logic changes in a
   * backwards-incompatible way (different output for same input).
   */
  public static version: number = 1;

  /**
   * Default cache policy for this task class. Used by `getCachePolicy()` when the
   * task does not override the method. Subclasses with side effects should set
   * `{ kind: "none" }`; tasks producing non-deterministic-but-expensive outputs
   * (e.g., image generation without a seed) should set `{ kind: "private" }`.
   */
  public static cachePolicy: CachePolicy = { kind: "deterministic" };

  /**
   * Whether this task has dynamic input/output schemas that can change at runtime.
   * Tasks with dynamic schemas should override instance methods for inputSchema() and/or outputSchema()
   * and emit 'schemaChange' events when their schemas change.
   */
  public static hasDynamicSchemas: boolean = false;

  /**
   * When true, dynamically added input ports (via the universal "Add Input" handle in the builder)
   * are mirrored as output ports of the same name and type. Set this on pass-through tasks that
   * forward their additional inputs to their outputs unchanged.
   */
  public static passthroughInputsToOutputs: boolean = false;

  /**
   * When true, this task can be saved as a custom task with a preset configuration.
   * Tasks that have meaningful user-facing config options beyond the base fields should set this.
   */
  public static customizable: boolean = false;

  /**
   * When true, this task defines the graph's output. The graph runner will
   * collect results only from tasks with this flag when they exist among the
   * leaf nodes; otherwise it falls back to collecting from all leaves.
   */
  public static isGraphOutput: boolean = false;

  /**
   * When true, this task does no real work — it only forwards inputs to outputs
   * (e.g. `InputTask`, `OutputTask`). Such tasks are excluded from graph-level
   * progress averaging because they jump from 0% to 100% and would dilute the bar.
   */
  public static isPassthrough: boolean = false;

  /**
   * Whether this task has dynamic entitlements that can change at runtime.
   * Tasks with dynamic entitlements should override the instance entitlements() method
   * and emit 'entitlementChange' events when their entitlements change.
   */
  public static hasDynamicEntitlements: boolean = false;

  /**
   * Whether this task's entitlements come from tasks it CONTAINS rather than
   * from its own declaration.
   *
   * Distinct from {@link hasDynamicEntitlements}, and the two must not be
   * conflated by anything deciding whether a static declaration can be
   * trusted. A task is dynamic when it refines what it already declares —
   * an AI task declares `ai:inference` statically and adds `ai:model` scoped
   * to the resolved model id at run time — and there the static answer is
   * representative. A task whose entitlements come from children declares
   * NOTHING statically while its instance may reach anywhere, so the static
   * answer is not merely coarse, it is empty and misleading.
   *
   * "Children" means tasks NOT KNOWN UNTIL RUN TIME — the subgraph a
   * `GraphAsTask` is handed. A task that owns a fixed, hard-coded child in
   * `execute()` is not this: its reach is knowable from its own source, so it
   * declares the union its children need and leaves this false. Setting it
   * there would tell a reader the reach is undeclared when it is merely
   * inherited — the same misleading prompt in the other direction.
   */
  public static entitlementsFromChildren: boolean = false;

  /**
   * Entitlements required by this task class.
   * Subclasses override to declare their permission requirements.
   */
  public static entitlements(): TaskEntitlements {
    return EMPTY_ENTITLEMENTS;
  }

  public static inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  public static outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  /**
   * Config schema for this task. Subclasses that add config properties MUST override this
   * and spread TaskConfigSchema["properties"] into their own properties object.
   */
  public static configSchema(): DataPortSchema {
    return TaskConfigSchema;
  }

  // ========================================================================
  // Task Execution Methods - Core logic provided by subclasses
  // ========================================================================

  /**
   * The actual task execution logic for subclasses to override
   *
   * @param input The input to the task
   * @param config The configuration for the task
   * @throws TaskError if the task fails
   * @returns The output of the task or undefined if no changes
   */
  public async execute(_input: Input, context: IExecuteContext): Promise<Output | undefined> {
    if (context.signal?.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    return undefined;
  }

  /**
   * Default implementation of executePreview that does nothing.
   * Subclasses should override this to provide actual preview functionality.
   *
   * This is generally for UI updating, and should be lightweight.
   * @param input The input to the task
   * @returns The preview output, or undefined for "no preview update"
   */
  public async executePreview(
    _input: Input,
    _context: IExecutePreviewContext
  ): Promise<Output | undefined> {
    return undefined;
  }

  // ========================================================================
  // TaskRunner delegation - Executes and manages the task
  // ========================================================================

  /**
   * The TaskGraph that owns this task, set by {@link TaskGraph#addTask}.
   * Used by {@link TaskRunner#runPreviewStream} to locate upstream tasks
   * and subscribe to their streaming events.
   */
  public parentGraph?: TaskGraph;

  protected _runner: TaskRunner<Input, Output, Config> | undefined;

  public get runner(): TaskRunner<Input, Output, Config> {
    if (!this._runner) {
      this._runner = new TaskRunner<Input, Output, Config>(this);
    }
    return this._runner;
  }

  /**
   * Runs the task and returns the output
   * Delegates to the task runner
   *
   * @param overrides Optional input overrides
   * @param runConfig Optional per-call run configuration (merged with task's runConfig)
   * @throws TaskError if the task fails
   * @returns The task output
   */
  async run(overrides: Partial<Input> = {}, runConfig: Partial<IRunConfig> = {}): Promise<Output> {
    return this.runner.run(overrides, { ...this.runConfig, ...runConfig });
  }

  /**
   * Runs the task in preview mode. Delegates to the task runner.
   */
  public async runPreview(overrides: Partial<Input> = {}): Promise<Output> {
    return this.runner.runPreview(overrides);
  }

  public abort(): void {
    this.runner.abort();
  }

  public async disable(): Promise<void> {
    await this.runner.disable();
  }

  /**
   * Report a charge that settles after this execution finished — provider
   * cache storage, billed when the checkpoint is disposed. Folded into this
   * task's total and forwarded to the run's sink.
   */
  public chargeLateUsage(usage: Usage, modelId: string | undefined): void {
    // While this task is executing again, StreamProcessor owns runUsage and the
    // graph is still observing this task's cumulative `usage` events; folding
    // the charge in there as well as into the run total would count it twice.
    const live = this.status === TaskStatus.PROCESSING || this.status === TaskStatus.STREAMING;
    if (!live) {
      const total = mergeUsage(this.runUsage, usage);
      this.runUsage = total;
      if (total) {
        try {
          // The merged cumulative total, not the bare charge: the `usage`
          // contract is replace-not-accumulate, so a delta blanks every
          // consumer's display.
          this.emit("usage", total, modelId ?? this.runUsageModelId);
        } catch (err) {
          getLogger().error("usage listener threw", { taskId: this.id, error: err });
        }
      }
    }
    this.runner.reportLateUsage(usage, modelId);
  }

  // ========================================================================
  // Static to Instance conversion methods
  // ========================================================================

  public inputSchema(): DataPortSchema {
    return (this.constructor as typeof Task).inputSchema();
  }

  public outputSchema(): DataPortSchema {
    return (this.constructor as typeof Task).outputSchema();
  }

  public configSchema(): DataPortSchema {
    return (this.constructor as typeof Task).configSchema();
  }

  /**
   * Gets entitlements for this task instance.
   * For tasks with dynamic entitlements, override this to compute based on config/state.
   */
  public entitlements(): TaskEntitlements {
    return (this.constructor as typeof Task).entitlements();
  }

  /**
   * Emits an entitlementChange event when the task's required entitlements change.
   * Call this from tasks with dynamic entitlements when their configuration changes
   * in a way that affects their entitlements.
   */
  protected emitEntitlementChange(entitlements?: TaskEntitlements): void {
    const final = entitlements ?? this.entitlements();
    this.emit("entitlementChange", final);
  }

  public get type(): TaskTypeName {
    return (this.constructor as typeof Task).type;
  }

  public get category(): string {
    return (this.constructor as typeof Task).category;
  }

  public get title(): string {
    return this.config?.title ?? (this.constructor as typeof Task).title;
  }

  /**
   * Relabels this instance. Needed when one task instance is reused for a
   * sequence of distinct jobs (so a progress UI names the current one) — the
   * usual case is set-once via `config.title` at construction.
   */
  public setTitle(title: string): void {
    this.config.title = title;
  }

  public get description(): string {
    return this.config?.description ?? (this.constructor as typeof Task).description;
  }

  /**
   * Whether this task instance is currently cacheable. Reads `runConfig.cacheable`
   * and `config.cacheable` first (per-instance overrides for back-compat), then
   * derives from `getCachePolicy(runInputData)`.
   *
   * Note: for tasks that override `getCachePolicy(inputs)` with input-dependent
   * logic (e.g., `AiImageOutputTask` returns `private` when seed is absent), the
   * value of `task.cacheable` can change as `runInputData` changes. Prefer calling
   * `getCachePolicy(inputs)` directly when you have explicit inputs.
   */
  public get cacheable(): boolean {
    if (this.runConfig?.cacheable !== undefined) return this.runConfig.cacheable;
    if (this.config?.cacheable !== undefined) return this.config.cacheable;
    return this.getCachePolicy((this.runInputData ?? {}) as unknown as Input).kind !== "none";
  }

  /**
   * Returns a dot-separated string of version numbers collected from each class in the
   * prototype chain (leaf first) that declares its own `version` static property.
   * Every class that owns a `version` contributes one segment, including the base Task
   * class. Returns "1" when called directly on a Task instance with no subclassing
   * (Task.version === 1 is the sole contributor).
   *
   * Use this as the cache-key version component: when any ancestor's version changes,
   * the combined string changes and the cached output is invalidated.
   */
  public getCacheVersion(): string {
    return collectCacheVersion(this.constructor);
  }

  /**
   * Returns the effective cache policy for this task given its inputs.
   *
   * Resolution order:
   *   1. Per-instance `runConfig.cacheable === false` or `config.cacheable === false`
   *      → `{ kind: "none" }` (callsite opt-out wins).
   *   2. Class-static `cacheable === false` (declared on the subclass) →
   *      `{ kind: "none" }`. The coarse on/off flag remains supported alongside
   *      the canonical `cachePolicy`; setting it on the class is equivalent
   *      to declaring `static cachePolicy: CachePolicy = { kind: "none" }`.
   *   3. Class-static `cachePolicy` if declared.
   *   4. {@link DEFAULT_CACHE_POLICY}.
   *
   * Override for dynamic decisions (e.g., AiImageOutputTask returns `private`
   * when seed is absent).
   */
  public getCachePolicy(_inputs: Input): CachePolicy {
    return resolveCachePolicy(this.constructor as typeof Task, this.config, this.runConfig);
  }

  // ========================================================================
  // Instance properties using @template types
  // ========================================================================

  /**
   * Default input values for this task.
   * If no overrides at run time, then this would be equal to the input.
   * resetInputData() will reset inputs to these defaults.
   */
  defaults: Record<string, any>;

  /**
   * The input to the task at the time of the task run.
   * This takes defaults from construction time and overrides from run time.
   * It is the input that created the output.
   */
  runInputData: Record<string, any> = {};

  /**
   * The output of the task at the time of the task run.
   * This is the result of the task execution.
   */
  runOutputData: Record<string, any> = {};

  runUsage: Usage | undefined = undefined;
  runUsageModelId: string | undefined = undefined;

  // ========================================================================
  // Task state properties
  // ========================================================================

  config: Config;

  /**
   * Frozen snapshot of config at construction time, used by toJSON and
   * as the resolution source for re-runs (so fresh lookups use original IDs).
   */
  readonly originalConfig: Readonly<Record<string, unknown>> | undefined;

  public get id(): unknown {
    return this.config.id;
  }

  /**
   * Whether this task instance has a caller-pinned (deterministic) id. The
   * default constructor mints a fresh v4 UUID when no id is supplied, so a
   * v4-UUID-shaped id is treated as autogenerated — not deterministic — and
   * the run-private cache will fall back to keying by task type to preserve
   * a best-effort crash-resume across restarts. Override (or pin `config.id`
   * to a stable string) to enable exact row reuse across restarts.
   */
  public hasDeterministicId(): boolean {
    return isDeterministicId(this.config.id);
  }

  /**
   * Runtime configuration (not serialized with the task).
   * Set via the constructor's third argument or mutated by the graph runner.
   */
  runConfig: Partial<IRunConfig> = {};

  status: TaskStatus = TaskStatus.PENDING;

  /**
   * Current progress, 0..100 for measured progress, `undefined` for
   * indeterminate. Initialized to 0 (not started).
   */
  progress: number | undefined = 0;

  createdAt: Date = new Date();

  startedAt?: Date;

  completedAt?: Date;

  error?: TaskError;

  public get events(): EventEmitter<TaskEventListeners> {
    if (!this._events) {
      this._events = new EventEmitter<TaskEventListeners>();
    }
    return this._events;
  }
  protected _events: EventEmitter<TaskEventListeners> | undefined;

  /**
   * Creates a new task instance
   *
   * @param config Configuration for the task (includes defaults for input values)
   * @param runConfig Runtime configuration for the task
   */
  constructor(config: NoInfer<Partial<Config>> = {}, runConfig: NoInfer<Partial<IRunConfig>> = {}) {
    const { defaults: callerDefaultInputs, ...restConfig } = config as Partial<Config> & {
      defaults?: Partial<Input>;
    };

    const inputDefaults = this.getDefaultInputsFromStaticInputDefinitions();
    const mergedDefaults = Object.assign(inputDefaults, callerDefaultInputs ?? {});
    // Strip symbol properties (like [$JSONSchema]) before storing defaults
    this.defaults = stripSymbols(mergedDefaults) as Record<string, any>;
    this.resetInputData();

    const title = (this.constructor as typeof Task).title || undefined;
    const baseConfig = Object.assign(
      {
        ...(title ? { title } : {}),
      },
      restConfig
    ) as Config;
    if (baseConfig.id === undefined) {
      (baseConfig as Record<string, unknown>).id = uuid4();
    }
    this.config = this.validateAndApplyConfigDefaults(baseConfig);
    try {
      this.originalConfig = Object.freeze(structuredClone(this.config) as Record<string, unknown>);
    } catch {
      // Config contains non-cloneable values (e.g. functions).
      // canSerializeConfig() should return false for such tasks.
      this.originalConfig = undefined;
    }

    this.runConfig = runConfig;

    // Reject input schemas that declare a `__cv` port: this name is reserved by
    // CacheCoordinator.buildKey for the cache version sentinel. Allowing a task
    // to declare it would silently shadow cache versioning and cause cache
    // collisions across versions. `inputSchema()` can legally return a boolean
    // (see addInput/setInput handling); skip the check in that case.
    const inputSchema = (this.constructor as typeof Task).inputSchema();
    if (
      inputSchema &&
      typeof inputSchema !== "boolean" &&
      inputSchema.properties &&
      Object.prototype.hasOwnProperty.call(inputSchema.properties, "__cv")
    ) {
      throw new TaskConfigurationError(
        `Task "${(this.constructor as typeof Task).type}": input port name '__cv' is reserved ` +
          `for cache versioning. Rename the port to avoid collision with the cache key sentinel.`
      );
    }
  }

  // ========================================================================
  // Input/Output handling
  // ========================================================================

  getDefaultInputsFromStaticInputDefinitions(): Partial<Input> {
    const schema = this.inputSchema();
    if (typeof schema === "boolean") {
      return {};
    }
    try {
      const compiledSchema = this.getInputSchemaNode();
      const defaultData = compiledSchema.getData(undefined, {
        addOptionalProps: true,
        removeInvalidData: false,
        useTypeDefaults: false,
      });
      return (defaultData || {}) as Partial<Input>;
    } catch (error) {
      getLogger().warn(
        `Failed to compile input schema for ${this.type}, falling back to manual extraction:`,
        { error }
      );
      // Fallback to manual extraction if compilation fails
      return Object.entries(schema.properties || {}).reduce<Record<string, any>>(
        (acc, [id, prop]) => {
          const defaultValue = (prop as any).default;
          if (defaultValue !== undefined) {
            acc[id] = defaultValue;
          }
          return acc;
        },
        {}
      ) as Partial<Input>;
    }
  }

  public resetInputData(): void {
    this.runInputData = smartClone(this.defaults) as Record<string, any>;
  }

  public setDefaults(defaults: Partial<Input>): void {
    // Strip symbol properties (like [$JSONSchema]) before storing defaults
    this.defaults = stripSymbols(defaults) as Partial<Input>;
  }

  public setInput(input: Partial<Input>): void {
    const schema = this.inputSchema();
    if (typeof schema === "boolean") {
      if (schema === true) {
        for (const [inputId, value] of Object.entries(input)) {
          if (value !== undefined) {
            this.runInputData[inputId] = value;
          }
        }
      }
      return;
    }
    const properties = schema.properties || {};

    for (const [inputId, prop] of Object.entries(properties)) {
      if (input[inputId] !== undefined) {
        this.runInputData[inputId] = input[inputId];
      } else if (
        this.runInputData[inputId] === undefined &&
        (prop as { default?: unknown }).default !== undefined
      ) {
        this.runInputData[inputId] = prop.default;
      }
    }

    // If additionalProperties is true, also copy any additional input properties
    if (schema.additionalProperties) {
      for (const [inputId, value] of Object.entries(input)) {
        if (!(inputId in properties)) {
          this.runInputData[inputId] = value;
        }
      }
    }
  }

  /**
   * Adds/merges input data during graph execution.
   * Unlike {@link setInput}, this method:
   * - Detects changes using deep equality
   * - Accumulates array values (appends rather than replaces)
   * - Handles DATAFLOW_ALL_PORTS for pass-through
   * - Handles additionalProperties for dynamic schemas
   *
   * @param overrides The input data to merge
   * @returns true if any input data was changed, false otherwise
   */
  public addInput(overrides: Partial<Input> | undefined): boolean {
    if (!overrides) return false;

    let changed = false;
    const inputSchema = this.inputSchema();

    if (typeof inputSchema === "boolean") {
      if (inputSchema === false) {
        return false;
      }
      // Schema is `true` - accept any input
      for (const [key, value] of Object.entries(overrides)) {
        if (!deepEqual(this.runInputData[key], value)) {
          this.runInputData[key] = value;
          changed = true;
        }
      }
      return changed;
    }

    const properties = inputSchema.properties || {};

    for (const [inputId, prop] of Object.entries(properties)) {
      if (inputId === DATAFLOW_ALL_PORTS) {
        this.runInputData = { ...this.runInputData, ...overrides };
        changed = true;
      } else {
        // `undefined` is treated as "no value provided" (absent), not as an
        // explicit clear: a dataflow yielding undefined does NOT reset a
        // previously-set port. There is intentionally no way to unset a port via
        // this merge path; the previous value persists.
        if (overrides[inputId] === undefined) continue;
        const isArray =
          (prop as any)?.type === "array" ||
          ((prop as any)?.type === "any" &&
            (Array.isArray(overrides[inputId]) || Array.isArray(this.runInputData[inputId])));

        if (isArray) {
          const existingItems = Array.isArray(this.runInputData[inputId])
            ? this.runInputData[inputId]
            : this.runInputData[inputId] !== undefined
              ? [this.runInputData[inputId]]
              : [];
          const newitems = [...existingItems];

          const overrideItem = overrides[inputId];
          if (Array.isArray(overrideItem)) {
            newitems.push(...overrideItem);
          } else {
            newitems.push(overrideItem);
          }
          this.runInputData[inputId] = newitems;
          changed = true;
        } else {
          if (!deepEqual(this.runInputData[inputId], overrides[inputId])) {
            this.runInputData[inputId] = overrides[inputId];
            changed = true;
          }
        }
      }
    }

    // If additionalProperties is true, also accept any additional input properties
    if (inputSchema.additionalProperties) {
      for (const [inputId, value] of Object.entries(overrides)) {
        if (!(inputId in properties)) {
          if (!deepEqual(this.runInputData[inputId], value)) {
            this.runInputData[inputId] = value;
            changed = true;
          }
        }
      }
    }

    return changed;
  }

  /**
   * Stub for narrowing input. Override in subclasses for custom logic.
   * @param input The input to narrow
   * @param _registry Optional service registry for lookups
   * @returns The (possibly narrowed) input
   */
  public async narrowInput(
    input: Partial<Input>,
    _registry: ServiceRegistry
  ): Promise<Partial<Input>> {
    return input;
  }

  // ========================================================================
  // Event handling methods
  // ========================================================================

  public subscribe<Event extends TaskEvents>(
    name: Event,
    fn: TaskEventListener<Event>
  ): () => void {
    return this.events.subscribe(name, fn);
  }

  public on<Event extends TaskEvents>(name: Event, fn: TaskEventListener<Event>): void {
    this.events.on(name, fn);
  }

  public off<Event extends TaskEvents>(name: Event, fn: TaskEventListener<Event>): void {
    this.events.off(name, fn);
  }

  public once<Event extends TaskEvents>(name: Event, fn: TaskEventListener<Event>): void {
    this.events.once(name, fn);
  }

  /**
   * Returns a promise that resolves when the specified event is emitted
   */
  public waitOn<Event extends TaskEvents>(name: Event): Promise<TaskEventParameters<Event>> {
    return this.events.waitOn(name) as Promise<TaskEventParameters<Event>>;
  }

  public emit<Event extends TaskEvents>(name: Event, ...args: TaskEventParameters<Event>): void {
    // Route through `events` so the emitter exists: `this._events?.emit` dropped progress when
    // nothing had accessed `task.events` yet (e.g. parent MapTask before CLI wired listeners).
    this.events.emit(name, ...args);
  }

  /**
   * Emits a schemaChange event when the task's input or output schema changes.
   * This should be called by tasks with dynamic schemas when their configuration
   * changes in a way that affects their schemas.
   *
   * @param inputSchema - The new input schema (optional, will use current schema if not provided)
   * @param outputSchema - The new output schema (optional, will use current schema if not provided)
   */
  protected emitSchemaChange(inputSchema?: DataPortSchema, outputSchema?: DataPortSchema): void {
    const finalInputSchema = inputSchema ?? this.inputSchema();
    const finalOutputSchema = outputSchema ?? this.outputSchema();
    this.emit("schemaChange", finalInputSchema, finalOutputSchema);
  }

  // ========================================================================
  // Input validation methods
  // ========================================================================

  /**
   * Gets the compiled config schema node, or undefined if no configSchema is defined.
   *
   * The compiled schema is cached directly on the concrete class object (not in a shared
   * inherited Map) so that each subclass always uses its own configSchema() result.
   * A shared Map keyed only by type name can be poisoned if a different class computes
   * and caches the schema first — e.g., due to cross-package static-method resolution
   * inconsistencies in bundled outputs.
   */
  private static getConfigSchemaNode(): SchemaNode | undefined {
    const schema = this.configSchema();
    if (!schema) return undefined;
    // Use Object.hasOwn so each class gets its own entry rather than inheriting
    // from a parent class that already cached under the same key.
    if (!Object.hasOwn(this, "__compiledConfigSchema")) {
      try {
        const schemaNode =
          typeof schema === "boolean"
            ? compileSchema(schema ? {} : { not: {} })
            : compileSchema(schema);
        Object.defineProperty(this, "__compiledConfigSchema", {
          value: schemaNode,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch (error) {
        throw new TaskConfigurationError(
          `${this.type}: the config schema could not be compiled, so config cannot be validated: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    return (this as any).__compiledConfigSchema as SchemaNode;
  }

  /**
   * Validates config against configSchema.
   * Returns config as-is; throws on validation errors.
   * Returns config as-is if no configSchema is defined.
   */
  private validateAndApplyConfigDefaults(config: Config): Config {
    const ctor = this.constructor as typeof Task;
    const schemaNode = ctor.getConfigSchemaNode();
    if (!schemaNode) return config;

    const result = schemaNode.validate(config);
    if (!result.valid) {
      const errorMessages = result.errors.map((e) => {
        const path = e.data?.pointer || "";
        return `${e.message}${path ? ` (${path})` : ""}`;
      });
      throw new TaskConfigurationError(
        `[${ctor.name}] Configuration Error: ${errorMessages.join(", ")}`
      );
    }

    return config;
  }

  /**
   * Returns a copy of an object input schema with `ports` removed from both
   * `properties` and `required`. Used by {@link validateInput} to exclude
   * stream-wired ports (which have no settled value this run) from whole-value
   * validation. Boolean schemas and non-object schemas pass through unchanged.
   */
  private static schemaWithoutPorts(
    schema: DataPortSchema,
    ports: ReadonlySet<string>
  ): DataPortSchema {
    if (typeof schema === "boolean" || !schema.properties) return schema;
    const properties: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (!ports.has(name)) properties[name] = prop;
    }
    const next: Record<string, unknown> = { ...schema, properties };
    if (Array.isArray(schema.required)) {
      next.required = schema.required.filter((r: string) => !ports.has(r));
    }
    return next as DataPortSchema;
  }

  protected static generateInputSchemaNode(schema: DataPortSchema) {
    if (typeof schema === "boolean") {
      if (schema === false) {
        return compileSchema({ not: {} });
      }
      return compileSchema({});
    }
    return compileSchema(schema);
  }

  /**
   * Compiles an input schema, refusing one that will not compile: a task whose
   * inputs cannot be validated does not run unvalidated.
   */
  protected static compileInputSchemaNode(schema: DataPortSchema, taskType: string): SchemaNode {
    try {
      return this.generateInputSchemaNode(schema);
    } catch (error) {
      throw new TaskConfigurationError(
        `${taskType}: the input schema could not be compiled, so inputs cannot be validated: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Gets the compiled input schema, cached per class (not in a shared inherited Map).
   * Uses Object.hasOwn so each subclass stores its own compiled schema and never
   * picks up a stale entry cached by a different class with the same type name.
   */
  protected static getInputSchemaNode(): SchemaNode {
    if (!Object.hasOwn(this, "__compiledInputSchema")) {
      const schemaNode = this.compileInputSchemaNode(this.inputSchema(), this.type);
      Object.defineProperty(this, "__compiledInputSchema", {
        value: schemaNode,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    return (this as any).__compiledInputSchema as SchemaNode;
  }

  protected getInputSchemaNode(): SchemaNode {
    return (this.constructor as typeof Task).getInputSchemaNode();
  }

  /**
   * Compiled input schemas that are not the static one — an instance's dynamic schema, or
   * either kind with stream-wired ports removed — cached per class and keyed by the
   * schema's JSON text. Compiling costs ~25× a validation, and these are rebuilt on every
   * run; keying by content rather than identity keeps a schema edited in place from
   * validating against its old shape.
   */
  protected static getDerivedInputSchemaNode(schema: DataPortSchema): SchemaNode {
    let key: string | undefined;
    try {
      key = JSON.stringify(schema);
    } catch {
      key = undefined;
    }
    if (key === undefined) return this.compileInputSchemaNode(schema, this.type);
    if (!Object.hasOwn(this, "__derivedInputSchemaNodes")) {
      Object.defineProperty(this, "__derivedInputSchemaNodes", {
        value: new Map<string, SchemaNode>(),
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    const cache = (this as any).__derivedInputSchemaNodes as Map<string, SchemaNode>;
    const hit = cache.get(key);
    if (hit) {
      // Re-insert so eviction drops the least recently used schema.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const node = this.compileInputSchemaNode(schema, this.type);
    cache.set(key, node);
    if (cache.size > Task.MAX_DERIVED_INPUT_SCHEMA_NODES) {
      cache.delete(cache.keys().next().value as string);
    }
    return node;
  }

  private static readonly MAX_DERIVED_INPUT_SCHEMA_NODES = 32;

  /**
   * Validates an input data object against the task's input schema.
   *
   * `skipPorts` exempts the named input ports from validation: they are dropped
   * from both the validated object and a derived copy of the schema (removed
   * from `properties` and `required`), so neither a type mismatch nor a
   * `required` check fires for them. The runner passes the ports it is feeding
   * as a live event stream this run — a stream-wired port has no settled value
   * to validate (its slot may hold only a {@link CacheRef} pointer), so
   * whole-value validation does not apply. Ports that carry a settled value are
   * always validated, even when they declare `x-stream`.
   */
  public async validateInput(input: Input, skipPorts?: ReadonlySet<string>): Promise<boolean> {
    if (typeof input !== "object" || input === null) {
      throw new TaskInvalidInputError("Input must be an object");
    }
    const ctor = this.constructor as typeof Task;
    const skip = skipPorts && skipPorts.size > 0 ? skipPorts : undefined;
    let validated: Record<string, unknown> = input as Record<string, unknown>;
    let schemaNode: SchemaNode;
    if (skip) {
      // Validate the settled ports against a schema with the streamed ports
      // removed; drop their keys from the object so `additionalProperties:false`
      // does not then reject them as unknown.
      const base = ctor.hasDynamicSchemas ? this.inputSchema() : ctor.inputSchema();
      schemaNode = ctor.getDerivedInputSchemaNode(Task.schemaWithoutPorts(base, skip));
      validated = { ...(input as Record<string, unknown>) };
      for (const port of skip) delete validated[port];
    } else if (ctor.hasDynamicSchemas) {
      // Dynamic-schema tasks use instance inputSchema() (e.g. config.inputSchema), not the static fallback.
      // The cached getInputSchemaNode uses static inputSchema() which would reject valid instance-specific inputs.
      schemaNode = ctor.getDerivedInputSchemaNode(this.inputSchema());
    } else {
      schemaNode = this.getInputSchemaNode();
    }
    const result = schemaNode.validate(validated);

    if (!result.valid) {
      const errorMessages = result.errors.map((e) => {
        const path = e.data.pointer || "";
        return `${e.message}${path ? ` (${path})` : ""}`;
      });
      const err = new TaskInvalidInputError(
        `Task "${this.type}" (${String(this.id)}): Input ${JSON.stringify(Object.keys(input))} does not match schema: ${errorMessages.join(", ")}`
      );
      err.taskType = this.type;
      err.taskId = this.id;
      throw err;
    }

    return true;
  }

  // ========================================================================
  // Serialization methods
  // ========================================================================

  /**
   * Returns whether the task's config can be serialized to JSON.
   * Override in subclasses that store non-serializable values (functions) in config.
   * Called by toJSON — if false, toJSON throws TaskSerializationError.
   */
  public canSerializeConfig(): boolean {
    return true;
  }

  /**
   * Serializes the task and its subtasks into a format that can be stored
   * @param _options Options controlling serialization (used by subclasses)
   * @returns The serialized task and subtasks
   */
  public toJSON(_options?: TaskGraphJsonOptions): TaskGraphItemJson {
    return buildTaskJson(this, _options);
  }

  /**
   * Converts the task to a JSON format suitable for dependency tracking
   * @param options Options controlling serialization (used by subclasses)
   * @returns The task and subtasks in JSON thats easier for humans to read
   */
  public toDependencyJSON(options?: TaskGraphJsonOptions): JsonTaskItem {
    const json = this.toJSON(options);
    return json;
  }

  // ========================================================================
  // Internal graph methods
  // ========================================================================

  /**
   * Checks if the task has children. Useful to gate to use of the internal subGraph
   * as this will return without creating a new graph if graph is non-existent .
   *
   * @returns True if the task has children, otherwise false
   */
  public hasChildren(): boolean {
    return (
      this._subGraph !== undefined &&
      this._subGraph !== null &&
      this._subGraph.getTasks().length > 0
    );
  }

  private _taskAddedListener: (taskId: TaskIdType) => void = () => {
    this.emit("regenerate");
  };

  /**
   * The internal task graph containing subtasks
   *
   * In the base case, these may just be incidental tasks that are not part of the task graph
   * but are used to manage the task's state as part of task execution. Therefore, the graph
   * is not used by the default runner.
   */
  protected _subGraph: TaskGraph | undefined = undefined;

  /**
   * Sets the subtask graph for the compound task
   * @param subGraph The subtask graph to set
   */
  set subGraph(subGraph: TaskGraph) {
    if (this._subGraph) {
      this._subGraph.off("task_added", this._taskAddedListener);
    }
    this._subGraph = subGraph;
    this._subGraph.on("task_added", this._taskAddedListener);
  }

  /**
   * The internal task graph containing subtasks
   *
   * In the base case, these may just be incidental tasks that are not part of the task graph
   * but are used to manage the task's state as part of task execution. Therefore, the graph
   * is not used by the default runner.
   *
   * Creates a new graph if one doesn't exist.
   *
   * @returns The task graph
   */
  get subGraph(): TaskGraph {
    if (!this._subGraph) {
      this._subGraph = new TaskGraph();
      this._subGraph.on("task_added", this._taskAddedListener);
    }
    return this._subGraph;
  }

  /**
   * Regenerates the task graph, which is internal state to execute() with config.own()
   *
   * This is a destructive operation that removes all dataflows and tasks from the graph.
   * It is used to reset the graph to a clean state.
   *
   * GraphAsTask and others override this and do not call super
   */
  public regenerateGraph(): void {
    if (this.hasChildren()) {
      for (const dataflow of this.subGraph.getDataflows()) {
        this.subGraph.removeDataflow(dataflow);
      }
      for (const child of this.subGraph.getTasks()) {
        this.subGraph.removeTask(child.id);
      }
    }
    this.events.emit("regenerate");
  }
}
