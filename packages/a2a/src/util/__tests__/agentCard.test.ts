/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import type { IA2AAgentDescriptor } from "../AgentDescriptor";
import { buildAgentCard } from "../agentCard";

const descriptor: IA2AAgentDescriptor = {
  id: "researcher",
  name: "Researcher",
  description: "Answers questions with citations.",
  version: "1.0.0",
  skills: [
    {
      id: "answer",
      name: "Answer",
      description: "Answer a question.",
      tags: ["research"],
      examples: ["What changed in the 2025 filing?"],
      inputSchema: undefined,
    },
  ],
  agentInput: { model: "m", systemPrompt: "sys", tools: [] },
};

const url = "https://example.test/a2a";

describe("buildAgentCard", () => {
  it("declares the URL it is served from as a JSONRPC interface", () => {
    const card = buildAgentCard(descriptor, { url, authenticated: false });
    // `protocolVersion` is what the server validates a request's A2A-Version
    // header against; an interface without one supports no version at all.
    expect(card.supportedInterfaces).toEqual([
      { url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
    ]);
  });

  it("carries the descriptor's identity and skills", () => {
    const card = buildAgentCard(descriptor, { url, authenticated: false });
    expect(card.name).toBe("Researcher");
    expect(card.version).toBe("1.0.0");
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]?.id).toBe("answer");
    expect(card.skills[0]?.tags).toEqual(["research"]);
  });

  it("declares the bearer scheme when the server requires one", () => {
    // The card is how a peer learns to authenticate. One that claims no
    // scheme in front of a server demanding a token is an agent nobody can
    // call, and a 401 nobody can act on.
    const card = buildAgentCard(descriptor, { url, authenticated: true });
    const scheme = card.securitySchemes.bearer?.scheme;
    expect(scheme?.$case).toBe("httpAuthSecurityScheme");
    expect(scheme?.$case === "httpAuthSecurityScheme" && scheme.value.scheme).toBe("Bearer");
    expect(card.securityRequirements).toHaveLength(1);
    expect(Object.keys(card.securityRequirements[0]!.schemes)).toEqual(["bearer"]);
  });

  it("declares nothing when the server was started open", () => {
    const card = buildAgentCard(descriptor, { url, authenticated: false });
    expect(card.securitySchemes).toEqual({});
    expect(card.securityRequirements).toEqual([]);
  });

  it("publishes no model, tools or system prompt", () => {
    // A2A peers are opaque to each other; the card is a disclosure surface
    // and agentInput is the half a caller must not see.
    const json = JSON.stringify(buildAgentCard(descriptor, { url, authenticated: false }));
    expect(json).not.toContain("sys");
    expect(json).not.toContain("agentInput");
  });

  it("states the modes it speaks", () => {
    const card = buildAgentCard(descriptor, { url, authenticated: false });
    expect(card.defaultInputModes).toContain("text/plain");
    expect(card.defaultOutputModes).toContain("text/plain");
  });
});
