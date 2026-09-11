/** @jsxImportSource preact */
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { ChatEntry } from "../state";

/**
 * A conversation, and the box to add to it.
 *
 * The run asks for each message the same way it asks for anything else, so this
 * is a rendering of a human request rather than a channel of its own — what
 * makes it a conversation rather than a form is that the answers stay on
 * screen underneath the question.
 */
export function ChatTranscript({
  entries,
  message,
  canAnswer,
  onSend,
  onEnd,
}: {
  readonly entries: readonly ChatEntry[];
  /** What the run called the thing it is asking for. */
  readonly message: string;
  /** False while the CLI is not answering; the run cannot receive a reply. */
  readonly canAnswer: boolean;
  readonly onSend: (text: string) => void;
  readonly onEnd: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const send = (): void => {
    if (!canAnswer || trimmed.length === 0) return;
    setDraft("");
    onSend(trimmed);
  };

  return (
    <div className="wrap">
      <div className="card" style="border-color:var(--accent)">
        {entries.length === 0 ? (
          <div className="fl" style="opacity:.7">
            Nothing said yet.
          </div>
        ) : (
          entries.map((entry, index) => (
            <div key={index} className="field">
              <div className="fl">
                <b>{entry.role === "user" ? "You" : "Agent"}</b>
                {entry.pending ? <span style="opacity:.6"> · still writing</span> : null}
              </div>
              <div className="txt" style="white-space:pre-wrap">
                {entry.text}
              </div>
            </div>
          ))
        )}
        <div className="field">
          <div className="fl">{message}</div>
          <textarea
            rows={3}
            value={draft}
            disabled={!canAnswer}
            title={canAnswer ? undefined : "the CLI is not responding"}
            onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line: a chat box where
              // Enter inserts a newline is one nobody can send from.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
        </div>
        <div className="row">
          <button type="button" disabled={!canAnswer || trimmed.length === 0} onClick={send}>
            Send
          </button>
          <button type="button" disabled={!canAnswer} onClick={onEnd}>
            End session
          </button>
        </div>
      </div>
    </div>
  );
}
