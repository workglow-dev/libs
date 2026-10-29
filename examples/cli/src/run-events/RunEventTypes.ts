/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RunState } from "../ui/model/runRowModel";

/**
 * One line of a run's event stream. Keys are short because a chatty run emits
 * thousands of these and every byte crosses a pipe.
 */
export type RunEvent =
  | { readonly k: "run_start"; readonly cli: string; readonly at: number }
  | {
      readonly k: "task_added";
      readonly id: string;
      readonly type: string;
      readonly label: string;
      readonly depth: number;
      /**
       * Row that owns this one, when it is not a root. Depth alone cannot place
       * a row: a subgraph's children arrive long after their parent's siblings,
       * so arrival order attributes them to whichever root happens to precede
       * them. The id says which parent, whenever the run has one.
       */
      readonly parent?: string;
    }
  | { readonly k: "task_removed"; readonly id: string }
  | { readonly k: "status"; readonly id: string; readonly status: string }
  | {
      readonly k: "progress";
      readonly id: string;
      readonly progress: number | undefined;
      readonly message?: string;
    }
  | {
      readonly k: "usage";
      readonly id: string;
      readonly input: number | undefined;
      readonly output: number | undefined;
      readonly cached: number | undefined;
      readonly modelId: string | undefined;
    }
  | { readonly k: "graph_progress"; readonly progress: number | undefined }
  | {
      readonly k: "graph_usage";
      readonly input: number | undefined;
      readonly output: number | undefined;
      readonly cached: number | undefined;
    }
  | {
      readonly k: "iteration";
      readonly id: string;
      readonly index: number;
      readonly count: number;
      readonly phase: "start" | "progress" | "complete";
      readonly progress?: number;
      readonly message?: string;
    }
  | { readonly k: "text"; readonly id: string; readonly delta: string }
  /** A model's thinking, streamed beside its answer; never folded into `text`. */
  | { readonly k: "reasoning"; readonly id: string; readonly delta: string }
  /**
   * Takes back the last `length` characters of a row's `text` or `reasoning`:
   * a model call that streamed and then failed, retracted before its retry.
   */
  | {
      readonly k: "retract";
      readonly id: string;
      readonly port: "text" | "reasoning";
      readonly length: number;
    }
  | { readonly k: "messages"; readonly id: string; readonly messages: unknown }
  | {
      readonly k: "human_request";
      readonly requestId: string;
      readonly kind: string;
      readonly message: string;
      readonly schema: unknown;
      readonly data: unknown;
    }
  | { readonly k: "log"; readonly level: "info" | "warn" | "error"; readonly text: string }
  /**
   * One graph finished and produced this. NOT the end of the run: a single
   * command routinely runs several graphs in sequence (`sync lists` rebuilds
   * six tables, `sync all` walks every leaf), and treating the first one's
   * completion as the run's end stopped the console watching after it.
   */
  | { readonly k: "result"; readonly output: unknown }
  | {
      readonly k: "run_end";
      readonly state: RunState;
      readonly error: string | undefined;
      readonly output: unknown;
    };

export type RunEventKind = RunEvent["k"];
