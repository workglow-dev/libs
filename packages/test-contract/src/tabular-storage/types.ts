/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage } from "@workglow/storage";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import type { CompoundPrimaryKeyNames, CompoundSchema } from "./fixtures";

export const VectorItemPrimaryKeyNames = ["id"] as const;
export const VectorItemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    embedding: { type: "array", format: "TypedArray:Float32Array" },
  },
  required: ["id", "embedding"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

/**
 * Closed string-literal union of tabular-storage contract assertions that
 * adapters can mark as known failing. A typo in `expectedFailures` becomes
 * a TS error rather than a silently-ignored entry.
 */
export type TabularStorageContractAssertion =
  | "subscribeToChanges"
  | "vectorColumnFormat"
  | "withTransactionRollback"
  | "withConnectionTransaction"
  | "countMatchesQuery"
  | "inListCriterion"
  | "notInListCriterion"
  | "joinPushdown"
  | "guardParity";

interface TabularStorageContractBaseOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout?: number;
  readonly createStorage: () => Promise<
    ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>
  >;
  /**
   * Required when capabilities.supportsVectorColumns is true. Creates a fresh
   * storage instance typed to VectorItemSchema for the round-trip assertion.
   */
  readonly createVectorStorage?: () => Promise<
    ITabularStorage<typeof VectorItemSchema, typeof VectorItemPrimaryKeyNames>
  >;
  /**
   * Creates a second table on the same connection handle as `primary`.
   * Required for the `withConnectionTransaction` assertion; backends that
   * cannot share a handle (InMemory, FsFolder, IndexedDB, Supabase) omit it
   * and that block is skipped.
   */
  readonly createSiblingStorage?: (
    primary: ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>
  ) => Promise<ITabularStorage<typeof CompoundSchema, typeof CompoundPrimaryKeyNames>>;
  /**
   * Releases whatever a factory allocated that the storage itself does not
   * own — typically a connection handle the adapter opened so `createStorage`
   * and `createSiblingStorage` could share one. Called from every `afterEach`
   * after `destroy()`, and passed the same instance the factory returned.
   *
   * Without it an adapter that opens its own handle has nowhere to close it:
   * `destroy()` deliberately leaves a caller-provided handle open, so the
   * handles pile up until the file ends. The parameter is `object` because
   * the hook is identity-keyed — the contract creates storages of two
   * different schema types and a release hook only ever looks its argument up.
   */
  readonly releaseStorage?: (storage: object) => void | Promise<void>;
  /**
   * Names of contract assertions currently broken in this adapter; each
   * named test wraps with `itExpectFail`. The string-literal union catches
   * typos at compile time.
   */
  readonly expectedFailures?: ReadonlyArray<TabularStorageContractAssertion>;
}

interface SubscriptionCapableCapabilities {
  readonly supportsSubscriptions: true;
  readonly supportsVectorColumns: boolean;
  readonly supportsTransactions: boolean;
  /** Whether `query(criteria)` is supported. False for FsFolder etc. */
  readonly supportsQuery: boolean;
}

interface SubscriptionCapableOpts extends TabularStorageContractBaseOpts {
  readonly capabilities: SubscriptionCapableCapabilities;
  /**
   * Required when supportsSubscriptions is true. Selects between the two
   * subscribeToChanges contract blocks:
   *   - false → eventDriven (strict commit order)
   *   - true  → polling (set equality + count)
   */
  readonly usesPolling: boolean;
  /** Polling interval forwarded to subscribeToChanges for polling-based implementations. */
  readonly pollingIntervalMs?: number;
}

interface SubscriptionIncapableCapabilities {
  readonly supportsSubscriptions: false;
  readonly supportsVectorColumns: boolean;
  readonly supportsTransactions: boolean;
  /** Whether `query(criteria)` is supported. False for FsFolder etc. */
  readonly supportsQuery: boolean;
}

interface SubscriptionIncapableOpts extends TabularStorageContractBaseOpts {
  readonly capabilities: SubscriptionIncapableCapabilities;
  /**
   * Only meaningful when supportsSubscriptions is true. Permitted (but
   * ignored) on incapable backends to keep wiring ergonomic.
   */
  readonly usesPolling?: boolean;
  readonly pollingIntervalMs?: number;
}

export type TabularStorageContractOpts = SubscriptionCapableOpts | SubscriptionIncapableOpts;
