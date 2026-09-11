/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a typed line means before the model sees it.
 *
 * Only lines that are exactly a known command are one: a message beginning
 * "/exit is the command that..." is a message, and a model that never receives
 * it because of a prefix match is a chat that silently eats input.
 */
export type ChatLineIntent =
  | { readonly kind: "blank" }
  | { readonly kind: "quit" }
  | { readonly kind: "reset" }
  | { readonly kind: "help" }
  | { readonly kind: "unknown-command"; readonly typed: string }
  | { readonly kind: "message"; readonly text: string };

const COMMANDS: ReadonlyMap<string, ChatLineIntent["kind"]> = new Map([
  ["/exit", "quit"],
  ["/quit", "quit"],
  ["/reset", "reset"],
  ["/help", "help"],
]);

export function classifyChatLine(line: string): ChatLineIntent {
  const text = line.trim();
  if (text.length === 0) return { kind: "blank" };
  if (!text.startsWith("/")) return { kind: "message", text };
  const known = COMMANDS.get(text.toLowerCase());
  if (known === "quit") return { kind: "quit" };
  if (known === "reset") return { kind: "reset" };
  if (known === "help") return { kind: "help" };
  // A lone word starting with "/" is a mistyped command far more often than a
  // message; anything longer is prose that happens to open with a slash.
  if (/^\/\S*$/.test(text)) return { kind: "unknown-command", typed: text };
  return { kind: "message", text };
}

export const CHAT_HELP_LINES: readonly string[] = [
  "/exit, /quit   end the session",
  "/reset         forget the conversation so far",
  "/help          this list",
];
