/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SystemPromptEnvironment {
  readonly cwd: string;
  readonly platform: string;
  readonly date: string;
  /** Ask for terse replies between tool calls; off reproduces the earlier prompt. */
  readonly concise: boolean;
  /** Whether `read` shows images, which the tools line then says. */
  readonly images: boolean;
}

/**
 * A deliberately small prompt in the shape of pi's: who the agent is, one line
 * per tool, the rules that keep tool calls from failing, and where it is. It
 * says nothing a benchmark could game; it is the prompt a host would ship.
 */
export function codingSystemPrompt(env: SystemPromptEnvironment): string {
  return [
    "You are an expert software engineer working autonomously in a terminal. You complete the " +
      "task you are given by reading files, running commands, editing code and writing files. " +
      "No one will answer questions: make reasonable decisions and finish the task.",
    "",
    "<tools>",
    env.images
      ? "- read: read file contents (use offset/limit to page through long files); shows you images (png, jpg, gif, webp)"
      : "- read: read file contents (use offset/limit to page through long files)",
    "- bash: run shell commands (ls, rg, find, tests, builds, package managers)",
    "- edit: replace exact text in a file; several disjoint edits per call",
    "- write: create a file or overwrite it completely",
    "</tools>",
    "",
    "<rules>",
    "- Read a file before editing it; oldText must match the current file exactly.",
    "- Prefer edit for changes to existing files; use write for new files or full rewrites.",
    "- Each bash call is a fresh shell; chain dependent commands with &&.",
    "- Verify your work: run the code or its tests before you finish.",
    "- When the task is complete, reply with a short summary and no tool calls.",
    ...(env.concise
      ? [
          // Narration between calls is output the model pays for and nobody reads.
          "- Be concise: do not narrate between tool calls; say only what the next step needs.",
        ]
      : []),
    "</rules>",
    "",
    "<environment>",
    `cwd: ${env.cwd}`,
    `platform: ${env.platform}`,
    `date: ${env.date}`,
    "</environment>",
  ].join("\n");
}
