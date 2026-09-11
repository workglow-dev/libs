/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EntitlementDeclaringTaskClass,
  IExecuteContext,
  TaskConfig,
} from "@workglow/task-graph";
import {
  describeTaskClassReach,
  getTaskConstructors,
  taskClassNeedsApproval,
} from "@workglow/task-graph";
import type { IHumanRequest, IHumanResponse } from "@workglow/util";
import { getLogger, HUMAN_CONNECTOR, uuid4 } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import type { ToolCall, ToolDefinition } from "./ToolCallingUtils";
import { ToolCallError } from "./ToolCallingUtils";

/**
 * When a tool call is put to a human before it runs.
 *
 * - `"beyond-inference"`: a tool whose reach exceeds what a caller running a
 *   model already holds is confirmed first. Which tools those are is read from
 *   the backing task class, so the answer tracks the entitlement taxonomy
 *   rather than a second list kept in step by hand.
 * - `"never"`: no tool is ever confirmed. For a headless run, where there is
 *   nobody to ask and blocking on an answer that cannot come is worse than the
 *   reach.
 */
export type AgentApprovalMode = "beyond-inference" | "never";

/** What a tool call produced, as the model will read it back. */
export interface AgentToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * The card a person approves. Titles are the labels a connector renders, so
 * they are written for a reader rather than for a schema.
 */
const APPROVAL_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", title: "Tool" },
    reach: { type: "string", title: "Reaches" },
    arguments: { type: "string", title: "Arguments" },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

/**
 * The task type behind a tool, which is not always what the tool is called.
 * `taskTypesToTools` carries the type separately for exactly this reason: a
 * host may present `search_the_web` for a task registered under another name,
 * and resolving on the presented name would then find nothing.
 */
function backingTaskType(tool: ToolDefinition): string {
  return tool.taskType && tool.taskType.length > 0 ? tool.taskType : tool.name;
}

/** Bound on a value shown for approval — a person reads a line, not a payload. */
const MAX_APPROVAL_ARGUMENT_CHARS = 400;

/**
 * Bounds anything sent back to a model, marking the cut so it can tell it is
 * reading a prefix. Every path into a `tool_result` goes through this: an error
 * message naming every tool the caller registered is as capable of filling a
 * context window as a fetched page is.
 */
export function clampToolText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated, ${text.length} chars total]`;
}

function stringifyForModel(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this tool call is put to a human first.
 *
 * A **task-backed** tool is answered from its class, because a task name can
 * arrive in graph JSON the host did not author — so the reach has to be read
 * rather than trusted. A **function-backed** tool can only have been handed in
 * by host code, which is a decision already made, so it defaults to no
 * approval. Either can say so outright with `requiresApproval`, which wins in
 * both directions.
 */
export function toolCallNeedsApproval(
  tool: ToolDefinition,
  mode: AgentApprovalMode,
  registry: Parameters<typeof getTaskConstructors>[0]
): boolean {
  if (mode === "never") return false;
  if (typeof tool.requiresApproval === "boolean") return tool.requiresApproval;
  const ctor = getTaskConstructors(registry).get(backingTaskType(tool));
  if (!ctor) return false;
  return taskClassNeedsApproval(ctor);
}

/**
 * Puts one request to the connector, reporting a failure to ask as `undefined`
 * rather than letting it out.
 *
 * A connector that throws is a host wired wrong — the terminal one raises when
 * no run UI is mounted, for instance — and letting that end the turn kills a
 * whole conversation over one tool call. The caller refuses the call instead:
 * the tool still does not run, and the model can say why. An abort is the one
 * exception, since the run is over either way.
 */
async function askToApprove(
  context: IExecuteContext,
  toolName: string,
  request: IHumanRequest
): Promise<IHumanResponse | undefined> {
  try {
    return await context.registry.get(HUMAN_CONNECTOR).send(request, context.signal);
  } catch (error) {
    if (context.signal.aborted) throw error;
    getLogger().warn(`Could not ask for approval of "${toolName}"`, { error });
    return undefined;
  }
}

/**
 * What the card says this tool reaches.
 *
 * Three answers, and the third is why "host function" cannot be the fallback:
 * a task-backed tool whose type is misspelled or unregistered also finds no
 * class, and telling a person approving it that it is a host function
 * describes something else entirely.
 */
function describeToolReach(
  tool: ToolDefinition,
  ctor: EntitlementDeclaringTaskClass | undefined
): string {
  if (ctor) return describeTaskClassReach(ctor);
  if (tool.execute) return "not declared — this tool is a host function";
  return `unknown — no task type "${backingTaskType(tool)}" is registered, so this call will fail`;
}

/**
 * Puts one tool call to a human and reports whether it may run.
 *
 * Fails **closed** when approval is called for and no connector is registered:
 * running unapproved would make the gate advisory, and the refusal reaches the
 * model as an ordinary tool result, so it can say why rather than stalling.
 */
async function approveToolCall(
  tool: ToolDefinition,
  call: ToolCall,
  context: IExecuteContext
): Promise<AgentToolResult | undefined> {
  if (!context.registry.has(HUMAN_CONNECTOR)) {
    return {
      text:
        `Running "${tool.name}" needs a person's approval, and this run has no way to ask for one. ` +
        `Tell the user that, and do not try this tool again.`,
      isError: true,
    };
  }
  const ctor = getTaskConstructors(context.registry).get(backingTaskType(tool));
  const response = await askToApprove(context, tool.name, {
    requestId: uuid4(),
    targetHumanId: "default",
    kind: "confirm",
    message: `Run "${tool.name}"?`,
    contentSchema: APPROVAL_SCHEMA as DataPortSchema,
    contentData: {
      tool: tool.name,
      reach: describeToolReach(tool, ctor),
      arguments: clampToolText(stringifyForModel(call.input), MAX_APPROVAL_ARGUMENT_CHARS),
    },
    expectsResponse: true,
    mode: "single",
    metadata: { toolUseId: call.id, toolName: tool.name },
  });
  if (response === undefined) {
    return {
      text:
        `Running "${tool.name}" needs a person's approval and asking for one failed. ` +
        `Tell the user, and do not try this tool again.`,
      isError: true,
    };
  }
  if (response.action === "accept") return undefined;
  // Declined and cancelled read the same way to a model — it did not happen and
  // repeating the request is not what the person wants next.
  return {
    text:
      `The user did not approve running "${tool.name}". Do not retry it; ` +
      `ask what they would rather do.`,
    isError: true,
  };
}

/**
 * Runs one tool call and returns what the model reads back.
 *
 * Every failure here is a **result**, never a throw: the loop has already
 * committed the model's `tool_use` to the conversation, and a provider rejects
 * a turn whose `tool_use` has no matching `tool_result`. An abort is the one
 * exception — the run is over, so there is no next turn to keep well-formed.
 */
export async function runAgentTool(
  tool: ToolDefinition,
  call: ToolCall,
  context: IExecuteContext,
  options: { readonly approval: AgentApprovalMode; readonly maxResultChars: number }
): Promise<AgentToolResult> {
  const refusal = toolCallNeedsApproval(tool, options.approval, context.registry)
    ? await approveToolCall(tool, call, context)
    : undefined;
  if (refusal) return refusal;

  try {
    const output = await invokeTool(tool, call, context);
    return {
      text: clampToolText(stringifyForModel(output), options.maxResultChars),
      isError: false,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    // A tool that says its failure IS the answer keeps its own wording; the
    // wrapper below is for a throw nobody planned.
    if (error instanceof ToolCallError) {
      return { text: clampToolText(error.message, options.maxResultChars), isError: true };
    }
    return { text: `${tool.name} failed: ${errorMessage(error)}`, isError: true };
  }
}

/**
 * Resolves a tool to the thing that runs it, in the order
 * {@link ToolDefinition} documents: an explicit `type` decides, and otherwise a
 * supplied `execute` wins over a registry lookup on the name.
 */
async function invokeTool(
  tool: ToolDefinition,
  call: ToolCall,
  context: IExecuteContext
): Promise<unknown> {
  if (tool.type === "function" || (tool.type === undefined && tool.execute)) {
    if (!tool.execute) {
      throw new Error(`Tool "${tool.name}" is declared type "function" but supplies no execute()`);
    }
    return await tool.execute(call.input, { toolUseId: call.id, signal: context.signal });
  }
  const ctor = getTaskConstructors(context.registry).get(backingTaskType(tool));
  if (!ctor) {
    throw new Error(
      `Tool "${tool.name}" is backed by no registered task type and supplies no execute()`
    );
  }
  // A fresh id per call: two calls to one tool would otherwise both carry the
  // id from `config` and collide as siblings in this task's subgraph.
  const task = new ctor({ ...tool.config, id: uuid4() } as TaskConfig);
  context.own(task);
  return await task.run(call.input);
}
