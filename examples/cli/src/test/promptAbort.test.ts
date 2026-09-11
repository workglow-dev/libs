/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { releaseOnAbort, type PromptInstance } from "../ui/promptAbort";

function fakeInstance(): PromptInstance & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    clear: () => calls.push("clear"),
    unmount: () => calls.push("unmount"),
  };
}

describe("releaseOnAbort", () => {
  it("takes the terminal back when the signal aborts", () => {
    const controller = new AbortController();
    const instance = fakeInstance();
    let settled: unknown = "unset";

    releaseOnAbort(controller.signal, instance, (value) => {
      settled = value;
    });
    controller.abort();

    expect(instance.calls).toEqual(["clear", "unmount"]);
    expect(settled).toBeUndefined();
  });

  it("releases immediately when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const instance = fakeInstance();

    releaseOnAbort(controller.signal, instance, () => {});

    expect(instance.calls).toEqual(["clear", "unmount"]);
  });

  it("does nothing after the prompt settled and detached", () => {
    const controller = new AbortController();
    const instance = fakeInstance();

    const detach = releaseOnAbort(controller.signal, instance, () => {});
    detach();
    controller.abort();

    // `clear()` writes an erase sequence, so a listener left attached past a
    // normal answer wipes whatever is on screen when the run later aborts.
    expect(instance.calls).toEqual([]);
  });

  it("leaves no listener behind per prompt on one long-lived signal", () => {
    const controller = new AbortController();
    const instances = [fakeInstance(), fakeInstance(), fakeInstance()];

    for (const instance of instances) {
      releaseOnAbort(controller.signal, instance, () => {})();
    }
    controller.abort();

    // A turn holding one signal across several prompts would otherwise erase
    // the screen once per prompt it had asked.
    expect(instances.flatMap((instance) => instance.calls)).toEqual([]);
  });

  it("detaches idempotently, and with no signal at all", () => {
    const instance = fakeInstance();
    const detach = releaseOnAbort(undefined, instance, () => {});
    expect(() => {
      detach();
      detach();
    }).not.toThrow();
    expect(instance.calls).toEqual([]);
  });
});
