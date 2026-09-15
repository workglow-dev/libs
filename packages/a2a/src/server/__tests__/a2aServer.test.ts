/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { IA2AAgentDescriptor } from "../../util/AgentDescriptor";
import { startA2AHttpServer } from "../A2AHttpServer";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const descriptor: IA2AAgentDescriptor = {
  id: "echo",
  name: "Echo",
  description: "Says it back.",
  version: "1.0.0",
  skills: [
    {
      id: "echo",
      name: "Echo",
      description: "Says it back.",
      tags: [],
      examples: [],
      inputSchema: undefined,
    },
  ],
  agentInput: { model: "m", tools: [] },
};

function sendMessage(text: string, id: number = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "SendMessage",
    params: {
      message: {
        messageId: `m${id}`,
        role: "ROLE_USER",
        parts: [{ text, mediaType: "text/plain" }],
      },
    },
  });
}

/**
 * A POST built by hand, because `fetch` will not send some of what this server
 * is checking: `Host` is a forbidden header name there, so a rebinding attempt
 * expressed through `fetch` arrives with the real host and proves nothing.
 */
function rawPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("startA2AHttpServer", () => {
  it("serves the card at the well-known path", async () => {
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: null,
      descriptor,
      runTurn: async () => ({ text: "ok" }),
    });
    close = handle.close;

    const res = await fetch(handle.cardUrl);
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.name).toBe("Echo");
    // The card names the endpoint a peer posts to, bound port included.
    expect(card.supportedInterfaces[0].url).toBe(handle.url);
  });

  it("publishes the bearer scheme it enforces, and the card itself stays readable", async () => {
    // A card silent about auth in front of a server demanding a token is an
    // agent nobody can call — and a card only readable with the token it
    // describes is one nobody can learn to call.
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: "secret",
      descriptor,
      runTurn: async () => ({ text: "ok" }),
    });
    close = handle.close;

    const card = await (await fetch(handle.cardUrl)).json();
    expect(Object.keys(card.securitySchemes)).toEqual(["bearer"]);
    // Proto JSON, which is the shape the SDK's client reads back into a card.
    expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe("Bearer");
  });

  it("refuses a request with no bearer when one is required", async () => {
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: "secret",
      descriptor,
      runTurn: async () => ({ text: "ok" }),
    });
    close = handle.close;

    const res = await fetch(handle.url, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    // Without this the client is not told which scheme to present.
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("refuses to serve unauthenticated on a wildcard bind", async () => {
    // Nothing else decides who may run an agent, and a host that never states
    // the choice would publish agent execution to whatever reaches the port.
    await expect(
      startA2AHttpServer({ port: 0, host: "0.0.0.0", token: null, descriptor })
    ).rejects.toThrow(/wildcard|unauthenticated/i);
  });

  it("refuses a request for a host it was not bound as", async () => {
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: null,
      descriptor,
      runTurn: async () => ({ text: "ok" }),
    });
    close = handle.close;

    const res = await rawPost(
      handle.url,
      { host: "evil.example", "content-type": "application/json", "A2A-Version": "1.0" },
      sendMessage("hi")
    );
    expect(res.status).toBe(403);
  });

  it("answers a message with the agent's text", async () => {
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: null,
      descriptor,
      runTurn: async () => ({ text: "hello back" }),
    });
    close = handle.close;

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", "A2A-Version": "1.0" },
      body: sendMessage("hi"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(JSON.stringify(body.result.task.artifacts)).toContain("hello back");
  });

  it("tells a peer speaking a version it does not, rather than guessing", async () => {
    // The SDK reads an absent header as 0.3. This server publishes 1.0 only,
    // so the answer is the protocol's own error, not a silent misparse.
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: null,
      descriptor,
      runTurn: async () => ({ text: "hello back" }),
    });
    close = handle.close;

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sendMessage("hi"),
    });
    const body = await res.json();
    expect(body.error?.message).toMatch(/version/i);
  });

  it("streams a message's events as SSE", async () => {
    const handle = await startA2AHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: null,
      descriptor,
      runTurn: async () => ({ text: "streamed" }),
    });
    close = handle.close;

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", "A2A-Version": "1.0" },
      body: sendMessage("hi").replace('"SendMessage"', '"SendStreamingMessage"'),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("streamed");
    expect(text).toContain("TASK_STATE_COMPLETED");
  });
});
