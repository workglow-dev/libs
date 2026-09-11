/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SchemaNode } from "@workglow/util/schema";
import { compileSchema } from "@workglow/util/schema";
import type { JsonSchema } from "@workglow/util/worker";
import { getLogger } from "@workglow/util/worker";

/**
 * A tool definition that can be passed to an LLM for tool calling.
 * Can be created manually or generated from TaskRegistry entries via `taskTypesToTools` in ToolCallingTask.
 *
 * The `name` is used both as the tool name presented to the LLM and as a
 * lookup key for the backing Task in the TaskRegistry. When a tool is
 * backed by a configurable task (e.g. `McpToolCallTask`, `JavaScriptTask`),
 * `configSchema` describes what configuration the task accepts and `config`
 * provides the concrete values. The LLM never sees `configSchema` or
 * `config` — they are setup-time concerns used when instantiating the task.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /**
   * Optional discriminator for tool resolution. When specified, skips
   * duck-typing heuristics:
   * - `"function"` — uses the `execute` function directly
   * - `"task"` — looks up the task by `name` in the TaskRegistry
   *
   * When omitted, resolution falls back to the existing heuristic
   * (check `execute`, then registry lookup, then stub).
   */
  type?: "function" | "task";
  /**
   * The task type backing this tool, when it is not the name the model sees.
   * A host is free to present `search_the_web` for a task registered under
   * another name, and a runner resolving on the presented name would then find
   * nothing. `taskTypesToTools` always sets it.
   */
  taskType?: string;
  /** JSON Schema describing the task's configuration options. */
  configSchema?: JsonSchema;
  /** Concrete configuration values matching {@link configSchema}. */
  config?: Record<string, unknown>;
  /**
   * Optional custom executor function. When provided, the tool is executed
   * by calling this function directly instead of instantiating a Task.
   *
   * A string comes back to the model as the tool result verbatim; anything else
   * is serialized. To answer with a failure rather than a value, throw a
   * {@link ToolCallError} — its message reaches the model unwrapped.
   */
  execute?: (input: Record<string, unknown>, context: ToolExecuteContext) => Promise<unknown>;
  /**
   * Whether a person approves each call before it runs, overriding whatever a
   * runner would otherwise decide for this tool. Set it in both directions: a
   * host function that spends money says `true`, and a task whose reach a host
   * has already scoped away says `false`. Absent leaves the decision to the
   * runner — see `AgentTask`, which reads it from the backing task class.
   */
  requiresApproval?: boolean;
}

/**
 * What a host function is told about the call it is serving.
 *
 * A tool that draws something, or asks a person something, has to say WHICH
 * call it is drawing for — a transcript keys its cards on the tool-use id, and
 * an answer that arrives against the wrong one is worse than no answer. The
 * signal is the run's: work a tool starts outlives the tool otherwise.
 */
export interface ToolExecuteContext {
  readonly toolUseId: string;
  readonly signal: AbortSignal;
}

/**
 * A tool failure that is an answer rather than a fault.
 *
 * A runner wraps an ordinary throw ("<tool> failed: …"), which is right for a
 * bug and wrong for an outcome the tool means to report — a person declining an
 * action, a workflow that ran and errored. The message of one of these reaches
 * the model exactly as written, so the tool keeps the wording it chose,
 * including whatever it wants the model to do next.
 */
export class ToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCallError";
  }
}

/**
 * A tool call returned by the LLM, requesting invocation of a specific tool.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Opaque, provider-scoped signature the model attached to this call that must
   * be echoed back verbatim when the call is replayed in a later turn (e.g.
   * Gemini's `thoughtSignature`). Undefined for providers without the concept.
   */
  providerSignature?: string;
}

export type ToolCalls = Array<ToolCall>;

/**
 * Controls which tools the model may call.
 * - `"auto"` — model decides whether to call tools
 * - `"none"` — model must not call any tools
 * - `"required"` — model must call at least one tool
 * - any other string — model must call the tool with that name
 */
export type ToolChoiceOption = "auto" | "none" | "required" | (string & {});

/**
 * Builds a tool description string for provider APIs, appending the output
 * schema when present. Shared across all provider implementations.
 */
export function buildToolDescription(tool: ToolDefinition): string {
  let desc = tool.description;
  if (tool.outputSchema && typeof tool.outputSchema === "object") {
    desc += `\n\nReturns: ${JSON.stringify(tool.outputSchema)}`;
  }
  return desc;
}

/**
 * Validates that a tool call name returned by the LLM matches one of the
 * allowed tool definitions. Returns true if valid, false otherwise.
 */
export function isAllowedToolName(
  name: string,
  allowedTools: ReadonlyArray<ToolDefinition>
): boolean {
  return allowedTools.some((t) => t.name === name);
}

/**
 * Filters an array of tool calls, removing any whose name does not appear
 * in the provided tools list. Returns the filtered array.
 */
export function filterValidToolCalls(
  toolCalls: ToolCalls,
  allowedTools: ReadonlyArray<ToolDefinition>
): ToolCalls {
  return toolCalls.filter((tc) => {
    if (tc.name && isAllowedToolName(tc.name, allowedTools)) {
      return true;
    }
    getLogger().warn(`Filtered out tool call with unknown name "${tc.name ?? "(missing)"}"`, {
      callId: tc.id,
      toolName: tc.name,
    });
    return false;
  });
}

const FORBIDDEN_TOOL_ARG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively rebuild a model-supplied JSON value, dropping any
 * `__proto__`, `constructor`, or `prototype` keys at every depth.
 * Returns a plain object (Object.prototype), never inheriting from a
 * tainted source. Use this on tool-call arguments captured from any LLM
 * before validation and propagation.
 *
 * Tool input schemas frequently set `additionalProperties: true` (or
 * omit it entirely), so a hallucinated `__proto__` key would otherwise
 * pass JSON-schema validation and leak into downstream consumers — a
 * classic prototype-pollution vector. Sanitization must happen BEFORE
 * validation so the validator sees the clean object.
 */
export function sanitizeToolArgs(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeToolArgs);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_TOOL_ARG_KEYS.has(k)) continue;
    out[k] = sanitizeToolArgs((value as Record<string, unknown>)[k]);
  }
  return out;
}

/**
 * Compiles each tool's `inputSchema` into a validator. A tool whose schema
 * fails to compile maps to `null`, signalling that downstream code should
 * fall back to name-only validation rather than failing the whole run.
 */
export function compileToolValidators(
  tools: ReadonlyArray<ToolDefinition>
): Map<string, SchemaNode | null> {
  const validators = new Map<string, SchemaNode | null>();
  for (const td of tools) {
    try {
      validators.set(td.name, compileSchema(td.inputSchema));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        `Tool "${td.name}" has invalid inputSchema, ` +
          `falling back to name-only validation — ${msg}`,
        { toolName: td.name }
      );
      validators.set(td.name, null);
    }
  }
  return validators;
}

/**
 * Filter tool calls whose `input` doesn't match the tool's compiled
 * `inputSchema`. Tools without a compiled validator (compile failed,
 * or absent from the map) pass through — callers should still apply
 * {@link filterValidToolCalls} for name-only defence in depth.
 */
export function validateToolCallArgs(
  toolCalls: ToolCalls,
  validators: ReadonlyMap<string, SchemaNode | null>
): ToolCalls {
  return toolCalls.filter((tc) => {
    const v = validators.get(tc.name);
    if (!v) return true;
    const result = v.validate(tc.input);
    if (result.valid) return true;
    const firstError = result.errors[0];
    const detail = firstError?.message ?? "unknown validation error";
    getLogger().warn(`Dropping call to "${tc.name}" — args fail inputSchema (${detail})`, {
      callId: tc.id,
      toolName: tc.name,
    });
    return false;
  });
}
