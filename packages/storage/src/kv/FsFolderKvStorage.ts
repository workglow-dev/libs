/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServiceToken } from "@workglow/util";
import type { JsonSchema } from "@workglow/util/schema";
import { mkdir, readFile, rm, unlink } from "fs/promises";
import path from "path";
import { safeEmit } from "../events/safeEmit";
import { StorageCorruptionError, StorageUnsupportedError } from "../tabular/StorageError";
import { atomicWriteFile } from "../util/atomicWriteFile";
import type { IKvStorage } from "./IKvStorage";
import { KvStorage } from "./KvStorage";

export const FS_FOLDER_KV_REPOSITORY = createServiceToken<IKvStorage<string, any, any>>(
  "storage.kvRepository.fsFolder"
);

/**
 * Key-value repository that stores each value as a file in a folder, using
 * a caller-supplied `pathWriter` to map keys to relative paths.
 */
export class FsFolderKvStorage<
  Key extends string = string,
  Value = any,
  Combined = { key: Key; value: Value },
> extends KvStorage<Key, Value, Combined> {
  constructor(
    public folderPath: string,
    public pathWriter: (key: Key) => string,
    keySchema: JsonSchema = { type: "string" },
    valueSchema: JsonSchema = { contentEncoding: "blob" }
  ) {
    super(keySchema, valueSchema);
  }

  private async setupDirectory(): Promise<void> {
    try {
      await mkdir(this.folderPath, { recursive: true });
    } catch (error) {
      // CI system sometimes has issues temporarily; retry once.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await mkdir(this.folderPath, { recursive: true });
      } catch {
        // Ignore: directory likely already exists.
      }
    }
  }

  public async put(key: Key, value: Value): Promise<void> {
    const localPath = path.join(this.folderPath, this.pathWriter(key).replaceAll("..", "_"));

    let content: string;
    const schemaType =
      typeof this.valueSchema === "object" &&
      this.valueSchema !== null &&
      "type" in this.valueSchema
        ? this.valueSchema.type
        : undefined;
    if (value === null) {
      content = "";
    } else if (schemaType === "object") {
      content = JSON.stringify(value);
    } else if (typeof value === "object") {
      content = JSON.stringify(value);
    } else {
      content = String(value);
    }

    await mkdir(path.dirname(localPath), { recursive: true });
    // Temp file + rename: a crash mid-write leaves the previous value, never a
    // truncated file that reads back as a different value.
    await atomicWriteFile(localPath, content);
    // Post-commit emit: the file is written, so a throwing subscriber must not
    // turn a durable write into a thrown error.
    safeEmit(this.events, "put", key, value);
  }

  public async putBulk(items: Array<{ key: Key; value: Value }>): Promise<void> {
    await this.setupDirectory();
    await Promise.all(items.map(async ({ key, value }) => this.put(key, value)));
  }

  /** Parallel single-file reads; missing keys are dropped from the result. */
  public async getBulk(keys: readonly Key[]): Promise<Combined[]> {
    if (keys.length === 0) return [];
    const settled = await Promise.all(
      keys.map(async (key) => {
        const value = await this.get(key);
        if (value === undefined) return undefined;
        return { key, value } as Combined;
      })
    );
    const combined = settled.filter((r) => r !== undefined) as Combined[];
    safeEmit(this.events, "getBulk", keys, combined);
    return combined;
  }

  /**
   * Only a missing file means "no such key". Any other read failure (`EACCES`,
   * `EMFILE`, a path that is a directory) is thrown: reporting it as absent
   * invites the caller to recompute and overwrite a value that still exists.
   */
  public async get(key: Key): Promise<Value | undefined> {
    const localPath = path.join(this.folderPath, this.pathWriter(key).replaceAll("..", "_"));
    const typeDef = this.valueSchema;
    const encoding =
      typeof typeDef === "object" &&
      typeDef !== null &&
      "contentEncoding" in typeDef &&
      typeDef.contentEncoding === "blob"
        ? "binary"
        : "utf-8";
    let content: string;
    try {
      content = (await readFile(localPath, { encoding })).toString().trim();
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") throw error;
      safeEmit(this.events, "get", key, undefined);
      return undefined;
    }

    let value: Value;
    if (encoding === "utf-8") {
      const schemaType =
        typeof typeDef === "object" && typeDef !== null && "type" in typeDef
          ? typeDef.type
          : undefined;
      if (
        schemaType === "object" ||
        (content.startsWith("{") && content.endsWith("}")) ||
        (content.startsWith("[") && content.endsWith("]"))
      ) {
        try {
          value = JSON.parse(content) as Value;
        } catch (error) {
          // An object-typed value is always written as JSON (or as "" for
          // null), so anything else under that schema is a damaged file. An
          // untyped value that merely looks like JSON may be a plain string.
          if (schemaType === "object" && content !== "") {
            throw new StorageCorruptionError(localPath, { cause: error });
          }
          value = content as unknown as Value;
        }
      } else {
        value = content as unknown as Value;
      }
    } else {
      value = content as unknown as Value;
    }

    safeEmit(this.events, "get", key, value);
    return value;
  }

  public async delete(key: Key): Promise<void> {
    const localPath = path.join(this.folderPath, this.pathWriter(key).replaceAll("..", "_"));
    try {
      await unlink(localPath);
    } catch (error) {
      // Deleting a key that was never written is a no-op, matching the
      // idempotent delete of the in-memory and tabular FsFolder backends.
      if ((error as { code?: string })?.code !== "ENOENT") throw error;
    }
    safeEmit(this.events, "delete", key);
  }

  public async getAll(): Promise<Combined[] | undefined> {
    throw new StorageUnsupportedError("getAll", "FsFolderKvStorage");
  }

  public async deleteAll(): Promise<void> {
    const localPath = path.join(this.folderPath);
    await rm(localPath, { recursive: true, force: true });
    safeEmit(this.events, "deleteall");
  }

  public async size(): Promise<number> {
    throw new StorageUnsupportedError("size", "FsFolderKvStorage");
  }
}
