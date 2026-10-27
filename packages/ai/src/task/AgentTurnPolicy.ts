/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JsonSchema } from "@workglow/util/schema";
import type { AgentTurnBudget } from "./AgentTurnBudget";
import type { AgentStep, AgentSubmissionCheck, AgentToolRecord } from "./AgentTurnRecord";
import { AGENT_SUBMIT_TOOL_NAME } from "./AgentTurnRecord";
import type { ChatMessage, ContentBlockToolResult } from "./ChatMessage";
import type { ToolDefinition } from "./ToolCallingUtils";
import { ToolCallError } from "./ToolCallingUtils";

/**
 * Times a turn with an `outputSchema` reminds a model that replied in text to
 * submit instead. Some models narrate a final answer out of habit and submit
 * when told; one that still will not after this is not going to.
 */
const MAX_SUBMIT_REMINDERS = 2;

/**
 * Times a host's `checkSubmission` may turn an answer away. A check that keeps
 * objecting is either wrong or asking for what the filing does not hold, and
 * the turn must still end with the answer the model could give.
 */
export const MAX_SUBMISSION_REJECTIONS = 2;

const SUBMIT_REMINDER =
  `Call ${AGENT_SUBMIT_TOOL_NAME} with your final answer. ` +
  "An answer given as text is not recorded.";

/** The turn as a submission check sees it when the model submits. */
export interface AgentTurnSoFar {
  readonly messages: readonly ChatMessage[];
  readonly steps: readonly AgentStep[];
}

export interface AgentTurnPolicyOptions {
  readonly maxRounds: number;
  readonly outputSchema: JsonSchema | undefined;
  readonly checkSubmission: AgentSubmissionCheck | undefined;
  readonly reviewPrompt: string | undefined;
  readonly announceTimeLeft: boolean;
  /** Read when the model submits, so a check sees the turn as it stands then. */
  readonly turnSoFar: () => AgentTurnSoFar;
}

/**
 * What follows a round in which the model answered without a tool: another
 * message to it, or the end of the turn and how it is reported.
 */
export type AgentFollowUp =
  | { readonly kind: "send"; readonly message: ChatMessage }
  | { readonly kind: "end"; readonly stopReason: "answered" | "budget" };

/** The time a turn has left, as the model is shown it: whole seconds, rounded down. */
export function timeLeftNotice(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `\n\n[Time left: ${minutes > 0 ? `${minutes}m ` : ""}${total % 60}s]`;
}

/**
 * What a turn says to its model besides the caller's prompt, and when it ends
 * on the model's word rather than the loop's.
 *
 * - **Submission.** Given an `outputSchema`, the turn gains a submit tool whose
 *   arguments are the answer, checked against that schema like any tool's, and
 *   then by the host's `checkSubmission` (at most
 *   {@link MAX_SUBMISSION_REJECTIONS} times). A model that replies in text
 *   instead is reminded to submit, twice.
 * - **Review.** `reviewPrompt` is sent once, the first time the model replies
 *   without a tool, so it checks its work before the turn ends.
 * - **Time left.** `announceTimeLeft` appends the time left to each round's
 *   last tool result.
 */
export class AgentTurnPolicy {
  /** The tool the turn finishes with, when it has an `outputSchema`. */
  public readonly submitTool: ToolDefinition | undefined;
  /** Each reason `checkSubmission` gave for sending an answer back, in order. */
  public readonly submissionRejections: string[] = [];
  private readonly options: AgentTurnPolicyOptions;
  private answer: { readonly value: unknown } | undefined;
  /** The submission still being checked; the next waits for it. */
  private submitting: Promise<unknown> = Promise.resolve();
  private reminders = 0;
  private reviewed = false;

  constructor(options: AgentTurnPolicyOptions) {
    this.options = options;
    this.submitTool = submitToolFor(options.outputSchema, (value) => this.submit(value));
  }

  /** The answer the model submitted and the check accepted; undefined until then. */
  public get submitted(): { readonly value: unknown } | undefined {
    return this.answer;
  }

  /**
   * After a round with no tool call: the user message to send before another
   * round, or how the turn ends.
   *
   * The model has answered, so the turn ends `"answered"` unless it still owes
   * a submission the budget or the clock will not let it be asked for. On the
   * last round no reminder is sent and the turn ends `"answered"`, as it does
   * once the reminders are spent. A review is optional,
   * so it is skipped, and the answer stands, on a turn with an `outputSchema`
   * (that is `checkSubmission`'s job), with no round or time left, or once the
   * loop would stop on its budget — a round it could not measure included. A
   * reminder is the only way a typed turn gets its answer, so a round it could
   * not measure does not withhold one: there are at most two, and a provider
   * that reports no usage would otherwise never be reminded at all.
   */
  public followUp(round: number, budget: AgentTurnBudget): AgentFollowUp {
    const { reviewPrompt, maxRounds } = this.options;
    if (
      reviewPrompt &&
      !this.reviewed &&
      this.submitTool === undefined &&
      round + 1 < maxRounds &&
      !budget.mustStopLoop() &&
      !budget.timeExhausted()
    ) {
      this.reviewed = true;
      return send(reviewPrompt);
    }
    if (this.submitTool !== undefined && this.reminders < MAX_SUBMIT_REMINDERS) {
      // A reminder is a question that needs a round to be answered in. With no
      // round left the model has given its last reply, so the turn ends on it;
      // with no time left the loop would stop on its budget before asking.
      // Either way none is appended, so the transcript never ends in a message
      // the model did not see.
      if (round + 1 >= maxRounds) return { kind: "end", stopReason: "answered" };
      if (budget.exhausted() || budget.timeExhausted()) {
        return { kind: "end", stopReason: "budget" };
      }
      this.reminders++;
      return send(SUBMIT_REMINDER);
    }
    return { kind: "end", stopReason: "answered" };
  }

  /**
   * Appends the time left to the last of a round's results, when the turn
   * announces it, and counts the notice in that call's record, which counts
   * what the model is shown. Results and records are updated in place.
   */
  public announceTimeLeft(
    results: ContentBlockToolResult[],
    records: AgentToolRecord[],
    deadline: number | undefined,
    now: number = Date.now()
  ): void {
    // On the last result rather than in a message of its own: a tool message
    // holds only tool results, and the tail of the transcript is the one place
    // a changing line costs no prompt cache.
    if (!this.options.announceTimeLeft || deadline === undefined || results.length === 0) return;
    const last = results[results.length - 1]!;
    const notice = timeLeftNotice(deadline - now);
    // Joined onto the last text block, not added as a second one: a result of
    // one text block stays one, which providers send as a plain string (or
    // parse as a whole) and a second block would turn into a list of parts.
    // A result of images alone has no text to join, so the notice leads them.
    const content = [...last.content];
    const at = content.findLastIndex((block) => block.type === "text");
    const block = content[at];
    if (block?.type === "text") content[at] = { ...block, text: block.text + notice };
    else content.unshift({ type: "text", text: notice });
    results[results.length - 1] = { ...last, content };
    const recordAt = records.findIndex((r) => r.id === last.tool_use_id);
    if (recordAt !== -1) {
      const counted = records[recordAt]!;
      records[recordAt] = { ...counted, chars: counted.chars + notice.length };
    }
  }

  /**
   * A reason to send the answer back to the model, or undefined once it is
   * recorded. Submissions are checked one at a time, in the order they were
   * called: under `toolConcurrency` two calls in one round would otherwise read
   * the same rejection count, so the cap on rejections could be passed, and
   * the answer recorded would be whichever check happened to settle last.
   */
  private submit(value: unknown): Promise<string | undefined> {
    const checked = this.submitting.then(() => this.checkAndRecord(value));
    this.submitting = checked.catch(() => undefined);
    return checked;
  }

  private async checkAndRecord(value: unknown): Promise<string | undefined> {
    const { checkSubmission } = this.options;
    if (
      checkSubmission !== undefined &&
      this.submissionRejections.length < MAX_SUBMISSION_REJECTIONS
    ) {
      const reason = await checkSubmission(value, {
        ...this.options.turnSoFar(),
        rejections: this.submissionRejections.length,
      });
      if (reason !== undefined && reason.trim() !== "") {
        this.submissionRejections.push(reason);
        return reason;
      }
    }
    this.answer = { value };
    return undefined;
  }
}

function send(text: string): AgentFollowUp {
  return { kind: "send", message: { role: "user", content: [{ type: "text", text }] } };
}

/**
 * The tool a turn with an `outputSchema` finishes with: its arguments are the
 * answer, checked against that schema like any tool's arguments, so a failing
 * answer comes back to the model as an error it can correct.
 */
function submitToolFor(
  outputSchema: JsonSchema | undefined,
  onSubmit: (value: unknown) => Promise<string | undefined>
): ToolDefinition | undefined {
  // The runner fills an object port the caller left unset with `{}`, and an
  // empty schema constrains nothing: a submit tool built from one would accept
  // any arguments at all, so it counts as no schema.
  if (
    outputSchema === undefined ||
    (typeof outputSchema === "object" && Object.keys(outputSchema).length === 0)
  ) {
    return undefined;
  }
  return {
    name: AGENT_SUBMIT_TOOL_NAME,
    description:
      "Submit your final answer. It is checked against the required schema: if it is rejected, fix what the error names and call this again.",
    inputSchema: outputSchema,
    // Recording an answer reaches nothing beyond the turn itself.
    requiresApproval: false,
    execute: async (input) => {
      const reason = await onSubmit(input);
      // Thrown as the tool's own words: the model reads the reason itself, not
      // a wrapped error, and answers it in its next round.
      if (reason !== undefined) {
        // The whole answer again, not a patch: a model resubmitting only what the
        // reason named drops every section it had already filled.
        throw new ToolCallError(
          `Answer not recorded yet. ${reason} Then call submit_answer again with the complete ` +
            "answer — every field, including those this does not mention, as you had them."
        );
      }
      return "Answer recorded.";
    },
  };
}
