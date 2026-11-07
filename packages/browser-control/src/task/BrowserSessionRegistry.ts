/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskInvalidInputError } from "@workglow/task-graph";
import { uuid4 } from "@workglow/util";
import type { IBrowserContext } from "./IBrowserContext";

const sessions = new Map<string, IBrowserContext>();

export const BrowserSessionRegistry = {
  register(context: IBrowserContext): string {
    const id = uuid4();
    sessions.set(id, context);
    return id;
  },

  /** Throws if the session does not exist or has been disconnected. */
  get(sessionId: string): IBrowserContext {
    const context = sessions.get(sessionId);
    if (!context) {
      throw new TaskInvalidInputError(
        `BrowserSessionRegistry: no session found for id "${sessionId}"`
      );
    }
    if (!context.isConnected()) {
      sessions.delete(sessionId);
      throw new TaskInvalidInputError(
        `BrowserSessionRegistry: session "${sessionId}" is no longer connected`
      );
    }
    return context;
  },

  unregister(sessionId: string): void {
    sessions.delete(sessionId);
  },

  has(sessionId: string): boolean {
    return sessions.has(sessionId);
  },

  async disconnectAll(): Promise<void> {
    const disconnects = Array.from(sessions.values()).map((ctx) => ctx.disconnect());
    await Promise.allSettled(disconnects);
    sessions.clear();
  },

  /** Clear all sessions without disconnecting (for tests). */
  clear(): void {
    sessions.clear();
  },
} as const;
