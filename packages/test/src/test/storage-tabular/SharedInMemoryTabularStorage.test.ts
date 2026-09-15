/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { SharedInMemoryTabularStorage } from "@workglow/storage";
import { DEFAULT_LIMITS, setLogger, uuid4 } from "@workglow/util";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, it } from "vitest";
import {
  runTabularStorageContract,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "@workglow/test-contract/tabular-storage";
import { CompoundPrimaryKeyNames, CompoundSchema } from "./genericTabularStorageTests";

const SearchSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    user_id: { type: "string" },
    created_at: { type: "string" },
    status: { type: "string" },
  },
  required: ["id", "user_id", "created_at", "status"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;
const SearchPK = ["id"] as const;

describe("SharedInMemoryTabularStorage.queryIndex", () => {
  const logger = getTestingLogger();
  setLogger(logger);

  it("delegates to the inner InMemory storage instead of throwing the base default", async () => {
    const storage = new SharedInMemoryTabularStorage<typeof SearchSchema, typeof SearchPK>(
      `shared_qidx_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      SearchSchema,
      SearchPK,
      [["user_id", "created_at"]]
    );
    await storage.put({ id: "1", user_id: "u", created_at: "0001", status: "done" });
    await storage.put({ id: "2", user_id: "u", created_at: "0005", status: "running" });
    await storage.put({ id: "3", user_id: "v", created_at: "0010", status: "done" });

    const rows = await storage.queryIndex(
      { user_id: "u" },
      { select: ["id", "user_id", "created_at"] }
    );

    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["1", "2"]);
    storage.destroy();
  });
});

describe("SharedInMemoryTabularStorage maxPendingMessages override", () => {
  it("uses the DEFAULT_LIMITS.storageMaxPendingMessages value when not overridden", () => {
    const store = new SharedInMemoryTabularStorage<typeof SearchSchema, typeof SearchPK>(
      `pending-default-${uuid4()}`,
      SearchSchema,
      SearchPK
    );
    // @ts-expect-error accessing private internal for the assertion
    expect(store.maxPendingMessages).toBe(DEFAULT_LIMITS.storageMaxPendingMessages);
    store.destroy();
  });

  it("accepts an explicit maxPendingMessages override", () => {
    const store = new SharedInMemoryTabularStorage<typeof SearchSchema, typeof SearchPK>(
      `pending-override-${uuid4()}`,
      SearchSchema,
      SearchPK,
      [],
      "if-missing",
      undefined,
      5
    );
    // @ts-expect-error accessing private internal for the assertion
    expect(store.maxPendingMessages).toBe(5);
    store.destroy();
  });
});

runTabularStorageContract({
  name: "SharedInMemoryTabularStorage",
  createStorage: async () =>
    new SharedInMemoryTabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>(
      `shared_contract_${uuid4().replace(/-/g, "_")}`,
      CompoundSchema,
      CompoundPrimaryKeyNames
    ),
  capabilities: {
    supportsSubscriptions: true,
    supportsVectorColumns: true,
    supportsTransactions: false,
    supportsQuery: true,
  },
  // SharedInMemoryTabularStorage broadcasts events via BroadcastChannel /
  // the inner InMemoryTabularStorage event bus — strictly event-driven.
  usesPolling: false,
  createVectorStorage: async () =>
    new SharedInMemoryTabularStorage<typeof VectorItemSchema, typeof VectorItemPrimaryKeyNames>(
      `shared_vec_${uuid4().replace(/-/g, "_")}`,
      VectorItemSchema,
      VectorItemPrimaryKeyNames
    ),
});
