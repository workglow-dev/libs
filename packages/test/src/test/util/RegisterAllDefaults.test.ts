/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the set `registerAllDefaults()` produces, against an ISOLATED registry.
 *
 * The global registry cannot express this assertion. Every `register*Defaults`
 * module ALSO self-registers on the global registry at module scope
 * (`registerLoggerDefaults();` at the bottom of `LoggerRegistry.ts`, and
 * thirteen siblings), and `registerAllDefaults.ts` imports all of them — so
 * deleting a call from the function body leaves the global path fully
 * populated by import side effect and the whole suite green. The bug only
 * surfaces on `createOrchestrationContext()`, whose registry gets nothing it
 * was not explicitly handed: a `format: "storage:tabular"` input then resolves
 * to the raw id string instead of the repository. No error, wrong value.
 *
 * So the fixtures below are deliberately EXACT and fail in both directions —
 * a dropped registration and an undeclared new one are both worth a failing
 * test. Update the fixture in the same commit that changes the set.
 */

import { registerAllDefaults } from "@workglow/bootstrap";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AI_PROVIDER_REGISTRY, MODEL_REPOSITORY } from "@workglow/ai";
import { KNOWLEDGE_BASE_REPOSITORY, KNOWLEDGE_BASES } from "@workglow/knowledge-base";
import { MCP_SERVER_REPOSITORY, MCP_SERVERS } from "@workglow/mcp/util";
import { TABULAR_REPOSITORIES } from "@workglow/storage";
import { TASK_CONSTRUCTORS, TRANSFORM_DEFS } from "@workglow/task-graph";
import type { ServiceToken } from "@workglow/util";
import {
  Container,
  CREDENTIAL_STORE,
  getInputCompactors,
  getInputResolvers,
  INPUT_COMPACTORS,
  INPUT_RESOLVERS,
  LOGGER,
  ServiceRegistry,
  TELEMETRY_PROVIDER,
  WORKER_MANAGER,
} from "@workglow/util";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SOURCE_PATH = join(REPO_ROOT, "packages/bootstrap/src/bootstrap/registerAllDefaults.ts");

/**
 * Every factory token `registerAllDefaults` installs, named so a failure says
 * which registrar went missing rather than only that a count moved.
 */
const EXPECTED_TOKENS: ReadonlyArray<readonly [string, ServiceToken<unknown>]> = [
  ["INPUT_RESOLVERS", INPUT_RESOLVERS as ServiceToken<unknown>],
  ["INPUT_COMPACTORS", INPUT_COMPACTORS as ServiceToken<unknown>],
  ["LOGGER", LOGGER as ServiceToken<unknown>],
  ["TELEMETRY_PROVIDER", TELEMETRY_PROVIDER as ServiceToken<unknown>],
  ["WORKER_MANAGER", WORKER_MANAGER as ServiceToken<unknown>],
  ["CREDENTIAL_STORE", CREDENTIAL_STORE as ServiceToken<unknown>],
  ["MODEL_REPOSITORY", MODEL_REPOSITORY as ServiceToken<unknown>],
  ["AI_PROVIDER_REGISTRY", AI_PROVIDER_REGISTRY as ServiceToken<unknown>],
  ["KNOWLEDGE_BASES", KNOWLEDGE_BASES as ServiceToken<unknown>],
  ["KNOWLEDGE_BASE_REPOSITORY", KNOWLEDGE_BASE_REPOSITORY as ServiceToken<unknown>],
  ["MCP_SERVERS", MCP_SERVERS as ServiceToken<unknown>],
  ["MCP_SERVER_REPOSITORY", MCP_SERVER_REPOSITORY as ServiceToken<unknown>],
  ["TABULAR_REPOSITORIES", TABULAR_REPOSITORIES as ServiceToken<unknown>],
  ["TASK_CONSTRUCTORS", TASK_CONSTRUCTORS as ServiceToken<unknown>],
  ["TRANSFORM_DEFS", TRANSFORM_DEFS as ServiceToken<unknown>],
];

/**
 * Format prefixes `Task` matches an input's `format` annotation against. A
 * missing entry is the silent failure: the raw id string reaches the task.
 */
const EXPECTED_RESOLVER_PREFIXES = [
  "credential",
  "image",
  "knowledge-base",
  "mcp-server",
  "model",
  "storage:tabular",
  "tasks",
] as const;

/**
 * One fewer than the resolvers: `image` resolves a data URI it cannot
 * round-trip back to an id, so it registers no compactor.
 */
const EXPECTED_COMPACTOR_PREFIXES = [
  "credential",
  "knowledge-base",
  "mcp-server",
  "model",
  "storage:tabular",
  "tasks",
] as const;

const bareRegistry = (): ServiceRegistry => new ServiceRegistry(new Container());

const presentTokens = (registry: ServiceRegistry): string[] =>
  EXPECTED_TOKENS.filter(([, token]) => registry.has(token)).map(([name]) => name);

describe("registerAllDefaults", () => {
  // FIRST: without this, every assertion below could pass on a registry that
  // was already populated, and the suite would prove nothing.
  it("a bare registry has none of the defaults before the call", () => {
    const registry = bareRegistry();
    expect(presentTokens(registry)).toEqual([]);
  });

  it("registers exactly these factory tokens on an isolated registry", () => {
    const registry = bareRegistry();
    registerAllDefaults(registry);
    expect(presentTokens(registry)).toEqual(EXPECTED_TOKENS.map(([name]) => name));
  });

  it("registers exactly these input-resolver prefixes", () => {
    const registry = bareRegistry();
    registerAllDefaults(registry);
    expect([...getInputResolvers(registry).keys()].sort()).toEqual([...EXPECTED_RESOLVER_PREFIXES]);
  });

  it("registers exactly these input-compactor prefixes", () => {
    const registry = bareRegistry();
    registerAllDefaults(registry);
    expect([...getInputCompactors(registry).keys()].sort()).toEqual([
      ...EXPECTED_COMPACTOR_PREFIXES,
    ]);
  });

  it("is idempotent — a second call changes nothing", () => {
    const registry = bareRegistry();
    registerAllDefaults(registry);
    const resolvers = getInputResolvers(registry);
    const firstModelResolver = resolvers.get("model");

    registerAllDefaults(registry);

    expect(presentTokens(registry)).toEqual(EXPECTED_TOKENS.map(([name]) => name));
    expect([...getInputResolvers(registry).keys()].sort()).toEqual([...EXPECTED_RESOLVER_PREFIXES]);
    expect(getInputResolvers(registry).get("model")).toBe(firstModelResolver);
  });

  /**
   * Ordering is invisible at runtime and cannot be asserted by calling the
   * function. `getInputResolvers` SELF-HEALS: handed a registry with no
   * `INPUT_RESOLVERS` map it calls `registerInputResolverDefaults` and carries
   * on, so moving `registerInputResolverDefaults` after its nine consumers
   * produces an identical registry and a green suite — until a resolver map is
   * pre-registered by a caller and the healed one silently replaces it. The
   * source text is the only place the ordering is stated, so it is the only
   * place it can be checked.
   */
  it("registers the primitive containers before their consumers", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    const body = source.slice(source.indexOf("export function registerAllDefaults"));
    const callOrder = [...body.matchAll(/^ {2}(register\w+)\(registry\);$/gm)].map(
      (match) => match[1]!
    );

    // Anti-vacuity: the regex must actually have found the call list.
    expect(callOrder.length).toBe(14);

    const primitives = [
      "registerInputResolverDefaults",
      "registerInputCompactorDefaults",
      "registerLoggerDefaults",
      "registerTelemetryDefaults",
      "registerWorkerManagerDefaults",
    ];
    // The primitives are the FIRST five calls, in that order.
    expect(callOrder.slice(0, primitives.length)).toEqual(primitives);

    // And every consumer that stores into a primitive's map comes after them.
    const consumers = [
      "registerImageDefaults",
      "registerCredentialDefaults",
      "registerModelDefaults",
      "registerKnowledgeBaseDefaults",
      "registerMcpServerDefaults",
      "registerTabularStorageDefaults",
      "registerTaskDefaults",
    ];
    const lastPrimitive = Math.max(...primitives.map((name) => callOrder.indexOf(name)));
    for (const consumer of consumers) {
      expect(callOrder.indexOf(consumer), consumer).toBeGreaterThan(lastPrimitive);
    }
  });
});
