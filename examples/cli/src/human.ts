/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The CLI's human-in-the-loop surface, on its own entry so a conformance suite
 * can reach the two connectors without loading the command tree behind
 * {@link ../lib.ts}.
 */

export { getCliHumanInteractionEnqueue, setCliHumanInteractionEnqueue } from "./cliHumanBridge";
export type { CliHumanInteractionEnqueue } from "./cliHumanBridge";
export { RunEventHumanConnector } from "./run-events/RunEventHumanConnector";
export type { AnswerReaderFactory } from "./run-events/RunEventHumanConnector";
export type { RunEvent } from "./run-events/RunEventTypes";
export type { RunEventSink } from "./run-events/runEventChannel";
export { InkHumanConnector } from "./ui/InkHumanConnector";
export { PromptHumanConnector } from "./ui/PromptHumanConnector";
export type { PromptHumanRenderers } from "./ui/PromptHumanConnector";
// Re-exported, not defined here. `humanPromptModel` is a pure function over a
// request, and it shipped from a package whose dependencies include ink, react,
// commander, a keyring binding and two model runtimes — which a browser app
// will not install to get one hundred lines. It lives in `@workglow/util` now,
// beside the interface it decides the rendering for; this stays so existing
// callers are unchanged.
export { humanPromptModel } from "@workglow/util";
export type {
  HumanPromptDetail,
  HumanPromptModel,
  HumanPromptShape,
  HumanPromptSource,
} from "@workglow/util";
export { emptyRunView, reduceRunEvent } from "./web/client/state";
export type { RunViewState } from "./web/client/state";
