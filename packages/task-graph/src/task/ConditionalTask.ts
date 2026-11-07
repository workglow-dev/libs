/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";
import type { CachePolicy } from "../cache/CachePolicy";
import type { UIConditionConfig } from "./ConditionUtils";
import { evaluateCondition, getNestedValue } from "./ConditionUtils";
import type { IExecuteContext } from "./ITask";
import { Task } from "./Task";
import type { TaskConfig, TaskInput, TaskOutput, TaskTypeName } from "./TaskTypes";
import { TaskFailedError } from "./TaskError";
import { TaskConfigSchema } from "./TaskTypes";

/**
 * A predicate function that evaluates whether a branch condition is met.
 * Returns true if the branch should be active.
 */
export type ConditionFn<Input> = (input: Input) => boolean;

/**
 * Configuration for a single branch in a ConditionalTask. When `condition`
 * returns true, the branch becomes active and its output port receives the
 * task's input data.
 */
export interface BranchConfig<Input> {
  readonly id: string;
  readonly condition: ConditionFn<Input>;
  /** Name of the output port that will receive data when this branch is active */
  readonly outputPort: string;
}

export const conditionalTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    branches: { type: "array", items: {} },
    defaultBranch: { type: "string" },
    exclusive: { type: "boolean" },
    conditionConfig: { type: "object", additionalProperties: true },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type ConditionalTaskConfig = TaskConfig & {
  /** Branches may contain ConditionFn functions — not JSON-schema-representable */
  readonly branches?: BranchConfig<any>[];
  readonly defaultBranch?: string;
  readonly exclusive?: boolean;
  /** Serializable UI condition configuration used to build branches at runtime. */
  readonly conditionConfig?: UIConditionConfig;
};

/**
 * A task that evaluates conditions to determine which downstream paths are active.
 *
 * Implements conditional branching within a task graph (if/then/else or switch/case).
 * In exclusive mode (default), branches are evaluated in order and only the first
 * match activates. In multi-path mode, all matching branches activate simultaneously.
 * Inactive branches DISABLE their outgoing dataflows, cascading to downstream tasks
 * with no other active inputs.
 *
 * TWO OUTPUT SHAPES (selected by how branches are supplied), both described by
 * the instance {@link outputSchema}:
 * - Function branches (config.branches with ConditionFn) -> {@link buildOutput}:
 *   `{ _activeBranches: string[], [outputPort]: { ...input } }`.
 * - Serialized `conditionConfig` (from input or config, no function branches) ->
 *   {@link buildConditionConfigOutput}: UI-style `key_<n>` / `key_else` suffixed
 *   keys with NO `_activeBranches`, one per declared input port per branch.
 */
export class ConditionalTask<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends ConditionalTaskConfig = ConditionalTaskConfig,
> extends Task<Input, Output, Config> {
  /**
   * Marks the branch-routing family for the scheduler.
   *
   * The scheduler tests this instead of `instanceof` so it can reach this class
   * through a type-only import: a value import closes the
   * `Task -> TaskGraph -> TaskGraphRunner -> RunScheduler -> ConditionalTask`
   * module cycle, and any module that enters it at `Task` then evaluates this
   * class body before `Task` is defined. Subclasses inherit the flag, so the
   * check keeps `instanceof` semantics.
   */
  static readonly isConditionalTask = true;

  /**
   * Never cached. The routing decision this task makes lives in instance state
   * ({@link activeBranches} / {@link getPortActiveStatus}) that the scheduler
   * reads to enable and disable outgoing dataflows — and a cache hit returns the
   * output without ever entering `execute`, so that state is never populated. A
   * cached gate therefore mis-routes in both modes: a `conditionConfig` gate
   * reports no branch ports at all (nothing is disabled, so the untaken branch
   * runs) and a function-branch gate reports every port inactive (everything is
   * disabled, so the taken branch does not run). Evaluating a condition is
   * cheap; there is nothing here worth caching.
   */
  static override cacheable = false;

  /**
   * Both halves of the cacheability surface are pinned, because the class-static
   * flag above is not the last word: {@link Task.cacheable} returns
   * `runConfig.cacheable` / `config.cacheable` BEFORE consulting
   * {@link getCachePolicy}, so a caller passing `{ cacheable: true }` would turn
   * the gate back on. Overriding only one is not enough either — `StreamPump`
   * and `CacheCoordinator` read `task.cacheable`, while `TaskRunner` reads
   * `task.getCachePolicy(inputs)`.
   */
  public override get cacheable(): boolean {
    return false;
  }

  // Keeps the base signature's parameter even though the answer ignores it: an
  // override declaring zero parameters still satisfies `ITask` structurally,
  // but it narrows the arity seen through the CONCRETE type, so a caller
  // holding a `ConditionalTask` (rather than an `ITask`) could no longer pass
  // the inputs `TaskRunner` passes through the interface.
  public override getCachePolicy(_inputs: Input): CachePolicy {
    return { kind: "none" };
  }

  static override type: TaskTypeName = "ConditionalTask";
  static override category = "Flow Control";
  static override title = "Condition";
  static override description = "Route data based on conditions";
  static override hasDynamicSchemas: boolean = true;

  public static override configSchema(): DataPortSchema {
    return conditionalTaskConfigSchema;
  }

  public override canSerializeConfig(): boolean {
    if (!this.config.branches) return true;
    return !this.config.branches.some((b) => typeof b.condition === "function");
  }

  /**
   * Set of branch IDs that are currently active after execution.
   * Populated during execute() and used by the graph runner to
   * determine which dataflows should be enabled vs disabled.
   */
  public activeBranches: Set<string> = new Set();

  /**
   * Per-output-port activation recorded by the last run, covering the full port
   * universe the run could have written (not only the ports it did write).
   * `undefined` before the first run — {@link getPortActiveStatus} then falls
   * back to deriving from `config.branches`.
   */
  private portActiveStatus: Map<string, boolean> | undefined;

  // ========================================================================
  // Execution methods
  // ========================================================================

  /**
   * Builds runtime branch configs from serialized UI condition config.
   */
  private buildBranchesFromConditionConfig(
    conditionConfig: UIConditionConfig
  ): BranchConfig<Input>[] {
    if (!conditionConfig?.branches || conditionConfig.branches.length === 0) {
      return [
        {
          id: "default",
          condition: () => true,
          outputPort: "1",
        },
      ];
    }

    return conditionConfig.branches.map((branch, index) => ({
      id: branch.id,
      outputPort: String(index + 1),
      condition: (inputData: Input): boolean => {
        const fieldValue = getNestedValue(inputData as Record<string, unknown>, branch.field);
        return evaluateCondition(fieldValue, branch.operator, branch.value);
      },
    }));
  }

  /**
   * Resolves the effective branches to evaluate.
   * Uses config.branches if they have condition functions,
   * otherwise falls back to conditionConfig from input or extras.
   */
  private resolveBranches(input: Input): {
    branches: BranchConfig<Input>[];
    isExclusive: boolean;
    defaultBranch: string | undefined;
    fromConditionConfig: boolean;
  } {
    const configBranches = this.config.branches ?? [];

    // If config branches have condition functions, use them directly
    if (configBranches.length > 0 && typeof configBranches[0].condition === "function") {
      return {
        branches: configBranches,
        isExclusive: this.config.exclusive ?? true,
        defaultBranch: this.config.defaultBranch,
        fromConditionConfig: false,
      };
    }

    // Try to find serialized conditionConfig from input or config
    const conditionConfig =
      ((input as Record<string, unknown>).conditionConfig as UIConditionConfig | undefined) ??
      this.config.conditionConfig;

    if (conditionConfig) {
      return {
        branches: this.buildBranchesFromConditionConfig(conditionConfig),
        isExclusive: conditionConfig.exclusive ?? true,
        defaultBranch: conditionConfig.defaultBranch,
        fromConditionConfig: true,
      };
    }

    // Fallback: use config branches even if they lack conditions
    return {
      branches: configBranches,
      isExclusive: this.config.exclusive ?? true,
      defaultBranch: this.config.defaultBranch,
      fromConditionConfig: false,
    };
  }

  public override async execute(
    input: Input,
    context: IExecuteContext
  ): Promise<Output | undefined> {
    if (context.signal?.aborted) {
      return undefined;
    }

    // Clear previous branch activation state
    this.activeBranches.clear();
    this.portActiveStatus = undefined;

    const { branches, isExclusive, defaultBranch, fromConditionConfig } =
      this.resolveBranches(input);

    // Evaluate each branch condition
    for (const branch of branches) {
      // A condition that throws fails the task, as it does in WhileTask. Treating the
      // throw as "not taken" routed the data down the next branch or the default --
      // a bug in a condition, or a branch with no condition function, became a
      // silently wrong route on a run reported as a success.
      let isActive: boolean;
      try {
        isActive = branch.condition(input);
      } catch (error) {
        const failure = new TaskFailedError(
          `${this.type}: condition for branch "${branch.id}" threw: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (error instanceof Error && error.stack) {
          failure.stack = `${failure.stack ?? ""}\nCaused by original error:\n${error.stack}`;
        }
        throw failure;
      }
      if (isActive) {
        this.activeBranches.add(branch.id);
        if (isExclusive) {
          // In exclusive mode, stop at first match
          break;
        }
      }
    }

    // If no branch matched and there's a default, use it
    if (this.activeBranches.size === 0 && defaultBranch) {
      const defaultBranchExists = branches.some((b) => b.id === defaultBranch);
      if (defaultBranchExists) {
        this.activeBranches.add(defaultBranch);
      }
    }

    // Build output: if from conditionConfig, use the UI-style output building
    if (fromConditionConfig) {
      return this.buildConditionConfigOutput(input, branches, isExclusive);
    }

    // Build output: pass through input to active branch ports
    return this.buildOutput(input);
  }

  /**
   * Builds output in the UI-style format where inputs are passed through
   * with numbered suffixes based on matched branches.
   *
   * Also records the activation of every port this shape could have produced —
   * not just the ones it did — so the scheduler can DISABLE the edges hanging
   * off the branches that were not taken. Deriving that from `config.branches`
   * instead (as the scheduler used to) yields nothing here, because a
   * conditionConfig-driven task has no `config.branches` at all.
   */
  protected buildConditionConfigOutput(
    input: Input,
    branches: BranchConfig<Input>[],
    isExclusive: boolean
  ): Output {
    const output: Record<string, unknown> = {};

    // Remove conditionConfig from pass-through data
    const { conditionConfig, ...passThrough } = input as Record<string, unknown>;
    const inputKeys = Object.keys(passThrough);

    // Find matched branch number
    let matchedBranchNumber: number | null = null;
    for (let i = 0; i < branches.length; i++) {
      if (this.activeBranches.has(branches[i].id)) {
        if (matchedBranchNumber === null) {
          matchedBranchNumber = i + 1;
        }
      }
    }

    if (isExclusive) {
      if (matchedBranchNumber !== null) {
        for (const key of inputKeys) {
          output[`${key}_${matchedBranchNumber}`] = passThrough[key];
        }
      } else {
        for (const key of inputKeys) {
          output[`${key}_else`] = passThrough[key];
        }
      }
    } else {
      for (let i = 0; i < branches.length; i++) {
        if (this.activeBranches.has(branches[i].id)) {
          for (const key of inputKeys) {
            output[`${key}_${i + 1}`] = passThrough[key];
          }
        }
      }
    }

    // Which branch suffixes this run activated. Activation is a property of the
    // BRANCH, not of whether a given key carried data: a declared port that
    // arrived empty still belongs to the taken branch, and disabling its edge
    // would stop a downstream task the condition actually selected.
    const activeSuffixes = new Set<string>();
    if (isExclusive) {
      activeSuffixes.add(matchedBranchNumber !== null ? String(matchedBranchNumber) : "else");
    } else {
      for (let i = 0; i < branches.length; i++) {
        if (this.activeBranches.has(branches[i].id)) activeSuffixes.add(String(i + 1));
      }
    }

    // Full port universe: every branch port for every routed key, plus the
    // `_else` ports when exclusive. The keys are the DECLARED input ports union
    // the ones that actually arrived — deriving them from the arrived data
    // alone leaves a declared-but-unfed port missing from the map, and a
    // missing port reads to the scheduler as "not a branch port", which is
    // exactly the undisabled edge this map exists to prevent.
    const routedKeys = new Set([...Object.keys(this.routedInputPorts()), ...inputKeys]);
    const portStatus = new Map<string, boolean>();
    for (const key of routedKeys) {
      for (let i = 0; i < branches.length; i++) {
        portStatus.set(`${key}_${i + 1}`, activeSuffixes.has(String(i + 1)));
      }
      // Recorded in BOTH modes. Non-exclusive mode produces no `_else` port, so
      // an edge wired off one can never carry data — but omitting the port from
      // this map reads to the scheduler as "not a branch port", which leaves
      // that edge COMPLETED and hands the downstream task `undefined`. INACTIVE
      // is the honest answer: the port does not exist, so it is never active.
      portStatus.set(`${key}_else`, isExclusive && activeSuffixes.has("else"));
    }
    this.portActiveStatus = portStatus;

    return output as Output;
  }

  /**
   * Builds the output object with data routed to active branch ports.
   * Each active branch's output port receives the full input data.
   *
   * @param input - The input data to pass through to active branches
   * @returns Output object with active branch ports populated
   */
  protected buildOutput(input: Input): Output {
    const output: Record<string, unknown> = {
      _activeBranches: Array.from(this.activeBranches),
    };

    const branches = this.config.branches ?? [];
    const portStatus = new Map<string, boolean>();

    // For each active branch, populate its output port with the input data
    for (const branch of branches) {
      const isActive = this.activeBranches.has(branch.id);
      portStatus.set(branch.outputPort, isActive);
      if (isActive) {
        // Pass through all input properties to the active branch's output port
        output[branch.outputPort] = { ...input };
      }
    }

    // `_activeBranches` is deliberately absent: it is metadata, not a branch
    // port, and its edge must follow the task's own status.
    this.portActiveStatus = portStatus;

    return output as Output;
  }

  // ========================================================================
  // Branch information methods
  // ========================================================================

  public isBranchActive(branchId: string): boolean {
    return this.activeBranches.has(branchId);
  }

  /** Returns a copy to prevent external modification. */
  public getActiveBranches(): Set<string> {
    return new Set(this.activeBranches);
  }

  /**
   * Per-output-port activation, and the single authority the scheduler uses to
   * decide which outgoing dataflows are COMPLETED and which are DISABLED. A
   * port absent from the map is not a branch port and follows the task's own
   * status.
   *
   * After a run this is what the run itself recorded, so it describes whichever
   * output shape actually ran. Before a run (and for a cached completion that
   * never entered `execute`) it falls back to deriving from `config.branches`.
   *
   * Returns a copy to prevent external modification.
   */
  public getPortActiveStatus(): Map<string, boolean> {
    if (this.portActiveStatus) {
      return new Map(this.portActiveStatus);
    }

    const status = new Map<string, boolean>();
    const branches = this.config.branches ?? [];

    for (const branch of branches) {
      status.set(branch.outputPort, this.activeBranches.has(branch.id));
    }

    return status;
  }

  // ========================================================================
  // Schema methods
  // ========================================================================

  static override outputSchema(): DataPortSchema {
    // Base schema - actual properties are determined by branch configuration
    return {
      type: "object",
      properties: {
        _activeBranches: {
          type: "array",
          items: { type: "string" },
          description: "List of active branch IDs after condition evaluation",
        },
      },
      additionalProperties: true,
    } as const satisfies DataPortSchema;
  }

  /**
   * The input ports data is routed through: the declared input ports minus
   * `conditionConfig`, which is control data rather than something to route.
   */
  private routedInputPorts(): Record<string, unknown> {
    const schema = this.inputSchema();
    if (typeof schema === "boolean" || !schema.properties) return {};
    const { conditionConfig: _controlPort, ...ports } = schema.properties as Record<
      string,
      unknown
    >;
    return ports;
  }

  /**
   * Derives the suffixed output ports a {@link buildConditionConfigOutput} run
   * produces: `<inputPort>_<branchIndex + 1>` for every branch, plus
   * `<inputPort>_else` when the config is exclusive. Each derived port reuses
   * its input port's own schema, so downstream compatibility checks see the
   * real type rather than an opaque object.
   */
  private conditionConfigOutputSchema(conditionConfig: UIConditionConfig): DataPortSchema {
    // An empty branch list still runs one implicit "default" branch (see
    // buildBranchesFromConditionConfig), so the port universe is never empty.
    const branchCount = Math.max(conditionConfig.branches?.length ?? 0, 1);
    const isExclusive = conditionConfig.exclusive !== false;
    const properties: Record<string, unknown> = {};

    for (const [key, portSchema] of Object.entries(this.routedInputPorts())) {
      for (let i = 0; i < branchCount; i++) {
        properties[`${key}_${i + 1}`] = portSchema;
      }
      if (isExclusive) {
        properties[`${key}_else`] = portSchema;
      }
    }

    return {
      type: "object",
      properties,
      additionalProperties: true,
    } as DataPortSchema;
  }

  override outputSchema(): DataPortSchema {
    const branches = this.config?.branches ?? [];
    const hasFunctionBranches = branches.length > 0 && typeof branches[0].condition === "function";

    if (!hasFunctionBranches) {
      const conditionConfig = this.config?.conditionConfig;
      if (conditionConfig) {
        return this.conditionConfigOutputSchema(conditionConfig);
      }
      if (branches.length === 0) {
        // Nothing to derive from: the conditionConfig can still arrive on the
        // input port at runtime. Stay fully open so a dataflow off a suffixed
        // port resolves to "runtime" compatibility rather than "incompatible"
        // (an undefined source property is rejected before the target is even
        // consulted, so a closed schema would silently drop the edge's data).
        return {
          type: "object",
          properties: {},
          additionalProperties: true,
        } as const satisfies DataPortSchema;
      }
    }

    const properties: Record<string, any> = {
      _activeBranches: {
        type: "array",
        items: { type: "string" },
        description: "List of active branch IDs after condition evaluation",
      },
    };

    // Add each branch's output port to the schema
    for (const branch of branches) {
      properties[branch.outputPort] = {
        type: "object",
        description: `Output for branch "${branch.id}" when active`,
        additionalProperties: true,
      };
    }

    return {
      type: "object",
      properties,
      additionalProperties: false,
    } as DataPortSchema;
  }

  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    } as const satisfies DataPortSchema;
  }

  override inputSchema(): DataPortSchema {
    const declared = this.config?.inputSchema;
    if (declared && typeof declared === "object") {
      // Forcing `additionalProperties: true` keeps this a pure widening of the
      // previous always-open schema: honoring a declared `false` here would
      // turn existing compatible input edges (`conditionConfig`, and any port
      // the config forgot to declare) incompatible.
      return { ...declared, additionalProperties: true } as DataPortSchema;
    }
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    } as const satisfies DataPortSchema;
  }
}
