/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiEmit, ChatMessage, ToolCallingTaskOutput, ToolDefinition } from "@workglow/ai";

/** One call in a {@link ScriptedReply}. */
export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * A model reply described without any vendor's shape. The harness writes it as
 * its vendor's stream — thinking blocks, reasoning items, `<think>` markup,
 * `reasoning_details` — including whatever that vendor attaches to make a turn
 * replayable (a signature, encrypted content), so the run-fn under test reads
 * exactly what the real API would send.
 */
export interface ScriptedReply {
  readonly reasoning?: string | undefined;
  readonly text?: string | undefined;
  readonly toolCalls?: ReadonlyArray<ScriptedToolCall> | undefined;
}

/** What the suite hands a harness to run, the harness adding its own model. */
export interface ToolTurnRequest {
  readonly prompt: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools: ReadonlyArray<ToolDefinition>;
}

/**
 * The tool-calling run-fn under test, wired to a transport that answers it
 * instead of the vendor. Intercepted at whatever the adapter really talks to —
 * an SDK client, `fetch`, a local pipeline — so the request it records is the
 * one the vendor would have received.
 */
export interface ToolTurnHarness {
  /** Queue the answer to the next request, written in the vendor's wire shape. */
  readonly respond: (reply: ScriptedReply) => void;
  /** Runs the tool-calling run-fn once over `request`, forwarding every event to `emit`. */
  readonly run: (request: ToolTurnRequest, emit: AiEmit<ToolCallingTaskOutput>) => Promise<void>;
  /** Every request the run-fn sent, oldest first, as the vendor would have received it. */
  readonly sent: () => ReadonlyArray<unknown>;
  /** Removes the interception. Called after every test. */
  readonly dispose: () => void | Promise<void>;
}

/** The roles a vendor's conversation turn is read as. */
export type WireRole = "system" | "user" | "assistant" | "tool";

/**
 * One conversation turn of a captured request: its vendor body, and which role
 * it plays. A turn answering a tool call is `"tool"` whatever the vendor calls
 * it — an Anthropic user message holding `tool_result` blocks, a Gemini content
 * holding `functionResponse` parts, a Responses `function_call_output` item.
 */
export interface WireTurn {
  readonly role: WireRole;
  readonly body: unknown;
}

/**
 * How a provider carries a turn's reasoning into the next round. Every
 * provider names one, so a provider that replays nothing says so with a reason
 * rather than by leaving a field out.
 */
export type ReasoningReplay =
  | {
      /**
       * The provider emits its own turn on `nativeTurn` and replays it verbatim
       * while the turn's calls still match.
       */
      readonly kind: "native";
      /** The `<vendor>` half of the `<vendor>:<model>` key. */
      readonly vendor: string;
      /** The API model name the harness runs, the `<model>` half of the key. */
      readonly model: string;
      /**
       * The part of a `nativeTurn` payload the vendor's wire carries, decoded:
       * Anthropic's content blocks, the Responses output items, OpenRouter's
       * `reasoning_details`. A replayed turn must contain it unchanged — as a
       * value somewhere in the request, or as a contiguous run of an array.
       */
      readonly wireForm: (payload: string) => unknown;
    }
  | {
      /** The provider sends the reasoning text back on the assistant turn. */
      readonly kind: "text";
    }
  | {
      /**
       * The provider sends back the opaque signature each tool call carried
       * (`providerSignature`), and the reasoning text not at all. The harness
       * signs each scripted call with a signature naming it.
       */
      readonly kind: "call-signature";
    }
  | {
      readonly kind: "none";
      /** Why this provider replays nothing. */
      readonly reason: string;
    };

/** Where an image a tool returned reaches the wire. */
export type ToolResultImages =
  | {
      /** Inside the tool result itself: Anthropic, Gemini 3+ `functionResponse.parts`. */
      readonly kind: "in-result";
    }
  | {
      /**
       * In a user turn right after the tool results, the results carrying text
       * only: OpenAI, xAI, OpenRouter, HF Inference, Ollama, older Gemini.
       */
      readonly kind: "user-turn-after";
    }
  | {
      /** The model reads no images, so none may reach the wire. */
      readonly kind: "text-only";
      readonly reason: string;
    };

export interface ToolTurnConformanceOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout?: number;
  /**
   * A fresh harness per test. A run-fn that cached a client in one test would
   * otherwise answer the next one's assertions about what it sent.
   */
  readonly createHarness: () => ToolTurnHarness | Promise<ToolTurnHarness>;
  /** Splits a captured request into its conversation turns, in order. */
  readonly turns: (request: unknown) => ReadonlyArray<WireTurn>;
  /**
   * Whether the reasoning the vendor streams reaches the `reasoning` port. A
   * string is the reason it does not; reasoning must stay off `text` either way.
   */
  readonly reasoningStream: "reasoning-port" | { readonly notForwarded: string };
  readonly reasoningReplay: ReasoningReplay;
  readonly toolResultImages: ToolResultImages;
  /**
   * Names of assertions currently broken in this adapter, each run as an
   * expected failure until the adapter is fixed:
   *   "reasoning.port", "native.emit", "native.replay", "native.rebuild",
   *   "reasoning.replay", "toolResult.image", "toolResult.empty"
   */
  readonly expectedFailures?: ReadonlyArray<string>;
}
