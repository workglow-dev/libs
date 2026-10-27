/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WireTurn } from "@workglow/test-contract/ai-provider";

const CALL_LABEL = "Tool call: ";
const RESULT_LABEL = /^Tool (?:result|error) from /;

/**
 * The turns of a prompt that carries its tool exchange as prose, the way a
 * runtime with no frame for a call or its result has to (Chrome's Prompt API,
 * Cactus's single-query engine): the user's text, then one paragraph per call
 * (`Tool call: name(args)`) and per result (`Tool result from name: …`), with
 * any assistant text between them.
 *
 * The roles are read off those labels — the same labels the model reads them
 * off — so a result the prompt does not attribute to its call is not a tool
 * turn here either.
 */
export function proseToolExchangeTurns(text: string): WireTurn[] {
  const turns: WireTurn[] = [];
  const lead: string[] = [];
  let inExchange = false;
  for (const paragraph of text.split("\n\n")) {
    if (paragraph.startsWith(CALL_LABEL)) {
      inExchange = true;
      turns.push({ role: "assistant", body: paragraph });
    } else if (RESULT_LABEL.test(paragraph)) {
      inExchange = true;
      turns.push({ role: "tool", body: paragraph });
    } else if (inExchange) {
      turns.push({ role: "assistant", body: paragraph });
    } else {
      lead.push(paragraph);
    }
  }
  return lead.length > 0 ? [{ role: "user", body: lead.join("\n\n") }, ...turns] : turns;
}
