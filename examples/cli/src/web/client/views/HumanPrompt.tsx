/** @jsxImportSource preact */
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HumanResponseAction } from "@workglow/util";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { humanPromptModel } from "@workglow/util";

interface SchemaLike {
  readonly properties?: Record<string, { type?: string; title?: string; format?: string }>;
  readonly required?: readonly string[];
}

/**
 * A run asking its operator something. The CLI renders this as an Ink panel; the
 * console renders the same model, and the answer travels back down the same
 * channel the request came up.
 */
export function HumanPrompt({
  request,
  onAnswer,
  canAnswer = true,
}: {
  request: {
    requestId: string;
    kind: string;
    message: string;
    schema: unknown;
    data: unknown;
  };
  onAnswer: (action: HumanResponseAction, content: Record<string, unknown> | undefined) => void;
  /** False while the CLI is not answering; the run cannot receive a reply. */
  canAnswer?: boolean;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const model = humanPromptModel(request);
  const schema = (request.schema ?? {}) as SchemaLike;
  const properties = model.shape === "form" ? Object.entries(schema.properties ?? {}) : [];
  const disabledTitle = canAnswer ? undefined : "the CLI is not responding";

  return (
    <div className="wrap">
      <div className="card" style="border-color:var(--accent)">
        <div className="field">
          <div className="fl">
            <b>{model.shape === "approval" ? "The run needs approval" : "The run is asking"}</b>
            <span>{model.message}</span>
          </div>
          <div className="fc">
            {/* An approval's values are read, never typed into. */}
            {model.details.map((detail) => (
              <div key={detail.label} style="margin-bottom:8px">
                <div className="cmd-d">{detail.label}</div>
                <div>{detail.value}</div>
              </div>
            ))}
            {properties.map(([key, property]) => (
              <div key={key} style="margin-bottom:8px">
                <div className="cmd-d">{property.title ?? key}</div>
                <input
                  type={property.format === "password" ? "password" : "text"}
                  value={values[key] ?? ""}
                  onInput={(event) =>
                    setValues({ ...values, [key]: (event.target as HTMLInputElement).value })
                  }
                />
              </div>
            ))}
            <div style="display:flex;gap:8px;margin-top:8px">
              {model.actions.includes("accept") ? (
                <button
                  className="btn primary"
                  onClick={() => onAnswer("accept", model.carriesContent ? values : undefined)}
                  disabled={!canAnswer}
                  title={disabledTitle}
                >
                  {model.shape === "approval" ? "Approve" : "Send"}
                </button>
              ) : null}
              {model.actions.includes("decline") ? (
                <button
                  className="btn"
                  onClick={() => onAnswer("decline", undefined)}
                  disabled={!canAnswer}
                  title={disabledTitle}
                >
                  Decline
                </button>
              ) : null}
              {model.actions.includes("cancel") ? (
                <button
                  className="btn"
                  onClick={() => onAnswer("cancel", undefined)}
                  disabled={!canAnswer}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
