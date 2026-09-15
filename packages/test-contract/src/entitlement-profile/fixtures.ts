/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Entitlements,
  type EntitlementSignal,
  type IEntitlementSignalSource,
  type TaskEntitlement,
} from "@workglow/task-graph";

export const NETWORK_HTTP_REQUIRED: TaskEntitlement = {
  id: Entitlements.NETWORK_HTTP,
  reason: "Conformance fixture: HTTP request",
};

export const FILESYSTEM_REQUIRED: TaskEntitlement = {
  id: Entitlements.FILESYSTEM,
  reason: "Conformance fixture: filesystem access",
};

export const OPTIONAL_CREDENTIAL: TaskEntitlement = {
  id: Entitlements.CREDENTIAL,
  reason: "Conformance fixture: optional credential",
  optional: true,
};

export const SCOPED_FILESYSTEM_TMP_OK: TaskEntitlement = {
  id: Entitlements.FILESYSTEM_READ,
  reason: "Conformance fixture: scoped read of /tmp",
  resources: ["/tmp/data.json"],
};

export const SCOPED_FILESYSTEM_ETC_BAD: TaskEntitlement = {
  id: Entitlements.FILESYSTEM_READ,
  reason: "Conformance fixture: scoped read of /etc",
  resources: ["/etc/passwd"],
};

/** Guaranteed not to appear in any built-in profile surface. */
export const UNCOVERED_FOO: TaskEntitlement = {
  id: "foo:bar",
  reason: "Conformance fixture: uncovered entitlement",
};

/**
 * In-memory signal source for the Custom_Profile shim. The returned source
 * exposes `emit` so the shim's `simulateSignal` can drive listeners.
 */
export interface ControllableSignalSource extends IEntitlementSignalSource {
  emit(signal: EntitlementSignal): void;
}

export function createControllableSignalSource(): ControllableSignalSource {
  const listeners = new Set<(s: EntitlementSignal) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      let unsubbed = false;
      return () => {
        if (unsubbed) return;
        unsubbed = true;
        listeners.delete(listener);
      };
    },
    emit(signal) {
      for (const l of listeners) l(signal);
    },
  };
}
