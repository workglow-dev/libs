/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pre-built entitlement grant profiles for common runtime environments.
 * The library has no concept of Electron, brands, or deployment targets —
 * only capability profiles expressed as entitlement policies.
 */

import type { EntitlementPolicy } from "./EntitlementPolicy";
import {
  createPolicyProfile,
  type CreateProfileOptions,
  type IEntitlementProfile,
} from "./EntitlementProfile";
import type { EntitlementGrant } from "./TaskEntitlements";
import { Entitlements } from "./TaskEntitlements";

// ========================================================================
// Grant Profiles
// ========================================================================

/**
 * Browser environment grants.
 * No filesystem access, no stdio MCP, and no code execution beyond JavaScript.
 *
 * `code-execution:javascript` is granted, and only that leaf: `JavaScriptTask`
 * runs its code in its own interpreter, not through `eval` or `Function`, so
 * the code reaches nothing the interpreter does not hand it. The broader
 * `code-execution` grant is NOT issued, for the same reason as `network` below —
 * its hierarchical cover would admit any other runtime a task declares.
 *
 * Network grants are intentionally narrow: `network:http` + `network:websocket`.
 * The broader `network` grant is NOT issued because its hierarchical cover
 * would silently permit `network:private`, undermining SSRF protection.
 * Callers that legitimately need private/loopback access (e.g. a dev server
 * on localhost) must augment the enforcer with a scoped `network:private`
 * grant — see `workflow-builder/packages/app/src/lib/run-workflow.ts`.
 */
export const BROWSER_GRANTS: readonly EntitlementGrant[] = [
  { id: Entitlements.NETWORK_HTTP },
  { id: Entitlements.NETWORK_WEBSOCKET },
  { id: Entitlements.AI },
  { id: Entitlements.MCP_TOOL_CALL },
  { id: Entitlements.MCP_RESOURCE_READ },
  { id: Entitlements.MCP_PROMPT_GET },
  { id: Entitlements.STORAGE },
  { id: Entitlements.CREDENTIAL },
  { id: Entitlements.CODE_EXECUTION_JS },
];

/**
 * Desktop environment grants (e.g., Electron with Node.js main process).
 * Adds filesystem, code execution, stdio MCP, and browser control on top of browser grants.
 */
export const DESKTOP_GRANTS: readonly EntitlementGrant[] = [
  ...BROWSER_GRANTS,
  { id: Entitlements.FILESYSTEM },
  { id: Entitlements.CODE_EXECUTION },
  { id: Entitlements.MCP_STDIO },
  { id: Entitlements.BROWSER_CONTROL },
  { id: Entitlements.BROWSER_CONTROL_LOCAL },
  { id: Entitlements.BROWSER_CONTROL_NAVIGATE },
  { id: Entitlements.BROWSER_CONTROL_EVALUATE },
  { id: Entitlements.BROWSER_CONTROL_CREDENTIAL },
];

/**
 * Server environment grants (e.g., cloud deployment).
 * Same as desktop plus BROWSER_CONTROL_CLOUD since server can proxy to cloud providers.
 */
export const SERVER_GRANTS: readonly EntitlementGrant[] = [
  ...DESKTOP_GRANTS,
  { id: Entitlements.BROWSER_CONTROL_CLOUD },
];

// ========================================================================
// Policy Factory
// ========================================================================

export type EntitlementProfile = "browser" | "desktop" | "server";

const PROFILE_GRANTS: Record<EntitlementProfile, readonly EntitlementGrant[]> = {
  browser: BROWSER_GRANTS,
  desktop: DESKTOP_GRANTS,
  server: SERVER_GRANTS,
};

/**
 * Creates an entitlement policy for the given runtime profile.
 * The profile's grants become the policy's grant rules.
 * Deny and ask arrays are empty by default — callers can extend the returned policy.
 */
export function createProfilePolicy(profile: EntitlementProfile): EntitlementPolicy {
  return { deny: [], grant: PROFILE_GRANTS[profile], ask: [] };
}

/**
 * Creates an entitlement profile for the given runtime profile.
 * The profile's grants become the policy's grant rules.
 * Deny and ask arrays are empty by default — callers can extend the returned profile.
 *
 * @param profile - The runtime profile to use
 * @param options - Optional resolver (for "ask" verdicts) and signal source
 */
export function createProfileEnforcer(
  profile: EntitlementProfile,
  options?: CreateProfileOptions
): IEntitlementProfile {
  return createPolicyProfile(profile, createProfilePolicy(profile), options);
}

/**
 * Returns the grant list for a given profile.
 * Useful for inspection or combining with additional grants.
 */
export function getProfileGrants(profile: EntitlementProfile): readonly EntitlementGrant[] {
  return PROFILE_GRANTS[profile];
}
