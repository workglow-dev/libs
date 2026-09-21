/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai";
import { registerAiTasks } from "@workglow/ai";
import { _testOnly as anthropic } from "@workglow/anthropic/ai";
import { _testOnly as chromeAi } from "@workglow/chrome-ai/ai";
import { _testOnly as deepseek } from "@workglow/deepseek/ai";
import { _testOnly as gemini } from "@workglow/google-gemini/ai";
import { _testOnly as hfi } from "@workglow/huggingface-inference/ai";
import { _testOnly as hft } from "@workglow/huggingface-transformers/ai";
import { _testOnly as llamaCpp } from "@workglow/node-llama-cpp/ai";
import { _testOnly as ollama } from "@workglow/ollama/ai";
import { _testOnly as openai } from "@workglow/openai/ai";
import { _testOnly as openrouter } from "@workglow/openrouter/ai";
import { _testOnly as tfmp } from "@workglow/tf-mediapipe/ai";
import { _testOnly as typesafeai } from "@workglow/typesafeai/ai";
import { _testOnly as xai } from "@workglow/xai/ai";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** Every AI provider package, by the name its `package.json` publishes under. */
const PROVIDER_SERVES: Readonly<Record<string, readonly (readonly Capability[])[]>> = {
  "@workglow/anthropic": anthropic.ANTHROPIC_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/chrome-ai": chromeAi.WEB_BROWSER_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/deepseek": deepseek.DEEPSEEK_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/google-gemini": gemini.GEMINI_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/huggingface-inference": hfi.HFI_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/huggingface-transformers": hft.HFT_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/node-llama-cpp": llamaCpp.LLAMACPP_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/ollama": ollama.OLLAMA_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/openai": openai.OPENAI_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/openrouter": openrouter.OPENROUTER_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/tf-mediapipe": tfmp.TFMP_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/typesafeai": typesafeai.TYPESAFEAI_RUN_FN_SPECS.map((s) => s.serves),
  "@workglow/xai": xai.XAI_RUN_FN_SPECS.map((s) => s.serves),
};

function metaPackageDependencies(): ReadonlySet<string> {
  const { dependencies } = JSON.parse(
    readFileSync(join(repoRoot, "packages", "workglow", "package.json"), "utf8")
  ) as { dependencies: Record<string, string> };
  return new Set(Object.keys(dependencies));
}

/**
 * A task in the unconditional registration list is nameable by graph JSON the
 * host did not author, so a host that installs `workglow` and calls
 * `registerAiTasks` must be able to install something that serves it.
 *
 * When it cannot, the graph builds, the task resolves, and dispatch fails with
 * "model is missing capabilities" — the outcome the provider capability gate
 * exists to produce *actionably*, except that here there is nothing to install
 * without already knowing the package name.
 *
 * Not every provider is in the meta-package, and that is house style rather
 * than a defect: `cactus`, `mlx`, `llamacpp-server` and `stable-diffusion-server`
 * serve capabilities several reachable providers also serve, so their absence
 * costs a choice. What this asserts is narrower — that no registered task is
 * left with NO reachable provider at all.
 */
describe("every registered AI task has a provider the meta-package reaches", () => {
  const reachable = metaPackageDependencies();

  it("reaches at least one AI provider", () => {
    const found = Object.keys(PROVIDER_SERVES).filter((name) => reachable.has(name));
    expect(found.length).toBeGreaterThan(5);
  });

  it("leaves no registered task's capability unserved", () => {
    const servedByReachable = new Set<string>();
    for (const [name, serves] of Object.entries(PROVIDER_SERVES)) {
      if (!reachable.has(name)) continue;
      for (const set of serves) for (const capability of set) servedByReachable.add(capability);
    }

    const orphaned: string[] = [];
    for (const task of registerAiTasks()) {
      const requires = (task as { requires?: readonly Capability[] }).requires;
      if (requires === undefined || requires.length === 0) continue;
      const unserved = requires.filter((capability) => !servedByReachable.has(capability));
      if (unserved.length > 0) {
        orphaned.push(`${(task as { type: string }).type} requires ${unserved.join(", ")}`);
      }
    }

    expect(
      orphaned,
      "these task types are registered unconditionally but no provider the `workglow` " +
        "meta-package depends on advertises what they require — either wire the provider " +
        "in, or make the registration conditional"
    ).toEqual([]);
  });
});
