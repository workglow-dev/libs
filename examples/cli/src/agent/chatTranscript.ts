/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where a chat turn is written, and the one thing that is easy to get wrong
 * about it: a model's text arrives as deltas that rarely end on a line break,
 * and everything else the turn prints — a tool line, an approval, the next
 * prompt — has to start at column 0 or it lands in the middle of a sentence.
 *
 * Kept apart from the loop so the rule can be read, and tested, without a
 * terminal.
 */
export interface ChatTranscript {
  /** Model text, exactly as it arrived. */
  delta(text: string): void;
  /** A line about the run rather than from the model. */
  note(line: string): void;
  /** Close the turn, leaving the cursor at column 0. */
  endTurn(): void;
}

export function createChatTranscript(write: (text: string) => void): ChatTranscript {
  let atLineStart = true;
  const breakLine = (): void => {
    if (!atLineStart) {
      write("\n");
      atLineStart = true;
    }
  };
  return {
    delta(text) {
      if (text.length === 0) return;
      write(text);
      atLineStart = text.endsWith("\n");
    },
    note(line) {
      breakLine();
      write(`${line}\n`);
    },
    endTurn() {
      breakLine();
    },
  };
}
