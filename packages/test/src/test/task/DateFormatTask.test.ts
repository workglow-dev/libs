/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskInvalidInputError, TaskStatus } from "@workglow/task-graph";
import { DateFormatTask } from "@workglow/tasks";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { beforeEach, describe, expect, it } from "vitest";

describe("DateFormatTask", () => {
  const logger = getTestingLogger();
  setLogger(logger);
  let task: DateFormatTask;

  beforeEach(() => {
    task = new DateFormatTask({ id: "dateformat-test" });
  });

  it("should have correct static properties", () => {
    expect(DateFormatTask.type).toBe("DateFormatTask");
    expect(DateFormatTask.category).toBe("Utility");
  });

  it("should format as ISO string by default", async () => {
    const result = await task.run({ value: "2025-01-15T12:00:00.000Z" });
    expect(result.result).toBe("2025-01-15T12:00:00.000Z");
  });

  it("should format as ISO string explicitly", async () => {
    const result = await task.run({
      value: "2025-01-15T12:00:00.000Z",
      format: "iso",
    });
    expect(result.result).toBe("2025-01-15T12:00:00.000Z");
  });

  it("should format as unix timestamp", async () => {
    const result = await task.run({
      value: "2025-01-15T12:00:00.000Z",
      format: "unix",
    });
    const expected = String(new Date("2025-01-15T12:00:00.000Z").getTime());
    expect(result.result).toBe(expected);
  });

  it("should format as date string", async () => {
    const result = await task.run({
      value: "2025-01-15T12:00:00.000Z",
      format: "date",
      locale: "en-US",
      timeZone: "UTC",
    });
    expect(result.result).toBeTruthy();
    expect(typeof result.result).toBe("string");
  });

  it("should format as time string", async () => {
    const result = await task.run({
      value: "2025-01-15T12:00:00.000Z",
      format: "time",
      locale: "en-US",
      timeZone: "UTC",
    });
    expect(result.result).toBeTruthy();
    expect(typeof result.result).toBe("string");
  });

  it("should format as datetime string", async () => {
    const result = await task.run({
      value: "2025-01-15T12:00:00.000Z",
      format: "datetime",
      locale: "en-US",
      timeZone: "UTC",
    });
    expect(result.result).toBeTruthy();
    expect(typeof result.result).toBe("string");
  });

  it("should parse numeric timestamp string", async () => {
    const ts = String(new Date("2025-06-01T00:00:00.000Z").getTime());
    const result = await task.run({ value: ts, format: "iso" });
    expect(result.result).toBe("2025-06-01T00:00:00.000Z");
  });

  it("should throw for invalid date", async () => {
    await expect(task.run({ value: "not-a-date" })).rejects.toThrow("Invalid date");
  });

  it("should complete with COMPLETED status on success", async () => {
    await task.run({ value: "2025-01-01" });
    expect(task.status).toBe(TaskStatus.COMPLETED);
  });

  it("refuses an unknown time zone or locale as invalid input, naming it", async () => {
    const value = "2024-01-02T03:04:05Z";
    for (const extra of [{ timeZone: "Mars/Olympus" }, { locale: "not a locale!!" }]) {
      const run = new DateFormatTask().run({ value, format: "datetime", ...extra });
      await expect(run).rejects.toBeInstanceOf(TaskInvalidInputError);
      await expect(run).rejects.toThrow(Object.values(extra)[0]);
    }
  });
});
