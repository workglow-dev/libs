/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ListTasksRequest, ListTasksResponse, Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";

/** How many tasks are kept unless the host says otherwise. */
export const DEFAULT_MAX_TASKS = 1000;

/** How many tasks one page of `list` returns when the caller names no size. */
const DEFAULT_PAGE_SIZE = 50;

export interface BoundedTaskStoreOptions {
  readonly maxTasks?: number;
}

function timestampOf(task: Task): string {
  return task.status?.timestamp ?? "";
}

function encodeCursor(task: Task): string {
  return Buffer.from(`${timestampOf(task)}|${task.id}`, "utf8").toString("base64");
}

/**
 * A task store that forgets.
 *
 * `TaskStore` has `save`, `load` and `list` and no delete, and the SDK's
 * in-memory store keeps every task for the life of the process — each one
 * holding its whole history and its answer. A server meant to stay up cannot
 * afford that, so this one keeps the `maxTasks` most recently touched and
 * drops the rest. A task in flight is touched on every event and so is never
 * the one dropped.
 *
 * One principal per server: the SDK's store scopes by caller, and this does
 * not, because every peer here presents the same token or none.
 */
export class BoundedTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly maxTasks: number;

  constructor(options: BoundedTaskStoreOptions = {}) {
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  }

  public get size(): number {
    return this.tasks.size;
  }

  public async load(taskId: string, _context: ServerCallContext): Promise<Task | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    // Re-inserting moves it to the young end of the map's insertion order.
    this.tasks.delete(taskId);
    this.tasks.set(taskId, task);
    return structuredClone(task);
  }

  public async save(task: Task, _context: ServerCallContext): Promise<void> {
    this.tasks.delete(task.id);
    this.tasks.set(task.id, structuredClone(task));
    while (this.tasks.size > this.maxTasks) {
      const oldest = this.tasks.keys().next().value;
      if (oldest === undefined) break;
      this.tasks.delete(oldest);
    }
  }

  public async list(
    params: ListTasksRequest,
    _context: ServerCallContext
  ): Promise<ListTasksResponse> {
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    let tasks = [...this.tasks.values()];
    if (params.contextId) tasks = tasks.filter((task) => task.contextId === params.contextId);
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      tasks = tasks.filter((task) => task.status?.state === params.status);
    }
    if (params.statusTimestampAfter) {
      const after = new Date(params.statusTimestampAfter).getTime();
      tasks = tasks.filter((task) => new Date(timestampOf(task)).getTime() > after);
    }
    // Newest first, as the SDK's own store orders them.
    tasks.sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)) || b.id.localeCompare(a.id));
    const totalSize = tasks.length;
    if (params.pageToken) {
      const index = tasks.findIndex((task) => encodeCursor(task) === params.pageToken);
      tasks = index === -1 ? [] : tasks.slice(index + 1);
    }
    const page = tasks.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      tasks: page.map((task) => {
        const copy = structuredClone(task);
        if (!params.includeArtifacts) copy.artifacts = [];
        return copy;
      }),
      nextPageToken: last !== undefined && tasks.length > page.length ? encodeCursor(last) : "",
      pageSize,
      totalSize,
    };
  }
}
