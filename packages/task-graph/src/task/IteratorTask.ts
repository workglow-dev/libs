/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema, PropertySchema } from "@workglow/util/schema";
import type { TaskGraph } from "../task-graph/TaskGraph";
import type { GraphAsTaskConfig } from "./GraphAsTask";
import { GraphAsTask, graphAsTaskConfigSchema } from "./GraphAsTask";
import type { IExecuteContext, IRunConfig } from "./ITask";
import { IteratorTaskRunner } from "./IteratorTaskRunner";
import type { StreamEvent } from "./StreamTypes";
import { TaskConfigurationError } from "./TaskError";
import type { TaskInput, TaskOutput, TaskTypeName } from "./TaskTypes";

/**
 * Standard iteration context schema for IteratorTask subclasses (Map, Reduce).
 * Properties are marked with "x-ui-iteration": true so the builder
 * knows to hide them from parent-level display.
 */
export const ITERATOR_CONTEXT_SCHEMA: DataPortSchema = {
  type: "object",
  properties: {
    _iterationIndex: {
      type: "integer",
      minimum: 0,
      title: "Iteration Index",
      description: "Current iteration index (0-based)",
      "x-ui-iteration": true,
    },
    _iterationCount: {
      type: "integer",
      minimum: 0,
      title: "Iteration Count",
      description: "Total number of iterations",
      "x-ui-iteration": true,
    },
  },
};

/**
 * Execution mode for iterator tasks.
 * - `parallel`: Execute all iterations concurrently (logical mode)
 * - `parallel-limited`: Execute with a concurrency limit
 */
export type ExecutionMode = "parallel" | "parallel-limited";

/**
 * Input mode for a property in the iteration input schema.
 * - "array": Property must be an array (will be iterated)
 * - "scalar": Property must be a scalar (constant for all iterations)
 * - "flexible": Property accepts both array and scalar (T | T[])
 */
export type IterationInputMode = "array" | "scalar" | "flexible";

/**
 * Upper bound for iteration. Either a positive integer or the string
 * sentinel `"unbounded"` — which the runner treats as `Number.POSITIVE_INFINITY`.
 * The string form forces every caller to explicitly acknowledge the opt-out
 * instead of silently dropping the safety ceiling.
 */
export type IterationBound = number | "unbounded";

/**
 * Resolves an IterationBound to a numeric cap the runner can compare against.
 */
export function resolveIterationBound(bound: IterationBound): number {
  return bound === "unbounded" ? Number.POSITIVE_INFINITY : bound;
}

export interface IterationPropertyConfig {
  /** The base schema for the property (without array wrapping) */
  readonly baseSchema: PropertySchema;
  /** The input mode for this property */
  readonly mode: IterationInputMode;
}

export const iteratorTaskConfigSchema = {
  type: "object",
  properties: {
    ...graphAsTaskConfigSchema["properties"],
    concurrencyLimit: { type: "integer", minimum: 1 },
    concurrencyMode: { type: "string", enum: ["inline", "thread"] },
    batchSize: { type: "integer", minimum: 1 },
    maxIterations: {
      oneOf: [
        { type: "integer", minimum: 1 },
        { type: "string", const: "unbounded" },
      ],
    },
    iterationInputConfig: { type: "object", additionalProperties: true },
  },
  required: ["maxIterations"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type IteratorTaskConfig<Input extends TaskInput = TaskInput> = GraphAsTaskConfig<Input> & {
  /**
   * Maximum number of concurrent iteration workers
   * @default undefined (unlimited)
   */
  readonly concurrencyLimit?: number;

  /**
   * Where each iteration's subgraph runs.
   *
   * `"inline"` (the default) runs it on this thread, concurrently with its
   * siblings but sharing one core: `concurrencyLimit` interleaves waiting, it
   * does not add compute.
   *
   * `"thread"` asks for it to be dispatched off-thread through the registered
   * {@link SUBGRAPH_DISPATCHER}, so `concurrencyLimit` becomes a real
   * parallelism width. It is a *request*, not a guarantee — an iteration falls
   * back to `"inline"`, with the reason logged, when no dispatcher is
   * registered or the subgraph is not thread-portable (see
   * {@link taskGraphThreadPortabilityError}). A graph must produce the same
   * result either way, so only ask for it where the per-iteration work is CPU
   * the host owns: a subgraph that fetches over a rate-limited host belongs on
   * the thread holding the limiter.
   *
   * @default "inline"
   */
  readonly concurrencyMode?: "inline" | "thread";

  /**
   * Number of items per batch. When set, iteration indices are grouped into batches.
   * @default undefined
   */
  readonly batchSize?: number;

  /**
   * Upper bound on the number of iterations. Required — pass `"unbounded"` to
   * explicitly opt out of the safety ceiling, or a positive integer to cap.
   * Prevents runaway iteration on unexpectedly large input arrays.
   */
  readonly maxIterations: IterationBound;

  /**
   * User-defined iteration input schema configuration.
   */
  readonly iterationInputConfig?: Record<string, IterationPropertyConfig>;
};

interface IteratorPortInfo {
  readonly portName: string;
  readonly itemSchema: DataPortSchema;
}

export interface IterationAnalysisResult {
  /** The number of iterations to perform */
  readonly iterationCount: number;
  /** Names of properties that are arrays (to be iterated) */
  readonly arrayPorts: string[];
  /** Names of properties that are scalars (passed as constants) */
  readonly scalarPorts: string[];
  /** Gets the input for a specific iteration index */
  getIterationInput(index: number): Record<string, unknown>;
}

function isArrayVariant(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  return record.type === "array" || record.items !== undefined;
}

function getExplicitIterationFlag(schema: DataPortSchema | undefined): boolean | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const record = schema as Record<string, unknown>;
  const flag = record["x-ui-iteration"];
  if (flag === true) return true;
  if (flag === false) return false;
  return undefined;
}

function inferIterationFromSchema(schema: DataPortSchema | undefined): boolean | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  const record = schema as Record<string, unknown>;

  if (record.type === "array" || record.items !== undefined) {
    return true;
  }

  const variants = (record.oneOf ?? record.anyOf) as unknown[] | undefined;
  if (!Array.isArray(variants) || variants.length === 0) {
    // Schema does not clearly indicate array/non-array - defer to runtime
    if (record.type !== undefined) {
      return false;
    }
    return undefined;
  }

  let hasArrayVariant = false;
  let hasNonArrayVariant = false;

  for (const variant of variants) {
    if (isArrayVariant(variant)) {
      hasArrayVariant = true;
    } else {
      hasNonArrayVariant = true;
    }
  }

  if (hasArrayVariant && hasNonArrayVariant) return undefined;
  if (hasArrayVariant) return true;
  return false;
}

/** Creates a union type schema (T | T[]) for flexible iteration input. */
export function createFlexibleSchema(baseSchema: PropertySchema): PropertySchema {
  return {
    anyOf: [baseSchema, { type: "array", items: baseSchema }],
  } as PropertySchema;
}

export function createArraySchema(baseSchema: PropertySchema): PropertySchema {
  return {
    type: "array",
    items: baseSchema,
  } as PropertySchema;
}

/**
 * Extracts the base (scalar) schema from a potentially wrapped schema.
 * Only unwraps flexible schemas (T | T[]) and plain arrays.
 * Preserves discriminated unions (oneOf/anyOf) that aren't flexible wrappers.
 */
export function extractBaseSchema(schema: PropertySchema): PropertySchema {
  const schemaType = (schema as Record<string, unknown>).type;
  if (schemaType === "array" && (schema as Record<string, unknown>).items) {
    return (schema as Record<string, unknown>).items as PropertySchema;
  }

  const variants =
    (schema as Record<string, unknown>).oneOf ?? (schema as Record<string, unknown>).anyOf;
  if (Array.isArray(variants)) {
    // Only unwrap if this is a flexible schema (T | T[]) pattern.
    // Discriminated unions (e.g., oneOf: [string, object]) should be preserved as-is.
    let hasScalar = false;
    let hasArray = false;
    let scalarVariant: PropertySchema | undefined;
    let arrayVariant: PropertySchema | undefined;

    for (const variant of variants) {
      if (typeof variant === "object") {
        const v = variant as Record<string, unknown>;
        if (v.type === "array" || "items" in v) {
          hasArray = true;
          arrayVariant = variant as PropertySchema;
        } else {
          hasScalar = true;
          scalarVariant = variant as PropertySchema;
        }
      }
    }

    if (hasScalar && hasArray && variants.length === 2) {
      // This is a flexible (T | T[]) wrapper — extract the scalar base
      return scalarVariant!;
    }

    if (!hasScalar && hasArray && arrayVariant) {
      // All variants are arrays — extract items from the first array variant
      return (arrayVariant as Record<string, unknown>).items as PropertySchema;
    }

    // Not a flexible wrapper — preserve the union as-is
    return schema;
  }

  return schema;
}

export function schemaAcceptsArray(schema: DataPortSchema): boolean {
  if (typeof schema === "boolean") return false;

  const schemaType = (schema as Record<string, unknown>).type;
  if (schemaType === "array") return true;

  const variants = (schema.oneOf ?? schema.anyOf) as DataPortSchema[] | undefined;
  if (Array.isArray(variants)) {
    return variants.some((variant) => isArrayVariant(variant));
  }

  return false;
}

export abstract class IteratorTask<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends IteratorTaskConfig<Input> = IteratorTaskConfig<Input>,
> extends GraphAsTask<Input, Output, Config> {
  public static override type: TaskTypeName = "IteratorTask";
  public static override category: string = "Flow Control";
  public static override title: string = "Iterator";
  public static override description: string = "Base class for loop-type tasks";

  /** This task has dynamic schemas based on the inner workflow */
  public static override hasDynamicSchemas: boolean = true;

  public static override configSchema(): DataPortSchema {
    return iteratorTaskConfigSchema;
  }

  constructor(config: Partial<Config> = {}, runConfig: Partial<IRunConfig> = {}) {
    if ((config as Partial<IteratorTaskConfig<Input>>).maxIterations === undefined) {
      throw new TaskConfigurationError(
        `${(new.target as typeof IteratorTask).type ?? "IteratorTask"}: maxIterations is required. ` +
          `Pass a positive integer to cap iteration, or "unbounded" to opt out explicitly.`
      );
    }
    super(config, runConfig);
  }

  /**
   * Returns the schema for iteration-context inputs that will be
   * injected into the subgraph at runtime.
   */
  public static getIterationContextSchema(): DataPortSchema {
    return ITERATOR_CONTEXT_SCHEMA;
  }

  /** Cached iterator port info from schema analysis. */
  protected _iteratorPortInfo: IteratorPortInfo | undefined;

  /** Cached computed iteration input schema. */
  protected _iterationInputSchema: DataPortSchema | undefined;

  // ========================================================================
  // TaskRunner Override
  // ========================================================================

  declare _runner: IteratorTaskRunner<Input, Output, Config>;

  override get runner(): IteratorTaskRunner<Input, Output, Config> {
    if (!this._runner) {
      this._runner = new IteratorTaskRunner<Input, Output, Config>(this);
    }
    return this._runner;
  }

  /**
   * IteratorTask does not support streaming pass-through because its output
   * is an aggregation of multiple iterations (arrays for MapTask, accumulated
   * value for ReduceTask). Subclass output schemas keep `x-stream` off the
   * aggregate ports so runs never route here; if one does anyway, fail loudly
   * — quietly skipping the iterations would return a wrong result.
   */
  override executeStream(
    _input: Input,
    _context: IExecuteContext
  ): AsyncIterable<StreamEvent<Output>> {
    throw new TaskConfigurationError(
      `${this.type} does not support streaming output; its result aggregates multiple ` +
        `iterations. Remove the x-stream annotation from the iterator's output ports.`
    );
  }

  // ========================================================================
  // Graph hooks
  // ========================================================================

  override set subGraph(subGraph: TaskGraph) {
    super.subGraph = subGraph;
    this.invalidateIterationInputSchema();
    this.events.emit("regenerate");
  }

  override get subGraph(): TaskGraph {
    return super.subGraph;
  }

  public override regenerateGraph(): void {
    this.invalidateIterationInputSchema();
    super.regenerateGraph();
  }

  // ========================================================================
  // Runner hooks
  // ========================================================================

  /**
   * Whether results should be ordered by iteration index.
   * MapTask overrides this to use its `preserveOrder` config.
   */
  public preserveIterationOrder(): boolean {
    return true;
  }

  public isReduceTask(): boolean {
    return false;
  }

  /**
   * Whether the runner must keep each iteration's merged output until the batch
   * ends so {@link collectResults} can fold them.
   *
   * `ForEachTask` answers false: it discards results by contract, and holding
   * them costs one retained output per item for the life of the batch — with
   * `batchSize` unset that is the WHOLE iteration set, however large. What the
   * outputs carry is the caller's business (a `.forEach()` over a sweep's
   * worklist may return only a status flag; another may return a document), so
   * the ceiling is not knowable from here and is not worth paying for a value
   * nothing reads.
   */
  public retainsIterationResults(): boolean {
    return true;
  }

  /** Initial accumulator for reduce mode. */
  public getInitialAccumulator(): Output {
    return {} as Output;
  }

  public buildIterationRunInput(
    analysis: IterationAnalysisResult,
    index: number,
    iterationCount: number,
    extraInput: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      ...analysis.getIterationInput(index),
      ...extraInput,
      _iterationIndex: index,
      _iterationCount: iterationCount,
    };
  }

  /** Updates the accumulator with one iteration result in reduce mode. */
  public mergeIterationIntoAccumulator(
    accumulator: Output,
    iterationResult: TaskOutput | undefined,
    _index: number
  ): Output {
    return (iterationResult ?? accumulator) as Output;
  }

  /** Returns the result when there are no items to iterate. */
  public getEmptyResult(): Output {
    return {} as Output;
  }

  /** Collects and merges results from all iterations. */
  public collectResults(results: TaskOutput[]): Output {
    if (results.length === 0) {
      return {} as Output;
    }

    const merged: Record<string, unknown[]> = {};

    for (const result of results) {
      if (!result || typeof result !== "object") continue;

      for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
        if (!merged[key]) {
          merged[key] = [];
        }
        merged[key].push(value);
      }
    }

    return merged as Output;
  }

  // ========================================================================
  // Execution Mode Configuration
  // ========================================================================

  public get concurrencyMode(): "inline" | "thread" {
    return this.config.concurrencyMode ?? "inline";
  }

  public get concurrencyLimit(): number | undefined {
    return this.config.concurrencyLimit;
  }

  public get batchSize(): number | undefined {
    return this.config.batchSize;
  }

  /**
   * Live clone graphs for currently-running iterations, plus the most recently
   * completed ones up to {@link concurrencyLimit}. A UI that attaches after
   * `iteration_start` can still render the in-flight (or just-finished) clones
   * instead of an empty Map row.
   */
  private readonly runningIterationGraphs = new Map<number, TaskGraph>();
  private readonly completedIterationGraphs: Array<{ index: number; graph: TaskGraph }> = [];

  /** Hard cap so an unbounded map does not retain a graph per completed item. */
  private static readonly VISIBLE_ITERATION_GRAPH_CAP = 64;

  private iterationGraphCap(): number {
    const limit = this.concurrencyLimit;
    if (typeof limit === "number" && limit >= 1) {
      return Math.min(limit, IteratorTask.VISIBLE_ITERATION_GRAPH_CAP);
    }
    return IteratorTask.VISIBLE_ITERATION_GRAPH_CAP;
  }

  /** Drop tracked clones at the start of a collect/reduce run. */
  public clearIterationGraphs(): void {
    this.runningIterationGraphs.clear();
    this.completedIterationGraphs.length = 0;
  }

  /** Record the live clone for a just-started iteration. */
  public trackIterationGraph(index: number, graph: TaskGraph): void {
    this.runningIterationGraphs.set(index, graph);
  }

  /** Move a finished iteration's clone into the recently-completed window. */
  public completeIterationGraph(index: number): void {
    const graph = this.runningIterationGraphs.get(index);
    this.runningIterationGraphs.delete(index);
    if (!graph) return;
    this.completedIterationGraphs.push({ index, graph });
    const cap = this.iterationGraphCap();
    while (this.completedIterationGraphs.length > cap) {
      this.completedIterationGraphs.shift();
    }
  }

  /**
   * Clones a late-attaching UI should render: running first, then the most
   * recently completed, capped at the iterator's concurrency.
   */
  public getVisibleIterationGraphs(): Array<{ index: number; graph: TaskGraph }> {
    const cap = this.iterationGraphCap();
    const running = [...this.runningIterationGraphs.entries()]
      .map(([index, graph]) => ({ index, graph }))
      .sort((a, b) => a.index - b.index);
    if (running.length >= cap) return running.slice(0, cap);

    const out = [...running];
    const seen = new Set(running.map((r) => r.index));
    for (let i = this.completedIterationGraphs.length - 1; i >= 0 && out.length < cap; i--) {
      const completed = this.completedIterationGraphs[i];
      if (completed && !seen.has(completed.index)) {
        out.push(completed);
        seen.add(completed.index);
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }

  // ========================================================================
  // Iteration Input Schema Management
  // ========================================================================

  public get iterationInputConfig(): Record<string, IterationPropertyConfig> | undefined {
    return this.config.iterationInputConfig;
  }

  protected buildDefaultIterationInputSchema(): DataPortSchema {
    const innerSchema = this.getInnerInputSchema();
    if (!innerSchema || typeof innerSchema === "boolean") {
      return { type: "object", properties: {}, additionalProperties: true };
    }

    const properties: Record<string, PropertySchema> = {};
    const innerProps = innerSchema.properties || {};

    for (const [key, propSchema] of Object.entries(innerProps)) {
      if (typeof propSchema === "boolean") continue;

      if ((propSchema as Record<string, unknown>)["x-ui-iteration"]) {
        continue;
      }

      const baseSchema = propSchema as PropertySchema;
      properties[key] = createFlexibleSchema(baseSchema);
    }

    return {
      type: "object",
      properties,
      additionalProperties: innerSchema.additionalProperties ?? true,
    } as DataPortSchema;
  }

  protected buildConfiguredIterationInputSchema(): DataPortSchema {
    const innerSchema = this.getInnerInputSchema();
    if (!innerSchema || typeof innerSchema === "boolean") {
      return { type: "object", properties: {}, additionalProperties: true };
    }

    const config = this.iterationInputConfig || {};
    const properties: Record<string, PropertySchema> = {};
    const innerProps = innerSchema.properties || {};

    for (const [key, propSchema] of Object.entries(innerProps)) {
      if (typeof propSchema === "boolean") continue;

      if ((propSchema as Record<string, unknown>)["x-ui-iteration"]) {
        continue;
      }

      const baseSchema = propSchema as PropertySchema;
      const propConfig = config[key];

      if (!propConfig) {
        properties[key] = createFlexibleSchema(baseSchema);
        continue;
      }

      switch (propConfig.mode) {
        case "array":
          properties[key] = createArraySchema(propConfig.baseSchema);
          break;
        case "scalar":
          properties[key] = propConfig.baseSchema;
          break;
        case "flexible":
        default:
          properties[key] = createFlexibleSchema(propConfig.baseSchema);
          break;
      }
    }

    return {
      type: "object",
      properties,
      additionalProperties: innerSchema.additionalProperties ?? true,
    } as DataPortSchema;
  }

  /**
   * Derives the schema accepted by each iteration of the inner workflow.
   * For root tasks (no incoming edges) all input properties are collected.
   * For non-root tasks, only REQUIRED properties that are not satisfied by
   * any internal dataflow are added — this ensures that required inputs are
   * included in the iterator's input schema without pulling in every optional
   * downstream property.
   */
  protected getInnerInputSchema(): DataPortSchema | undefined {
    if (!this.hasChildren()) return undefined;

    const tasks = this.subGraph.getTasks();
    if (tasks.length === 0) return undefined;

    const startingNodes = tasks.filter(
      (task) => this.subGraph.getSourceDataflows(task.id).length === 0
    );
    const sources = startingNodes.length > 0 ? startingNodes : tasks;

    const properties: Record<string, DataPortSchema> = {};
    const required: string[] = [];
    let additionalProperties = false;

    // Collect all properties from root tasks (original behavior)
    for (const task of sources) {
      const inputSchema = task.inputSchema();
      if (typeof inputSchema === "boolean") {
        if (inputSchema === true) {
          additionalProperties = true;
        }
        continue;
      }

      additionalProperties = additionalProperties || inputSchema.additionalProperties === true;

      for (const [key, prop] of Object.entries(inputSchema.properties || {})) {
        if (typeof prop === "boolean") continue;
        if (!properties[key]) {
          properties[key] = prop as DataPortSchema;
        }
      }

      for (const key of inputSchema.required || []) {
        if (!required.includes(key)) {
          required.push(key);
        }
      }
    }

    // For non-root tasks, collect only REQUIRED properties not satisfied by dataflows.
    // This handles cases like: map().fetch().structuralParser() where structuralParser
    // requires "title" but fetch doesn't output it — title must come from the map input.
    const sourceIds = new Set(sources.map((t) => t.id));
    for (const task of tasks) {
      if (sourceIds.has(task.id)) continue;

      const inputSchema = task.inputSchema();
      if (typeof inputSchema === "boolean") continue;

      const requiredKeys = new Set<string>((inputSchema.required as string[] | undefined) || []);
      if (requiredKeys.size === 0) continue;

      const connectedPorts = new Set(
        this.subGraph.getSourceDataflows(task.id).map((df) => df.targetTaskPortId)
      );

      for (const key of requiredKeys) {
        // Skip if already connected via dataflow or already collected from a root task
        if (connectedPorts.has(key)) continue;
        if (properties[key]) continue;

        // Skip if the task already has a default value for this property
        // (e.g., .textEmbedding({ model }) stores model in task.defaults)
        if (task.defaults && task.defaults[key] !== undefined) continue;

        const prop = (inputSchema.properties || {})[key];
        if (!prop || typeof prop === "boolean") continue;

        properties[key] = prop as DataPortSchema;
        if (!required.includes(key)) {
          required.push(key);
        }
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties,
    } as DataPortSchema;
  }

  public getIterationInputSchema(): DataPortSchema {
    if (this._iterationInputSchema) {
      return this._iterationInputSchema;
    }

    this._iterationInputSchema = this.iterationInputConfig
      ? this.buildConfiguredIterationInputSchema()
      : this.buildDefaultIterationInputSchema();

    return this._iterationInputSchema;
  }

  public setIterationInputSchema(schema: DataPortSchema): void {
    this._iterationInputSchema = schema;
    this._inputSchemaNode = undefined;
    this.events.emit("regenerate");
  }

  public setPropertyInputMode(
    propertyName: string,
    mode: IterationInputMode,
    baseSchema?: PropertySchema
  ): void {
    const currentSchema = this.getIterationInputSchema();
    if (typeof currentSchema === "boolean") return;

    const currentProps = (currentSchema.properties || {}) as Record<string, PropertySchema>;
    const existingProp = currentProps[propertyName];
    const base: PropertySchema =
      baseSchema ?? (existingProp ? extractBaseSchema(existingProp) : { type: "string" });

    let newPropSchema: PropertySchema;
    switch (mode) {
      case "array":
        newPropSchema = createArraySchema(base);
        break;
      case "scalar":
        newPropSchema = base;
        break;
      case "flexible":
      default:
        newPropSchema = createFlexibleSchema(base);
        break;
    }

    this._iterationInputSchema = {
      ...currentSchema,
      properties: {
        ...currentProps,
        [propertyName]: newPropSchema,
      },
    } as DataPortSchema;

    this._inputSchemaNode = undefined;
    this.events.emit("regenerate");
  }

  public invalidateIterationInputSchema(): void {
    this._iterationInputSchema = undefined;
    this._iteratorPortInfo = undefined;
    this._inputSchemaNode = undefined;
  }

  // ========================================================================
  // Iteration analysis
  // ========================================================================

  /**
   * Analyzes input to determine which ports are iterated vs scalar.
   * Precedence:
   * 1) explicit x-ui-iteration annotation
   * 2) schema inference where deterministic
   * 3) runtime value fallback (Array.isArray)
   */
  public analyzeIterationInput(input: Input): IterationAnalysisResult {
    const inputData = input as Record<string, unknown>;
    const schema = this.hasChildren() ? this.getIterationInputSchema() : this.inputSchema();
    const schemaProps: Record<string, DataPortSchema> =
      typeof schema === "object" && schema.properties
        ? (schema.properties as Record<string, DataPortSchema>)
        : {};

    const keys = new Set([...Object.keys(schemaProps), ...Object.keys(inputData)]);

    const arrayPorts: string[] = [];
    const scalarPorts: string[] = [];
    const iteratedValues: Record<string, unknown[]> = {};
    const arrayLengths: number[] = [];

    for (const key of keys) {
      if (key.startsWith("_iteration")) continue;

      const value = inputData[key];
      const portSchema = schemaProps[key];

      let shouldIterate: boolean;

      const explicitFlag = getExplicitIterationFlag(portSchema);
      if (explicitFlag !== undefined) {
        shouldIterate = explicitFlag;
      } else {
        const schemaInference = inferIterationFromSchema(portSchema);
        shouldIterate = schemaInference ?? Array.isArray(value);
      }

      if (!shouldIterate) {
        scalarPorts.push(key);
        continue;
      }

      if (!Array.isArray(value)) {
        throw new TaskConfigurationError(
          `${this.type}: Input '${key}' is configured for iteration but value is not an array.`
        );
      }

      iteratedValues[key] = value;
      arrayPorts.push(key);
      arrayLengths.push(value.length);
    }

    if (arrayPorts.length === 0) {
      throw new TaskConfigurationError(
        `${this.type}: At least one array input is required for iteration. ` +
          `Mark a port with x-ui-iteration=true, provide array-typed schema, or pass array values at runtime.`
      );
    }

    const uniqueLengths = new Set(arrayLengths);
    if (uniqueLengths.size > 1) {
      const lengthInfo = arrayPorts
        .map((port, index) => `${port}=${arrayLengths[index]}`)
        .join(", ");
      throw new TaskConfigurationError(
        `${this.type}: All iterated array inputs must have the same length (zip semantics). ` +
          `Found different lengths: ${lengthInfo}`
      );
    }

    const iterationCount = arrayLengths[0] ?? 0;

    const getIterationInput = (index: number): Record<string, unknown> => {
      const iterInput: Record<string, unknown> = {};

      for (const key of arrayPorts) {
        iterInput[key] = iteratedValues[key][index];
      }

      for (const key of scalarPorts) {
        if (key in inputData) {
          iterInput[key] = inputData[key];
        }
      }

      return iterInput;
    };

    return {
      iterationCount,
      arrayPorts,
      scalarPorts,
      getIterationInput,
    };
  }

  // ========================================================================
  // Schema Methods
  // ========================================================================

  public getIterationContextSchema(): DataPortSchema {
    return (this.constructor as typeof IteratorTask).getIterationContextSchema();
  }

  public override inputSchema(): DataPortSchema {
    if (this.hasChildren()) {
      return this.getIterationInputSchema();
    }
    return (this.constructor as typeof IteratorTask).inputSchema();
  }

  public override outputSchema(): DataPortSchema {
    if (!this.hasChildren()) {
      return (this.constructor as typeof IteratorTask).outputSchema();
    }

    return this.getWrappedOutputSchema();
  }

  protected getWrappedOutputSchema(): DataPortSchema {
    if (!this.hasChildren()) {
      return { type: "object", properties: {}, additionalProperties: false };
    }

    const endingNodes = this.subGraph
      .getTasks()
      .filter((task) => this.subGraph.getTargetDataflows(task.id).length === 0);

    if (endingNodes.length === 0) {
      return { type: "object", properties: {}, additionalProperties: false };
    }

    const properties: Record<string, unknown> = {};

    for (const task of endingNodes) {
      const taskOutputSchema = task.outputSchema();
      if (typeof taskOutputSchema === "boolean") continue;

      for (const [key, schema] of Object.entries(taskOutputSchema.properties || {})) {
        properties[key] = {
          type: "array",
          items: schema,
        };
      }
    }

    return {
      type: "object",
      properties,
      additionalProperties: false,
    } as DataPortSchema;
  }
}
