/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid4 } from "@workglow/util";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Suffix every in-flight {@link atomicWriteFile} temp file ends with. A folder
 * listing that publishes files by name must skip it: such a file is either a
 * write still in progress or the remains of one a crash interrupted.
 */
export const ATOMIC_WRITE_TEMP_SUFFIX = ".tmp";

/** True for a file name {@link atomicWriteFile} uses for a write in progress. */
export function isAtomicWriteTempFile(fileName: string): boolean {
  return fileName.endsWith(ATOMIC_WRITE_TEMP_SUFFIX);
}

/** Directory fsync is not portable; these codes mean "this platform cannot". */
const DIR_SYNC_UNSUPPORTED = new Set(["EPERM", "EINVAL", "ENOTSUP", "EISDIR", "EACCES"]);

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  filePath: string
): Promise<void> {
  // write(2) may accept fewer bytes than asked (quota/NFS/FUSE edges); loop
  // until the whole chunk is on disk so the returned size never overstates it.
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new Error(`Short write persisting ${filePath} (0 bytes accepted)`);
    }
    offset += bytesWritten;
  }
}

/**
 * Writes `data` to `filePath` so that a reader, or the next process after a
 * crash, sees either the previous file or the complete new one, never a
 * truncated or half-written file.
 *
 * Bytes go to a uniquely named sibling temp file (so concurrent writers of one
 * path never share it), are fsync'd, and are then renamed over the target,
 * which is atomic within one filesystem. The directory is fsync'd best-effort
 * so the rename itself survives a power loss; platforms that refuse a directory
 * fsync fall through silently. A failed write removes its temp file.
 *
 * The parent directory must already exist. Returns the number of bytes written.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array | AsyncIterable<Uint8Array>
): Promise<number> {
  const tmpPath = `${filePath}.${uuid4()}${ATOMIC_WRITE_TEMP_SUFFIX}`;
  let size = 0;
  try {
    const handle = await open(tmpPath, "w");
    try {
      if (typeof data === "string" || data instanceof Uint8Array) {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        await writeAll(handle, bytes, filePath);
        size = bytes.byteLength;
      } else {
        for await (const chunk of data) {
          await writeAll(handle, chunk, filePath);
          size += chunk.byteLength;
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  await syncDirectory(path.dirname(filePath));
  return size;
}

async function syncDirectory(dirPath: string): Promise<void> {
  try {
    const dir = await open(dirPath, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !DIR_SYNC_UNSUPPORTED.has(code)) throw err;
  }
}

/**
 * Removes {@link atomicWriteFile} temp files in `dirPath` last modified more
 * than `olderThanMs` ago: what a crash between write and rename leaves behind.
 * The age floor keeps it off temp files another process is still writing.
 * Best-effort: a file that vanishes or cannot be removed is left for next time.
 */
export async function sweepStaleAtomicWriteTempFiles(
  dirPath: string,
  olderThanMs: number
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dirPath);
  } catch {
    return;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const name of names) {
    if (!isAtomicWriteTempFile(name)) continue;
    const filePath = path.join(dirPath, name);
    try {
      if ((await stat(filePath)).mtimeMs < cutoff) await rm(filePath, { force: true });
    } catch {
      // Raced with the writer's rename or another sweep.
    }
  }
}
