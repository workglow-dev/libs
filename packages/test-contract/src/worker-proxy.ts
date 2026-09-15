/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parity boundary for an adapter registered through a worker: the inline
 * assertions must still hold across `postMessage`.
 */

export * from "./worker-proxy/browserOnlyStub";
export * from "./worker-proxy/runWorkerProxyBoundary";
export * from "./worker-proxy/types";
export * from "./worker-proxy/assertions/backlogOrdering";
export * from "./worker-proxy/assertions/disposeTerminatesWorker";
export * from "./worker-proxy/assertions/errorPropagation";
export * from "./worker-proxy/assertions/providerCallHelpers";
