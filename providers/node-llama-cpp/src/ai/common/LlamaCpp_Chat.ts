/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiChatProviderInput,
  AiChatProviderOutput,
  AiProviderRunFn,
  AiSessionContext,
  ChatMessage,
} from "@workglow/ai";
import { createEstimatedOutputUsageReporter } from "@workglow/ai/provider-utils";
import { renderLlamaCppPrefixFunctions } from "./LlamaCpp_CacheCheckpoint";
import type { LlamaCppModelConfig } from "./LlamaCpp_ModelSchema";
import {
  acquireContextSequence,
  getActualModelPath,
  getConfigKey,
  getLlamaCppSession,
  getOrCreateTextContext,
  llamaCppChatSessionConstructorSpread,
  llamaCppSeedPromptSpread,
  loadSdk,
  setLlamaCppSession,
  withModelInUse,
} from "./LlamaCpp_Runtime";
import { messagesToPureChatHistoryForPrefix } from "./LlamaCpp_ToolCalling";
import { llamaCppThoughtBudgetOption } from "./LlamaCpp_EffortPolicy";

export function resolveLlamaCppCheckpointSystemPrompt(
  inputSystemPrompt: string | undefined,
  prefixSystemPrompt: string | undefined
): string | undefined {
  return inputSystemPrompt ?? prefixSystemPrompt;
}

async function getOrCreateChatSession(
  sessionContext: AiSessionContext | undefined,
  model: LlamaCppModelConfig,
  systemPrompt: string | undefined,
  priorMessages: ReadonlyArray<ChatMessage>,
  signal: AbortSignal
): Promise<{ session: any; sequence: any }> {
  const sessionId = sessionContext?.sessionId;
  const isCheckpoint = sessionContext?.prefix !== undefined;

  if (sessionId) {
    // AiChatTask uses `ownedSession` — the session id is the caller's mutable
    // chat session, not an immutable checkpoint. That's why we use
    // `getLlamaCppSession` (a non-consuming lookup) here rather than
    // `stealLlamaCppSession`, which TextGen / ToolCalling use to serialize
    // concurrent consumers of a shared checkpoint sequence.
    const existing = getLlamaCppSession(sessionId);
    if (existing !== undefined) {
      // Session already created with its prompt state baked in (progressive
      // turn history or a prefix-rewind checkpoint) — ignore the systemPrompt
      // argument on subsequent turns.
      return { session: existing.session, sequence: existing.sequence };
    }
  }

  const { LlamaChatSession } = await loadSdk();
  const context = await getOrCreateTextContext(model);
  const sequence = await acquireContextSequence(context, signal);
  const effectiveSystemPrompt = isCheckpoint
    ? resolveLlamaCppCheckpointSystemPrompt(systemPrompt, sessionContext!.prefix!.systemPrompt)
    : systemPrompt;
  // Sequence ownership only transfers once the session is stored in the map (or
  // returned to the caller, which disposes it); free the session/sequence on any
  // throw before that (e.g. an aborted preload) so it does not strand the slot.
  let session: any;
  try {
    session = new LlamaChatSession({
      contextSequence: sequence,
      ...(effectiveSystemPrompt !== undefined && { systemPrompt: effectiveSystemPrompt }),
      ...llamaCppChatSessionConstructorSpread(model),
    });

    // Missing-state rebuild: the session for this id is gone (worker restart,
    // VRAM eviction) or this is the conversation's first turn seeded from a
    // checkpoint. Re-encode the checkpoint prefix (when present) PLUS every
    // conversation turn before the final user turn — the caller prompts only
    // that final user text, so a prefix-only rebuild would silently forget
    // turns 1..N-1. Rendered via the pure history helper so tool_use /
    // tool_result blocks survive (a raw-text preload would drop them), with
    // the EFFECTIVE system prompt rendered into the history: setChatHistory
    // replaces the constructor-baked history wholesale, so rendering the
    // prefix's own systemPrompt here would wipe the caller's.
    const rebuildMessages: ChatMessage[] = [
      ...(isCheckpoint ? (sessionContext!.prefix!.messages ?? []) : []),
      ...priorMessages,
    ];
    if (isCheckpoint || rebuildMessages.length > 0) {
      const history = messagesToPureChatHistoryForPrefix(rebuildMessages, effectiveSystemPrompt);
      session.setChatHistory(history);
      const functions = isCheckpoint
        ? renderLlamaCppPrefixFunctions(sessionContext!.prefix!)
        : undefined;
      await session.preloadPrompt("", {
        signal,
        ...(functions ? { functions } : {}),
      });
    }

    if (sessionId) {
      setLlamaCppSession(sessionId, {
        // An ownedSession id is the caller's mutable chat session even when it
        // was seeded from a checkpoint prefix — only a bare checkpoint id gets
        // the immutable prefix-rewind label.
        mode: isCheckpoint && !sessionContext?.ownedSession ? "prefix-rewind" : "progressive",
        session,
        sequence,
        modelKey: getConfigKey(model),
      });
    }
  } catch (err) {
    if (session) {
      try {
        await session.dispose({ disposeSequence: false });
      } catch {}
    }
    try {
      await sequence.dispose();
    } catch {}
    throw err;
  }

  return { session, sequence };
}

/**
 * Split the chat's message list into the final user turn's text (what
 * `session.prompt` sends) and everything before it (what a missing-session
 * rebuild must re-encode). The chat task sends the FULL conversation every
 * turn, so the rebuild path needs all prior turns, not just the prompted one.
 */
function splitFinalUserTurn(messages: ReadonlyArray<ChatMessage>): {
  readonly priorMessages: ReadonlyArray<ChatMessage>;
  readonly userText: string;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = messages[i].content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
    if (text) return { priorMessages: messages.slice(0, i), userText: text };
  }
  return { priorMessages: messages, userText: "" };
}

export const LlamaCpp_Chat_Stream: AiProviderRunFn<
  AiChatProviderInput,
  AiChatProviderOutput,
  LlamaCppModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const sessionId = sessionContext?.sessionId;
  if (!model) throw new Error("Model config is required for AiChatTask.");

  const modelPath = getActualModelPath(model);

  await withModelInUse(modelPath, async () => {
    const { priorMessages, userText } = splitFinalUserTurn(input.messages ?? []);
    const { session, sequence } = await getOrCreateChatSession(
      sessionContext,
      model,
      input.systemPrompt,
      priorMessages,
      signal
    );

    const queue: string[] = [];
    let done = false;
    let resolver: (() => void) | undefined;

    // node-llama-cpp surfaces no token accounting on its prompt API; estimate
    // ↑ from the turn text and ↓ from chunks so the CLI counter still moves.
    const provisionalUsage = createEstimatedOutputUsageReporter(emit);
    provisionalUsage.onPrompt(userText);

    const promptPromise = session
      .prompt(userText, {
        signal,
        ...llamaCppSeedPromptSpread(model.provider_config),
        ...(input.temperature !== undefined && { temperature: input.temperature }),
        ...(input.maxTokens !== undefined && { maxTokens: input.maxTokens }),
        ...llamaCppThoughtBudgetOption(model),
        onTextChunk: (chunk: string) => {
          queue.push(chunk);
          provisionalUsage.onText(chunk);
          resolver?.();
        },
      })
      .finally(async () => {
        done = true;
        resolver?.();
        if (!sessionId) {
          try {
            await session.dispose({ disposeSequence: false });
          } catch {}
          try {
            await sequence.dispose();
          } catch {}
        }
      });

    while (!done || queue.length > 0) {
      if (queue.length === 0 && !done) {
        await new Promise<void>((res) => (resolver = res));
        resolver = undefined;
      }
      while (queue.length > 0) {
        emit({ type: "text-delta", port: "text", textDelta: queue.shift()! });
      }
    }
    await promptPromise;
    provisionalUsage.flush();
    // No usage on finish: mid-stream snapshots settle via liveUsage fallback.
    emit({ type: "finish", data: {} as AiChatProviderOutput });
  });
};
