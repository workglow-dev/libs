/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

/**
 * A scripted stand-in for the Anthropic Messages API, for checking the whole
 * pipeline — install, run, usage capture, verification, comparison — without a
 * key or a bill. Every harness in the comparison can be pointed at an
 * Anthropic base URL, so one fake serves all three.
 *
 * The script is a list of shell commands. Each request is answered with a call
 * to whatever tool the harness named `bash`, running the next command — the
 * position is the number of assistant turns already in the conversation —
 * and once the commands run out, with a short text answer. That makes the
 * behaviour a function of the conversation alone, so it is the same for every
 * harness and survives the retries and side requests (titles, summaries) a
 * harness makes.
 */
export interface AnthropicMockOptions {
  readonly port: number;
  readonly host?: string | undefined;
  readonly commands: readonly string[];
  /** Append every request body here as JSON lines, for inspection. */
  readonly requestLog?: string | undefined;
  readonly finalText?: string | undefined;
}

interface MessagesRequest {
  readonly model?: string;
  readonly stream?: boolean;
  readonly system?: unknown;
  readonly messages?: ReadonlyArray<{ role: string; content: unknown }>;
  readonly tools?: ReadonlyArray<{
    name: string;
    input_schema?: { properties?: Record<string, { type?: string }>; required?: string[] };
  }>;
}

type Reply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: Record<string, unknown> };

let nextId = 0;
const id = (prefix: string): string => `${prefix}_mock${(++nextId).toString().padStart(6, "0")}`;

/** Fills a tool's required arguments: the command where it wants one, a placeholder elsewhere. */
function bashInput(
  tool: NonNullable<MessagesRequest["tools"]>[number],
  command: string
): Record<string, unknown> {
  const input: Record<string, unknown> = { command };
  const properties = tool.input_schema?.properties ?? {};
  for (const name of tool.input_schema?.required ?? []) {
    if (name in input) continue;
    const type = properties[name]?.type;
    input[name] =
      type === "number" || type === "integer"
        ? 60
        : type === "boolean"
          ? false
          : "Run the next step";
  }
  return input;
}

export function decideReply(request: MessagesRequest, options: AnthropicMockOptions): Reply {
  const finalText = options.finalText ?? "Done. The task is complete.";
  const bash = request.tools?.find((tool) => tool.name.toLowerCase() === "bash");
  if (bash === undefined) return { kind: "text", text: finalText };
  const step = (request.messages ?? []).filter((message) => message.role === "assistant").length;
  const command = options.commands[step];
  if (command === undefined) return { kind: "text", text: finalText };
  return { kind: "tool", name: bash.name, input: bashInput(bash, command) };
}

function promptSize(request: MessagesRequest): number {
  return Math.ceil(JSON.stringify([request.system, request.messages, request.tools]).length / 4);
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function respond(res: ServerResponse, request: MessagesRequest, reply: Reply): void {
  const messageId = id("msg");
  const model = request.model ?? "mock";
  const usage = {
    input_tokens: promptSize(request),
    output_tokens: 24,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const stopReason = reply.kind === "tool" ? "tool_use" : "end_turn";
  const block =
    reply.kind === "tool"
      ? { type: "tool_use", id: id("toolu"), name: reply.name, input: reply.input }
      : { type: "text", text: reply.text };

  if (!request.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [block],
        stop_reason: stopReason,
        stop_sequence: null,
        usage,
      })
    );
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 1 },
    },
  });
  if (block.type === "tool_use") {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
    });
  } else {
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: block.text },
    });
  }
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function startAnthropicMock(options: AnthropicMockOptions): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === "POST" && path.endsWith("/messages/count_tokens")) {
        const request = JSON.parse(await readBody(req)) as MessagesRequest;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: promptSize(request) }));
        return;
      }
      if (req.method === "POST" && path.endsWith("/messages")) {
        const body = await readBody(req);
        const request = JSON.parse(body) as MessagesRequest;
        if (options.requestLog) {
          appendFileSync(
            options.requestLog,
            `${JSON.stringify({ at: new Date().toISOString(), request })}\n`
          );
        }
        respond(res, request, decideReply(request, options));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: path } }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: String(error) },
        })
      );
    }
  });
  return new Promise((resolve) => {
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve(server));
  });
}
