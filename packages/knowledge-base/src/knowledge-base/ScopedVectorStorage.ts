/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyVectorStorage, IVectorStorage, VectorSearchOptions } from "@workglow/storage";
import type { DataPortSchemaObject, TypedArray } from "@workglow/util/schema";
import { ScopedTabularStorage } from "./ScopedTabularStorage";

/**
 * The `topK` every vector backend in this monorepo applies when a search names
 * none. The wrapper has to know it: it widens the inner search until that many
 * of its own rows come back.
 */
const DEFAULT_TOP_K = 10;

/**
 * Adds an `IVectorStorage` surface to {@link ScopedTabularStorage}.
 *
 * `IVectorStorage` filters on metadata only, not on columns, so the inner
 * search cannot be told to keep `kb_id`'s rows; its results are filtered here.
 * The first search over-fetches `topK * overFetchMultiplier`, and while fewer
 * than `topK` of this scope's rows survive and the inner store returned all it
 * was asked for (so it may hold more), the request doubles. A small knowledge
 * base sharing a table with a large one therefore still gets its `topK`, at the
 * cost of a deeper inner search, instead of an empty answer.
 */
export class ScopedVectorStorage<
  Metadata extends Record<string, unknown> | undefined,
  Schema extends DataPortSchemaObject,
  Entity = any,
  PrimaryKeyNames extends ReadonlyArray<keyof Schema["properties"]> = ReadonlyArray<
    keyof Schema["properties"]
  >,
>
  extends ScopedTabularStorage<Schema, PrimaryKeyNames, Entity>
  implements IVectorStorage<Metadata, Schema, Entity, PrimaryKeyNames>
{
  protected override readonly inner: AnyVectorStorage;
  private readonly overFetchMultiplier: number;

  constructor(inner: AnyVectorStorage, kbId: string, overFetchMultiplier: number = 3) {
    super(inner, kbId);
    this.inner = inner;
    this.overFetchMultiplier = Math.max(1, overFetchMultiplier);
  }

  getVectorDimensions(): number {
    return this.inner.getVectorDimensions();
  }

  async similaritySearch(
    query: TypedArray,
    options?: VectorSearchOptions<Metadata>
  ): Promise<(Entity & { score: number })[]> {
    const topK = options?.topK ?? DEFAULT_TOP_K;
    let limit = Math.max(1, Math.ceil(topK * this.overFetchMultiplier));
    let own: any[];
    for (;;) {
      const results = await this.inner.similaritySearch(query, {
        ...options,
        topK: limit,
      } as any);
      own = results.filter((r: any) => r.kb_id === this.kbId);
      // Fewer rows than asked for means the inner store has no more to give.
      if (own.length >= topK || results.length < limit) break;
      limit *= 2;
    }

    const scoped = own.slice(0, Math.max(0, topK)).map((r: any) => {
      const { kb_id: _, ...rest } = r;
      return rest as Entity & { score: number };
    });

    // On this wrapper's own emitter, and with the rows the caller is handed —
    // as every inherited event here already does. The inner store's event fires
    // with the overfetched, unfiltered, unstripped set, so a listener that took
    // it would see another knowledge base's rows and a count nobody received.
    // The emitter is typed to the tabular event names; this is the one the
    // vector interface adds.
    (
      this.events as unknown as {
        emit: (name: string, query: TypedArray, results: unknown[]) => void;
      }
    ).emit("similaritySearch", query, scoped);

    return scoped;
  }
}
