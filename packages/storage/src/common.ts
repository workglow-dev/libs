/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export * from "./tabular/BaseSqlTabularStorage";
export * from "./tabular/BaseTabularStorage";
export * from "./tabular/CachedTabularStorage";
export * from "./tabular/columnConstraints";
export * from "./tabular/CoveringIndexMissingError";
export { pickCoveringIndex } from "./tabular/coveringIndexPicker";
export type {
  PickCoveringIndexInput,
  PickedIndex,
  RegisteredIndex,
} from "./tabular/coveringIndexPicker";
export * from "./tabular/pkFingerprint";
// Cursor codec: the public surface is the opaque type, the codec
// functions, the length cap, and the cross-arity assertion. The
// payload shape and version constant are implementation details —
// keep them out of `@workglow/storage`'s public API so callers can't
// depend on the encoding format and we stay free to evolve it.
export {
  assertCursorMatches,
  decodeCursor,
  encodeCursor,
  MAX_CURSOR_LENGTH,
} from "./tabular/Cursor";
export type { PageCursor } from "./tabular/Cursor";
export * from "./tabular/HttpTabularProxyStorage";
export * from "./tabular/HuggingFaceTabularStorage";
export * from "./tabular/InMemoryTabularMigrationApplier";
export * from "./tabular/InMemoryTabularStorage";
export * from "./tabular/ITabularStorage";
export * from "./tabular/joinDelegate";
export * from "./tabular/sqlMigrationDdl";
export * from "./tabular/SqlTabularMigrationApplier";
export * from "./tabular/StorageError";
// The two delete helpers specifically: a wrapper implementing `ITabularStorage`
// owes its caller the same refusal, and its subscribers the same `delete`
// event, that a concrete backend does — and cannot reach into the module or a
// protected member to get either.
export { deleteSearchIdentity, shouldRunDeleteSearch } from "./tabular/tabularValidation";
export * from "./tabular/TabularStorageRegistry";
export * from "./tabular/TelemetryTabularStorage";
export * from "./tabular/withConnectionTransaction";

export * from "./kv/IKvStorage";
export * from "./kv/InMemoryKvStorage";
export * from "./kv/KvStorage";
export * from "./kv/KvViaTabularStorage";
export * from "./kv/TelemetryKvStorage";

export * from "./util/HybridSubscriptionManager";
export * from "./util/PollingSubscriptionManager";

export { safeEmit } from "./events/safeEmit";

export * from "./migrations";
export * from "./sql";

export * from "./vector/assertVectorShape";
export * from "./vector/emitSimilaritySearch";
export * from "./vector/InMemoryVectorStorage";
export * from "./vector/IVectorStorage";
export * from "./vector/TelemetryVectorStorage";

export * from "./text/index";

export * from "./credentials/EncryptedKvCredentialStore";
export * from "./credentials/LazyEncryptedCredentialStore";
export * from "./credentials/SecretVault";
export * from "./credentials/ServerCredentialStore";
