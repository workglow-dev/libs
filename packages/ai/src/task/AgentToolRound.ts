/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext, StreamToolCall } from "@workglow/task-graph";
import { createEmitQueue } from "../capability/emitQueue";
import type { AgentApprovalMode } from "./AgentToolExecution";
import { clampToolText, runAgentTool, toolCallNeedsApproval } from "./AgentToolExecution";
import type { AgentToolRecord } from "./AgentTurnRecord";
import type {
  ChatMessage,
  ContentBlock,
  ContentBlockImage,
  ContentBlockInToolResultBody,
  ContentBlockText,
  ContentBlockToolResult,
} from "./ChatMessage";
import type { compileToolValidators, ToolCall, ToolDefinition } from "./ToolCallingUtils";
import { describeSchemaErrors, sanitizeToolArgs } from "./ToolCallingUtils";

/** A call the model made that cannot be answered, so must not be committed. */
export function isAnswerable(call: ToolCall): boolean {
  return typeof call.id === "string" && call.id.length > 0 && typeof call.name === "string";
}

/** One round's reply as the transcript records it. */
export function assistantMessage(
  text: string,
  calls: readonly ToolCall[],
  reasoning: string | undefined,
  nativeTurn: { readonly provider: string; readonly payload: string } | undefined
): ChatMessage {
  const content: ContentBlock[] = [];
  // Reasoning rides only on a reply that has something else: on its own it is
  // not a reply, and an assistant turn with no text and no call is rejected.
  if (text.length > 0 || calls.length > 0) {
    if (nativeTurn) {
      content.push({
        type: "reasoning",
        text: reasoning ?? "",
        provider: nativeTurn.provider,
        payload: nativeTurn.payload,
      });
    } else if (reasoning) {
      content.push({ type: "reasoning", text: reasoning });
    }
  }
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of calls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
      ...(call.providerSignature === undefined
        ? {}
        : { providerSignature: call.providerSignature }),
    });
  }
  return { role: "assistant", content };
}

/** The text of a settled call, as the model will read it. */
function toolResultText(result: ContentBlockToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Every path into a `tool_result` is bounded by the same budget, not just the
 * one carrying a tool's output. "Unknown tool X. Available: …" names every tool
 * the caller registered, which on a large registry is as capable of filling a
 * context window as a fetched page — and it would then do it on every round the
 * model keeps guessing.
 */
function toolResult(
  call: ToolCall,
  text: string,
  isError: boolean,
  maxChars: number,
  content?: ReadonlyArray<ContentBlockText | ContentBlockImage>
): ContentBlockToolResult {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: content ? orderedToolBody(content, maxChars) : [textBlock(text, maxChars)],
    is_error: isError ? true : undefined,
  };
}

function textBlock(text: string, maxChars: number): ContentBlockText {
  return { type: "text", text: clampToolText(text, maxChars) };
}

/**
 * A tool's own blocks in the order it returned them, so text describing an image
 * stays beside it. Adjacent text joins into one block, which keeps a result of
 * text alone a single block, as providers send it as a plain string. The text
 * shares one budget: past it a block is cut and later text dropped, while images
 * stay. A result of images alone carries no text block: an empty one is not a
 * block Anthropic accepts, and there is nothing in it for the model to read.
 */
function orderedToolBody(
  blocks: ReadonlyArray<ContentBlockText | ContentBlockImage>,
  maxChars: number
): ContentBlockInToolResultBody[] {
  const runs: Array<ContentBlockText | ContentBlockImage> = [];
  for (const block of blocks) {
    const previous = runs[runs.length - 1];
    if (block.type === "text" && previous?.type === "text") {
      runs[runs.length - 1] = { type: "text", text: `${previous.text}\n${block.text}` };
    } else {
      runs.push(block);
    }
  }
  const total = runs.reduce((n, block) => n + (block.type === "text" ? block.text.length : 0), 0);
  const note = `[truncated, ${total} chars total]`;
  let left = maxChars;
  let noted = false;
  const body: ContentBlockInToolResultBody[] = [];
  for (const block of runs) {
    if (block.type === "image") {
      body.push(block);
    } else if (block.text.length === 0) {
      continue;
    } else if (block.text.length <= left) {
      body.push(block);
      left -= block.text.length;
    } else if (left > 0) {
      body.push({ type: "text", text: `${block.text.slice(0, left)}… ${note}` });
      left = 0;
      noted = true;
    } else if (!noted) {
      // The budget ran out exactly at an earlier block: the model is still told
      // that text was left out, where it was.
      body.push({ type: "text", text: `… ${note}` });
      noted = true;
    }
  }
  return body.length > 0 ? body : [textBlock("", maxChars)];
}

export interface AgentToolRoundOptions {
  readonly byName: ReadonlyMap<string, ToolDefinition>;
  readonly validators: ReturnType<typeof compileToolValidators>;
  readonly approval: AgentApprovalMode;
  /** Calls of one round run at once, when none of them is put to a person. */
  readonly concurrency: number;
  readonly maxResultChars: number;
  /** When the turn's time budget runs out; see {@link ToolExecuteContext.deadline}. */
  readonly deadline: number | undefined;
  /** The tool that submits the answer, when the turn has an `outputSchema`. */
  readonly submitToolName: string | undefined;
}

/** A round's results and records, in the order the model asked for the calls. */
export interface AgentToolRoundResult {
  readonly results: ContentBlockToolResult[];
  readonly records: AgentToolRecord[];
}

/**
 * Runs every call of one round and reports each one pending, running and
 * settled, returning what the model reads back.
 *
 * Every call the model asked for is announced before any of them runs: it
 * asked for them together, and a host laying out cards can draw the whole set
 * rather than watching them appear one at a time in an order that is this
 * loop's business and not the model's.
 */
export async function* runToolRound(
  calls: readonly ToolCall[],
  context: IExecuteContext,
  options: AgentToolRoundOptions
): AsyncGenerator<StreamToolCall, AgentToolRoundResult, undefined> {
  for (const call of calls) {
    yield {
      type: "tool-call",
      status: "pending",
      toolCallId: call.id,
      name: call.name,
      input: call.input,
    };
  }
  // A call put to a person is never raced: the next one must not run ahead
  // of the answer, so a round holding one runs every call in turn.
  const width = calls.some((call) => {
    const tool = options.byName.get(call.name);
    return tool !== undefined && toolCallNeedsApproval(tool, options.approval, context.registry);
  })
    ? 1
    : options.concurrency;
  return yield* runCalls(calls, width, context, options);
}

/**
 * Runs one round's calls, `width` at a time, and reports each one running and
 * settled. Results and records come back in the order the model asked,
 * whatever order the calls finish in, because that is the order its next
 * round reads them.
 */
async function* runCalls(
  calls: readonly ToolCall[],
  width: number,
  context: IExecuteContext,
  options: AgentToolRoundOptions
): AsyncGenerator<StreamToolCall, AgentToolRoundResult, undefined> {
  const queue = createEmitQueue<StreamToolCall>();
  const settled: Array<{ result: ContentBlockToolResult; record: AgentToolRecord } | undefined> =
    calls.map(() => undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < calls.length) {
      context.signal.throwIfAborted();
      const index = next++;
      const call = calls[index]!;
      await context.updateProgress(undefined, `Running ${call.name}`);
      queue.push({ type: "tool-call", status: "running", toolCallId: call.id, name: call.name });
      const began = Date.now();
      const result = await runCall(call, context, options);
      const resultText = toolResultText(result);
      settled[index] = {
        result,
        record: {
          id: call.id,
          name: call.name,
          isError: result.is_error === true,
          chars: resultText.length,
          durationMs: Date.now() - began,
        },
      };
      // Read back off the block rather than from a second copy of the text:
      // what the card says the call produced is then the same string the
      // model is about to read, clamp included.
      queue.push({
        type: "tool-call",
        status: result.is_error === true ? "failed" : "completed",
        toolCallId: call.id,
        name: call.name,
        result: resultText,
      });
    }
  };
  const run = Promise.all(
    Array.from({ length: Math.min(width, calls.length) }, () => worker())
  ).finally(() => queue.close());
  // Held so a rejection while the queue is still draining is not reported as
  // unhandled; it is re-thrown below, once the events already produced have
  // reached the caller.
  run.catch(() => {});
  for await (const event of queue.iterable) yield event;
  await run;
  const results: ContentBlockToolResult[] = [];
  const records: AgentToolRecord[] = [];
  for (const entry of settled) {
    results.push(entry!.result);
    records.push(entry!.record);
  }
  return { results, records };
}

/**
 * One tool call, from the model's arguments to what it reads back.
 *
 * Sanitising before validating is the order that matters: a `__proto__` key
 * would otherwise pass a schema that allows additional properties.
 */
async function runCall(
  call: ToolCall,
  context: IExecuteContext,
  options: AgentToolRoundOptions
): Promise<ContentBlockToolResult> {
  const { byName, validators } = options;
  const tool = byName.get(call.name);
  if (!tool) {
    const known = [...byName.keys()].join(", ");
    return toolResult(
      call,
      `Unknown tool "${call.name}". Available: ${known}`,
      true,
      options.maxResultChars
    );
  }
  const sanitized = sanitizeToolArgs(call.input) as Record<string, unknown>;
  const validator = validators.get(call.name);
  if (validator) {
    const check = validator.validate(sanitized);
    if (!check.valid) {
      const detail = describeSchemaErrors(check.errors);
      // The answer itself failed its schema: say so as a correction to make,
      // which is what gets a model to resubmit rather than give up.
      const text =
        call.name === options.submitToolName
          ? `Answer rejected; nothing was recorded. Fix these and call ${call.name} again with the complete answer: ${detail}`
          : `Invalid arguments for ${call.name}: ${detail}`;
      return toolResult(call, text, true, options.maxResultChars);
    }
  }
  const result = await runAgentTool(tool, { ...call, input: sanitized }, context, {
    approval: options.approval,
    maxResultChars: options.maxResultChars,
    deadline: options.deadline,
  });
  return toolResult(call, result.text, result.isError, options.maxResultChars, result.content);
}
