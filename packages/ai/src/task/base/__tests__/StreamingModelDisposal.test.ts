/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelConfig } from "@workglow/ai";
import { AiProviderRegistry, setAiProviderRegistry, TextGenerationTask } from "@workglow/ai";
import { DisposeStrategy, ResourceScope } from "@workglow/util";
import { describe, expect, it } from "vitest";

const PROVIDER = "mock-streaming-disposable-provider";

// A local runtime (llama.cpp, HF Transformers) keeps a model resident until it is
// disposed, and AiTask hands that disposal to the run's ResourceScope. A streaming task
// never reaches AiTask.execute, so the registration has to happen on that path as well.
describe("StreamingAiTask registers the model's disposal with the run's scope", () => {
  it("unloads a model a streamed run loaded when the scope disposes", async () => {
    const registry = new AiProviderRegistry();
    setAiProviderRegistry(registry);

    const generate: AiProviderRunFn = async (_input, _model, _signal, emit) => {
      emit({ type: "text-delta", port: "text", textDelta: "hello" });
      emit({ type: "finish", data: {} });
    };
    const disposed: string[] = [];
    const dispose: AiProviderRunFn = async (_input, model, _signal, emit) => {
      disposed.push(model.model_id);
      emit({ type: "finish", data: {} });
    };
    registry.registerRunFn(PROVIDER, { serves: ["text.generation"], runFn: generate });
    registry.registerRunFn(PROVIDER, { serves: ["model.dispose"], runFn: dispose });

    const model: ModelConfig = {
      model_id: "local-model",
      title: "local-model",
      description: "test",
      capabilities: ["text.generation"],
      provider: PROVIDER,
      provider_config: {},
      metadata: {},
    };
    const scope = new ResourceScope({ strategy: DisposeStrategy.never() });

    const result = await new TextGenerationTask().run(
      { model, prompt: "hi" },
      { resourceScope: scope }
    );
    expect(result.text).toBe("hello");

    await scope.disposeAll();
    expect(disposed).toEqual(["local-model"]);
  });
});
