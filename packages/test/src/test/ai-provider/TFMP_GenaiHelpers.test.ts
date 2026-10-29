/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/tf-mediapipe/ai";
// The base-URL accessors must come from `./ai-runtime`: it is bundled separately
// from `./ai`, so each entry point holds its own copy of the module state, and
// `./ai-runtime` is the copy `getWasmTask` actually reads.
import {
  getTfmpWasmBaseUrls,
  resetTfmpWasmBaseUrls,
  setTfmpWasmBaseUrls,
} from "@workglow/tf-mediapipe/ai-runtime";
import { afterEach, describe, expect, it } from "vitest";

const {
  buildGenaiPrompt,
  extractJsonFromText,
  isGenaiBusy,
  optionsMatch,
  resolveTfmpChatTemplate,
  resolveTfmpDelegate,
  withGenaiLock,
} = _testOnly;

describe("resolveTfmpDelegate", () => {
  it("defaults vision to GPU", () => {
    expect(resolveTfmpDelegate("vision", undefined)).toBe("GPU");
    expect(resolveTfmpDelegate("vision", true)).toBe("GPU");
  });

  it("respects explicit gpu=false for vision", () => {
    expect(resolveTfmpDelegate("vision", false)).toBe("CPU");
  });

  it("never sets a delegate for CPU-only engines", () => {
    for (const engine of ["text", "audio"]) {
      expect(resolveTfmpDelegate(engine, true)).toBeUndefined();
      expect(resolveTfmpDelegate(engine, false)).toBeUndefined();
      expect(resolveTfmpDelegate(engine, undefined)).toBeUndefined();
    }
  });

  it("leaves genai to the genai runtime", () => {
    expect(resolveTfmpDelegate("genai", true)).toBeUndefined();
    expect(resolveTfmpDelegate("genai", false)).toBeUndefined();
  });
});

describe("buildGenaiPrompt", () => {
  it("wraps a single user message and opens a model turn", () => {
    const prompt = buildGenaiPrompt([{ role: "user", content: "Hello" }], "gemma");
    expect(prompt).toBe("<start_of_turn>user\nHello<end_of_turn>\n<start_of_turn>model\n");
  });

  it("folds the system prompt into the first user turn", () => {
    const prompt = buildGenaiPrompt(
      [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hi" },
      ],
      "gemma"
    );
    expect(prompt).toBe(
      "<start_of_turn>user\nBe terse.\n\nHi<end_of_turn>\n<start_of_turn>model\n"
    );
  });

  it("renders multi-turn history with model turns", () => {
    const prompt = buildGenaiPrompt(
      [
        { role: "user", content: "One" },
        { role: "assistant", content: "Two" },
        { role: "user", content: "Three" },
      ],
      "gemma"
    );
    expect(prompt).toBe(
      "<start_of_turn>user\nOne<end_of_turn>\n" +
        "<start_of_turn>model\nTwo<end_of_turn>\n" +
        "<start_of_turn>user\nThree<end_of_turn>\n" +
        "<start_of_turn>model\n"
    );
  });

  it("emits a lone system prompt as a user turn", () => {
    const prompt = buildGenaiPrompt([{ role: "system", content: "Rules." }], "gemma");
    expect(prompt).toBe("<start_of_turn>user\nRules.<end_of_turn>\n<start_of_turn>model\n");
  });

  it("none template passes a single message through verbatim", () => {
    expect(buildGenaiPrompt([{ role: "user", content: "raw prompt" }], "none")).toBe("raw prompt");
  });

  it("none template joins messages with blank lines", () => {
    expect(
      buildGenaiPrompt(
        [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
        "none"
      )
    ).toBe("S\n\nU");
  });
});

describe("buildGenaiPrompt chatml", () => {
  it("renders system natively and opens an assistant turn", () => {
    const prompt = buildGenaiPrompt(
      [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hi" },
      ],
      "chatml"
    );
    expect(prompt).toBe(
      "<|im_start|>system\nBe terse.<|im_end|>\n" +
        "<|im_start|>user\nHi<|im_end|>\n" +
        "<|im_start|>assistant\n"
    );
  });

  it("renders multi-turn history", () => {
    const prompt = buildGenaiPrompt(
      [
        { role: "user", content: "One" },
        { role: "assistant", content: "Two" },
        { role: "user", content: "Three" },
      ],
      "chatml"
    );
    expect(prompt).toBe(
      "<|im_start|>user\nOne<|im_end|>\n" +
        "<|im_start|>assistant\nTwo<|im_end|>\n" +
        "<|im_start|>user\nThree<|im_end|>\n" +
        "<|im_start|>assistant\n"
    );
  });
});

describe("resolveTfmpChatTemplate", () => {
  it("defaults to gemma", () => {
    expect(resolveTfmpChatTemplate(undefined)).toBe("gemma");
    expect(resolveTfmpChatTemplate("gemma")).toBe("gemma");
    expect(resolveTfmpChatTemplate("bogus")).toBe("gemma");
  });
  it("honors none", () => {
    expect(resolveTfmpChatTemplate("none")).toBe("none");
  });
  it("honors chatml", () => {
    expect(resolveTfmpChatTemplate("chatml")).toBe("chatml");
  });
});

describe("withGenaiLock", () => {
  it("serializes calls FIFO per model path", async () => {
    const order: number[] = [];
    const gate = Promise.withResolvers<void>();
    const first = withGenaiLock("m", async () => {
      await gate.promise;
      order.push(1);
    });
    const second = withGenaiLock("m", async () => {
      order.push(2);
    });
    expect(isGenaiBusy("m")).toBe(true);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
    expect(isGenaiBusy("m")).toBe(false);
  });

  it("keeps chaining after a rejection", async () => {
    await expect(
      withGenaiLock("m2", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(withGenaiLock("m2", async () => "ok")).resolves.toBe("ok");
  });
});

describe("optionsMatch", () => {
  it("deep-compares nested baseOptions", () => {
    expect(
      optionsMatch(
        { baseOptions: { delegate: "GPU", modelAssetPath: "m" } },
        { baseOptions: { delegate: "GPU", modelAssetPath: "m" } }
      )
    ).toBe(true);
    expect(
      optionsMatch(
        { baseOptions: { delegate: "GPU", modelAssetPath: "m" } },
        { baseOptions: { delegate: "CPU", modelAssetPath: "m" } }
      )
    ).toBe(false);
  });

  it("still compares scalars and arrays", () => {
    expect(optionsMatch({ numHands: 2 }, { numHands: 2 })).toBe(true);
    expect(optionsMatch({ numHands: 2 }, { numHands: 1 })).toBe(false);
    expect(optionsMatch({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(optionsMatch({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  it("rejects differing key sets", () => {
    expect(optionsMatch({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(optionsMatch({ a: 1 }, { b: 1 })).toBe(false);
  });
});

describe("extractJsonFromText", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonFromText('{"a": 1}')).toEqual({ a: 1 });
  });

  it("unwraps a ```json fence", () => {
    expect(extractJsonFromText('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("unwraps an anonymous fence", () => {
    expect(extractJsonFromText('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("extracts an object embedded in prose", () => {
    expect(extractJsonFromText('Sure! Here you go: {"a": 1} Hope that helps.')).toEqual({
      a: 1,
    });
  });

  it("recovers a truncated object via partial parsing", () => {
    expect(extractJsonFromText('{"a": 1, "b": {"c": 2')).toEqual({ a: 1, b: { c: 2 } });
  });

  it("returns an empty object when no JSON is present", () => {
    expect(extractJsonFromText("no json here")).toEqual({});
  });
});

describe("TFMP wasm base URLs", () => {
  afterEach(() => {
    resetTfmpWasmBaseUrls();
  });

  it("defaults every engine to its jsDelivr fileset", () => {
    // Unbundled, no version is defined and the URL names none; a bundle built by
    // the package's build.ts inserts the installed SDK version after the name.
    const bases = getTfmpWasmBaseUrls();
    for (const engine of ["vision", "text", "audio", "genai"] as const) {
      expect(bases[engine]).toMatch(
        new RegExp(`^https://cdn\\.jsdelivr\\.net/npm/@mediapipe/tasks-${engine}(@[^/]+)?/wasm$`)
      );
    }
  });

  it("overrides only the engines it is given", () => {
    setTfmpWasmBaseUrls({ vision: "/wasm/vision" });
    expect(getTfmpWasmBaseUrls().vision).toBe("/wasm/vision");
    expect(getTfmpWasmBaseUrls().text).toContain("cdn.jsdelivr.net");

    setTfmpWasmBaseUrls({ text: "/wasm/text" });
    expect(getTfmpWasmBaseUrls().vision).toBe("/wasm/vision");
    expect(getTfmpWasmBaseUrls().text).toBe("/wasm/text");
  });

  it("treats an explicit undefined as 'leave unchanged', not 'clear'", () => {
    setTfmpWasmBaseUrls({ vision: "/wasm/vision" });
    setTfmpWasmBaseUrls({ vision: undefined, audio: "/wasm/audio" });
    expect(getTfmpWasmBaseUrls().vision).toBe("/wasm/vision");
    expect(getTfmpWasmBaseUrls().audio).toBe("/wasm/audio");
  });

  it("restores the pinned defaults on reset", () => {
    setTfmpWasmBaseUrls({ vision: "/wasm/vision", genai: "/wasm/genai" });
    resetTfmpWasmBaseUrls();
    expect(getTfmpWasmBaseUrls().vision).toContain("cdn.jsdelivr.net");
    expect(getTfmpWasmBaseUrls().genai).toContain("cdn.jsdelivr.net");
  });
});
