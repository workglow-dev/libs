/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for `IEntitlementProfile` — denial shape, hierarchy and
 * subscription behaviour, over every shipped profile.
 */

export * from "./entitlement-profile/fixtures";
export * from "./entitlement-profile/runEntitlementProfileConformance";
export * from "./entitlement-profile/types";
export * from "./entitlement-profile/assertions/denialShape";
export * from "./entitlement-profile/assertions/dispose";
export * from "./entitlement-profile/assertions/hierarchyHonoring";
export * from "./entitlement-profile/assertions/optionalNeverDenied";
export * from "./entitlement-profile/assertions/requestEntitlementShape";
export * from "./entitlement-profile/assertions/resourceScoping";
export * from "./entitlement-profile/assertions/subscribeGrant";
export * from "./entitlement-profile/assertions/subscribeReload";
export * from "./entitlement-profile/assertions/subscribeRevocation";
export * from "./entitlement-profile/assertions/surfaceCoverage";
export * from "./entitlement-profile/assertions/unsubscribeIdempotent";
