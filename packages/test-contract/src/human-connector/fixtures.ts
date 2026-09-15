/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";

import type { ConformanceFixture } from "./types";

const elicitSchema: DataPortSchema = {
  type: "object",
  properties: {
    approved: {
      type: "boolean",
      title: "Approved",
      description: "Whether the request is approved",
    },
    reason: { type: "string", title: "Reason" },
  },
  required: ["approved"],
  additionalProperties: false,
};

const emptySchema: DataPortSchema = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

export const DEFAULT_HUMAN_CONFORMANCE_FIXTURE: ConformanceFixture = {
  elicitContentSchema: elicitSchema,
  elicitAcceptContent: { approved: true, reason: "looks good" },
  notifyRequest: {
    message: "Job completed.",
    contentSchema: emptySchema,
    contentData: { jobId: "test-1" },
  },
  displayRequest: {
    message: "Here is the result.",
    contentSchema: emptySchema,
    contentData: { result: 42 },
  },
  // A confirm's schema describes the action awaiting approval rather than
  // fields to fill in, so the data is what a person reads before deciding.
  confirmRequest: {
    message: 'Run workflow "nightly-export"?',
    contentSchema: {
      type: "object",
      properties: {
        action: { type: "string", title: "Action" },
        reaches: { type: "string", title: "Reaches" },
      },
      additionalProperties: true,
    },
    contentData: { action: "Run workflow", reaches: "network:http → https://example.test" },
  },
  abortGraceMs: 1000,
};

export function resolveHumanConformanceFixture(
  override: Partial<ConformanceFixture> | undefined
): ConformanceFixture {
  if (!override) return DEFAULT_HUMAN_CONFORMANCE_FIXTURE;
  return { ...DEFAULT_HUMAN_CONFORMANCE_FIXTURE, ...override };
}
