/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskAbortedError } from "@workglow/task-graph";
import { afterEach, describe, expect, it } from "vitest";
import { installRunSignalAbort, isAbortError, runFailureExitCode } from "../run-signal-abort";

const uninstalls: Array<() => void> = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
});

function emit(signal: "SIGINT" | "SIGTERM"): void {
  process.emit(signal);
}

describe("installRunSignalAbort", () => {
  it("calls abort on SIGINT and does not exit", () => {
    const exits: number[] = [];
    let aborted = 0;
    uninstalls.push(
      installRunSignalAbort({
        abort: () => {
          aborted += 1;
        },
        exit: (code) => {
          exits.push(code);
        },
      })
    );

    emit("SIGINT");

    expect(aborted).toBe(1);
    expect(exits).toEqual([]);
  });

  it("calls abort on SIGTERM and does not exit", () => {
    const exits: number[] = [];
    let aborted = 0;
    uninstalls.push(
      installRunSignalAbort({
        abort: () => {
          aborted += 1;
        },
        exit: (code) => {
          exits.push(code);
        },
      })
    );

    emit("SIGTERM");

    expect(aborted).toBe(1);
    expect(exits).toEqual([]);
  });

  it("force-exits 130 on a second SIGINT", () => {
    const exits: number[] = [];
    uninstalls.push(
      installRunSignalAbort({
        abort: () => {},
        exit: (code) => {
          exits.push(code);
        },
      })
    );

    emit("SIGINT");
    emit("SIGINT");

    expect(exits).toEqual([130]);
  });

  it("force-exits 143 on a second SIGTERM", () => {
    const exits: number[] = [];
    uninstalls.push(
      installRunSignalAbort({
        abort: () => {},
        exit: (code) => {
          exits.push(code);
        },
      })
    );

    emit("SIGTERM");
    emit("SIGTERM");

    expect(exits).toEqual([143]);
  });

  it("force-exits for the second signal even when the two differ", () => {
    const exits: number[] = [];
    let aborted = 0;
    uninstalls.push(
      installRunSignalAbort({
        abort: () => {
          aborted += 1;
        },
        exit: (code) => {
          exits.push(code);
        },
      })
    );

    emit("SIGINT");
    emit("SIGTERM");

    expect(aborted).toBe(1);
    expect(exits).toEqual([143]);
  });

  it("detach stops listening so a later SIGINT is not handled", () => {
    let aborted = 0;
    const detach = installRunSignalAbort({
      abort: () => {
        aborted += 1;
      },
      exit: () => {},
    });
    detach();

    emit("SIGINT");
    emit("SIGTERM");

    expect(aborted).toBe(0);
  });
});

describe("isAbortError", () => {
  it("recognizes TaskAbortedError and abort-named Errors", () => {
    expect(isAbortError(new TaskAbortedError())).toBe(true);
    const named = new Error("stopped");
    named.name = "AbortError";
    expect(isAbortError(named)).toBe(true);
    expect(isAbortError(new Error("The operation was aborted"))).toBe(true);
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError("abort")).toBe(false);
  });

  it("maps abort to exit 130 and other failures to 1", () => {
    expect(runFailureExitCode(new TaskAbortedError())).toBe(130);
    expect(runFailureExitCode(new Error("boom"))).toBe(1);
  });
});
