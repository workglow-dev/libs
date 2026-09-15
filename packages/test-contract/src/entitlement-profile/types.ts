/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EntitlementId, EntitlementSignal, IEntitlementProfile } from "@workglow/task-graph";

export interface EntitlementProfileConformanceOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout: number;
  readonly factory: () => Promise<EntitlementProfileConformanceHandle>;
  readonly capabilities: EntitlementProfileCapabilities;
  readonly expected: EntitlementProfileExpected;
}

export interface EntitlementProfileCapabilities {
  /**
   * If true, the factory returns a handle whose `simulateSignal` method
   * is wired to the profile's signal source. Subscribe/* assertions are
   * gated on this flag.
   */
  readonly mutableSignalSource: boolean;
  /**
   * If true, hierarchyHonoringBlock runs. All built-ins set this true
   * because they use `createPolicyEnforcer` which honors hierarchy.
   */
  readonly hierarchyHonoring: boolean;
  /** If true, resourceScopingBlock runs. */
  readonly resourceScoping: boolean;
}

export interface EntitlementProfileExpected {
  /** Entitlement IDs that MUST appear in the profile's surface(). */
  readonly surfaceIncludes: readonly EntitlementId[];
  /** Entitlement IDs that MUST NOT appear in the profile's surface(). */
  readonly surfaceExcludes: readonly EntitlementId[];
}

export interface EntitlementProfileConformanceHandle {
  readonly profile: IEntitlementProfile;
  /**
   * Present iff `capabilities.mutableSignalSource` is true. Pushes a signal
   * as if the underlying source emitted it, so subscribe/* assertions can
   * exercise the verdict-flip path.
   */
  simulateSignal?(signal: EntitlementSignal): void;
  dispose(): Promise<void>;
}
