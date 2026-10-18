/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentTaskInput, AgentTaskOutput, ChatMessage, ModelConfig } from "@workglow/ai";
import { AGENT_APPROVAL_OPT_OUT, AgentTask } from "@workglow/ai";
import type { StreamEvent } from "@workglow/task-graph";
import { globalServiceRegistry, ServiceRegistry } from "@workglow/util";
import { SANDBOX_SYSTEM_PROMPT } from "./sandboxPrompt";
import type { SandboxPort } from "./sandboxPort";
import type { SandboxToolOptions, SandboxTools } from "./sandboxTools";
import { createSandboxTools } from "./sandboxTools";

/** What the run reports as it goes, for a UI to draw. */
export type SandboxAgentEvent =
  | {
      readonly type: "tool-call";
      readonly status: string;
      readonly id: string;
      readonly name: string | undefined;
      readonly input?: unknown;
      readonly result?: string | undefined;
    }
  | { readonly type: "preview"; readonly url: string; readonly port: number }
  | { readonly type: "messages"; readonly messages: readonly ChatMessage[] };

export interface SandboxAgentRun {
  readonly instruction: string;
  readonly model: ModelConfig;
  readonly sandbox: SandboxPort;
  readonly signal?: AbortSignal | undefined;
  /** The conversation so far, so a follow-up edits the project it built. */
  readonly messages?: readonly ChatMessage[] | undefined;
  readonly maxRounds?: number | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly systemPrompt?: string | undefined;
  readonly tools?: SandboxToolOptions | undefined;
  /**
   * Tools created by the caller, kept across turns. A run given these never
   * stops their servers, not even when it fails or is stopped, because the
   * project (and the preview showing it) outlives any one turn. Without them
   * the run makes its own, which `dispose` on the result ends.
   */
  readonly sandboxTools?: SandboxTools | undefined;
  readonly onEvent?: ((event: SandboxAgentEvent) => void) | undefined;
}

export interface SandboxAgentResult {
  readonly text: string;
  readonly messages: readonly ChatMessage[];
  readonly stopReason: AgentTaskOutput["stopReason"];
  readonly rounds: number;
  /** The last server the project started, if any. */
  readonly previewUrl: string | undefined;
}

const DEFAULT_MAX_ROUNDS = 40;

/**
 * One turn of the coding agent: AgentTask with the sandbox tools, running until
 * the model answers or a limit stops it. Servers the project left running stay
 * up when this returns, so the user keeps a live preview; the caller ends them
 * with `dispose` when it is done with the sandbox.
 *
 * Providers are the host's to register (`registerAnthropicInline()` and the
 * like) and the key is the host's to supply in `model.provider_config`: this
 * function owns neither, so it carries no credential handling of its own.
 */
export async function runSandboxAgent(
  run: SandboxAgentRun
): Promise<SandboxAgentResult & { dispose(): void }> {
  let previewUrl: string | undefined;
  const owned = run.sandboxTools === undefined;
  const sandboxTools = run.sandboxTools ?? createSandboxTools(run.sandbox, run.tools);
  // Subscribed for this run only, so caller-owned tools report to whichever run is live.
  const offPreview = sandboxTools.onPreview((url, port) => {
    previewUrl = url;
    run.onEvent?.({ type: "preview", url, port });
  });

  // Every tool is a host function over the sandbox, so there is nothing for a
  // person to approve that the sandbox does not already contain.
  const registry = new ServiceRegistry(globalServiceRegistry.container.createChildContainer());
  registry.registerInstance(AGENT_APPROVAL_OPT_OUT, true);

  const task = new AgentTask();
  const off = task.subscribe("stream_chunk", (event: StreamEvent) => {
    if (event.type === "snapshot") {
      const data = event.data as { messages?: ChatMessage[] };
      if (data.messages) run.onEvent?.({ type: "messages", messages: data.messages });
    } else if (event.type === "tool-call") {
      const call = event as unknown as {
        status: string;
        toolCallId: string;
        name?: string;
        input?: unknown;
        result?: string;
      };
      run.onEvent?.({
        type: "tool-call",
        status: call.status,
        id: call.toolCallId,
        name: call.name,
        ...(call.input === undefined ? {} : { input: call.input }),
        ...(call.result === undefined ? {} : { result: call.result }),
      });
    }
  });

  const input: AgentTaskInput = {
    model: run.model,
    prompt: run.instruction,
    systemPrompt: run.systemPrompt ?? SANDBOX_SYSTEM_PROMPT,
    tools: sandboxTools.tools,
    maxRounds: run.maxRounds ?? DEFAULT_MAX_ROUNDS,
    approval: "never",
    ...(run.messages === undefined ? {} : { messages: [...run.messages] }),
    ...(run.maxDurationMs === undefined ? {} : { maxDurationMs: run.maxDurationMs }),
  };

  try {
    const output = (await task.run(input, {
      registry,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
    })) as AgentTaskOutput;
    return {
      text: output.text,
      messages: output.messages,
      stopReason: output.stopReason,
      rounds: output.rounds,
      previewUrl,
      dispose: sandboxTools.dispose,
    };
  } catch (error) {
    if (owned) sandboxTools.dispose();
    throw error;
  } finally {
    off();
    offPreview();
  }
}
