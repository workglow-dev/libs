/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createPolicyEnforcer,
  createProfilePolicy,
  ENTITLEMENT_ENFORCER,
  Entitlements,
  TaskEntitlementError,
  taskClassNeedsApproval,
  TaskGraph,
  TaskGraphRunner,
} from "@workglow/task-graph";
import type { IEntitlementEnforcer } from "@workglow/task-graph";
import { registerSafeFetch } from "@workglow/tasks";
import { Container, ServiceRegistry } from "@workglow/util";
import { describe, expect, it } from "vitest";

import { textPart } from "../../util/partBinding";
import type { A2AClientLike } from "../A2AAgentTask";
import { A2AAgentTask, resolveCardLocation } from "../A2AAgentTask";

const METADATA_URL = "http://169.254.169.254/latest/meta-data/";

function entitlementIds(agentUrl: string | undefined): readonly string[] {
  return new A2AAgentTask({ defaults: { agentUrl, prompt: "hi", contextId: undefined } as never })
    .entitlements()
    .entitlements.map((entitlement) => entitlement.id);
}

function privateScopeOf(agentUrl: string): readonly string[] | undefined {
  return new A2AAgentTask({ defaults: { agentUrl, prompt: "hi", contextId: undefined } })
    .entitlements()
    .entitlements.find((entitlement) => entitlement.id === Entitlements.NETWORK_PRIVATE)?.resources;
}

function fakeClient(reply: { text: string; contextId: string; state: string }): A2AClientLike {
  return {
    sendMessage: async () => ({
      contextId: reply.contextId,
      state: reply.state,
      parts: [textPart(reply.text)],
    }),
  };
}

describe("resolveCardLocation", () => {
  it("hands a card URL over as-is, with no path for the SDK to append", () => {
    // The SDK resolves the well-known path relative to what it is handed, so
    // the card's own URL would otherwise look for the card underneath itself.
    expect(resolveCardLocation("http://h:1/.well-known/agent-card.json")).toEqual({
      baseUrl: "http://h:1/.well-known/agent-card.json",
      cardPath: "",
    });
  });

  it("keeps a path-mounted agent's path, by ending the base with a slash", () => {
    // Relative resolution drops the last segment of a base without one, so
    // `/agents/foo` would look under `/agents/`.
    expect(resolveCardLocation("http://h:1/agents/foo")).toEqual({
      baseUrl: "http://h:1/agents/foo/",
      cardPath: undefined,
    });
    expect(resolveCardLocation("http://h:1")).toEqual({
      baseUrl: "http://h:1/",
      cardPath: undefined,
    });
    expect(resolveCardLocation("http://h:1/a2a/")).toEqual({
      baseUrl: "http://h:1/a2a/",
      cardPath: undefined,
    });
  });
});

describe("A2AAgentTask", () => {
  it("declares a title, because the progress UI labels the row with it", () => {
    expect(A2AAgentTask.title).toBeTruthy();
  });

  it("returns the remote agent's answer and the context to continue in", async () => {
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      createClient: async () =>
        fakeClient({ text: "hello", contextId: "c1", state: "TASK_STATE_COMPLETED" }),
    });
    const out = await task.run();
    expect(out.text).toBe("hello");
    expect(out.contextId).toBe("c1");
  });

  it("carries a caller's contextId through to the remote agent", async () => {
    const seen: (string | undefined)[] = [];
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "and then?", contextId: "c1" },
      createClient: async () => ({
        sendMessage: async (input) => {
          seen.push(input.contextId);
          return { contextId: "c1", state: "TASK_STATE_COMPLETED", parts: [textPart("ok")] };
        },
      }),
    });
    await task.run();
    // Without this the second turn opens a new conversation and the remote
    // agent has forgotten the first.
    expect(seen).toEqual(["c1"]);
  });

  it("reports a remote task that stopped for input rather than calling it an answer", async () => {
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      createClient: async () =>
        fakeClient({ text: "which year?", contextId: "c1", state: "TASK_STATE_INPUT_REQUIRED" }),
    });
    const out = await task.run();
    // A caller reading this as an answer never sends the follow-up, and the
    // remote task stays parked until it expires.
    expect(out.taskState).toBe("TASK_STATE_INPUT_REQUIRED");
  });

  it("fails when the remote task failed, carrying the peer's reason", async () => {
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      createClient: async () =>
        fakeClient({ text: "model unavailable", contextId: "c1", state: "TASK_STATE_FAILED" }),
    });
    // An empty answer with a state nobody downstream reads is a pipeline that
    // reports success on a call that produced nothing.
    await expect(task.run()).rejects.toThrow(/TASK_STATE_FAILED.*model unavailable/);
  });

  it("hands the run's signal to the call, not just to a check before it", async () => {
    let received: AbortSignal | undefined;
    const task = new A2AAgentTask({
      defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      createClient: async () => ({
        sendMessage: async (_input, signal) => {
          received = signal;
          return { contextId: "c1", state: "TASK_STATE_COMPLETED", parts: [textPart("ok")] };
        },
      }),
    });
    await task.run();
    // An aborted run that only checked beforehand leaves a remote turn in
    // flight, and the peer bills for it.
    expect(received).toBeInstanceOf(AbortSignal);
  });
});

describe("A2AAgentTask entitlements", () => {
  it("declares network:http, which is what makes the approval gate fire", () => {
    // Declaring nothing is not "reaches nothing": `taskClassNeedsApproval`
    // reads the class, so an empty declaration let a model call this tool with
    // any URL it liked — no prompt, no policy check — and send the prompt there.
    expect(A2AAgentTask.entitlements().entitlements.map((e) => e.id)).toEqual([
      Entitlements.NETWORK_HTTP,
    ]);
    expect(taskClassNeedsApproval(A2AAgentTask)).toBe(true);
  });

  it("is dynamic, so the run-time destination is evaluated and not just the class", () => {
    expect(A2AAgentTask.hasDynamicEntitlements).toBe(true);
  });

  it("asks for nothing private when the agent is public", () => {
    expect(entitlementIds("https://example.test/a2a")).toEqual([Entitlements.NETWORK_HTTP]);
  });

  it("adds network:private, scoped to the origin, for a loopback agent", () => {
    expect(entitlementIds("http://127.0.0.1:8789/a2a")).toContain(Entitlements.NETWORK_PRIVATE);
    // Scoped, so a grant for one dev server is not a grant for every internal host.
    expect(privateScopeOf("http://127.0.0.1:8789/a2a")).toEqual(["http://127.0.0.1:8789/*"]);
  });

  it("adds network:private for the cloud metadata endpoint", () => {
    expect(entitlementIds(METADATA_URL)).toContain(Entitlements.NETWORK_PRIVATE);
  });

  it("fails closed when the destination is not known yet", () => {
    // Root-task input is not applied when the graph snapshot is taken, so an
    // absent URL must require the private grant rather than under-declare.
    const declared = new A2AAgentTask({}).entitlements().entitlements;
    expect(declared.map((e) => e.id)).toContain(Entitlements.NETWORK_PRIVATE);
    expect(declared.find((e) => e.id === Entitlements.NETWORK_PRIVATE)?.resources).toBeUndefined();
  });
});

describe("A2AAgentTask transport", () => {
  it("resolves the card through SafeFetch rather than the global fetch", async () => {
    // The destination is caller-supplied, so the SSRF checks, DNS pinning and
    // redirect scoping have to be in front of it. Without a `fetchImpl` the SDK
    // reaches for `globalThis.fetch` and none of them run.
    const seen: string[] = [];
    const previous = registerSafeFetch(async (url) => {
      seen.push(url);
      throw new Error("no network in this test");
    });
    try {
      const task = new A2AAgentTask({
        defaults: { agentUrl: "https://example.test/a2a", prompt: "hi", contextId: undefined },
      });
      await expect(task.run()).rejects.toThrow();
    } finally {
      registerSafeFetch(previous);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^https:\/\/example\.test\/a2a\/.*agent-card\.json$/);
  });
});

describe("A2AAgentTask entitlement enforcement", () => {
  function makeRegistry(enforcer: IEntitlementEnforcer): ServiceRegistry {
    const registry = new ServiceRegistry(new Container());
    registry.register(ENTITLEMENT_ENFORCER, () => enforcer);
    return registry;
  }

  function makeGraph(agentUrl: string): TaskGraph {
    const graph = new TaskGraph();
    graph.addTask(
      new A2AAgentTask({
        id: "a2a-node",
        defaults: { agentUrl, prompt: "hi", contextId: undefined },
        // The enforcer is what is under test; nothing should reach a socket.
        createClient: async () => ({
          sendMessage: async () => ({
            contextId: "c1",
            state: "TASK_STATE_COMPLETED",
            parts: [textPart("ok")],
          }),
        }),
      })
    );
    return graph;
  }

  it("denies a metadata-endpoint agent under a policy without network:private", async () => {
    const runner = new TaskGraphRunner(makeGraph(METADATA_URL));
    await expect(
      runner.runGraph(
        {},
        {
          registry: makeRegistry(createPolicyEnforcer(createProfilePolicy("browser"))),
          enforceEntitlements: true,
        }
      )
    ).rejects.toThrow(TaskEntitlementError);
  });

  it("allows a public agent under the same policy", async () => {
    const runner = new TaskGraphRunner(makeGraph("https://example.test/a2a"));
    await expect(
      runner.runGraph(
        {},
        {
          registry: makeRegistry(createPolicyEnforcer(createProfilePolicy("browser"))),
          enforceEntitlements: true,
        }
      )
    ).resolves.toBeDefined();
  });
});
