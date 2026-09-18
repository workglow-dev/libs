/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from "@workglow/util";
import { CycleError } from "@workglow/util/graph";
import type { DataPortSchema, SchemaNode } from "@workglow/util/schema";
import { compileSchema } from "@workglow/util/schema";
import { registerGraphWrapperFactory } from "../task-graph/Conversions";
import {
  computeGraphEntitlements,
  knownInput,
  withStaticInputProjection,
} from "../task-graph/GraphEntitlementUtils";
import { computeGraphInputSchema, computeGraphOutputSchema } from "../task-graph/GraphSchemaUtils";
import { bridgeSubGraphTaskEvents } from "../task-graph/SubGraphEventBridge";
import type { TaskGraph } from "../task-graph/TaskGraph";
import type { CompoundMergeStrategy } from "../task-graph/TaskGraphRunner";
import { PROPERTY_ARRAY } from "../task-graph/TaskGraphRunner";
import type { CreateLoopWorkflow } from "../task-graph/WorkflowFactories";
import { GraphAsTaskRunner } from "./GraphAsTaskRunner";
import type { IExecuteContext, IRunConfig } from "./ITask";
import type { StreamEvent, StreamFinish } from "./StreamTypes";
import { Task } from "./Task";
import type { TaskEntitlements } from "./TaskEntitlements";
import type { TaskEventListener, TaskEvents } from "./TaskEvents";
import type { JsonTaskItem, TaskGraphItemJson, TaskGraphJsonOptions } from "./TaskJSON";
import type { TaskConfig, TaskInput, TaskOutput, TaskTypeName } from "./TaskTypes";
import { TaskConfigSchema } from "./TaskTypes";

export const graphAsTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    compoundMerge: { type: "string", "x-ui-hidden": true },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type GraphAsTaskConfig<Input extends TaskInput = TaskInput> = TaskConfig<Input> & {
  /** subGraph is extracted in the constructor before validation — not in the JSON schema */
  subGraph?: TaskGraph;
  compoundMerge?: CompoundMergeStrategy;
};

/**
 * A task that contains a subgraph of tasks
 */
export class GraphAsTask<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends GraphAsTaskConfig<Input> = GraphAsTaskConfig<Input>,
> extends Task<Input, Output, Config> {
  // ========================================================================
  // Static properties - should be overridden by subclasses
  // ========================================================================

  public static override type: TaskTypeName = "GraphAsTask";
  public static override title: string = "Group";
  public static override description: string = "A group of tasks that are executed together";
  public static override category: string = "Flow Control";
  public static compoundMerge: CompoundMergeStrategy = PROPERTY_ARRAY;

  /** This task has dynamic schemas that change based on the subgraph structure */
  public static override hasDynamicSchemas: boolean = true;

  /** Entitlements are always dynamic — they depend on child tasks in the subgraph */
  public static override hasDynamicEntitlements: boolean = true;

  /**
   * The subgraph is where the reach lives, so this class declares none of it.
   * Every composed task inherits this, which is what stops a caller reading the
   * empty static declaration as "reaches nothing".
   */
  public static override entitlementsFromChildren: boolean = true;

  // ========================================================================
  // Constructor
  // ========================================================================

  /**
   * `subGraph` is extracted from `config` and applied to the instance before
   * validating the remainder of the config.
   */
  constructor(config: Partial<Config> = {}, runConfig: Partial<IRunConfig> = {}) {
    const { subGraph, ...rest } = config;
    super(rest as Partial<Config>, runConfig);
    if (subGraph) {
      this.subGraph = subGraph;
    }
    this.regenerateGraph();
  }

  // ========================================================================
  // TaskRunner delegation - Executes and manages the task
  // ========================================================================

  declare _runner: GraphAsTaskRunner<Input, Output, Config>;

  override get runner(): GraphAsTaskRunner<Input, Output, Config> {
    if (!this._runner) {
      this._runner = new GraphAsTaskRunner<Input, Output, Config>(this);
    }
    return this._runner;
  }

  // ========================================================================
  // Static to Instance conversion methods
  // ========================================================================

  public static override configSchema(): DataPortSchema {
    return graphAsTaskConfigSchema;
  }

  public get compoundMerge(): CompoundMergeStrategy {
    return this.config?.compoundMerge || (this.constructor as typeof GraphAsTask).compoundMerge;
  }

  public override get cacheable(): boolean {
    return (
      this.runConfig?.cacheable ??
      this.config?.cacheable ??
      ((this.constructor as typeof GraphAsTask).cacheable && !this.hasChildren())
    );
  }

  // ========================================================================
  // Input/Output handling
  // ========================================================================

  /**
   * Override inputSchema to compute it dynamically from the subgraph at runtime.
   * For root tasks (no incoming edges) all input properties are collected.
   * For non-root tasks, only REQUIRED properties that are not satisfied by
   * any internal dataflow are added — this ensures that required inputs are
   * included in the graph's input schema without pulling in every optional
   * downstream property.
   */
  public override inputSchema(): DataPortSchema {
    // If there's no subgraph or it has no children, fall back to the static schema
    if (!this.hasChildren()) {
      return (this.constructor as typeof Task).inputSchema();
    }

    return computeGraphInputSchema(this.subGraph);
  }

  protected _inputSchemaNode: SchemaNode | undefined;
  protected override getInputSchemaNode(): SchemaNode {
    // every graph as task is different, so we need to compile the schema for each one
    if (!this._inputSchemaNode) {
      try {
        const dataPortSchema = this.inputSchema();
        const schemaNode = Task.generateInputSchemaNode(dataPortSchema);
        this._inputSchemaNode = schemaNode;
      } catch (error) {
        // If compilation fails, fall back to accepting any object structure.
        // This is a safety net for schemas that json-schema-library can't compile.
        getLogger().warn(
          `GraphAsTask "${this.type}" (${String(this.id)}): Failed to compile input schema, ` +
            `falling back to permissive validation. Inputs will NOT be validated.`,
          { error, taskType: this.type, taskId: this.id }
        );
        this._inputSchemaNode = compileSchema({});
      }
    }
    return this._inputSchemaNode!;
  }

  /**
   * Compute output schema dynamically from the subgraph. Depends on the
   * compoundMerge strategy and the nodes at the last level.
   */
  public override outputSchema(): DataPortSchema {
    // If there's no subgraph or it has no children, fall back to the static schema
    if (!this.hasChildren()) {
      return (this.constructor as typeof Task).outputSchema();
    }

    return computeGraphOutputSchema(this.subGraph);
  }

  /**
   * Aggregates entitlements from all tasks in the subgraph.
   *
   * The subgraph is projected with this task's own input first. A child whose
   * declaration depends on its input — `FileLoaderTask` classifying its `url`
   * — otherwise sees nothing here and declares the fail-closed superset (an
   * unscoped `network:private`), which no scoped grant can satisfy. The graph
   * pre-flight never hit that because `withStaticInputProjection` had already
   * seeded the subgraph before reading this aggregate; the runtime check that
   * `hasDynamicEntitlements` triggers has no such outer projection, so a
   * compound task denied itself the moment its input was finally known.
   *
   * The projection restores every task it touches before returning, so this
   * stays an evaluation-time view — nothing executes against a seeded value.
   */
  public override entitlements(): TaskEntitlements {
    if (!this.hasChildren()) {
      return (this.constructor as typeof Task).entitlements();
    }
    return withStaticInputProjection(this.subGraph, knownInput(this), () =>
      computeGraphEntitlements(this.subGraph)
    );
  }

  public override resetInputData(): void {
    super.resetInputData();
    if (this.hasChildren()) {
      this.subGraph!.getTasks().forEach((node) => {
        node.resetInputData();
      });
      this.subGraph!.getDataflows().forEach((dataflow) => {
        dataflow.reset();
      });
    }
  }

  // ========================================================================
  //  Streaming pass-through
  // ========================================================================

  /**
   * Stream pass-through for compound tasks: runs the subgraph and forwards
   * streaming events from ending nodes to the outer graph. Also re-yields
   * any input streams from upstream for cases where this GraphAsTask is
   * itself downstream of another streaming task.
   */
  async *executeStream(input: Input, context: IExecuteContext): AsyncIterable<StreamEvent<Output>> {
    // Forward upstream input streams first (pass-through from outer graph)
    if (context.inputStreams) {
      for (const [, stream] of context.inputStreams) {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // A child's `finish` is its own result, and its `usage` is its own
            // spend -- the subgraph bridge already forwards that to the parent
            // graph attributed to the child. Re-yielding it here would have the
            // run total count the same tokens twice, under two task ids.
            if (value.type === "finish" || value.type === "usage") continue;
            yield value as StreamEvent<Output>;
          }
        } finally {
          reader.releaseLock();
        }
      }
    }

    // Run the subgraph and forward streaming events from ending nodes
    if (this.hasChildren()) {
      const endingNodeIds = new Set<unknown>();
      const tasks = this.subGraph.getTasks();
      for (const task of tasks) {
        if (this.subGraph.getTargetDataflows(task.id).length === 0) {
          endingNodeIds.add(task.id);
        }
      }

      const eventQueue: StreamEvent<Output>[] = [];
      let subgraphDone = false;

      // Eager promise/resolver — always available for producers to signal.
      // Prevents a race where producers call a stale or undefined resolver,
      // causing the generator to hang on a promise that never resolves.
      // `isWaiting` is true only while the generator is suspended at `await notifyPromise`.
      // `hasPending` records a notification that arrived while the generator was active,
      // so the generator skips the next wait without allocating a new promise.
      let { promise: notifyPromise, resolve: notifyResolve } = Promise.withResolvers<void>();
      let isWaiting = false;
      let hasPending = false;
      const notify = () => {
        if (isWaiting) {
          // Wake the generator and prepare a fresh deferred for the next wait.
          notifyResolve();
          ({ promise: notifyPromise, resolve: notifyResolve } = Promise.withResolvers<void>());
          isWaiting = false;
        } else {
          // Generator is still draining; skip the allocation.
          hasPending = true;
        }
      };

      const unsub = this.subGraph.subscribeToTaskStreaming({
        onStreamChunk: (taskId, event) => {
          if (endingNodeIds.has(taskId) && event.type !== "finish" && event.type !== "usage") {
            eventQueue.push(event as StreamEvent<Output>);
            notify();
          }
        },
      });

      // Bubble inner-task events up to the parent graph so subgraph children of
      // a streaming group surface as individual task events on the top-level
      // stream (previews + progress). Mirrors GraphAsTaskRunner for the
      // non-streaming path; bubbles recursively for nested compound tasks.
      const parentGraph = this.parentGraph;
      const bridgeUnsub = parentGraph
        ? bridgeSubGraphTaskEvents(this.subGraph, parentGraph)
        : () => {};

      const runPromise = this.subGraph
        .run<Output>(input, {
          parentSignal: context.signal,
          accumulateLeafOutputs: false,
          ...this.runner.subGraphRunContext,
          enforceEntitlements: this.runConfig?.enforceEntitlements,
          ...this.runner.streamRunOptions,
        })
        .then(
          (results) => {
            subgraphDone = true;
            notify();
            return results;
          },
          (err) => {
            subgraphDone = true;
            notify();
            throw err;
          }
        );

      // Yield events as they arrive from ending nodes. Wrapped in try/finally so
      // the subscriptions are torn down even if the consumer terminates this
      // generator early (.return()/.throw()) — otherwise the parentGraph bridge
      // would leak and double-emit on a later run of the same streaming group.
      try {
        while (!subgraphDone) {
          if (eventQueue.length === 0) {
            if (hasPending) {
              // A notification arrived while we were active; consume it without blocking.
              hasPending = false;
            } else {
              isWaiting = true;
              await notifyPromise;
            }
          }
          while (eventQueue.length > 0) {
            yield eventQueue.shift()!;
          }
        }
        // Drain any remaining events
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }
      } finally {
        unsub();
        bridgeUnsub();
      }

      const results = await runPromise;
      const mergedOutput = this.subGraph.mergeExecuteOutputsToRunOutput(
        results,
        this.compoundMerge
      ) as Output;
      yield { type: "finish", data: mergedOutput } as StreamFinish<Output>;
    } else {
      yield { type: "finish", data: input as unknown as Output } as StreamFinish<Output>;
    }
  }

  // ========================================================================
  //  Compound task methods
  // ========================================================================

  /**
   * Defensive re-assertion of the DAG invariant for the subgraph. `TaskGraph`
   * already rejects cycle-creating dataflows at `addDataflow` time, but this
   * runs a full topo sort so that any direct `_dag` manipulation or cycle
   * introduced via recursive subgraph composition surfaces here with a clear
   * error rather than deep inside the runner.
   */
  public validateAcyclic(): void {
    if (!this.hasChildren()) return;
    if (!this.subGraph.isAcyclic()) {
      throw new CycleError(
        `${this.type} (${String(this.id)}): subgraph contains a cycle — loop tasks must wrap an acyclic subgraph.`
      );
    }
    for (const child of this.subGraph.getTasks()) {
      if (child instanceof GraphAsTask) {
        child.validateAcyclic();
      }
    }
  }

  /**
   * Regenerates the subtask graph and emits a "regenerate" event.
   * Subclasses override to implement actual regeneration logic; they only
   * need to call this method to emit the event.
   */
  public override regenerateGraph(): void {
    this._inputSchemaNode = undefined;
    this.events.emit("regenerate");
    this.emitEntitlementChange();
  }

  // ========================================================================
  // SubGraph entitlement forwarding
  // ========================================================================

  /** Unsubscribe handle for the current subGraph entitlement subscription */
  private _entitlementUnsub: (() => void) | undefined;

  /**
   * Guards against re-entry while the synchronous initial emit of
   * `subscribeToTaskEntitlements` is unwinding. Without this, the initial
   * emit's callback re-reads `this.subGraph`, which would re-trigger
   * `_syncSubGraphEntitlementSubscription` before `_entitlementUnsub` has
   * been assigned and loop forever.
   */
  private _subscribingEntitlements: boolean = false;

  /**
   * Subscribe to the subGraph's aggregated entitlement changes and forward
   * them as an entitlementChange event on this task so that the parent
   * TaskGraph / Workflow sees the update.
   */
  private _subscribeToSubGraphEntitlements(graph: TaskGraph): void {
    this._entitlementUnsub?.();
    this._entitlementUnsub = undefined;
    this._subscribingEntitlements = true;
    try {
      this._entitlementUnsub = graph.subscribeToTaskEntitlements(() => {
        this.emitEntitlementChange();
      });
    } finally {
      this._subscribingEntitlements = false;
    }
  }

  private _syncSubGraphEntitlementSubscription(
    graph: TaskGraph | undefined = this._subGraph
  ): void {
    if (this._subscribingEntitlements) return;

    if ((this._events?.listenerCount("entitlementChange") ?? 0) === 0) {
      this._entitlementUnsub?.();
      this._entitlementUnsub = undefined;
      return;
    }

    if (!graph || this._entitlementUnsub) {
      return;
    }

    this._subscribeToSubGraphEntitlements(graph);
  }

  public override subscribe<Event extends TaskEvents>(
    name: Event,
    fn: TaskEventListener<Event>
  ): () => void {
    const unsub = super.subscribe(name, fn);
    if (name !== "entitlementChange") {
      return unsub;
    }

    this._syncSubGraphEntitlementSubscription();

    return () => {
      unsub();
      this._syncSubGraphEntitlementSubscription();
    };
  }

  public override on<Event extends TaskEvents>(name: Event, fn: TaskEventListener<Event>): void {
    super.on(name, fn);
    if (name === "entitlementChange") {
      this._syncSubGraphEntitlementSubscription();
    }
  }

  public override off<Event extends TaskEvents>(name: Event, fn: TaskEventListener<Event>): void {
    super.off(name, fn);
    if (name === "entitlementChange") {
      this._syncSubGraphEntitlementSubscription();
    }
  }

  public override once<Event extends TaskEvents>(name: Event, fn: TaskEventListener<Event>): void {
    super.once(name, fn);
    if (name === "entitlementChange") {
      this._syncSubGraphEntitlementSubscription();
    }
  }

  public override set subGraph(subGraph: TaskGraph) {
    this._entitlementUnsub?.();
    this._entitlementUnsub = undefined;
    super.subGraph = subGraph;
    this._syncSubGraphEntitlementSubscription(subGraph);
  }

  override get subGraph(): TaskGraph {
    const graph = super.subGraph;
    // The base getter may have lazily created a new graph — subscribe only when needed.
    this._syncSubGraphEntitlementSubscription(graph);
    return graph;
  }

  // ========================================================================
  // Serialization methods
  // ========================================================================

  public override toJSON(options?: TaskGraphJsonOptions): TaskGraphItemJson {
    let json = super.toJSON(options);
    const hasChildren = this.hasChildren();
    if (hasChildren) {
      json = {
        ...json,
        merge: this.compoundMerge,
        subgraph: this.subGraph!.toJSON(options),
      };
    }
    return json;
  }

  public override toDependencyJSON(options?: TaskGraphJsonOptions): JsonTaskItem {
    const json = this.toJSON(options);
    if (this.hasChildren()) {
      if ("subgraph" in json) {
        delete json.subgraph;
      }
      return { ...json, subtasks: this.subGraph!.toDependencyJSON(options) };
    }
    return json;
  }
}

// ----------------------------------------------------------------------------
// Wrappers used by ensureTask() to adapt a TaskGraph/Workflow into a task.
// Defined here (not in Conversions) so they extend GraphAsTask directly with no
// init-order casts; registered with Conversions' deferred factory seam.
// ----------------------------------------------------------------------------

class ListeningGraphAsTask extends GraphAsTask<any, any> {
  constructor(config: any) {
    super(config);
    this.subGraph.on("start", () => {
      this.emit("start");
    });
    this.subGraph.on("complete", () => {
      this.emit("complete");
    });
    this.subGraph.on("error", (e) => {
      this.emit("error", e);
    });
  }
}

// `type` is the wrapper's identity; `title` is what a progress UI shows when the
// caller passed no title of its own. Without these the base "Group" would label
// every unnamed subgraph, which says less than the kind of subgraph it is.
class OwnGraphTask extends ListeningGraphAsTask {
  public static override readonly type = "Own[Graph]";
  public static override readonly title = "Graph";
}

class OwnWorkflowTask extends ListeningGraphAsTask {
  public static override readonly type = "Own[Workflow]";
  public static override readonly title = "Workflow";
}

class GraphTask extends GraphAsTask {
  public static override readonly type = "Graph";
  public static override readonly title = "Graph";
}

class ConvWorkflowTask extends GraphAsTask {
  public static override readonly type = "Workflow";
  public static override readonly title = "Workflow";
}

registerGraphWrapperFactory(({ subGraph, isOwned, isWorkflow, config }) => {
  if (isWorkflow) {
    return isOwned
      ? new OwnWorkflowTask({ ...config, subGraph })
      : new ConvWorkflowTask({ ...config, subGraph });
  }
  return isOwned
    ? new OwnGraphTask({ ...config, subGraph })
    : new GraphTask({ ...config, subGraph });
});

declare module "../task-graph/Workflow" {
  interface Workflow {
    /**
     * Starts a group that wraps inner tasks in a GraphAsTask subgraph.
     * Use .endGroup() to close the group and return to the parent workflow.
     */
    group: CreateLoopWorkflow<TaskInput, TaskOutput, GraphAsTaskConfig<TaskInput>>;

    /**
     * Ends the group and returns to the parent workflow.
     */
    endGroup(): Workflow;
  }
}

// Prototype assignments live in Workflow.ts (bottom of file) to avoid
// circular-dependency issues at module evaluation time.
