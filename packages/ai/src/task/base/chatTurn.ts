/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IExecuteContext,
  StreamEvent,
  TaskInput,
  TaskOutput,
  Usage,
} from "@workglow/task-graph";
import { mergeUsage, retractText } from "@workglow/task-graph";
import type { AiEmit } from "../../capability/AiEmit";
import type { IAiExecutionStrategy } from "../../execution/IAiExecutionStrategy";
import type { AiJobInput } from "../../job/AiJob";
import { runWithIterable } from "./runWithIterable";

/** Everything one conversational turn needs to reach a provider. */
export interface ChatTurnArgs {
  readonly strategy: IAiExecutionStrategy;
  readonly jobInput: AiJobInput<TaskInput>;
  readonly context: IExecuteContext;
  readonly runnerId: string | undefined;
  /** Port stamped onto port-less `text-delta` / `text-retract` events from the provider. */
  readonly textPort: string;
}

/**
 * One turn's stream plus the state the multi-turn loop needs after it drains.
 * `text` and `usage` are getters over closure state: they read empty/undefined
 * before `events` is consumed and are final once it has drained.
 */
export interface ChatTurn<Output extends TaskOutput> {
  readonly events: AsyncIterable<StreamEvent<Output>>;
  /** Assistant text accumulated from this turn's `text-delta` events. */
  readonly text: string;
  /** Token counts this turn's provider reported, if any. */
  readonly usage: Usage | undefined;
}

/**
 * Drive one chat turn through a provider strategy.
 *
 * Shared by every multi-turn chat task: each turn is its own provider request,
 * but only the outer task emits a `finish` to the consumer, so the per-turn
 * text and token counts have to be captured here instead of riding the stream
 * out. Driving through {@link runWithIterable} means a consumer break or a
 * context abort cancels the provider stream rather than leaving it running
 * into a closed queue.
 */
export function runChatTurn<Output extends TaskOutput>(args: ChatTurnArgs): ChatTurn<Output> {
  let text = "";
  let usage: Usage | undefined;

  const events = runWithIterable<Output>(
    args.strategy,
    args.jobInput,
    args.context,
    args.runnerId,
    (queue): AiEmit<Output> =>
      (event) => {
        if (event.type === "text-delta") {
          text += event.textDelta;
          queue.push({
            ...event,
            port: event.port ?? args.textPort,
          } as StreamEvent<Output>);
        } else if (event.type === "text-retract") {
          text = retractText(text, event.length);
          queue.push({
            ...event,
            port: event.port ?? args.textPort,
          } as StreamEvent<Output>);
        } else if (event.type === "finish") {
          // Invariant: inner turn run-fns must be text.generation only;
          // finish.data from inner turns is intentionally discarded. If
          // json-mode capability is ever added to inner dispatch, this
          // swallow must be revisited. The `usage` sibling is NOT
          // discarded — it is summed onto the outer finish by the caller.
          usage = mergeUsage(usage, event.usage);
        } else {
          queue.push(event as StreamEvent<Output>);
        }
      }
  );

  return {
    events,
    get text(): string {
      return text;
    },
    get usage(): Usage | undefined {
      return usage;
    },
  };
}
