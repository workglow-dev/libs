/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, Task as A2ATask, TaskStatus } from "@a2a-js/sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
  ServerCallContext,
  TaskStore,
} from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";
import type { AgentTaskInput, ChatMessage } from "@workglow/ai";
import { AgentTask } from "@workglow/ai";
import { getLogger, uuid4 } from "@workglow/util";

import type { IA2AAgentDescriptor } from "../util/AgentDescriptor";
import { PartBindingError, partsToPorts, textOfParts, textPart } from "../util/partBinding";

/** One turn, as this executor needs it — injected so a test needs no model. */
export type RunAgentTurn = (
  input: AgentTaskInput,
  signal: AbortSignal
) => Promise<{ readonly text: string }>;

/**
 * The key under which a transport puts a request-scoped `AbortSignal` into
 * the SDK's `ServerCallContext.state`, so a peer hanging up reaches the turn
 * its request started. The SDK's own executor seam carries no signal.
 */
export const A2A_REQUEST_SIGNAL_KEY = "a2a.requestSignal";

export interface AgentTaskExecutorOptions {
  readonly descriptor: IA2AAgentDescriptor;
  readonly runTurn?: RunAgentTurn;
  /**
   * Where earlier tasks in a context are read from, so a continued
   * conversation reaches the model with its history. Without one every
   * message is a first message.
   */
  readonly taskStore?: TaskStore;
  /** How many earlier tasks of a context are replayed. */
  readonly maxHistoryTasks?: number;
}

const DEFAULT_MAX_HISTORY_TASKS = 50;

async function runWithAgentTask(
  input: AgentTaskInput,
  signal: AbortSignal
): Promise<{ readonly text: string }> {
  const task = new AgentTask({ defaults: input });
  const output = await task.run({}, { signal });
  return { text: output.text };
}

interface RunningTurn {
  readonly controller: AbortController;
  readonly contextId: string;
  /** Set once a terminal status has gone out; nothing publishes after it. */
  finalized: boolean;
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: uuid4(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function statusNow(state: TaskState, message: Message | undefined): TaskStatus {
  return { state, message, timestamp: new Date().toISOString() };
}

function chatMessage(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: [{ type: "text", text }] };
}

/**
 * One completed task, as the exchange it recorded: the peer's messages from
 * its history, then the answer from its artifacts — which is where this
 * executor puts it, so the status message carries only failures.
 */
function exchangeOf(task: A2ATask): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const message of task.history) {
    const text = textOfParts(message.parts);
    if (text.length === 0) continue;
    messages.push(chatMessage(message.role === Role.ROLE_USER ? "user" : "assistant", text));
  }
  const answer = textOfParts(task.artifacts.flatMap((artifact) => artifact.parts));
  if (answer.length > 0) messages.push(chatMessage("assistant", answer));
  return messages;
}

/**
 * One saved agent, as the SDK's executor.
 *
 * Two rules the event sequence has to keep. A stream MUST open with a `task`
 * or `message` event — the server rejects one that begins with a status or
 * artifact update — and it MUST reach exactly one terminal state on every
 * path: a throw, a cancel, a peer that hung up. The protocol has no separate
 * "final" flag, a terminal `state` is what ends the task, and a second one
 * after it rewrites what the store recorded.
 *
 * `INPUT_REQUIRED` is never published. A turn that would ask a person has no
 * resume path yet, so parking here would leave a task nothing can finish.
 */
export class AgentTaskExecutor implements AgentExecutor {
  private readonly descriptor: IA2AAgentDescriptor;
  private readonly runTurn: RunAgentTurn;
  private readonly taskStore: TaskStore | undefined;
  private readonly maxHistoryTasks: number;
  private readonly running = new Map<string, RunningTurn>();

  constructor(options: AgentTaskExecutorOptions) {
    this.descriptor = options.descriptor;
    this.runTurn = options.runTurn ?? runWithAgentTask;
    this.taskStore = options.taskStore;
    this.maxHistoryTasks = options.maxHistoryTasks ?? DEFAULT_MAX_HISTORY_TASKS;
  }

  public execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const { taskId, contextId } = requestContext;
    const controller = new AbortController();
    const turn: RunningTurn = { controller, contextId, finalized: false };
    this.running.set(taskId, turn);

    // A peer that hangs up should stop paying for an answer nobody reads.
    const requestSignal = requestContext.context.state.get(A2A_REQUEST_SIGNAL_KEY);
    if (requestSignal instanceof AbortSignal) {
      if (requestSignal.aborted) controller.abort();
      else requestSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    // Must be first. The server rejects a stream opening with an update. The
    // history is left for the server to fill: it prepends the user message
    // itself, and restates what it already persisted for a continued task.
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: statusNow(TaskState.TASK_STATE_WORKING, undefined),
        artifacts: [],
        history: [],
        metadata: undefined,
      })
    );

    try {
      const skill = this.descriptor.skills[0];
      const parts = requestContext.userMessage.parts;
      // Bind through the skill's schema when it declares one; otherwise the
      // prompt is simply the text the caller sent.
      const bound = skill?.inputSchema
        ? partsToPorts(parts, skill.inputSchema)
        : { prompt: textOfParts(parts) };
      const history = await this.priorMessages(contextId, taskId, requestContext.context);
      // A cancel that landed while the history was read has no turn to abort;
      // starting one now would be starting it for nobody.
      if (turn.finalized) return;
      if (controller.signal.aborted) {
        this.publishFinal(eventBus, turn, taskId, TaskState.TASK_STATE_CANCELED, undefined);
        return;
      }

      // The host's input is spread last: a peer's ports fill what the skill
      // declared and nothing the host decided — the model, the system prompt,
      // the tool list and the approval mode are not the caller's to set. Typed
      // loosely on purpose: the ports are whatever the skill's schema declared,
      // and the turn validates the result against its own input schema.
      const input = {
        ...bound,
        ...this.descriptor.agentInput,
        messages: [...(this.descriptor.agentInput.messages ?? []), ...history],
      } as unknown as AgentTaskInput;
      const result = await this.runTurn(input, controller.signal);
      if (turn.finalized) return;
      if (controller.signal.aborted) {
        // A run-fn that ignores its signal still answers; the peer is gone
        // and the task ends as what it is.
        this.publishFinal(eventBus, turn, taskId, TaskState.TASK_STATE_CANCELED, undefined);
        return;
      }

      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: `${taskId}-answer`,
            name: "answer",
            description: "",
            parts: [textPart(result.text)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        })
      );
      this.publishFinal(eventBus, turn, taskId, TaskState.TASK_STATE_COMPLETED, undefined);
    } catch (error) {
      if (turn.finalized) return;
      if (controller.signal.aborted) {
        // The abort is ours — a cancel or a peer hanging up — not a failure.
        this.publishFinal(eventBus, turn, taskId, TaskState.TASK_STATE_CANCELED, undefined);
        return;
      }
      // A bad bind is the caller's mistake and names the ports it could not
      // fill; anything else is ours and stays on the server's own log, since
      // a model error can carry a key name or a path a peer must not see.
      // Both end the task — a caller left on `working` waits forever.
      const isCallerError = error instanceof PartBindingError;
      if (!isCallerError) {
        getLogger().error("a2a agent turn failed", {
          agent: this.descriptor.id,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const message = isCallerError ? error.message : "The agent failed to answer.";
      this.publishFinal(eventBus, turn, taskId, TaskState.TASK_STATE_FAILED, message);
    } finally {
      this.running.delete(taskId);
    }
  };

  public cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    const turn = this.running.get(taskId);
    if (!turn) {
      // Nothing is running: the task already reached its end, and a second
      // terminal status would overwrite it. The bus is told so the server
      // stops waiting on this call.
      eventBus.finished();
      return;
    }
    // Abort the run as well as recording the state: marking a task canceled
    // while the model keeps generating bills for an answer nobody reads.
    turn.controller.abort();
    this.publishFinal(eventBus, turn, taskId, TaskState.TASK_STATE_CANCELED, undefined);
  };

  /** Earlier completed tasks of this context, as the model should read them. */
  private async priorMessages(
    contextId: string,
    currentTaskId: string,
    context: ServerCallContext
  ): Promise<ChatMessage[]> {
    if (!this.taskStore || !contextId) return [];
    const listed = await this.taskStore.list(
      {
        tenant: context.tenant ?? "",
        contextId,
        status: TaskState.TASK_STATE_COMPLETED,
        pageSize: this.maxHistoryTasks,
        pageToken: "",
        statusTimestampAfter: undefined,
        includeArtifacts: true,
      },
      context
    );
    // Newest first is how a store lists; a conversation reads oldest first.
    return listed.tasks
      .filter((task) => task.id !== currentTaskId)
      .reverse()
      .flatMap(exchangeOf);
  }

  /** Exactly once per turn: the terminal status, then the bus is finished. */
  private publishFinal(
    eventBus: ExecutionEventBus,
    turn: RunningTurn,
    taskId: string,
    state: TaskState,
    message: string | undefined
  ): void {
    if (turn.finalized) return;
    turn.finalized = true;
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: turn.contextId,
        status: statusNow(
          state,
          message === undefined ? undefined : agentMessage(taskId, turn.contextId, message)
        ),
        metadata: undefined,
      })
    );
    eventBus.finished();
  }
}
