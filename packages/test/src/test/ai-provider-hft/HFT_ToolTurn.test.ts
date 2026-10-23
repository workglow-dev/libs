/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScriptedReply, WireTurn } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";
import {
  clearPipelineCache,
  getPipelineCacheKey,
  loadTransformersSDK,
  pipelines,
} from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Pipeline";
import { HFT_ToolCalling } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_ToolCalling";

// "qwen" in the path selects the Hermes-style `<tool_call>` parser family.
const model = {
  model_id: "hft-conformance-qwen",
  provider: "HF_TRANSFORMERS_ONNX",
  provider_config: { model_path: "test-org/qwen-fake", pipeline: "text-generation" },
} as never;

/** The reply as a Qwen-style model decodes it: `<think>`, the answer, then `<tool_call>` markup. */
function decodedPieces(reply: ScriptedReply): string[] {
  const pieces: string[] = [];
  if (reply.reasoning !== undefined) pieces.push(`<think>${reply.reasoning}</think>`);
  if (reply.text !== undefined) pieces.push(reply.text);
  for (const call of reply.toolCalls ?? []) {
    pieces.push(
      `<tool_call>${JSON.stringify({ name: call.name, arguments: call.input })}</tool_call>`
    );
  }
  return pieces;
}

/**
 * A pipeline that renders nothing and decodes the scripted reply. What the
 * provider hands `apply_chat_template` is the request: everything the model
 * would read is rendered from it.
 */
function scriptedPipeline(sent: unknown[], replies: ScriptedReply[]): unknown {
  const tokenizer = Object.assign((text: string) => ({ input_ids: { dims: [1, text.length] } }), {
    all_special_ids: [] as number[],
    apply_chat_template: (messages: unknown) => {
      sent.push(JSON.parse(JSON.stringify(messages)));
      return "<user>question</user>\n<assistant>";
    },
    decode: () => "",
  });
  const hfModel = {
    generate: async (args: Record<string, any>) => {
      for (const piece of decodedPieces(replies.shift() ?? {})) {
        args.streamer?.callback_function?.(piece);
      }
      return { dims: [1, args.input_ids.dims[1]] };
    },
  };
  const pipeline: any = async (prompt: string, opts: Record<string, unknown>) => {
    await hfModel.generate({ ...tokenizer(prompt), ...opts });
    return [{ generated_text: "" }];
  };
  pipeline.tokenizer = tokenizer;
  pipeline.model = hfModel;
  return pipeline;
}

function turns(request: unknown): WireTurn[] {
  return (request as Array<{ role: WireTurn["role"] }>).map((message) => ({
    role: message.role,
    body: message,
  }));
}

runToolTurnConformance({
  name: "HF Transformers",
  createHarness: async () => {
    await loadTransformersSDK();
    await clearPipelineCache();
    const sent: unknown[] = [];
    const replies: ScriptedReply[] = [];
    pipelines.set(getPipelineCacheKey(model), scriptedPipeline(sent, replies) as never);
    return {
      respond: (reply) => void replies.push(reply),
      run: (request, emit) =>
        HFT_ToolCalling(
          { model, toolChoice: "auto", ...request } as never,
          model,
          new AbortController().signal,
          emit as never
        ),
      sent: () => sent,
      dispose: () => clearPipelineCache(),
    };
  },
  turns,
  reasoningStream: "reasoning-port",
  reasoningReplay: { kind: "text" },
  toolResultImages: {
    kind: "text-only",
    reason: "the ONNX text-generation pipeline renders a chat template, which takes no images",
  },
});
