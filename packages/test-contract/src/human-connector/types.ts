/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IHumanConnector, IHumanRequest, IHumanResponse } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";

/**
 * Stable identifiers for each conformance assertion. Add to `expectedFailures`
 * to mark an assertion as known-failing without skipping it.
 */
export type HumanConnectorAssertionId =
  | "roundtrip.accept"
  | "roundtrip.decline"
  | "roundtrip.cancel"
  | "roundtrip.confirm.accept"
  | "roundtrip.confirm.decline"
  | "roundtrip.confirm.details"
  | "roundtrip.confirm.noContent"
  | "abort.beforeSend"
  | "abort.midElicit"
  | "concurrent.isolation"
  | "notify.fastResolve"
  | "display.fastResolve"
  | "multiTurn.followUp"
  | "capabilityHonesty";

export interface HumanConnectorCapabilities {
  /** Connector handles `kind: "elicit"` requests with a real human-driven response. */
  readonly elicit: boolean;
  /**
   * Connector handles `kind: "confirm"` requests with a real human decision.
   * A connector without a native approval primitive may map it onto its
   * elicitation path and still declare true — what it must not do is answer
   * "accept" without asking anyone.
   */
  readonly confirm: boolean;
  /** Connector handles `kind: "notify"` requests (fast-resolve, no script consumption). */
  readonly notify: boolean;
  /** Connector handles `kind: "display"` requests (fast-resolve, no script consumption). */
  readonly display: boolean;
  /** Connector implements `followUp()` for multi-turn elicit conversations. */
  readonly multiTurn: boolean;
  /** Connector correctly isolates concurrent in-flight `send()` calls. */
  readonly concurrent: boolean;
  /** Connector honors `AbortSignal` while an elicit is in flight (mid-flight abort). */
  readonly abortMidElicit: boolean;
}

/**
 * Either an exact response, or a request-aware function. FIFO consumption.
 */
export type MockResponseEntry =
  | IHumanResponse
  | ((req: IHumanRequest) => IHumanResponse | Promise<IHumanResponse>);

/**
 * Test-side handle for driving the human side of an `IHumanConnector`. Every
 * adapter wired into the conformance suite must expose a `MockResponseScript`
 * — for `MockHumanConnector` it's the connector's own queue; for real
 * adapters (e.g. McpElicitationConnector) the factory wires `push(...)` to
 * the paired UI's response.
 */
export interface MockResponseScript {
  /** Push an exact response or a request-aware response function. FIFO. */
  push(entry: MockResponseEntry): void;
  /**
   * Push a deferred handle. The next `send()` blocks until `release(response)`
   * is called. Releasing after the awaiting `send()` has rejected is a no-op.
   */
  pushDeferred(): { release(response: IHumanResponse): void };
  /** Inspect what was sent (in order received). */
  readonly received: ReadonlyArray<IHumanRequest>;
  /** Reset between tests (clears queue and received history). */
  clear(): void;
}

export interface HumanConnectorConformanceHandle {
  readonly connector: IHumanConnector;
  readonly script: MockResponseScript;
  dispose(): Promise<void>;
}

export interface ConformanceFixture {
  /** Default elicit form schema. */
  readonly elicitContentSchema: DataPortSchema;
  /** Default content data the script returns when accepting an elicit. */
  readonly elicitAcceptContent: Record<string, unknown>;
  /** Default notify request payload. */
  readonly notifyRequest: Pick<IHumanRequest, "message" | "contentSchema" | "contentData">;
  /** Default display request payload. */
  readonly displayRequest: Pick<IHumanRequest, "message" | "contentSchema" | "contentData">;
  /** Default confirm request payload — the action awaiting approval. */
  readonly confirmRequest: Pick<IHumanRequest, "message" | "contentSchema" | "contentData">;
  /** Bound for abort propagation (ms). */
  readonly abortGraceMs: number;
}

export interface HumanConnectorConformanceOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout: number;
  readonly factory: () => Promise<HumanConnectorConformanceHandle>;
  readonly capabilities: HumanConnectorCapabilities;
  readonly fixture?: Partial<ConformanceFixture>;
  /**
   * Assertions known to fail. Each named id is wrapped in `it.fails` instead
   * of `it`. Remove the entry once the adapter bug is fixed.
   */
  readonly expectedFailures?: ReadonlyArray<HumanConnectorAssertionId>;
}
