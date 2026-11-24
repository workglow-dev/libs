/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { atomicWriteFile, FsFolderTabularStorage } from "@workglow/storage";
import { makeFingerprint } from "@workglow/util";
import { createReadStream, openSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CacheRef } from "../cache/CacheRef";
import { makeCacheRef, makeRefPattern, mintRefKey } from "../cache/CacheRef";
import type { StreamMode } from "../task/StreamTypes";
import type { TaskInput, TaskOutput } from "../task/TaskTypes";
import { deleteBounded } from "./boundedDelete";
import type { TaskOutputRowPrimaryKey } from "./ITaskOutputStorage";
import { tabularTaskOutputStorage } from "./TabularTaskOutputStorage";
import type { RunCacheEntryKey } from "./TaskOutputRepository";
import {
  TaskOutputPrimaryKeyNames,
  TaskOutputSchema,
  TaskOutputTabularRepository,
} from "./TaskOutputTabularRepository";

/**
 * Blob names are `<mintRefKey token>.bin` ({@link makeRefPattern} single-segment
 * match); anything else — in-flight `.tmp` files, foreign `$ref` schemes,
 * traversal-shaped refs — never resolves.
 */
const REF_PATTERN = makeRefPattern("fsfolder", { pathPrefix: "blobs/", suffix: ".bin" });

/**
 * Fold a `runId` into the `taskType` axis. FsFolder has no runId column — rows
 * are keyed `(taskType, key)` and blob names lead with `sanitize(taskType)` —
 * so scoping a private run means prefixing its taskType with {@link runScopePrefix}.
 */
function runScopedType(runId: string, taskType: string): string {
  return `${runScopePrefix(runId)}${taskType}`;
}

/**
 * Namespace prefix for a run's taskType axis. The runId rides as hex (UTF-8
 * bytes, lowercase), so the prefix stays inside the blob-name alphabet and
 * {@link sanitize} is the identity on it: the raw prefix compared against rows
 * and the prefix embedded in sanitized blob names coincide. Hex is injective
 * and never contains the terminating `.`, so two distinct runIds can never
 * yield equal or prefix-related namespaces — neither same-length sanitize
 * collisions (a raw-runId scheme sanitizes `a:b` and `a-b` to the same
 * `a-b`, merging their blob namespaces) nor boundary extensions (`runA` vs
 * `runA-`) can leak reads/deletes across runs.
 */
function runScopePrefix(runId: string): string {
  const bytes = new TextEncoder().encode(runId);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `__run.${hex}.`;
}

/**
 * Filesystem-backed task output repository with full binary streaming support.
 *
 * JSON output rows are stored through {@link FsFolderTabularStorage} (one file
 * per row, compression and TTL pruning inherited from
 * {@link TaskOutputTabularRepository}). Port payloads written via
 * `saveOutputStreamPort` live as sidecar files under `<folder>/blobs/`, written
 * incrementally (never materialized) to a `.tmp` file and atomically renamed
 * on completion — a crash mid-write never publishes a readable partial blob.
 * The temp handle is `sync()`'d before rename so a power loss between the
 * rename and the OS flushing dirty data cannot leave the published blob name
 * pointing at zero bytes. The containing directory is then `sync()`'d as
 * well so the rename itself is durable: on ext4 `data=ordered` and similar
 * filesystems, a crash between the rename returning and the directory
 * metadata being flushed can otherwise leave the published name pointing at
 * stale (zero-byte) content. The dir fsync runs best-effort — platforms
 * that reject opening a directory for fsync (`EPERM` / `EINVAL` / `ENOTSUP`
 * / `EISDIR`) fall through silently.
 *
 * Each `saveOutputStreamPort` call mints a unique blob filename of the form
 * `<sanitized-taskType>_<fingerprint>_<port>_<uuid>.bin`. Two concurrent writers
 * computing the same `(taskType, inputs, port)` therefore land at distinct paths,
 * so a failed-row-commit cleanup on one writer cannot remove the published
 * blob the other writer's row still points at. Stale blobs from crashes
 * between rename and row commit are reclaimed by `clearOlderThan` (which prunes
 * old rows and sweeps sidecar blobs by mtime) and the {@link CacheJanitor}.
 *
 * Two instances pointed at the same folder interoperate: a `CacheRef` written
 * by one resolves through the other (the cross-process contract for queue
 * consumers). Node/Bun only — exported via the package's server entries.
 *
 * Multi-tenant warning: blob names in the deterministic cache path are derived
 * from `(sanitize(taskType), fingerprint(inputs))` with no tenant axis, so two
 * tenants running the same task with identical inputs share a blob — an
 * existence side-channel for sensitive inputs. This repository assumes a
 * SINGLE-TENANT deployment. For multi-tenant use, wrap with a per-tenant
 * folder/prefix at the layer above, or scope writes through
 * {@link RunPrivateCacheRepo} so each run namespaces its own blobs.
 */
export class FsFolderTaskOutputRepository extends TaskOutputTabularRepository {
  private readonly blobsDir: string;

  constructor(folderPath: string) {
    super({
      storage: tabularTaskOutputStorage(
        new FsFolderTabularStorage(folderPath, TaskOutputSchema, TaskOutputPrimaryKeyNames)
      ),
    });
    this.blobsDir = join(folderPath, "blobs");
  }

  override async saveOutputStreamPort(
    taskType: string,
    inputs: TaskInput,
    port: string,
    mode: StreamMode,
    chunks: AsyncIterable<Uint8Array>,
    metadata: Record<string, unknown>
  ): Promise<CacheRef> {
    const fingerprint = await makeFingerprint({ __taskType: taskType, inputs });
    // Port is part of the name so a multi-port task's sidecars are distinct and
    // remain greppable / prefix-deletable; the file stays an opaque `.bin` so
    // the existing readers resolve it unchanged — the codec to replay is named
    // by the ref's `mode`, not the extension.
    const name = `${mintRefKey(taskType, fingerprint, port)}.bin`;
    const size = await this.writeSidecar(name, chunks);
    this.emit("output_saved", taskType);
    const mime = typeof metadata.mime === "string" ? metadata.mime : undefined;
    return makeCacheRef({ $ref: `fsfolder://blobs/${name}`, port, mode, size, mime });
  }

  // ==========================================================================
  // Run-scoped surface (private cache tier)
  //
  // FsFolder doubles as the run-private backing: it namespaces each run into
  // the taskType axis (see runScopedType) so the SAME sidecar streaming path
  // serves both the deterministic and the private tier, and a run's rows and
  // blobs are prefix-selectable for cleanup on deleteRun / deleteRunOlderThan.
  // ==========================================================================

  override async saveOutputForRun(
    runId: string,
    taskType: string,
    inputs: TaskInput,
    output: TaskOutput,
    createdAt = new Date()
  ): Promise<void> {
    await this.saveOutput(runScopedType(runId, taskType), inputs, output, createdAt);
  }

  override async getOutputForRun(
    runId: string,
    taskType: string,
    inputs: TaskInput
  ): Promise<TaskOutput | undefined> {
    return this.getOutput(runScopedType(runId, taskType), inputs);
  }

  override async saveOutputStreamPortForRun(
    runId: string,
    taskType: string,
    inputs: TaskInput,
    port: string,
    mode: StreamMode,
    chunks: AsyncIterable<Uint8Array>,
    metadata: Record<string, unknown>
  ): Promise<CacheRef> {
    return this.saveOutputStreamPort(
      runScopedType(runId, taskType),
      inputs,
      port,
      mode,
      chunks,
      metadata
    );
  }

  /**
   * Exhaustive run cleanup. Rows are keyed `(taskType, key)` with the key a
   * fingerprint hash, so a run's rows are not recoverable from the filenames
   * and finding them means reading every row in the folder. That cost is the
   * reason {@link deleteRunEntries} exists for the common case; this method
   * stays the honest primitive for a caller that cannot enumerate what a run
   * wrote (a resumed run reclaiming a previous process's rows, an operator
   * clearing a run id by hand).
   */
  override async deleteRun(runId: string): Promise<void> {
    const nsPrefix = runScopePrefix(runId);
    const doomed: TaskOutputRowPrimaryKey[] = [];
    for await (const row of this.storage.records()) {
      if (typeof row.taskType === "string" && row.taskType.startsWith(nsPrefix)) {
        doomed.push({ key: row.key, taskType: row.taskType });
      }
    }
    await deleteBounded(doomed, (key) => this.storage.delete(key));
    this.emit("output_pruned");
    // Blob names lead with `sanitize(taskType)` and `sanitize` is the identity
    // on the hex run-scope prefix, so `nsPrefix` itself is the shared prefix of
    // every sidecar this run wrote (streamed or orphaned).
    await this.deleteBlobsByPrefix(nsPrefix);
  }

  /**
   * Delete exactly the listed rows of `runId`, and NOTHING else.
   *
   * The scan {@link deleteRun} performs is what this avoids: the caller states
   * which rows it wrote, so cleanup costs one unlink per row, independent of
   * how much unrelated data the folder holds. Rows of `runId` that the caller
   * did not list are LEFT IN PLACE — {@link deleteRunOlderThan} reclaims those.
   *
   * Sidecar blobs are deliberately NOT swept here. A blob's name is not
   * derivable from a {@link RunCacheEntryKey} (the row key fingerprints the
   * inputs; the blob name fingerprints `{__taskType, inputs}` and carries a
   * per-write uuid), so the only prefix available is the whole run's — and
   * deleting by it would take the blob of a row this call is NOT deleting,
   * leaving a dangling `CacheRef` in a row that still reads back. A consumer
   * discovers that only when `TaskRunner.hydrateInputRefs` throws, long after
   * the cleanup that caused it. A caller that streamed ports names its own
   * blobs through {@link deleteOutputByRefForRun}; whatever neither half names
   * is reclaimed by {@link deleteRunOlderThan} on age, the same reclaim story
   * that already governs the surviving rows.
   */
  override async deleteRunEntries(
    runId: string,
    entries: readonly RunCacheEntryKey[]
  ): Promise<void> {
    // A run that wrote nothing prunes nothing, so it must not announce a prune.
    if (entries.length === 0) return;
    const nsPrefix = runScopePrefix(runId);
    const doomed = entries.map((entry) => ({
      key: entry.key,
      taskType: `${nsPrefix}${entry.taskType}`,
    }));
    await deleteBounded(doomed, (key) => this.storage.delete(key));
    this.emit("output_pruned");
  }

  /**
   * Age-bounded run cleanup — the crash-recovery reclaim path, and deliberately
   * still a full scan. It is reached with no knowledge of what the run wrote
   * (that is exactly the state a crashed or abandoned run leaves behind), so
   * the rows have to be found rather than named.
   */
  override async deleteRunOlderThan(runId: string, olderThanInMs: number): Promise<void> {
    const cutoff = Date.now() - olderThanInMs;
    const nsPrefix = runScopePrefix(runId);
    const doomed: TaskOutputRowPrimaryKey[] = [];
    for await (const row of this.storage.records()) {
      if (typeof row.taskType !== "string" || !row.taskType.startsWith(nsPrefix)) continue;
      const ts = typeof row.createdAt === "string" ? new Date(row.createdAt).getTime() : NaN;
      if (!isNaN(ts) && ts < cutoff) {
        doomed.push({ key: row.key, taskType: row.taskType });
      }
    }
    await deleteBounded(doomed, (key) => this.storage.delete(key));
    this.emit("output_pruned");
    await this.deleteBlobsByPrefix(nsPrefix, cutoff);
  }

  override async sizeForRun(runId: string): Promise<number> {
    const nsPrefix = runScopePrefix(runId);
    let count = 0;
    for await (const row of this.storage.records()) {
      if (typeof row.taskType === "string" && row.taskType.startsWith(nsPrefix)) count++;
    }
    return count;
  }

  /**
   * Stream `chunks` to a uniquely-named sidecar under `blobsDir`, returning the
   * byte count. {@link atomicWriteFile} publishes it by rename after an fsync, so
   * a crash mid-write never leaves a readable partial blob.
   * Callers compute `name` (the prefix keeps names greppable and prefix-
   * deletable; a per-write UUID suffix makes every path unique so two concurrent
   * writers with the same `(taskType, inputs)` cannot race on one file).
   */
  private async writeSidecar(name: string, chunks: AsyncIterable<Uint8Array>): Promise<number> {
    await mkdir(this.blobsDir, { recursive: true });
    return await atomicWriteFile(join(this.blobsDir, name), chunks);
  }

  private blobPath(ref: CacheRef): string | undefined {
    const match = REF_PATTERN.exec(ref.$ref);
    return match ? join(this.blobsDir, match[1]) : undefined;
  }

  /**
   * Return the blob path for `ref` only when its blob name lies within
   * `runId`'s run-scope namespace. Foreign refs (malformed, wrong-runId, or
   * unscoped deterministic writes) yield `undefined` — the caller then reports
   * a cache miss / no-op instead of touching another run's blobs. Blob names
   * lead with `sanitize(taskType)` and `sanitize` is the identity on the hex
   * `runScopePrefix`, so the prefix is the shared lead of every sidecar the
   * run wrote.
   */
  private blobPathInRunScope(ref: CacheRef, runId: string): string | undefined {
    const match = REF_PATTERN.exec(ref.$ref);
    if (match === null) return undefined;
    if (!match[1].startsWith(runScopePrefix(runId))) return undefined;
    return join(this.blobsDir, match[1]);
  }

  /** Materialize the blob at `path`, or `undefined` when absent (cache miss). */
  private async readBlobAt(path: string): Promise<Blob | undefined> {
    try {
      return new Blob([await readFile(path)]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /**
   * Open a byte stream over the blob at `path`, or `undefined` when absent.
   * Deliberately synchronous: the file descriptor opens NOW so a missing blob
   * reports `undefined` (the clean cache-miss contract, matching
   * {@link readBlobAt}) instead of an ENOENT thrown mid-iteration; once open,
   * a concurrent prune can no longer break the read (POSIX keeps the inode
   * alive until the handle closes).
   */
  private openBlobStreamAt(path: string): AsyncIterable<Uint8Array> | undefined {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    // Return the ReadStream itself (it is an AsyncIterable<Buffer>): its async
    // iterator's `return()` destroys the stream and releases the fd, so a
    // caller that resolves several port streams and then abandons them (e.g. a
    // replay that converts to a miss) can close without reading.
    return createReadStream(path, { fd, autoClose: true }) as unknown as AsyncIterable<Uint8Array>;
  }

  /** Best-effort delete of the blob at `path` (no error when absent). */
  private async deleteBlobAt(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  override async getOutputByRef(ref: CacheRef): Promise<Blob | undefined> {
    const path = this.blobPath(ref);
    return path === undefined ? undefined : this.readBlobAt(path);
  }

  override async getOutputByRefForRun(ref: CacheRef, runId: string): Promise<Blob | undefined> {
    const path = this.blobPathInRunScope(ref, runId);
    return path === undefined ? undefined : this.readBlobAt(path);
  }

  override async getOutputStreamByRef(
    ref: CacheRef
  ): Promise<AsyncIterable<Uint8Array> | undefined> {
    const path = this.blobPath(ref);
    return path === undefined ? undefined : this.openBlobStreamAt(path);
  }

  override async getOutputStreamByRefForRun(
    ref: CacheRef,
    runId: string
  ): Promise<AsyncIterable<Uint8Array> | undefined> {
    const path = this.blobPathInRunScope(ref, runId);
    return path === undefined ? undefined : this.openBlobStreamAt(path);
  }

  override async deleteOutputByRef(ref: CacheRef): Promise<void> {
    const path = this.blobPath(ref);
    if (path === undefined) return;
    await this.deleteBlobAt(path);
  }

  override async deleteOutputByRefForRun(ref: CacheRef, runId: string): Promise<void> {
    const path = this.blobPathInRunScope(ref, runId);
    if (path === undefined) return;
    await this.deleteBlobAt(path);
  }

  override async clear(): Promise<void> {
    await super.clear();
    await rm(this.blobsDir, { recursive: true, force: true });
  }

  /**
   * Prune rows and blobs older than `olderThanInMs`. Operators SHOULD schedule
   * this (e.g. via {@link CacheJanitor}) on a recurring cadence: it is also
   * the sweep that reclaims orphan blobs left by process crashes between a
   * successful stream-write and the row commit (the runner cleans up best-
   * effort via {@link TaskOutputRepository.deleteOutputByRef} on synchronous
   * save failure, but a hard kill races that path). Without periodic
   * `clearOlderThan`, stranded blobs accumulate without bound.
   */
  override async clearOlderThan(olderThanInMs: number): Promise<void> {
    const cutoff = Date.now() - olderThanInMs;
    // FsFolderTabularStorage does not implement deleteSearch (the base
    // implementation's pruning path), so prune rows by scanning.
    for await (const row of this.storage.records()) {
      const ts = typeof row.createdAt === "string" ? new Date(row.createdAt).getTime() : NaN;
      if (!isNaN(ts) && ts < cutoff) {
        await this.storage.delete({ key: row.key, taskType: row.taskType });
      }
    }
    this.emit("output_pruned");
    await this.deleteBlobsByPrefix("", cutoff);
  }

  private async deleteBlobsByPrefix(namePrefix: string, olderThanMtimeMs?: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.blobsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(namePrefix)) continue;
      const path = join(this.blobsDir, name);
      try {
        if (olderThanMtimeMs !== undefined && (await stat(path)).mtimeMs >= olderThanMtimeMs) {
          continue;
        }
        await rm(path, { force: true });
      } catch {
        // Raced with a concurrent write or delete; the next sweep catches it.
      }
    }
  }
}
