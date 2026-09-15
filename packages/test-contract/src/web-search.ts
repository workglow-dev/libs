/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for `IWebSearchProvider` — that what a provider declares in
 * its capability record is what it refuses, what it attempts, and what it sends.
 */

export * from "./web-search/assertions/capabilityAgreement";
export * from "./web-search/assertions/credentialNaming";
export * from "./web-search/assertions/dateFiltering";
export * from "./web-search/assertions/domainNormalization";
export * from "./web-search/assertions/maxResultsCeiling";
export * from "./web-search/assertions/reportedQuery";
export * from "./web-search/assertions/signalThreading";
export * from "./web-search/fixtures";
export * from "./web-search/runWebSearchProviderConformance";
export * from "./web-search/types";
