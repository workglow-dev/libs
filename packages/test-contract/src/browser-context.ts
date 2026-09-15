/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for `IBrowserContext` — tab lifecycle, ARIA round trip and
 * network introspection, over every browser backend.
 */

export * from "./browser-context/ConformanceMockContext";
export * from "./browser-context/fixtures";
export * from "./browser-context/runIBrowserContextConformance";
export * from "./browser-context/types";
export * from "./browser-context/assertions/ariaRoundTrip";
export * from "./browser-context/assertions/capabilityHonesty";
export * from "./browser-context/assertions/itExpectFail";
export * from "./browser-context/assertions/networkIntrospection";
export * from "./browser-context/assertions/tabsLifecycle";
