/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for `IHumanConnector` — the round trip of every prompt kind,
 * multi-turn follow-up, concurrency isolation and abort.
 */

export * from "./human-connector/MockHumanConnector";
export * from "./human-connector/fixtures";
export * from "./human-connector/runHumanConnectorConformance";
export * from "./human-connector/types";
export * from "./human-connector/assertions/abort";
export * from "./human-connector/assertions/capabilityHonesty";
export * from "./human-connector/assertions/concurrentIsolation";
export * from "./human-connector/assertions/multiTurnFollowUp";
export * from "./human-connector/assertions/notifyDisplayFastResolve";
export * from "./human-connector/assertions/roundtrip";
