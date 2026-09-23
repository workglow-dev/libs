/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskAbortedError, TaskGraphTimeoutError, TaskTimeoutError } from "@workglow/task-graph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installRunSignalAbort,
  isAbortError,
  isSignalCancellation,
  resetRunSignalAbortForTesting,
  runAbortedBySignal,
  runFailureExitCode,
} from "../run-signal-abort";

const uninstalls: Array<() => void> = [];

beforeEach(() => {
  resetRunSignalAbortForTesting();
});

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  resetRunSignalAbortForTesting();
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
  it("recognizes TaskAbortedError and AbortError-named errors", () => {
    expect(isAbortError(new TaskAbortedError())).toBe(true);
    const named = new Error("stopped");
    named.name = "AbortError";
    expect(isAbortError(named)).toBe(true);
    expect(isAbortError(new DOMException("stopped", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError("abort")).toBe(false);
  });

  // A timeout is a failure with a message worth printing, and both timeout
  // classes extend TaskAbortedError. A failure that merely says "aborted" —
  // a fetch, a job — is an ordinary failure too: the class decides, not the text.
  it("does not treat a timeout or an abort-worded failure as cancellation", () => {
    expect(isAbortError(new TaskTimeoutError(5000))).toBe(false);
    expect(isAbortError(new TaskGraphTimeoutError(5000))).toBe(false);
    expect(isAbortError(new Error("The operation was aborted"))).toBe(false);
    const named = new Error("request aborted");
    named.name = "FetchAbortedError";
    expect(isAbortError(named)).toBe(false);
  });

  it("maps cancellation to exit 130 and every other failure, timeouts included, to 1", () => {
    expect(runFailureExitCode(new TaskAbortedError())).toBe(130);
    expect(runFailureExitCode(new Error("boom"))).toBe(1);
    expect(runFailureExitCode(new TaskGraphTimeoutError(5000))).toBe(1);
  });
});

describe("isSignalCancellation", () => {
  it("is false until a signal asks this process to abort", () => {
    expect(runAbortedBySignal()).toBe(false);
    expect(isSignalCancellation(new TaskAbortedError())).toBe(false);
  });

  // The message is suppressed only for the cancellation this process asked for;
  // a run aborted by something else still explains itself.
  it("is true for a bare abort once a signal arrived, and never for a timeout", () => {
    uninstalls.push(installRunSignalAbort({ abort: () => {}, exit: () => {} }));
    emit("SIGINT");

    expect(runAbortedBySignal()).toBe(true);
    expect(isSignalCancellation(new TaskAbortedError())).toBe(true);
    expect(isSignalCancellation(new TaskGraphTimeoutError(5000))).toBe(false);
    expect(isSignalCancellation(new Error("boom"))).toBe(false);
  });
});
