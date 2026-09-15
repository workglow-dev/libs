/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, TaskStatus } from "@a2a-js/sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";
import type { AgentTaskInput } from "@workglow/ai";
import { AgentTask } from "@workglow/ai";
import { getLogger, uuid4 } from "@workglow/util";

import type { IA2AAgentDescriptor } from "../util/AgentDescriptor";
import { PartBindingError, partsToPorts, textOfParts, textPart } from "../util/partBinding";

/** One turn, as this executor needs it — injected so a test needs no model. */
export type RunAgentTurn = (
  input: AgentTaskInput,
  signal: AbortSignal
) => Promise<{ readonly text: string }>;

export interface AgentTaskExecutorOptions {
  readonly descriptor: IA2AAgentDescriptor;
  readonly runTurn?: RunAgentTurn;
}

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

/**
 * One saved agent, as the SDK's executor.
 *
 * Two rules the event sequence has to keep. A stream MUST open with a `task`
 * or `message` event — the server rejects one that begins with a status or
 * artifact update — and it MUST reach a terminal state on every path, including
 * a throw, or the caller waits on a task that will never move. The protocol
 * has no separate "final" flag: a terminal `state` is what ends the task.
 *
 * `INPUT_REQUIRED` is never published. A turn that would ask a person has no
 * resume path yet, so parking here would leave a task nothing can finish.
 */
export class AgentTaskExecutor implements AgentExecutor {
  private readonly descriptor: IA2AAgentDescriptor;
  private readonly runTurn: RunAgentTurn;
  private readonly running = new Map<string, RunningTurn>();

  constructor(options: AgentTaskExecutorOptions) {
    this.descriptor = options.descriptor;
    this.runTurn = options.runTurn ?? runWithAgentTask;
  }

  public execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const { taskId, contextId } = requestContext;
    const controller = new AbortController();
    this.running.set(taskId, { controller, contextId });

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

      const result = await this.runTurn(
        { ...this.descriptor.agentInput, ...bound } as AgentTaskInput,
        controller.signal
      );

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

      this.publishFinal(eventBus, taskId, contextId, TaskState.TASK_STATE_COMPLETED);
    } catch (error) {
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
      this.publishFinal(eventBus, taskId, contextId, TaskState.TASK_STATE_FAILED, message);
    } finally {
      this.running.delete(taskId);
      eventBus.finished();
    }
  };

  public cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    // Abort the run as well as recording the state: marking a task canceled
    // while the model keeps generating bills for an answer nobody reads.
    const turn = this.running.get(taskId);
    turn?.controller.abort();
    this.running.delete(taskId);
    this.publishFinal(eventBus, taskId, turn?.contextId ?? "", TaskState.TASK_STATE_CANCELED);
    eventBus.finished();
  };

  private publishFinal(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskState,
    message?: string
  ): void {
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: statusNow(
          state,
          message === undefined ? undefined : agentMessage(taskId, contextId, message)
        ),
        metadata: undefined,
      })
    );
  }
}
