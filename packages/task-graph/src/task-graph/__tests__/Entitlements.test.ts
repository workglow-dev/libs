/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  can,
  computeGraphEntitlements,
  createGrantListEnforcer,
  createPolicyEnforcer,
  createProfileEnforcer,
  createScopedEnforcer,
  DENY_ALL_RESOLVER,
  EMPTY_ENTITLEMENTS,
  ENTITLEMENT_ENFORCER,
  entitlementCovers,
  Entitlements,
  evaluatePolicy,
  getProfileGrants,
  grantCoversResources,
  mergeEntitlementPair,
  mergeEntitlements,
  PERMISSIVE_RESOLVER,
  resourcePatternMatches,
  Task,
  TaskEntitlementError,
  TaskGraph,
  TaskGraphRunner,
  type EntitlementPolicy,
  type IEntitlementResolver,
  type TaskEntitlements,
} from "@workglow/task-graph";
import { Container, ServiceRegistry, setLogger } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ========================================================================
// Test Tasks
// ========================================================================

class NetworkTask extends Task {
  static override readonly type = "NetworkTask";
  static override entitlements(): TaskEntitlements {
    return {
      entitlements: [{ id: Entitlements.NETWORK_HTTP, reason: "Fetches data" }],
    };
  }
  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { url: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { data: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute() {
    return { data: "ok" };
  }
}

class CodeExecTask extends Task {
  static override readonly type = "CodeExecTask";
  static override entitlements(): TaskEntitlements {
    return {
      entitlements: [{ id: Entitlements.CODE_EXECUTION_JS, reason: "Runs JS" }],
    };
  }
  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { code: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { result: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute() {
    return { result: "done" };
  }
}

class OptionalCredentialTask extends Task {
  static override readonly type = "OptionalCredentialTask";
  static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        { id: Entitlements.NETWORK_HTTP, reason: "Fetches data" },
        { id: Entitlements.CREDENTIAL, reason: "Auth is optional", optional: true },
      ],
    };
  }
  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { data: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute() {
    return { data: "ok" };
  }
}

class NoEntitlementTask extends Task {
  static override readonly type = "NoEntitlementTask";
  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { input: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { output: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute() {
    return { output: "pass" };
  }
}

class ScopedAiTask extends Task {
  static override readonly type = "ScopedAiTask";
  static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        { id: Entitlements.AI_MODEL, reason: "Uses specific model", resources: ["claude-3-opus"] },
      ],
    };
  }
  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }
  override async execute() {
    return {};
  }
}

// ========================================================================
// Tests
// ========================================================================

describe("Entitlements", () => {
  const logger = getTestingLogger();
  setLogger(logger);

  // ======================================================================
  // entitlementCovers
  // ======================================================================

  describe("entitlementCovers", () => {
    it("exact match", () => {
      expect(entitlementCovers("network", "network")).toBe(true);
    });

    it("parent covers child", () => {
      expect(entitlementCovers("network", "network:http")).toBe(true);
    });

    it("parent covers deeply nested child", () => {
      expect(entitlementCovers("network", "network:http:internal")).toBe(true);
    });

    it("child does not cover parent", () => {
      expect(entitlementCovers("network:http", "network")).toBe(false);
    });

    it("sibling does not cover sibling", () => {
      expect(entitlementCovers("network:http", "network:websocket")).toBe(false);
    });

    it("partial prefix does not match", () => {
      expect(entitlementCovers("net", "network")).toBe(false);
    });

    it("prefix without colon separator does not match", () => {
      expect(entitlementCovers("network", "network-http")).toBe(false);
    });
  });

  // ======================================================================
  // resourcePatternMatches
  // ======================================================================

  describe("resourcePatternMatches", () => {
    it("exact match", () => {
      expect(resourcePatternMatches("api.example.com", "api.example.com")).toBe(true);
    });

    it("no match without wildcard", () => {
      expect(resourcePatternMatches("api.example.com", "other.example.com")).toBe(false);
    });

    it("trailing wildcard (prefix*)", () => {
      expect(resourcePatternMatches("claude-*", "claude-3-opus")).toBe(true);
    });

    it("leading wildcard (*suffix)", () => {
      expect(resourcePatternMatches("*.example.com", "api.example.com")).toBe(true);
    });

    it("infix wildcard (pre*suf)", () => {
      expect(resourcePatternMatches("/tmp/*.json", "/tmp/data.json")).toBe(true);
    });

    it("infix wildcard does not match when suffix is wrong", () => {
      expect(resourcePatternMatches("/tmp/*.json", "/tmp/data.xml")).toBe(false);
    });

    it("wildcard matches empty string", () => {
      expect(resourcePatternMatches("prefix*", "prefix")).toBe(true);
    });

    it("wildcard does not match shorter than prefix+suffix", () => {
      expect(resourcePatternMatches("abc*xyz", "abxyz")).toBe(false);
    });

    it("bare wildcard matches anything", () => {
      expect(resourcePatternMatches("*", "anything")).toBe(true);
    });

    it("bare wildcard matches empty string", () => {
      expect(resourcePatternMatches("*", "")).toBe(true);
    });

    it("multi-wildcard URL pattern matches", () => {
      expect(resourcePatternMatches("https://localhost:*/*", "https://localhost:3000/foo")).toBe(
        true
      );
    });

    it("multi-wildcard URL pattern requires each wildcard segment", () => {
      expect(resourcePatternMatches("https://localhost:*/*", "https://localhost:3000")).toBe(false);
    });

    it("multi-wildcard pattern matches with zero-length wildcards", () => {
      expect(resourcePatternMatches("a*b*c", "abc")).toBe(true);
    });

    it("multi-wildcard pattern matches with content between segments", () => {
      expect(resourcePatternMatches("a*b*c", "aXXbYYc")).toBe(true);
    });

    it("multi-wildcard pattern rejects out-of-order segments", () => {
      expect(resourcePatternMatches("a*b*c", "acb")).toBe(false);
    });

    it("wrapped wildcards match single character", () => {
      expect(resourcePatternMatches("*a*", "a")).toBe(true);
    });

    it("wrapped wildcards do not match when required segment is missing", () => {
      expect(resourcePatternMatches("*a*", "")).toBe(false);
    });

    it("consecutive wildcards collapse", () => {
      expect(resourcePatternMatches("**", "anything")).toBe(true);
    });
  });

  // ======================================================================
  // grantCoversResources
  // ======================================================================

  describe("grantCoversResources", () => {
    it("broad grant covers any resource requirement", () => {
      expect(
        grantCoversResources(
          { id: "network" },
          { id: "network:http", resources: ["api.example.com"] }
        )
      ).toBe(true);
    });

    it("broad grant covers broad requirement", () => {
      expect(grantCoversResources({ id: "network" }, { id: "network:http" })).toBe(true);
    });

    it("scoped grant cannot cover broad requirement", () => {
      expect(
        grantCoversResources(
          { id: "network", resources: ["api.example.com"] },
          { id: "network:http" }
        )
      ).toBe(false);
    });

    it("scoped grant covers matching resource", () => {
      expect(
        grantCoversResources(
          { id: "ai:model", resources: ["claude-*"] },
          { id: "ai:model", resources: ["claude-3-opus"] }
        )
      ).toBe(true);
    });

    it("scoped grant rejects non-matching resource", () => {
      expect(
        grantCoversResources(
          { id: "ai:model", resources: ["claude-*"] },
          { id: "ai:model", resources: ["gpt-4o"] }
        )
      ).toBe(false);
    });

    it("scoped grant must cover ALL required resources", () => {
      expect(
        grantCoversResources(
          { id: "ai:model", resources: ["claude-*"] },
          { id: "ai:model", resources: ["claude-3-opus", "gpt-4o"] }
        )
      ).toBe(false);
    });

    it("multi-wildcard URL grant covers localhost request", () => {
      expect(
        grantCoversResources(
          { id: "network:http", resources: ["https://localhost:*/*"] },
          { id: "network:http", resources: ["https://localhost:3000/foo"] }
        )
      ).toBe(true);
    });
  });

  // ======================================================================
  // mergeEntitlementPair
  // ======================================================================

  describe("mergeEntitlementPair", () => {
    it("two required entitlements stay required", () => {
      const a = { id: "network" };
      const b = { id: "network" };
      const result = mergeEntitlementPair(a, b);
      expect(result.optional).toBeUndefined();
    });

    it("one optional + one required = required", () => {
      const a = { id: "network", optional: true };
      const b = { id: "network" };
      const result = mergeEntitlementPair(a, b);
      expect(result.optional).toBeUndefined();
    });

    it("both optional = optional", () => {
      const a = { id: "network", optional: true };
      const b = { id: "network", optional: true };
      const result = mergeEntitlementPair(a, b);
      expect(result.optional).toBe(true);
    });

    it("first reason wins", () => {
      const a = { id: "network", reason: "first" };
      const b = { id: "network", reason: "second" };
      const result = mergeEntitlementPair(a, b);
      expect(result.reason).toBe("first");
    });

    it("falls back to second reason if first is undefined", () => {
      const a = { id: "network" };
      const b = { id: "network", reason: "second" };
      const result = mergeEntitlementPair(a, b);
      expect(result.reason).toBe("second");
    });

    it("resources are unioned", () => {
      const a = { id: "ai:model", resources: ["claude-3-opus"] as const };
      const b = { id: "ai:model", resources: ["gpt-4o"] as const };
      const result = mergeEntitlementPair(a, b);
      expect(result.resources).toEqual(expect.arrayContaining(["claude-3-opus", "gpt-4o"]));
      expect(result.resources).toHaveLength(2);
    });

    it("resources deduplicated", () => {
      const a = { id: "ai:model", resources: ["claude-3-opus"] as const };
      const b = { id: "ai:model", resources: ["claude-3-opus"] as const };
      const result = mergeEntitlementPair(a, b);
      expect(result.resources).toEqual(["claude-3-opus"]);
    });

    it("one with resources + one without = undefined (broad)", () => {
      const a = { id: "network", resources: ["api.example.com"] as const };
      const b = { id: "network" };
      const result = mergeEntitlementPair(a, b);
      // When one side is broad (resources undefined), the merged result remains broad
      expect(result.resources).toBeUndefined();
    });

    it("both without resources = undefined", () => {
      const a = { id: "network" };
      const b = { id: "network" };
      const result = mergeEntitlementPair(a, b);
      expect(result.resources).toBeUndefined();
    });
  });

  // ======================================================================
  // mergeEntitlements
  // ======================================================================

  describe("mergeEntitlements", () => {
    it("empty + non-empty returns non-empty", () => {
      const a = EMPTY_ENTITLEMENTS;
      const b: TaskEntitlements = { entitlements: [{ id: "network" }] };
      expect(mergeEntitlements(a, b)).toBe(b);
    });

    it("non-empty + empty returns non-empty", () => {
      const a: TaskEntitlements = { entitlements: [{ id: "network" }] };
      const b = EMPTY_ENTITLEMENTS;
      expect(mergeEntitlements(a, b)).toBe(a);
    });

    it("merges distinct entitlements", () => {
      const a: TaskEntitlements = { entitlements: [{ id: "network" }] };
      const b: TaskEntitlements = { entitlements: [{ id: "filesystem" }] };
      const result = mergeEntitlements(a, b);
      expect(result.entitlements).toHaveLength(2);
      expect(result.entitlements.map((e) => e.id)).toEqual(
        expect.arrayContaining(["network", "filesystem"])
      );
    });

    it("merges same-id entitlements", () => {
      const a: TaskEntitlements = {
        entitlements: [{ id: "network", optional: true }],
      };
      const b: TaskEntitlements = {
        entitlements: [{ id: "network" }],
      };
      const result = mergeEntitlements(a, b);
      expect(result.entitlements).toHaveLength(1);
      expect(result.entitlements[0].optional).toBeUndefined();
    });
  });

  // ======================================================================
  // createGrantListEnforcer
  // ======================================================================

  describe("createGrantListEnforcer", () => {
    it("grants matching entitlement", async () => {
      const enforcer = createGrantListEnforcer(["network"]);
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "network:http" }],
      });
      expect(denied).toHaveLength(0);
    });

    it("denies non-matching entitlement", async () => {
      const enforcer = createGrantListEnforcer(["network"]);
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "filesystem:read" }],
      });
      expect(denied).toHaveLength(1);
      expect(denied[0].entitlement.id).toBe("filesystem:read");
      expect(denied[0].reason).toBe("default-deny");
    });

    it("skips optional entitlements", async () => {
      const enforcer = createGrantListEnforcer(["network"]);
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "credential", optional: true }],
      });
      expect(denied).toHaveLength(0);
    });

    it("grants multiple matching entitlements", async () => {
      const enforcer = createGrantListEnforcer(["network", "code-execution"]);
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "network:http" }, { id: "code-execution:javascript" }],
      });
      expect(denied).toHaveLength(0);
    });
  });

  // ======================================================================
  // createScopedEnforcer
  // ======================================================================

  describe("createScopedEnforcer", () => {
    it("broad grant covers any resource", async () => {
      const enforcer = createScopedEnforcer([{ id: "ai:model" }]);
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "ai:model", resources: ["claude-3-opus"] }],
      });
      expect(denied).toHaveLength(0);
    });

    it("scoped grant covers matching resource", async () => {
      const enforcer = createScopedEnforcer([{ id: "ai:model", resources: ["claude-*"] }]);
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "ai:model", resources: ["claude-3-opus"] }],
      });
      expect(denied).toHaveLength(0);
    });

    it("scoped grant denies non-matching resource", async () => {
      const enforcer = createScopedEnforcer([{ id: "ai:model", resources: ["claude-*"] }]);
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "ai:model", resources: ["gpt-4o"] }],
      });
      expect(denied).toHaveLength(1);
    });

    it("scoped grant cannot cover broad requirement", async () => {
      const enforcer = createScopedEnforcer([{ id: "network", resources: ["api.example.com"] }]);
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "network:http" }],
      });
      expect(denied).toHaveLength(1);
    });
  });

  // ======================================================================
  // createProfileEnforcer
  // ======================================================================

  describe("createProfileEnforcer", () => {
    it("browser profile grants network", async () => {
      const enforcer = createProfileEnforcer("browser");
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "network:http" }],
      });
      expect(denied).toHaveLength(0);
    });

    it("browser profile denies filesystem", async () => {
      const enforcer = createProfileEnforcer("browser");
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "filesystem:read" }],
      });
      expect(denied).toHaveLength(1);
    });

    it("browser profile grants code-execution:javascript", async () => {
      const enforcer = createProfileEnforcer("browser");
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "code-execution:javascript" }],
      });
      expect(denied).toHaveLength(0);
    });

    // Only the JavaScript leaf: a broader grant would cover any runtime a task
    // declares under `code-execution`.
    it("browser profile denies other code-execution", async () => {
      const enforcer = createProfileEnforcer("browser");
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "code-execution" }, { id: "code-execution:python" }],
      });
      expect(denied).toHaveLength(2);
    });

    it("browser profile denies mcp:stdio", async () => {
      const enforcer = createProfileEnforcer("browser");
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "mcp:stdio" }],
      });
      expect(denied).toHaveLength(1);
    });

    it("desktop profile grants filesystem", async () => {
      const enforcer = createProfileEnforcer("desktop");
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "filesystem:read" }],
      });
      expect(denied).toHaveLength(0);
    });

    it("desktop profile grants code-execution", async () => {
      const enforcer = createProfileEnforcer("desktop");
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "code-execution:javascript" }],
      });
      expect(denied).toHaveLength(0);
    });

    it("desktop profile grants mcp:stdio", async () => {
      const enforcer = createProfileEnforcer("desktop");
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "mcp:stdio" }],
      });
      expect(denied).toHaveLength(0);
    });

    it("server profile extends desktop with browser:cloud", () => {
      const serverGrants = getProfileGrants("server");
      const desktopGrants = getProfileGrants("desktop");
      expect(serverGrants).toEqual([...desktopGrants, { id: Entitlements.BROWSER_CONTROL_CLOUD }]);
    });
  });

  // ======================================================================
  // computeGraphEntitlements
  // ======================================================================

  describe("computeGraphEntitlements", () => {
    it("empty graph returns empty entitlements", () => {
      const graph = new TaskGraph();
      const result = computeGraphEntitlements(graph);
      expect(result.entitlements).toHaveLength(0);
    });

    it("single task returns its entitlements", () => {
      const graph = new TaskGraph();
      graph.addTask(new NetworkTask({ id: "t1" }));
      const result = computeGraphEntitlements(graph);
      expect(result.entitlements).toHaveLength(1);
      expect(result.entitlements[0].id).toBe(Entitlements.NETWORK_HTTP);
    });

    it("aggregates entitlements from multiple tasks", () => {
      const graph = new TaskGraph();
      graph.addTask(new NetworkTask({ id: "t1" }));
      graph.addTask(new CodeExecTask({ id: "t2" }));
      const result = computeGraphEntitlements(graph);
      expect(result.entitlements).toHaveLength(2);
      const ids = result.entitlements.map((e) => e.id);
      expect(ids).toContain(Entitlements.NETWORK_HTTP);
      expect(ids).toContain(Entitlements.CODE_EXECUTION_JS);
    });

    it("deduplicates same entitlement from multiple tasks", () => {
      const graph = new TaskGraph();
      graph.addTask(new NetworkTask({ id: "t1" }));
      graph.addTask(new NetworkTask({ id: "t2" }));
      const result = computeGraphEntitlements(graph);
      expect(result.entitlements).toHaveLength(1);
    });

    it("task with no entitlements is skipped", () => {
      const graph = new TaskGraph();
      graph.addTask(new NoEntitlementTask({ id: "t1" }));
      const result = computeGraphEntitlements(graph);
      expect(result.entitlements).toHaveLength(0);
    });

    it("tracks origins when requested", () => {
      const graph = new TaskGraph();
      graph.addTask(new NetworkTask({ id: "t1" }));
      graph.addTask(new NetworkTask({ id: "t2" }));
      const result = computeGraphEntitlements(graph, { trackOrigins: true });
      expect(result.entitlements).toHaveLength(1);
      const tracked = result.entitlements[0];
      expect(tracked.sourceTaskIds).toEqual(expect.arrayContaining(["t1", "t2"]));
    });
  });

  // ======================================================================
  // Task entitlements integration
  // ======================================================================

  describe("Task.entitlements()", () => {
    it("base Task returns empty entitlements", () => {
      const task = new NoEntitlementTask({ id: "t1" });
      const result = task.entitlements();
      expect(result.entitlements).toHaveLength(0);
    });

    it("subclass with static entitlements returns them from instance", () => {
      const task = new NetworkTask({ id: "t1" });
      const result = task.entitlements();
      expect(result.entitlements).toHaveLength(1);
      expect(result.entitlements[0].id).toBe(Entitlements.NETWORK_HTTP);
    });
  });

  // ======================================================================
  // TaskGraphRunner enforcement
  // ======================================================================

  describe("TaskGraphRunner entitlement enforcement", () => {
    let graph: TaskGraph;
    let registry: ServiceRegistry;

    beforeEach(() => {
      const container = new Container();
      registry = new ServiceRegistry(container);
      graph = new TaskGraph();
    });

    it("does not enforce by default", async () => {
      graph.addTask(new NetworkTask({ id: "t1", defaults: { url: "test" } }));
      const runner = new TaskGraphRunner(graph);
      // No enforcer registered, no enforceEntitlements flag — should run fine
      await expect(runner.runGraph({}, { registry })).resolves.toBeDefined();
    });

    it("throws TaskEntitlementError when enforcement denies", async () => {
      graph.addTask(new NetworkTask({ id: "t1", defaults: { url: "test" } }));
      // Register a restrictive enforcer that grants nothing
      registry.register(ENTITLEMENT_ENFORCER, () => createGrantListEnforcer([]));
      const runner = new TaskGraphRunner(graph);
      await expect(runner.runGraph({}, { registry, enforceEntitlements: true })).rejects.toThrow(
        TaskEntitlementError
      );
    });

    it("passes when enforcer grants required entitlements", async () => {
      graph.addTask(new NetworkTask({ id: "t1", defaults: { url: "test" } }));
      registry.register(ENTITLEMENT_ENFORCER, () => createGrantListEnforcer(["network"]));
      const runner = new TaskGraphRunner(graph);
      await expect(
        runner.runGraph({}, { registry, enforceEntitlements: true })
      ).resolves.toBeDefined();
    });

    it("optional entitlements do not cause denial", async () => {
      graph.addTask(new OptionalCredentialTask({ id: "t1" }));
      // Only grant network, not credential (which is optional)
      registry.register(ENTITLEMENT_ENFORCER, () => createGrantListEnforcer(["network"]));
      const runner = new TaskGraphRunner(graph);
      await expect(
        runner.runGraph({}, { registry, enforceEntitlements: true })
      ).resolves.toBeDefined();
    });

    it("scoped enforcer denies wrong resource", async () => {
      graph.addTask(new ScopedAiTask({ id: "t1" }));
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createScopedEnforcer([{ id: "ai:model", resources: ["gpt-*"] }])
      );
      const runner = new TaskGraphRunner(graph);
      await expect(runner.runGraph({}, { registry, enforceEntitlements: true })).rejects.toThrow(
        TaskEntitlementError
      );
    });

    it("scoped enforcer allows matching resource", async () => {
      graph.addTask(new ScopedAiTask({ id: "t1" }));
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createScopedEnforcer([{ id: "ai:model", resources: ["claude-*"] }])
      );
      const runner = new TaskGraphRunner(graph);
      await expect(
        runner.runGraph({}, { registry, enforceEntitlements: true })
      ).resolves.toBeDefined();
    });
  });

  // ======================================================================
  // evaluatePolicy
  // ======================================================================

  describe("evaluatePolicy", () => {
    it("deny overrides grant for same entitlement", () => {
      const policy: EntitlementPolicy = {
        deny: [{ id: "network:http" }],
        grant: [{ id: "network" }],
        ask: [],
      };
      const results = evaluatePolicy(policy, {
        entitlements: [{ id: "network:http" }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].verdict).toBe("denied");
    });

    it("deny with resource scoping blocks specific resources", () => {
      const policy: EntitlementPolicy = {
        deny: [{ id: "filesystem:write", resources: ["/etc/*"] }],
        grant: [{ id: "filesystem" }],
        ask: [],
      };
      // Writing to /etc/passwd — denied
      const deniedResults = evaluatePolicy(policy, {
        entitlements: [{ id: "filesystem:write", resources: ["/etc/passwd"] }],
      });
      expect(deniedResults[0].verdict).toBe("denied");

      // Writing to /tmp/data — granted (deny doesn't match)
      const grantedResults = evaluatePolicy(policy, {
        entitlements: [{ id: "filesystem:write", resources: ["/tmp/data"] }],
      });
      expect(grantedResults[0].verdict).toBe("granted");
    });

    it("grant without matching deny is granted", () => {
      const policy: EntitlementPolicy = {
        deny: [],
        grant: [{ id: "network" }],
        ask: [],
      };
      const results = evaluatePolicy(policy, {
        entitlements: [{ id: "network:http" }],
      });
      expect(results[0].verdict).toBe("granted");
    });

    it("ask rule produces ask verdict", () => {
      const policy: EntitlementPolicy = {
        deny: [],
        grant: [],
        ask: [{ id: "network" }],
      };
      const results = evaluatePolicy(policy, {
        entitlements: [{ id: "network:http" }],
      });
      expect(results[0].verdict).toBe("ask");
    });

    it("no matching rules produces denied (default deny)", () => {
      const policy: EntitlementPolicy = {
        deny: [],
        grant: [],
        ask: [],
      };
      const results = evaluatePolicy(policy, {
        entitlements: [{ id: "network:http" }],
      });
      expect(results[0].verdict).toBe("denied");
    });

    it("skips optional entitlements", () => {
      const policy: EntitlementPolicy = {
        deny: [],
        grant: [],
        ask: [],
      };
      const results = evaluatePolicy(policy, {
        entitlements: [{ id: "network:http", optional: true }],
      });
      expect(results).toHaveLength(0);
    });

    it("deny > grant > ask > default deny ordering", () => {
      const policy: EntitlementPolicy = {
        deny: [{ id: "filesystem:write" }],
        grant: [{ id: "network" }],
        ask: [{ id: "code-execution" }],
      };
      const results = evaluatePolicy(policy, {
        entitlements: [
          { id: "filesystem:write" }, // denied by deny rule
          { id: "network:http" }, // granted
          { id: "code-execution:javascript" }, // ask
          { id: "storage:read" }, // default deny
        ],
      });
      expect(results).toHaveLength(4);
      expect(results[0].verdict).toBe("denied");
      expect(results[1].verdict).toBe("granted");
      expect(results[2].verdict).toBe("ask");
      expect(results[3].verdict).toBe("denied");
    });

    it("includes matched rule in result", () => {
      const denyRule = { id: "filesystem:write", resources: ["/etc/*"] };
      const policy: EntitlementPolicy = {
        deny: [denyRule],
        grant: [{ id: "network" }],
        ask: [],
      };
      const results = evaluatePolicy(policy, {
        entitlements: [{ id: "filesystem:write", resources: ["/etc/passwd"] }],
      });
      expect(results[0].matchedRule).toBe(denyRule);
    });

    it("default-denied result has no matched rule", () => {
      const policy: EntitlementPolicy = { deny: [], grant: [], ask: [] };
      const results = evaluatePolicy(policy, {
        entitlements: [{ id: "network:http" }],
      });
      expect(results[0].matchedRule).toBeUndefined();
    });

    // ====================================================================
    // Explicit verdict matrix — one row per (rule-source × hierarchy ×
    // resource-scope) combination that needs to behave the same way every
    // release. Add a row whenever a new dimension is introduced.
    // ====================================================================
    describe("verdict matrix", () => {
      type MatrixRow = {
        readonly name: string;
        readonly policy: EntitlementPolicy;
        readonly required: TaskEntitlements;
        readonly expected: "granted" | "denied" | "ask";
      };
      const rows: readonly MatrixRow[] = [
        {
          name: "exact deny",
          policy: { deny: [{ id: "network:http" }], grant: [], ask: [] },
          required: { entitlements: [{ id: "network:http" }] },
          expected: "denied",
        },
        {
          name: "hierarchical deny (parent covers child)",
          policy: { deny: [{ id: "network" }], grant: [], ask: [] },
          required: { entitlements: [{ id: "network:http" }] },
          expected: "denied",
        },
        {
          name: "scoped deny matches resource",
          policy: {
            deny: [{ id: "filesystem:write", resources: ["/etc/*"] }],
            grant: [{ id: "filesystem" }],
            ask: [],
          },
          required: { entitlements: [{ id: "filesystem:write", resources: ["/etc/passwd"] }] },
          expected: "denied",
        },
        {
          name: "scoped deny misses, falls through to grant",
          policy: {
            deny: [{ id: "filesystem:write", resources: ["/etc/*"] }],
            grant: [{ id: "filesystem" }],
            ask: [],
          },
          required: { entitlements: [{ id: "filesystem:write", resources: ["/tmp/data"] }] },
          expected: "granted",
        },
        {
          name: "exact grant",
          policy: { deny: [], grant: [{ id: "network:http" }], ask: [] },
          required: { entitlements: [{ id: "network:http" }] },
          expected: "granted",
        },
        {
          name: "hierarchical grant (parent covers child)",
          policy: { deny: [], grant: [{ id: "network" }], ask: [] },
          required: { entitlements: [{ id: "network:http" }] },
          expected: "granted",
        },
        {
          name: "scoped grant matches resource pattern",
          policy: { deny: [], grant: [{ id: "ai:model", resources: ["claude-*"] }], ask: [] },
          required: { entitlements: [{ id: "ai:model", resources: ["claude-3-opus"] }] },
          expected: "granted",
        },
        {
          name: "scoped grant misses resource, falls through to ask",
          policy: {
            deny: [],
            grant: [{ id: "ai:model", resources: ["claude-*"] }],
            ask: [{ id: "ai:model" }],
          },
          required: { entitlements: [{ id: "ai:model", resources: ["gpt-4"] }] },
          expected: "ask",
        },
        {
          name: "scoped grant cannot cover broad requirement",
          policy: { deny: [], grant: [{ id: "network", resources: ["api.example.com"] }], ask: [] },
          required: { entitlements: [{ id: "network:http" }] },
          expected: "denied",
        },
        {
          name: "exact ask",
          policy: { deny: [], grant: [], ask: [{ id: "network:http" }] },
          required: { entitlements: [{ id: "network:http" }] },
          expected: "ask",
        },
        {
          name: "hierarchical ask (parent covers child)",
          policy: { deny: [], grant: [], ask: [{ id: "network" }] },
          required: { entitlements: [{ id: "network:http" }] },
          expected: "ask",
        },
        {
          name: "no rule matches → default deny",
          policy: { deny: [], grant: [], ask: [] },
          required: { entitlements: [{ id: "network:http" }] },
          expected: "denied",
        },
      ];

      it.each(rows)("$name → $expected", ({ policy, required, expected }) => {
        const results = evaluatePolicy(policy, required);
        expect(results).toHaveLength(1);
        expect(results[0].verdict).toBe(expected);
      });

      it("optional requirement is skipped regardless of policy", () => {
        const results = evaluatePolicy(
          { deny: [{ id: "network" }], grant: [], ask: [] },
          { entitlements: [{ id: "network:http", optional: true }] }
        );
        expect(results).toHaveLength(0);
      });
    });
  });

  // ======================================================================
  // can() helper
  // ======================================================================

  describe("can", () => {
    const policy: EntitlementPolicy = {
      deny: [{ id: "filesystem:write", resources: ["/etc/*"] }],
      grant: [{ id: "network" }, { id: "filesystem" }],
      ask: [{ id: "code-execution" }],
    };

    it("returns granted verdict for covered entitlement", () => {
      const result = can(policy, "network:http");
      expect(result.verdict).toBe("granted");
      expect(result.entitlement.id).toBe("network:http");
    });

    it("returns ask verdict for ask-rule match", () => {
      const result = can(policy, "code-execution:javascript");
      expect(result.verdict).toBe("ask");
    });

    it("returns denied verdict for default-deny", () => {
      const result = can(policy, "storage:read");
      expect(result.verdict).toBe("denied");
      expect(result.matchedRule).toBeUndefined();
    });

    it("respects resource scope when provided", () => {
      const allowed = can(policy, "filesystem:write", ["/tmp/data"]);
      expect(allowed.verdict).toBe("granted");
      const blocked = can(policy, "filesystem:write", ["/etc/passwd"]);
      expect(blocked.verdict).toBe("denied");
      expect(blocked.matchedRule?.id).toBe("filesystem:write");
    });
  });

  // ======================================================================
  // createPolicyEnforcer
  // ======================================================================

  describe("createPolicyEnforcer", () => {
    it("deny rules cause checkAll to return denied entitlements", async () => {
      const enforcer = createPolicyEnforcer({
        deny: [{ id: "network:http" }],
        grant: [{ id: "network" }],
        ask: [],
      });
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "network:http" }],
      });
      expect(denied).toHaveLength(1);
      const firstDenial = denied[0];
      expect(firstDenial.entitlement.id).toBe("network:http");
      expect(firstDenial.reason).toBe("policy-deny");
      if (firstDenial.reason === "policy-deny") {
        expect(firstDenial.matchedRule?.id).toBe("network:http");
      }
    });

    it("ask with PERMISSIVE_RESOLVER grants", async () => {
      const enforcer = createPolicyEnforcer(
        { deny: [], grant: [], ask: [{ id: "network" }] },
        PERMISSIVE_RESOLVER
      );
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "network:http" }],
      });
      expect(denied).toHaveLength(0);
    });

    it("ask with DENY_ALL_RESOLVER denies", async () => {
      const enforcer = createPolicyEnforcer(
        { deny: [], grant: [], ask: [{ id: "network" }] },
        DENY_ALL_RESOLVER
      );
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "network:http" }],
      });
      expect(denied).toHaveLength(1);
    });

    it("ask calls resolver.prompt when no saved answer", async () => {
      const mockResolver: IEntitlementResolver = {
        lookup: vi.fn().mockReturnValue(undefined),
        prompt: vi.fn().mockResolvedValue("grant"),
        save: vi.fn(),
      };
      const enforcer = createPolicyEnforcer(
        { deny: [], grant: [], ask: [{ id: "network" }] },
        mockResolver
      );
      await enforcer.checkAll({ entitlements: [{ id: "network:http" }] });
      expect(mockResolver.prompt).toHaveBeenCalledOnce();
      expect(mockResolver.save).toHaveBeenCalledOnce();
    });

    it("ask uses saved answer from resolver.lookup", async () => {
      const mockResolver: IEntitlementResolver = {
        lookup: vi.fn().mockReturnValue("grant"),
        prompt: vi.fn(),
        save: vi.fn(),
      };
      const enforcer = createPolicyEnforcer(
        { deny: [], grant: [], ask: [{ id: "network" }] },
        mockResolver
      );
      await enforcer.checkAll({ entitlements: [{ id: "network:http" }] });
      expect(mockResolver.lookup).toHaveBeenCalledOnce();
      expect(mockResolver.prompt).not.toHaveBeenCalled();
    });

    it("ask with saved deny answer returns denied", async () => {
      const mockResolver: IEntitlementResolver = {
        lookup: vi.fn().mockReturnValue("deny"),
        prompt: vi.fn(),
        save: vi.fn(),
      };
      const enforcer = createPolicyEnforcer(
        { deny: [], grant: [], ask: [{ id: "network" }] },
        mockResolver
      );
      const denied = await enforcer.checkAll({
        entitlements: [{ id: "network:http" }],
      });
      expect(denied).toHaveLength(1);
    });

    it("checkTask evaluates instance entitlements", async () => {
      const enforcer = createPolicyEnforcer({
        deny: [],
        grant: [{ id: "network" }],
        ask: [],
      });
      const task = new NetworkTask({ id: "t1" });
      const denied = await enforcer.checkTask(task);
      expect(denied).toHaveLength(0);
    });

    it("checkTask denies when policy denies", async () => {
      const enforcer = createPolicyEnforcer({
        deny: [{ id: "network:http" }],
        grant: [],
        ask: [],
      });
      const task = new NetworkTask({ id: "t1" });
      const denied = await enforcer.checkTask(task);
      expect(denied).toHaveLength(1);
    });
  });

  // ======================================================================
  // TaskGraphRunner with policy enforcer
  // ======================================================================

  describe("TaskGraphRunner with policy enforcer", () => {
    let graph: TaskGraph;
    let registry: ServiceRegistry;

    beforeEach(() => {
      const container = new Container();
      registry = new ServiceRegistry(container);
      graph = new TaskGraph();
    });

    it("deny rule blocks graph execution", async () => {
      graph.addTask(new NetworkTask({ id: "t1", defaults: { url: "test" } }));
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createPolicyEnforcer({
          deny: [{ id: "network:http" }],
          grant: [{ id: "network" }],
          ask: [],
        })
      );
      const runner = new TaskGraphRunner(graph);
      await expect(runner.runGraph({}, { registry, enforceEntitlements: true })).rejects.toThrow(
        TaskEntitlementError
      );
    });

    it("ask rule with permissive resolver allows execution", async () => {
      graph.addTask(new NetworkTask({ id: "t1", defaults: { url: "test" } }));
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createPolicyEnforcer({ deny: [], grant: [], ask: [{ id: "network" }] }, PERMISSIVE_RESOLVER)
      );
      const runner = new TaskGraphRunner(graph);
      await expect(
        runner.runGraph({}, { registry, enforceEntitlements: true })
      ).resolves.toBeDefined();
    });

    it("ask rule with deny resolver blocks execution", async () => {
      graph.addTask(new NetworkTask({ id: "t1", defaults: { url: "test" } }));
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createPolicyEnforcer({ deny: [], grant: [], ask: [{ id: "network" }] }, DENY_ALL_RESOLVER)
      );
      const runner = new TaskGraphRunner(graph);
      await expect(runner.runGraph({}, { registry, enforceEntitlements: true })).rejects.toThrow(
        TaskEntitlementError
      );
    });
  });
});
