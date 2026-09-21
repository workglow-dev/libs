/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ChatMessage,
  CheckpointPrefix,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolCalls,
  ToolDefinition,
} from "@workglow/ai";
import {
  createEstimatedOutputUsageReporter,
  extractMessageText,
  toolChoiceForcesToolCall,
} from "@workglow/ai/provider-utils";
import { filterValidToolCalls, sanitizeToolArgs } from "@workglow/ai/worker";
import type { StreamEvent } from "@workglow/task-graph";
import {
  renderLlamaCppPrefixChatHistory,
  renderLlamaCppPrefixFunctions,
} from "./LlamaCpp_CacheCheckpoint";
import type { LlamaCppModelConfig } from "./LlamaCpp_ModelSchema";
import type { LlamaCppSessionState } from "./LlamaCpp_Runtime";
import {
  acquireContextSequence,
  captureSequenceTokenBoundary,
  getActualModelPath,
  getConfigKey,
  getLlamaCppSdk,
  getLlamaCppSession,
  getOrCreateTextContext,
  llamaCppChatSessionConstructorSpread,
  llamaCppSeedPromptSpread,
  loadSdk,
  restoreLlamaCppCheckpointSession,
  setLlamaCppSession,
  stealLlamaCppSession,
  withModelInUse,
  withSequence,
  withSessionLock,
} from "./LlamaCpp_Runtime";
import { extractToolCallsFromText } from "./LlamaCpp_ToolParser";

function buildSystemPrompt(
  input: ToolCallingTaskInput,
  prefixSystemPrompt: string | undefined
): string | undefined {
  // `||`, not `??`: an explicit empty-string systemPrompt falls through to the
  // checkpoint prefix's system prompt, matching the other providers.
  const base = input.systemPrompt || prefixSystemPrompt;
  if (input.toolChoice === "required") {
    const instruction =
      "You must call at least one tool from the provided tool list when answering.";
    return base ? `${base}\n\n${instruction}` : instruction;
  }
  return base || undefined;
}

function buildToolChatHistory(
  input: ToolCallingTaskInput,
  prefix: CheckpointPrefix | undefined
): any[] {
  const messages: ChatMessage[] = [...(prefix?.messages ?? [])];
  if (input.messages && input.messages.length > 0) {
    messages.push(...input.messages);
  } else {
    const promptText =
      typeof input.prompt === "string" ? input.prompt : extractMessageText(input.prompt);
    messages.push({
      role: "user",
      content: [{ type: "text", text: promptText }],
    });
  }
  return convertMessagesToChatHistory(
    messages,
    undefined,
    buildSystemPrompt(input, prefix?.systemPrompt)
  );
}

/**
 * Pure message-array → `ChatHistoryItem[]` conversion — no trailing empty-user
 * placeholder when `messages` is empty. Emits only `system` when a system
 * prompt is provided and messages is empty; that shape is what a cache
 * checkpoint prefix needs before running any turn. Unknown block types are
 * skipped rather than throwing (mirrors HFT's posture).
 */
function messagesToPureChatHistory(
  messages: ReadonlyArray<ChatMessage>,
  systemPrompt: string | undefined
): any[] {
  const history: any[] = [];

  if (systemPrompt) {
    history.push({ type: "system", text: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractMessageText(msg.content);
      history.push({ type: "user", text });
      continue;
    }

    if (msg.role === "assistant") {
      const response: any[] = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          response.push(block.text);
        } else if (block.type === "tool_use") {
          // Create functionCall entry — result will be filled by subsequent tool message
          response.push({
            type: "functionCall",
            name: block.name,
            description: undefined,
            params: block.input ?? {},
            result: undefined,
            // Tag with id so we can match tool results below
            _toolUseId: block.id,
          });
        }
      }

      history.push({ type: "model", response });
      continue;
    }

    if (msg.role === "tool") {
      // Find the most recent "model" response to merge results into
      let lastModel: any;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].type === "model") {
          lastModel = history[i];
          break;
        }
      }
      if (!lastModel) continue;

      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        const toolUseId = block.tool_use_id;

        // Find the matching functionCall in the model response
        const fnCall = lastModel.response.find(
          (item: any) =>
            typeof item === "object" &&
            item !== null &&
            item.type === "functionCall" &&
            item._toolUseId === toolUseId &&
            item.result === undefined
        );
        if (fnCall) {
          // Flatten nested text blocks from tool_result content into a string
          let resultText = "";
          for (const inner of block.content) {
            if (inner.type === "text") resultText += inner.text;
          }
          fnCall.result = resultText || JSON.stringify(block.content);
        }
      }
      continue;
    }
  }

  // Clean up the temporary _toolUseId tags from functionCall objects
  for (const item of history) {
    if (item.type === "model" && Array.isArray(item.response)) {
      for (const entry of item.response) {
        if (typeof entry === "object" && entry !== null && "_toolUseId" in entry) {
          delete entry._toolUseId;
        }
      }
    }
  }

  return history;
}

/**
 * Convert workglow messages to node-llama-cpp's `ChatHistoryItem[]` for a
 * one-shot generation call. When `messages` is empty, `prompt` is appended as
 * the trailing user turn so the model has something to respond to.
 *
 * Key difference from OpenAI/Anthropic format: tool results are NOT separate
 * history items. They get merged into the preceding `model` response's
 * `ChatModelFunctionCall.result` fields, matched by `tool_use_id`.
 */
export function convertMessagesToChatHistory(
  messages: ReadonlyArray<ChatMessage> | undefined,
  prompt: string | undefined,
  systemPrompt: string | undefined
): any[] {
  if (!messages || messages.length === 0) {
    const history: any[] = [];
    if (systemPrompt) history.push({ type: "system", text: systemPrompt });
    const promptText = typeof prompt === "string" ? prompt : String(prompt ?? "");
    history.push({ type: "user", text: promptText });
    return history;
  }
  return messagesToPureChatHistory(messages, systemPrompt);
}

/** Pure history renderer for a checkpoint prefix — reused by the checkpoint module. */
export function messagesToPureChatHistoryForPrefix(
  messages: ReadonlyArray<ChatMessage>,
  systemPrompt: string | undefined
): any[] {
  return messagesToPureChatHistory(messages, systemPrompt);
}

export function buildChatModelFunctions(
  tools: ReadonlyArray<ToolDefinition>
): Record<string, { description?: string; params?: any }> {
  const functions: Record<string, { description?: string; params?: any }> = {};
  for (const tool of tools) {
    functions[tool.name] = {
      ...(tool.description && { description: tool.description }),
      ...(tool.inputSchema && { params: tool.inputSchema }),
    };
  }
  return functions;
}

/**
 * Sampling options for {@link LlamaChat.generateResponse}.
 * Does NOT include `responsePrefix` (not supported by LlamaChat).
 */
function llamaCppChatGenerateOptions(
  input: ToolCallingTaskInput,
  model: LlamaCppModelConfig
): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    ...llamaCppSeedPromptSpread(model.provider_config),
  };
  if (input.maxTokens !== undefined) {
    opts.maxTokens = input.maxTokens;
  }
  if (input.temperature !== undefined) {
    opts.temperature = input.temperature;
  } else if (toolChoiceForcesToolCall(input.toolChoice)) {
    opts.temperature = 0.2;
  }
  return opts;
}

function extractNativeFunctionCalls(
  functionCalls: ReadonlyArray<{ functionName: string; params: any }> | undefined
): ToolCalls {
  if (!functionCalls || functionCalls.length === 0) return [];
  return functionCalls.map((fc, index) => ({
    id: `call_${index}`,
    name: fc.functionName,
    input: sanitizeToolArgs((fc.params ?? {}) as Record<string, unknown>) as Record<
      string,
      unknown
    >,
  }));
}

/**
 * Drives an async generation call that pushes text chunks via `onTextChunk`,
 * yielding `text-delta` events (and provisional `usage` snapshots) as they
 * arrive. Returns accumulated text and the generation result (if any) once
 * complete.
 */
async function* streamTextChunks<T>(
  startGeneration: (onTextChunk: (chunk: string) => void) => Promise<T>,
  signal: AbortSignal,
  options: { readonly promptText?: string | undefined } = {}
): AsyncGenerator<StreamEvent<ToolCallingTaskOutput>, { text: string; result: T | undefined }> {
  const queue: string[] = [];
  const pendingUsage: StreamEvent<ToolCallingTaskOutput>[] = [];
  let isComplete = false;
  let completionError: unknown;
  let resolveWait: (() => void) | null = null;
  let accumulatedText = "";
  let result: T | undefined;

  const notifyWaiter = () => {
    resolveWait?.();
    resolveWait = null;
  };

  const provisionalUsage = createEstimatedOutputUsageReporter((event) => {
    pendingUsage.push(event);
    notifyWaiter();
  });
  if (options.promptText !== undefined) {
    provisionalUsage.onPrompt(options.promptText);
  }

  const generationPromise = startGeneration((chunk: string) => {
    queue.push(chunk);
    provisionalUsage.onText(chunk);
    notifyWaiter();
  })
    .then((res) => {
      result = res;
      isComplete = true;
      notifyWaiter();
    })
    .catch((err: unknown) => {
      completionError = err;
      isComplete = true;
      notifyWaiter();
    });

  const drain = function* (): Generator<StreamEvent<ToolCallingTaskOutput>> {
    while (pendingUsage.length > 0) {
      yield pendingUsage.shift()!;
    }
    while (queue.length > 0) {
      const chunk = queue.shift()!;
      accumulatedText += chunk;
      yield { type: "text-delta", port: "text", textDelta: chunk };
    }
  };

  try {
    while (true) {
      yield* drain();
      if (isComplete) break;
      await new Promise<void>((r) => {
        resolveWait = r;
      });
    }
    yield* drain();
  } finally {
    await generationPromise.catch(() => {});
  }

  if (completionError) {
    throw completionError;
  }

  if (signal.aborted) {
    throw (signal as any).reason ?? new Error("The operation was aborted");
  }
  provisionalUsage.flush();
  yield* drain();
  return { text: accumulatedText, result };
}

async function generateToolResponse(
  input: ToolCallingTaskInput,
  model: LlamaCppModelConfig,
  signal: AbortSignal,
  emit: (event: StreamEvent<ToolCallingTaskOutput>) => void,
  sequence: any,
  prefix: CheckpointPrefix | undefined
): Promise<{ cleanHistory: any[] }> {
  const { LlamaChat } = getLlamaCppSdk();
  let llamaChat: any;
  let gen:
    | AsyncGenerator<StreamEvent<ToolCallingTaskOutput>, { text: string; result: any }>
    | undefined;
  try {
    llamaChat = new LlamaChat({
      contextSequence: sequence,
      ...llamaCppChatSessionConstructorSpread(model),
    });

    const chatHistory = buildToolChatHistory(input, prefix);
    const functions = buildChatModelFunctions(input.tools);
    const promptText = [
      input.systemPrompt ?? "",
      ...(input.messages ?? []).map((m) => extractMessageText(m.content)),
      typeof input.prompt === "string" ? input.prompt : extractMessageText(input.prompt),
    ]
      .filter(Boolean)
      .join("\n");

    gen = streamTextChunks(
      (onTextChunk) =>
        llamaChat.generateResponse(chatHistory, {
          signal,
          ...llamaCppChatGenerateOptions(input, model),
          functions,
          ...(toolChoiceForcesToolCall(input.toolChoice) && { documentFunctionParams: true }),
          onTextChunk,
        }),
      signal,
      { promptText }
    );
    let step = await gen.next();
    while (!step.done) {
      emit(step.value);
      step = await gen.next();
    }
    const { text: accumulatedText, result: chatResponse } = step.value;

    const toolCalls = extractNativeFunctionCalls(chatResponse?.functionCalls);

    // Fallback: parse tool calls from text if native parsing found nothing
    if (toolCalls.length === 0 && input.tools.length > 0 && input.toolChoice !== "none") {
      toolCalls.push(...extractToolCallsFromText(accumulatedText, input));
    }
    const validToolCalls = filterValidToolCalls(toolCalls, input.tools);

    if (validToolCalls.length > 0) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...validToolCalls] });
    }

    // No accumulated output is returned on purpose: the text went out as
    // deltas and the calls as an object-delta, and `TaskRunner` accumulates
    // both. Handing a caller a second copy is what lets it reach `finish`.
    return {
      cleanHistory: chatResponse?.lastEvaluation.cleanHistory ?? chatHistory,
    };
  } finally {
    if (gen) {
      try {
        await gen.return({ text: "", result: undefined });
      } catch {}
    }
    if (llamaChat) {
      try {
        await llamaChat.dispose({ disposeSequence: false });
      } catch {}
    }
  }
}

export const LlamaCpp_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  LlamaCppModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  if (!model) throw new Error("Model config is required for ToolCallingTask.");

  await loadSdk();

  const modelPath = getActualModelPath(model);

  await withModelInUse(modelPath, async () => {
    if (!sessionContext) {
      const context = await getOrCreateTextContext(model);
      await withSequence(
        context,
        async (sequence) => {
          await generateToolResponse(input, model, signal, emit, sequence, undefined);
          emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput });
        },
        { signal }
      );
      return;
    }

    const sessionId = sessionContext.sessionId;
    const isCheckpoint = sessionContext.prefix !== undefined;
    // Consuming an immutable checkpoint steals ownership atomically — two
    // concurrent consumers of the same id would otherwise both call `.generate()`
    // on the shared LlamaContextSequence, which advances in place. The loser of
    // the steal observes `undefined` and re-encodes via the missing-state
    // fallback below. AiChatTask's `ownedSession` mode is the caller's mutable
    // session (not a checkpoint) so it uses the non-consuming getter.
    const isCheckpointConsumption =
      isCheckpoint && sessionId !== undefined && !sessionContext.ownedSession;

    const runGeneration = async (): Promise<void> => {
      // Defense-in-depth at the get site: an entry stored under this id for a
      // DIFFERENT model must be treated as a miss — its KV tokens belong to the
      // other model — without stealing, disposing, or overwriting it (the entry
      // belongs to that task). This run then stays ephemeral.
      const peeked = sessionId ? getLlamaCppSession(sessionId) : undefined;
      const modelKeyMismatch = peeked !== undefined && peeked.modelKey !== getConfigKey(model);
      let cached =
        peeked !== undefined && !modelKeyMismatch
          ? isCheckpointConsumption
            ? stealLlamaCppSession(sessionId!)
            : peeked
          : undefined;
      // A stolen checkpoint session's map entry is already gone — track owned=false
      // so the dispose path frees it unless it is re-keyed / restored below.
      // A non-consumption cache hit keeps the map entry, so it stays map-owned.
      let ownedByMap = Boolean(cached) && !isCheckpointConsumption;

      if (sessionId && !cached && isCheckpoint) {
        const prefix = sessionContext.prefix!;
        const { LlamaChatSession } = getLlamaCppSdk();
        const context = await getOrCreateTextContext(model);
        const sequence = await acquireContextSequence(context, signal);
        let chatSession: any;
        let state: LlamaCppSessionState | undefined;
        try {
          chatSession = new LlamaChatSession({
            contextSequence: sequence,
            ...(prefix.systemPrompt !== undefined && { systemPrompt: prefix.systemPrompt }),
            ...llamaCppChatSessionConstructorSpread(model),
          });
          // Route the prefix through the model's chat template — feeding role/text
          // strings via preloadPrompt would bypass the wrapper and drop
          // tool_use / tool_result blocks. setChatHistory + preloadPrompt("", { functions })
          // populates KV state via the same wrapper the consumer's generation uses.
          const history = renderLlamaCppPrefixChatHistory(prefix);
          chatSession.setChatHistory(history);
          const functions = renderLlamaCppPrefixFunctions(prefix);
          await chatSession.preloadPrompt("", {
            signal,
            ...(functions ? { functions } : {}),
          });
          state = {
            mode: "prefix-rewind",
            sequence,
            session: chatSession,
            modelKey: getConfigKey(model),
          };
        } catch (err) {
          if (chatSession) {
            try {
              await chatSession.dispose({ disposeSequence: false });
            } catch {}
          }
          try {
            await sequence.dispose();
          } catch {}
          throw err;
        }
        cached = state;
      }

      // Ownership tracking (`ownedByMap`) was decided above alongside the
      // steal-vs-get split: a stolen or freshly-encoded checkpoint session is
      // caller-owned until we re-key or restore it; a plain cache hit
      // (progressive / ownedSession) stays map-owned.
      const context = cached ? undefined : await getOrCreateTextContext(model);
      const sequence = cached ? cached.sequence : await acquireContextSequence(context!, signal);
      let session = cached?.session;
      if (!session) {
        const { LlamaChatSession } = getLlamaCppSdk();
        try {
          session = new LlamaChatSession({
            contextSequence: sequence,
            ...llamaCppChatSessionConstructorSpread(model),
          });
        } catch (err) {
          try {
            await sequence.dispose();
          } catch {}
          throw err;
        }
      }

      if (sessionId && !cached && !modelKeyMismatch) {
        setLlamaCppSession(sessionId, {
          mode: "progressive",
          sequence,
          session,
          modelKey: getConfigKey(model),
        });
        ownedByMap = true;
      }

      // Capture the prefix token boundary before generation so a successful
      // non-superseding consumption can rewind the KV back to the warmed prefix.
      const prefixBoundary = isCheckpointConsumption
        ? captureSequenceTokenBoundary(sequence)
        : undefined;

      try {
        const { cleanHistory } = await generateToolResponse(
          input,
          model,
          signal,
          emit,
          sequence,
          sessionContext.prefix
        );
        const emitId = sessionContext.emitCheckpointId;
        // Re-key under the emitted id only when the consumed parent is
        // superseded (or when nothing was consumed at all). An emit that keeps
        // the parent leaves the emitted id with no local KV state — its
        // consumers take the documented re-encode fallback — so the parent's
        // warmed state can be restored below.
        const reKeyForEmit =
          emitId !== undefined &&
          (!isCheckpointConsumption || sessionContext.supersedeParent === true);
        if (!isCheckpointConsumption || reKeyForEmit) {
          session.setChatHistory(cleanHistory);
        }
        emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput });
        if (emitId !== undefined && reKeyForEmit) {
          setLlamaCppSession(emitId, {
            mode: "prefix-rewind",
            sequence,
            session,
            modelKey: getConfigKey(model),
          });
          ownedByMap = true;
        } else if (isCheckpointConsumption && sessionId) {
          // Restore-after-consume: rewind the sequence KV to the prefix
          // boundary and re-register the warmed state under the checkpoint id
          // so the next consumer reuses it instead of paying a full prefix
          // re-encode. A consumer that arrived while the session was stolen
          // already re-encoded via the missing-state fallback (acceptable);
          // whichever finisher restores first wins and the other disposes. On
          // any rewind failure the state is disposed below — post-generation
          // state is never left registered under the checkpoint id.
          const restored = await restoreLlamaCppCheckpointSession(
            sessionId,
            { mode: "prefix-rewind", sequence, session, modelKey: getConfigKey(model) },
            prefixBoundary,
            renderLlamaCppPrefixChatHistory(sessionContext.prefix!)
          );
          if (restored) ownedByMap = true;
        }
      } finally {
        if (!ownedByMap) {
          try {
            await session.dispose({ disposeSequence: false });
          } catch {}
          try {
            await sequence.dispose();
          } catch {}
        }
      }
    };

    // Non-consuming shared-session paths (a fingerprint session reused across
    // same-toolset calls, or a chat's ownedSession) read-modify-write one live
    // sequence with async gaps between lookup, creation, generation, and the
    // store-back — serialize them per session id. Checkpoint consumption skips
    // the lock: the steal above is atomic and the loser re-encodes on its own
    // sequence.
    if (sessionId !== undefined && !isCheckpointConsumption) {
      await withSessionLock(sessionId, runGeneration);
    } else {
      await runGeneration();
    }
  });
};
