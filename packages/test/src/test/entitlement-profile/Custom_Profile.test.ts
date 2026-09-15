/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Entitlements,
  createPolicyProfile,
  type EntitlementGrant,
  type EntitlementPolicy,
  type EntitlementSignal,
  type IEntitlementProfile,
} from "@workglow/task-graph";

import { createControllableSignalSource } from "@workglow/test-contract/entitlement-profile";
import { runEntitlementProfileConformance } from "@workglow/test-contract/entitlement-profile";

/**
 * A custom profile backed by a mutable grant set. The accompanying
 * controllable signal source has a `simulateSignal` wrapper that:
 *  - on `revoke(e)`: removes any grant whose ID equals `e.id`
 *  - on `grant(e)`:  adds a broad grant for `e.id`
 *  - on `reload`:    flips one specific entitlement (NETWORK_HTTP) per
 *                    invocation so the suite can observe a deterministic
 *                    flip; subsequent calls flip it back.
 *
 * The mutable backing is the `grant` array of the policy used to build
 * the profile. We replace it via reassignment of a wrapper holder; the
 * profile reads it lazily via a getter.
 */
function buildCustomProfile(): {
  readonly profile: IEntitlementProfile;
  simulateSignal(signal: EntitlementSignal): void;
} {
  let grants: EntitlementGrant[] = [{ id: Entitlements.NETWORK_HTTP }, { id: Entitlements.AI }];
  // The policy's `grant` array is read each time the underlying enforcer
  // calls `evaluatePolicy`, so we wrap it in a getter via Object.defineProperty.
  const policy = {
    deny: [] as never[],
    ask: [] as never[],
  } as unknown as EntitlementPolicy;
  Object.defineProperty(policy, "grant", {
    get: () => grants,
    enumerable: true,
  });

  const source = createControllableSignalSource();

  const profile = createPolicyProfile("custom", policy, { signalSource: source });

  let reloadFlipState = false;
  return {
    profile,
    simulateSignal(signal) {
      if (signal.kind === "revoke") {
        grants = grants.filter((g) => g.id !== signal.entitlement.id);
      } else if (signal.kind === "grant") {
        if (!grants.some((g) => g.id === signal.entitlement.id)) {
          grants = [...grants, { id: signal.entitlement.id }];
        }
      } else {
        // reload: flip NETWORK_HTTP grant state.
        if (reloadFlipState) {
          grants = grants.filter((g) => g.id !== Entitlements.NETWORK_HTTP);
        } else {
          if (!grants.some((g) => g.id === Entitlements.NETWORK_HTTP)) {
            grants = [...grants, { id: Entitlements.NETWORK_HTTP }];
          }
        }
        reloadFlipState = !reloadFlipState;
      }
      source.emit(signal);
    },
  };
}

runEntitlementProfileConformance({
  name: "custom",
  timeout: 5_000,
  factory: async () => {
    const built = buildCustomProfile();
    return {
      profile: built.profile,
      simulateSignal: built.simulateSignal,
      dispose: () => built.profile.dispose(),
    };
  },
  capabilities: {
    mutableSignalSource: true,
    hierarchyHonoring: true,
    resourceScoping: false, // custom profile only declares broad grants
  },
  expected: {
    surfaceIncludes: [Entitlements.NETWORK_HTTP, Entitlements.AI],
    surfaceExcludes: [Entitlements.FILESYSTEM],
  },
});
