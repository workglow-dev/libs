/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IHumanConnector, IHumanRequest, IHumanResponse } from "@workglow/util";
import { prepareSchemaFormFields, type PromptFieldDescriptor } from "../input/prompt";
import { asDataPortSchemaObject } from "./humanSchema";
import { humanPromptModel } from "./model/humanPrompt";
import { renderSchemaPrompt, renderSelectPrompt } from "./render";

/**
 * The prompts this connector draws, injectable so the mapping can be exercised
 * without a terminal — and so a host with its own prompt stack can supply it.
 */
export interface PromptHumanRenderers {
  readonly select: (
    options: ReadonlyArray<{ label: string; value: string }>,
    message: string | undefined,
    signal: AbortSignal
  ) => Promise<string | undefined>;
  readonly form: (
    fields: readonly PromptFieldDescriptor[],
    signal: AbortSignal
  ) => Promise<Record<string, unknown> | undefined>;
  readonly notice: (lines: readonly string[]) => void;
}

const defaultRenderers: PromptHumanRenderers = {
  select: (options, message, signal) => renderSelectPrompt([...options], message, signal),
  form: (fields, signal) => renderSchemaPrompt(fields, undefined, signal),
  notice: (lines) => {
    for (const line of lines) console.log(line);
  },
};

/**
 * Rejects when `signal` aborts, so a pending prompt does not outlive the run
 * that asked the question.
 *
 * The renderer is handed the same signal and tears its own app down, but the
 * rejection is raised here rather than left to it: `IHumanConnector` requires
 * an aborted `send` to reject, and a renderer that resolves `undefined` on
 * abort would be indistinguishable from a person pressing Esc — which is a
 * `cancel` a caller may act on.
 */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void =>
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = whenAborted(signal);
  // Held so the loser of the race is not reported as an unhandled rejection.
  aborted.catch(() => {});
  return await Promise.race([work, aborted]);
}

/** Labels for the two decisions an approval offers, in the order it offers them. */
const APPROVAL_OPTIONS = [
  { label: "Approve", value: "accept" },
  { label: "Decline", value: "decline" },
] as const;

/**
 * The terminal connector for anything that is NOT inside the Ink run UI.
 *
 * {@link InkHumanConnector} hands a request to a mounted
 * {@link HumanInteractionHost} and throws when there is none — right for a
 * command whose whole life is one graph run, and useless to anything that
 * prompts between runs rather than during one. This draws its own prompt for
 * the length of the question and takes the screen back afterwards, so a
 * transcript printed around it survives.
 *
 * What each request is asking is decided by {@link humanPromptModel}, the same
 * function the Ink panel and the web console read, so the three cannot disagree
 * about whether something is a form or an approval — the case that matters,
 * since a confirm drawn as a form leaves a person no way to say no.
 *
 * There is deliberately no `followUp`: a modal prompt settles the question it
 * asked, so no response is ever `done: false` and there is no partial answer for
 * a follow-up to continue. Declaring one that just asked again would report a
 * multi-turn conversation this surface cannot hold.
 */
export class PromptHumanConnector implements IHumanConnector {
  private readonly renderers: PromptHumanRenderers;

  constructor(renderers: PromptHumanRenderers = defaultRenderers) {
    this.renderers = renderers;
  }

  async send(request: IHumanRequest, signal: AbortSignal): Promise<IHumanResponse> {
    signal.throwIfAborted();
    const model = humanPromptModel({
      kind: request.kind,
      message: request.message,
      schema: request.contentSchema,
      data: request.contentData,
    });
    const settle = (
      action: IHumanResponse["action"],
      content?: Record<string, unknown>
    ): IHumanResponse => ({
      requestId: request.requestId,
      action,
      content: action === "accept" && model.carriesContent ? content : undefined,
      done: true,
    });

    if (model.shape === "acknowledge") {
      this.renderers.notice([
        `${model.title}: ${model.message}`,
        ...model.details.map((detail) => `  ${detail.label}: ${detail.value}`),
      ]);
      return settle("accept");
    }

    if (model.shape === "approval") {
      // Printed rather than offered as fields: the schema of a confirm
      // describes the action awaiting approval, and drawing it as a form would
      // turn a description into something to edit.
      this.renderers.notice([
        model.title,
        ...model.details.map((detail) => `  ${detail.label}: ${detail.value}`),
      ]);
      const chosen = await untilAborted(
        this.renderers.select(APPROVAL_OPTIONS, model.message, signal),
        signal
      );
      // Walking away is not the same answer as refusing, and the caller acts
      // differently on each.
      if (chosen === undefined) return settle("cancel");
      return settle(chosen === "decline" ? "decline" : "accept");
    }

    const schema = asDataPortSchemaObject(request.contentSchema);
    const fields = await prepareSchemaFormFields(
      (request.contentData as Record<string, unknown> | undefined) ?? {},
      schema
    );
    const values = await untilAborted(this.renderers.form(fields, signal), signal);
    if (values === undefined) return settle("cancel");
    return settle("accept", values);
  }
}
