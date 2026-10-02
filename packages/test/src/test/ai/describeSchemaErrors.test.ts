/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describeSchemaErrors } from "@workglow/ai";
import { compileSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

const answer = compileSchema({
  type: "object",
  properties: {
    offering_terms: {
      anyOf: [
        {
          type: "object",
          properties: { price: { type: "number" } },
          required: ["price"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["offering_terms"],
});

describe("describeSchemaErrors", () => {
  it("reports a nullable object's own errors, at their path in the answer", () => {
    const { errors } = answer.validate({ offering_terms: { price: 10, trust_total: 5 } });
    const detail = describeSchemaErrors(errors);
    expect(detail).toContain("trust_total");
    expect(detail).toContain("#/offering_terms");
    expect(detail).not.toContain("does not match any schema");
  });

  it("keeps the any-of message when no single branch takes the value's type", () => {
    const { errors } = answer.validate({ offering_terms: "ten" });
    expect(describeSchemaErrors(errors)).toContain("does not match any schema");
  });

  it("passes other errors through", () => {
    const { errors } = answer.validate({});
    expect(describeSchemaErrors(errors)).toContain("offering_terms");
  });
});
