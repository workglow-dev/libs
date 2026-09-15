/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IHumanConnector, IHumanRequest, IHumanResponse } from "@workglow/util";

/**
 * The connector for a process serving agents with nobody at the keyboard.
 *
 * A served agent's approvals have no person to reach: the peer is a program,
 * and a prompt drawn on this process's terminal would wait forever. Every
 * request is declined, in the same words each time, so the model reads a
 * refusal it can work around rather than a thrown error it cannot — and the
 * operator's log names which agent asked.
 */
export class HeadlessHumanConnector implements IHumanConnector {
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  public async send(request: IHumanRequest, _signal: AbortSignal): Promise<IHumanResponse> {
    return {
      requestId: request.requestId,
      action: "decline",
      content: { reason: this.reason },
      done: true,
    };
  }
}
