/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentApprovalMode, AgentTaskOutput, ChatMessage, ToolDefinition } from "@workglow/ai";
import { AgentTask } from "@workglow/ai";
import type { StreamEvent } from "@workglow/task-graph";
import {
  globalServiceRegistry,
  HUMAN_CONNECTOR,
  resolveHumanConnector,
  ServiceRegistry,
  uuid4,
} from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { ensureRunReporting } from "../run-events/runReporting";
import { withCli } from "../run-interactive";
import { createInterface } from "node:readline/promises";
import { formatError } from "../util";
import { PromptHumanConnector } from "../ui/PromptHumanConnector";
import { CHAT_HELP_LINES, classifyChatLine } from "./chatCommands";
import { createChatTranscript } from "./chatTranscript";

/**
 * The session's two ends, injectable so the loop can be driven without a
 * terminal. Defaults are readline and stdout.
 */
export interface AgentChatIo {
  /** One line from the person, or `undefined` at end of input. */
  readonly ask: (prompt: string) => Promise<string | undefined>;
  readonly write: (text: string) => void;
}

export interface AgentChatOptions {
  readonly model: string;
  readonly tools: readonly ToolDefinition[];
  readonly systemPrompt: string | undefined;
  readonly maxRounds: number | undefined;
  readonly approval: AgentApprovalMode;
}

/**
 * One question, on a readline interface that exists only for the length of it.
 *
 * A long-lived interface keeps listeners on stdin, and the approval prompts
 * this session raises render their own Ink app over the same terminal — two
 * readers of one stdin is a session that drops keystrokes into whichever
 * happens to be listening. Creating and closing per question means nothing but
 * the prompt of the moment ever holds it.
 */
async function askLine(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } catch {
    // The interface closes on EOF (Ctrl-D), which rejects the pending question.
    return undefined;
  } finally {
    rl.close();
  }
}

/**
 * The schema of the one thing this loop asks a person for.
 *
 * `format` is the marker a renderer keys on: the console draws a chat composer
 * for it rather than the one-line text field every other string port gets, and
 * folds the answer into the transcript instead of showing it as a form it once
 * filled in.
 */
export const CHAT_MESSAGE_SCHEMA: DataPortSchema = {
  type: "object",
  properties: {
    message: { type: "string", title: "Message", format: "chat-message" },
  },
  required: ["message"],
  additionalProperties: false,
};

/**
 * A child of the host's registry carrying the connector this session prompts
 * through — but ONLY when the session owns a terminal.
 *
 * A run reporting to a parent process already has a connector wired to that
 * channel, installed with the channel itself. Overriding it here would point a
 * console session's approvals at an Ink prompt nobody can see, on a process
 * whose stdout is a pipe.
 */
export function chatRegistry(parent: ServiceRegistry, reported: boolean): ServiceRegistry {
  if (reported) return parent;
  const registry = new ServiceRegistry(parent.container.createChildContainer());
  registry.registerInstance(HUMAN_CONNECTOR, new PromptHumanConnector());
  return registry;
}

/**
 * The next message, asked through whoever is listening.
 *
 * A reported run has no terminal to read a line from — its stdin is not a
 * person — so the question goes up the same channel every other question does
 * and the answer comes back down it. Declining or dismissing ends the session,
 * which is what closing the composer means.
 */
export function askThroughConnector(
  registry: ServiceRegistry,
  signal: AbortSignal
): () => Promise<string | undefined> {
  return async (): Promise<string | undefined> => {
    const response = await resolveHumanConnector({ registry }).send(
      {
        requestId: uuid4(),
        targetHumanId: "default",
        kind: "elicit",
        message: "Your message",
        contentSchema: CHAT_MESSAGE_SCHEMA,
        contentData: undefined,
        expectsResponse: true,
        mode: "single",
        metadata: undefined,
      },
      signal
    );
    if (response.action !== "accept") return undefined;
    const message = response.content?.message;
    return typeof message === "string" ? message : undefined;
  };
}

/**
 * The chat loop: read a line, run one {@link AgentTask} turn, carry the
 * conversation forward.
 *
 * `messages` is this loop's only state — the task takes the history in and
 * hands it back with the turn appended, so nothing here has to know what a
 * tool result or a tool-call id looks like.
 */
export async function runAgentChat(options: AgentChatOptions, io?: AgentChatIo): Promise<void> {
  const reported = ensureRunReporting() !== undefined;
  const registry = chatRegistry(globalServiceRegistry, reported);
  const sessionAbort = new AbortController();
  const ask = io?.ask ?? (reported ? askThroughConnector(registry, sessionAbort.signal) : askLine);
  const transcript = createChatTranscript(io?.write ?? ((text) => void process.stdout.write(text)));
  let messages: ChatMessage[] = [];

  transcript.note(
    options.tools.length === 0
      ? "No tools — this agent can talk, and nothing else. Pass --tools to give it some."
      : `Tools: ${options.tools.map((tool) => tool.name).join(", ")}`
  );
  transcript.note("/help for commands, /exit to leave.");

  for (;;) {
    transcript.endTurn();
    const line = await ask("\n› ");
    if (line === undefined) return;
    const intent = classifyChatLine(line);
    if (intent.kind === "quit") return;
    if (intent.kind === "blank") continue;
    if (intent.kind === "reset") {
      messages = [];
      transcript.note("Conversation cleared.");
      continue;
    }
    if (intent.kind === "help") {
      for (const help of CHAT_HELP_LINES) transcript.note(help);
      continue;
    }
    if (intent.kind === "unknown-command") {
      transcript.note(`Unknown command ${intent.typed}. /help for the list.`);
      continue;
    }
    messages = await runTurn(intent.text, messages, options, registry, transcript);
  }
}

async function runTurn(
  text: string,
  messages: ChatMessage[],
  options: AgentChatOptions,
  registry: ServiceRegistry,
  transcript: ReturnType<typeof createChatTranscript>
): Promise<ChatMessage[]> {
  const task = new AgentTask();
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.on("SIGINT", onInterrupt);

  let phase: string | undefined;
  const offStream = task.subscribe("stream_chunk", (event: StreamEvent) => {
    if (event.type === "text-delta") transcript.delta(event.textDelta);
  });
  const offProgress = task.subscribe("progress", (_progress, message) => {
    // Only the tool lines are worth a row: "Thinking" is what the blank space
    // between the prompt and the first token already says.
    if (!message || message === phase) return;
    phase = message;
    if (message.startsWith("Running ")) transcript.note(`  · ${message.slice("Running ".length)}`);
  });

  try {
    // Through `withCli` rather than `task.run` so a session the console
    // started reports its rows and its text up the event channel like every
    // other command. `interactive: false` keeps the Ink run UI out of it: on a
    // terminal that UI clears its frame when the run completes, which is the
    // transcript this session is writing.
    const output = (await withCli(task, { interactive: false, suppressResultOutput: true }).run(
      {
        model: options.model,
        prompt: text,
        messages,
        tools: [...options.tools],
        systemPrompt: options.systemPrompt,
        maxRounds: options.maxRounds,
        approval: options.approval,
      },
      { registry, signal: controller.signal }
    )) as AgentTaskOutput;
    if (output.stopReason === "max-rounds") {
      transcript.note(`  · stopped after ${output.rounds} rounds without an answer`);
    }
    return output.messages;
  } catch (error) {
    if (controller.signal.aborted) {
      // The turn is gone but the conversation is not: an interrupted turn wrote
      // nothing to `messages`, so the next one continues from where it was.
      transcript.note("  · interrupted");
      return messages;
    }
    transcript.note(`  · ${formatError(error)}`);
    return messages;
  } finally {
    process.off("SIGINT", onInterrupt);
    offStream();
    offProgress();
  }
}
