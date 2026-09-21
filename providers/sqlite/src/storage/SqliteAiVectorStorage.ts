/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Sqlite } from "@workglow/sqlite/storage";
import type {
  IVectorStorage,
  VectorDistanceMetric,
  VectorIndexOptions,
  VectorSearchOptions,
} from "@workglow/storage";
import {
  assertVectorShape,
  emitSimilaritySearch,
  getMetadataProperty,
  getVectorProperty,
  matchesFilter,
  validateVectorEntities,
} from "@workglow/storage";
import type {
  DataPortSchemaObject,
  FromSchema,
  JsonSchema,
  TypedArray,
  TypedArrayConstructor,
  TypedArraySchemaOptions,
} from "@workglow/util/schema";
import { getLogger } from "@workglow/util";
import { cosineSimilarity } from "@workglow/util/schema";
import { createRequire } from "node:module";
import { SqliteTabularStorage } from "./SqliteTabularStorage";

/**
 * SQLite's own index options.
 *
 * `requireVectorExtension` decides what happens when the sqlite-vector
 * extension cannot be loaded. Left off, the storage degrades to the JS
 * fallback, which is the historical behaviour and still the right default for
 * a small table on a platform with no prebuilt binary. Turned on, coming up
 * without the extension is a failure — which is what a knowledge base sized
 * for the SQL path wants, since the degradation is invisible at every level
 * above it: nothing throws, the same values come back, and the only symptom is
 * a full table scan in a latency graph.
 */
export interface SqliteVectorIndexOptions extends VectorIndexOptions {
  readonly requireVectorExtension?: boolean;
}

/** Thrown from {@link SqliteAiVectorStorage.setupDatabase} under `requireVectorExtension`. */
export class SqliteVectorExtensionUnavailableError extends Error {
  public override readonly name = "SqliteVectorExtensionUnavailableError";
  constructor(
    public readonly table: string,
    public readonly loadError: unknown,
    public readonly probeError: unknown
  ) {
    const reason = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    super(
      `sqlite-vector is unavailable for table "${table}", so every write would store a JSON ` +
        `BLOB and every search would scan the table in JS. Loading it failed with: ` +
        `${reason(loadError)}. Probing for an already-loaded copy failed with: ` +
        `${reason(probeError)}. Pass requireVectorExtension: false to accept the fallback.`
    );
  }
}

/**
 * Maps TypedArray constructor types to their sqlite-vector encoding function names
 * and corresponding distance metric types.
 */
const VECTOR_TYPE_MAP: Record<string, string> = {
  Float32Array: "f32",
  Float64Array: "f32", // sqlite-vector doesn't support f64, convert to f32
  Int8Array: "i8",
  Uint8Array: "u8",
  Int16Array: "f16", // approximate mapping
};

/**
 * Gets the sqlite-vector encoding function suffix for a given TypedArray type
 */
function getVectorTypeSuffix(vectorCtor: TypedArrayConstructor): string {
  return VECTOR_TYPE_MAP[vectorCtor.name] || "f32";
}

/**
 * Gets the sqlite-vector type string for vector_init options
 */
function getVectorTypeOption(vectorCtor: TypedArrayConstructor): string {
  const typeMap: Record<string, string> = {
    Float32Array: "FLOAT32",
    Float64Array: "FLOAT32",
    Int8Array: "INT8",
    Uint8Array: "UINT8",
    Int16Array: "FLOAT16",
  };
  return typeMap[vectorCtor.name] || "FLOAT32";
}

/**
 * Escape a SQL identifier (table/column name) by doubling any backtick characters,
 * then wrapping in backticks. This prevents SQL injection via identifier names.
 */
function escapeIdentifier(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/**
 * SQLite vector storage implementation using the @sqliteai/sqlite-vector extension.
 * Provides native vector similarity search via SQLite virtual table functions
 * instead of in-memory brute-force search.
 *
 * Requirements:
 * - @sqliteai/sqlite-vector package installed
 * - Extension loaded via db.loadExtension(getExtensionPath())
 *
 * Vectors are stored as BLOBs using sqlite-vector encoding functions (vector_as_f32, etc.)
 * and searched using vector_full_scan for efficient KNN queries.
 *
 * @template Schema - The schema for the vector storage
 * @template PrimaryKeyNames - The primary key names
 * @template VectorCtor - Constructor for stored vectors (default {@link typeof Float32Array})
 * @template Metadata - The metadata type
 */
export class SqliteAiVectorStorage<
  Schema extends DataPortSchemaObject,
  PrimaryKeyNames extends ReadonlyArray<keyof Schema["properties"]>,
  Metadata extends Record<string, unknown> | undefined = Record<string, unknown>,
  Entity = FromSchema<Schema, TypedArraySchemaOptions>,
>
  extends SqliteTabularStorage<Schema, PrimaryKeyNames, Entity>
  implements IVectorStorage<Metadata, Schema, Entity, PrimaryKeyNames>
{
  private vectorDimensions: number;
  private readonly vectorCtor: TypedArrayConstructor;
  private vectorPropertyName: keyof Entity;
  private metadataPropertyName: keyof Entity | undefined;
  private vectorTypeSuffix: string;
  private extensionLoaded: boolean = false;
  /**
   * Why the extension is not loaded, or `undefined` while it is (or has not
   * been asked for yet). Exposed because a caller cannot tell the fallback
   * from the SQL path by its results — that is the whole problem with it.
   */
  private vectorFallbackReason: SqliteVectorExtensionUnavailableError | undefined;

  /**
   * Creates a new SQLite AI vector storage
   * @param dbOrPath - Either a Database instance or a path to the SQLite database file
   * @param table - The name of the table to use for storage
   * @param schema - The schema for the entity
   * @param primaryKeyNames - Array of property names forming the primary key
   * @param indexes - Array of columns to index
   * @param dimensions - The number of dimensions of the vector
   * @param vectorCtor - TypedArray constructor for stored vectors (e.g. {@link Float32Array})
   */
  private readonly indexOptions: SqliteVectorIndexOptions;
  private readonly distance: VectorDistanceMetric;

  constructor(
    dbOrPath: string | Sqlite.Database,
    table: string = "vectors",
    schema: Schema,
    primaryKeyNames: PrimaryKeyNames,
    indexes: readonly (keyof NoInfer<Entity> | readonly (keyof NoInfer<Entity>)[])[] = [],
    dimensions: number,
    vectorCtor: TypedArrayConstructor = Float32Array,
    indexOptions: SqliteVectorIndexOptions = {}
  ) {
    super(dbOrPath, table, schema, primaryKeyNames, indexes);

    this.vectorDimensions = dimensions;
    this.vectorCtor = vectorCtor;
    this.vectorTypeSuffix = getVectorTypeSuffix(vectorCtor);
    this.indexOptions = indexOptions;
    this.distance = indexOptions.distance ?? "cosine";
    // sqlite-vector's `vector_full_scan` returns a distance value that this
    // class converts to a similarity via `1 - distance` — which is only
    // correct for cosine. L2 / IP support would need different score and
    // threshold semantics; until that lands we reject them up front rather
    // than silently returning wrong scores.
    if (this.distance !== "cosine") {
      throw new Error(
        `SqliteAiVectorStorage only supports cosine distance; received "${this.distance}". ` +
          `Use PostgresVectorStorage for l2 / ip distances.`
      );
    }

    // Cache vector and metadata property names from schema
    const vectorProp = getVectorProperty(schema);
    if (!vectorProp) {
      throw new Error("Schema must have a property with type array and format TypedArray");
    }
    this.vectorPropertyName = vectorProp as keyof Entity;
    this.metadataPropertyName = getMetadataProperty(schema) as keyof Entity | undefined;
  }

  /**
   * Whether the sqlite-vector extension is loaded, i.e. whether writes encode
   * vectors and searches run in SQL rather than scanning the table in JS.
   */
  public isVectorExtensionLoaded(): boolean {
    return this.extensionLoaded;
  }

  /** Why the extension is unavailable, or `undefined` when it is loaded. */
  public getVectorFallbackReason(): SqliteVectorExtensionUnavailableError | undefined {
    return this.extensionLoaded ? undefined : this.vectorFallbackReason;
  }

  /** Returns the configured index/tuning options (sqlite-vector ignores HNSW knobs). */
  public getIndexOptions(): VectorIndexOptions {
    return this.indexOptions;
  }

  getVectorDimensions(): number {
    return this.vectorDimensions;
  }

  /**
   * Load the sqlite-vector extension and initialize vector indexing on the vector column.
   *
   * Failing to load it is not an error by default — a platform with no
   * prebuilt binary still gets a working storage — but it is never silent.
   * Falling back re-routes the class's entire behaviour: `_putInternal` and
   * `_putBulkInternal` store the parent's JSON BLOB rather than an encoded
   * vector, `vector_init` is never called, and `similaritySearch` reads the
   * whole table and sorts in process. Nothing throws and the same values come
   * back, so the only way to learn of it is to be told.
   *
   * Both failures are captured rather than discarded: the probe exists for a
   * caller that loaded the extension itself, so it must not stand in for the
   * reason loading failed. {@link SqliteVectorIndexOptions.requireVectorExtension}
   * turns the degradation into a refusal to come up.
   */
  public override async setupDatabase(): Promise<void> {
    // Always create the table first via the parent class
    await super.setupDatabase();

    // Try to load the sqlite-vector extension if not already loaded
    if (!this.extensionLoaded) {
      let extensionPath: string | undefined;
      let loadError: unknown;
      try {
        // Use CJS require so the platform-specific sub-package resolves correctly in ESM contexts
        const _require = createRequire(import.meta.url);
        const { getExtensionPath } = _require("@sqliteai/sqlite-vector");
        extensionPath = getExtensionPath() as string;
        this.database.loadExtension(extensionPath);
        this.extensionLoaded = true;
      } catch (error) {
        loadError = error;
        // Extension might already be loaded by the caller; verify with vector_version()
        try {
          this.database.exec("SELECT vector_version()");
          this.extensionLoaded = true;
        } catch (probeError) {
          this.vectorFallbackReason = new SqliteVectorExtensionUnavailableError(
            this.table,
            loadError,
            probeError
          );
          if (this.indexOptions.requireVectorExtension === true) {
            throw this.vectorFallbackReason;
          }
          getLogger().warn(
            `SqliteAiVectorStorage("${this.table}"): sqlite-vector unavailable` +
              `${extensionPath === undefined ? "" : ` at ${extensionPath}`}; ` +
              `writes store JSON BLOBs and searches scan the table in JS. ` +
              `${this.vectorFallbackReason.message}`
          );
        }
      }
    }

    // Initialize the vector column for sqlite-vector indexing (only if extension is available)
    if (this.extensionLoaded) {
      const vectorCol = String(this.vectorPropertyName);
      const vectorType = getVectorTypeOption(this.vectorCtor);
      try {
        this.database
          .prepare("SELECT vector_init(?, ?, ?)")
          .run(
            this.table,
            vectorCol,
            `dimension=${this.vectorDimensions},type=${vectorType},distance=COSINE`
          );
      } catch {
        // vector_init may fail if already initialized, that's OK
      }
    }
  }

  /**
   * Encode a vector as a BLOB using sqlite-vector functions.
   * Returns a JSON string representation suitable for vector_as_f32() etc.
   */
  private encodeVectorJson(vector: TypedArray): string {
    return `[${Array.from(vector).join(",")}]`;
  }

  /**
   * Decode a vector BLOB from SQLite back to a TypedArray.
   * sqlite-vector stores vectors as BLOBs, but when we SELECT them
   * they come back as Buffer/Uint8Array. We also handle JSON string fallback.
   */
  private decodeVector(raw: unknown): TypedArray {
    if (raw instanceof Uint8Array || (typeof Buffer !== "undefined" && raw instanceof Buffer)) {
      // Normalize to a Uint8Array view so we respect byteOffset/byteLength for Buffer as well.
      const view =
        raw instanceof Uint8Array
          ? raw
          : new Uint8Array(
              (raw as Buffer).buffer,
              (raw as Buffer).byteOffset,
              (raw as Buffer).byteLength
            );

      if (this.vectorCtor.name === "Float32Array" || this.vectorCtor === Float32Array) {
        return new Float32Array(view.buffer, view.byteOffset, this.vectorDimensions) as TypedArray;
      }
      // For other types, read as float32 and convert
      const f32 = new Float32Array(view.buffer, view.byteOffset, this.vectorDimensions);
      return new this.vectorCtor(Array.from(f32));
    }
    if (typeof raw === "string") {
      // JSON string fallback
      const array = JSON.parse(raw);
      return new this.vectorCtor(array);
    }
    if (Array.isArray(raw)) {
      return new this.vectorCtor(raw);
    }
    throw new Error(`Cannot decode vector from type: ${typeof raw}`);
  }

  /**
   * Override jsToSqlValue to encode vectors as BLOBs via sqlite-vector functions
   */
  protected override jsToSqlValue(
    column: string,
    value: Entity[keyof Entity]
  ): ReturnType<SqliteTabularStorage<Schema, PrimaryKeyNames, Entity>["jsToSqlValue"]> {
    if (column === String(this.vectorPropertyName) && value != null) {
      // For vector columns, encode as JSON string for sqlite-vector
      const vector = value as unknown as TypedArray;
      return this.encodeVectorJson(vector) as any;
    }
    return super.jsToSqlValue(column, value);
  }

  /**
   * Override sqlToJsValue to decode vector BLOBs back to TypedArrays
   */
  protected override sqlToJsValue(column: string, value: any): Entity[keyof Entity] {
    if (column === String(this.vectorPropertyName) && value != null) {
      return this.decodeVector(value) as Entity[keyof Entity];
    }
    return super.sqlToJsValue(column, value);
  }

  /**
   * Override mapTypeToSQL to use BLOB for vector columns instead of TEXT
   */
  protected override mapTypeToSQL(typeDef: JsonSchema): string {
    if (typeof typeDef !== "boolean" && typeDef.type === "array") {
      const format = typeDef.format as string | undefined;
      if (format === "TypedArray" || format?.startsWith("TypedArray:")) {
        return "BLOB";
      }
    }
    return super.mapTypeToSQL(typeDef);
  }

  /**
   * Build the INSERT OR REPLACE SQL + bound params for a single entity, wrapping
   * the vector column with `vector_as_${suffix}(?)` so sqlite-vector encodes it
   * as a native vector BLOB rather than a JSON string. Shared by `put` and
   * `putBulk` so both paths go through the same encoding — without this, bulk
   * vectors used to fall through `super.putBulk` and land as raw JSON, which
   * `vector_full_scan` cannot decode.
   */
  private buildVectorInsertSql(entity: any): { sql: string; params: any[] } {
    const vectorCol = String(this.vectorPropertyName);

    // Handle auto-generated keys (UUID generation)
    let entityToInsert = entity;
    if (this.hasAutoGeneratedKey() && this.autoGeneratedKeyName) {
      const keyName = String(this.autoGeneratedKeyName);
      const clientProvidedValue = (entity as Record<string, unknown>)[keyName];
      const hasClientValue = clientProvidedValue !== undefined && clientProvidedValue !== null;
      const clientProvidedKeys = this.clientProvidedKeys;
      const autoGeneratedKeyStrategy = this.autoGeneratedKeyStrategy;

      if (
        autoGeneratedKeyStrategy === "uuid" &&
        !hasClientValue &&
        clientProvidedKeys !== "always"
      ) {
        const generatedValue = this.generateKeyValue(keyName, "uuid");
        entityToInsert = { ...entity, [keyName]: generatedValue };
      }
    }

    // Build column lists and values
    const allColumns: string[] = [];
    const placeholders: string[] = [];
    const params: any[] = [];

    // Primary key columns
    const pkColumns = this.primaryKeyColumns() as string[];
    for (const col of pkColumns) {
      const autoGeneratedKeyStrategy = this.autoGeneratedKeyStrategy;
      const isAutoKey = this.isAutoGeneratedKey(col);
      if (isAutoKey && autoGeneratedKeyStrategy === "autoincrement") {
        const clientProvidedKeys = this.clientProvidedKeys;
        const clientValue = (entityToInsert as Record<string, unknown>)[col];
        if (clientProvidedKeys === "if-missing" && clientValue != null) {
          allColumns.push(col);
          placeholders.push("?");
          params.push(this.jsToSqlValue(col, clientValue as Entity[keyof Entity]));
        }
        continue;
      }
      allColumns.push(col);
      placeholders.push("?");
      params.push(this.jsToSqlValue(col, (entityToInsert as Record<string, unknown>)[col] as any));
    }

    // Value columns
    const valueColumns = this.valueColumns() as string[];
    for (const col of valueColumns) {
      allColumns.push(col);
      const value = (entityToInsert as Record<string, unknown>)[col];

      if (col === vectorCol && value != null) {
        // Use vector_as_fXX() for the vector column
        placeholders.push(`vector_as_${this.vectorTypeSuffix}(?)`);
        params.push(this.encodeVectorJson(value as TypedArray));
      } else {
        placeholders.push("?");
        params.push(this.jsToSqlValue(col, value as any));
      }
    }

    const columnList = allColumns.map((c) => `\`${c}\``).join(", ");
    const placeholderList = placeholders.join(", ");

    const sql = `
      INSERT OR REPLACE INTO ${escapeIdentifier(this.table)} (${columnList})
      VALUES (${placeholderList})
      RETURNING *
    `;

    // Ensure all params are SQLite-compatible
    for (let i = 0; i < params.length; i++) {
      if (params[i] === undefined) {
        params[i] = null;
      } else if (params[i] !== null && typeof params[i] === "object") {
        const p = params[i];
        if (
          !(p instanceof Uint8Array) &&
          (typeof Buffer === "undefined" || !(p instanceof Buffer))
        ) {
          params[i] = JSON.stringify(p);
        }
      }
    }

    return { sql, params };
  }

  /**
   * Decode all columns of a row returned from the vector INSERT's RETURNING
   * clause via `sqlToJsValue`, so the vector column comes back as a TypedArray
   * (not a raw Buffer) and any other JSON-encoded columns deserialize.
   */
  private decodeReturnedEntity(updatedEntity: Entity): Entity {
    const updatedRecord = updatedEntity as Record<string, unknown>;
    for (const k in this.schema.properties) {
      updatedRecord[k] = this.sqlToJsValue(k, updatedRecord[k] as any);
    }
    return updatedEntity;
  }

  /**
   * Encode and execute the vector-wrapped INSERT for a single entity, then
   * decode the RETURNING row back into an Entity. Optionally emits the `put`
   * event so bulk callers can defer events until after their own transaction
   * commits.
   */
  private executeVectorPutSync(entity: any, emitEvent: boolean = true): Entity {
    const { sql, params } = this.buildVectorInsertSql(entity);
    const stmt = this.database.prepare(sql);
    const updatedEntity = this.decodeReturnedEntity(stmt.get(...params) as Entity);
    if (emitEvent) this.emitPut(updatedEntity);
    return updatedEntity;
  }

  /**
   * Override put to use sqlite-vector encoding for vector data. Builds a
   * custom INSERT OR REPLACE that wraps the vector column with
   * `vector_as_fXX()` to encode as a native vector BLOB. Falls back to the
   * base put() if the extension is not available.
   */
  public override async put(entity: any): Promise<Entity> {
    return this.guardedWrite(() => this._putInternal(entity));
  }

  /**
   * Validate every entry up front so a single malformed vector rejects the
   * whole batch before any row is encoded for sqlite-vector, then route the
   * batch through the same `vector_as_${suffix}(?)`-wrapped INSERT as `put`
   * inside a SQLite transaction. Without this, the inherited bulk path binds
   * vectors as plain JSON strings, so `vector_full_scan` cannot decode them
   * and similarity search silently falls back to the in-memory cosine path.
   *
   * `put` events are deferred until after the (inner or outer) transaction
   * commits so listeners never observe rows that are about to roll back.
   */
  public override async putBulk(entities: any[]): Promise<Entity[]> {
    return this.guardedWrite(() => this._putBulkInternal(entities));
  }

  /**
   * Vector-encoding implementation behind {@link put}. Reached through the `tx`
   * handle the same way as outside one — the proxy runs this class's public
   * `put`, whose `this._putInternal` resolves to this override — so
   * `tx.put(vector)` goes through the vector-encoding INSERT instead of the
   * parent's `_putInternal` (which binds vectors as JSON BLOBs that
   * `vector_full_scan` cannot decode).
   */
  protected override async _putInternal(entity: any): Promise<Entity> {
    validateVectorEntities(
      [entity as Record<string, unknown>],
      this.vectorPropertyName as string,
      this.vectorDimensions
    );
    if (!this.extensionLoaded) {
      return super._putInternal(entity);
    }
    return this.executeVectorPutSync(entity);
  }

  /**
   * Vector-encoding implementation behind {@link putBulk}, reached through the
   * `tx` handle the same way as outside one.
   * When already inside an outer `withTransaction` BEGIN we cannot open a
   * second `db.transaction(...)` here — that would be a nested transaction
   * (the driver turns it into a SAVEPOINT, but we still want all
   * row-level rollback to fall under the outer BEGIN). In that case we
   * iterate the rows directly; otherwise we wrap them in a SQLite
   * transaction to collapse N fsyncs into one COMMIT.
   *
   * `put` events are appended to a local buffer and emitted only after the
   * inner transaction commits (or, when nested in `withTransaction`, after
   * the buffer is handed to `emitPut`, which the proxy routes into the
   * outer transaction's deferred-event queue).
   */
  protected override async _putBulkInternal(entities: any[]): Promise<Entity[]> {
    validateVectorEntities(
      entities as ReadonlyArray<Record<string, unknown>>,
      this.vectorPropertyName as string,
      this.vectorDimensions
    );
    if (entities.length === 0) return [];
    if (!this.extensionLoaded) {
      return super._putBulkInternal(entities);
    }

    // The shared connection chain slot is already held by whoever reached
    // here: the public `putBulk` takes it in `guardedWrite`, and a call
    // arriving through the `tx` proxy runs inside the transaction that holds
    // it. Re-taking it here would await a slot only this call can release.
    return this.runVectorPutBulkOnHandle(entities);
  }

  private async runVectorPutBulkOnHandle(entities: any[]): Promise<Entity[]> {
    const updatedEntities: Entity[] = [];
    // With a transaction already open (an outer `withTransaction` BEGIN that the
    // proxy routed `tx.putBulk` into, or one another storage opened on this
    // shared connection), iterate rows directly rather than opening a nested
    // SQLite transaction.
    if (this.database.inTransaction) {
      for (const item of entities) {
        updatedEntities.push(this.executeVectorPutSync(item, false));
      }
    } else {
      const transaction = this.database.transaction((items: any[]) => {
        for (const item of items) {
          updatedEntities.push(this.executeVectorPutSync(item, false));
        }
      });
      transaction(entities);
    }

    for (const entity of updatedEntities) this.emitPut(entity);
    return updatedEntities;
  }

  /**
   * Perform similarity search using sqlite-vector's vector_full_scan.
   * Uses native COSINE distance computation in SQLite rather than in-memory JS.
   * Falls back to in-memory search if the extension is unavailable.
   */
  async similaritySearch(query: TypedArray, options: VectorSearchOptions<Metadata> = {}) {
    // Validate before the extension/fallback split so a wrong-dimension or
    // non-finite query fails fast instead of silently returning a meaningless
    // score from the in-memory fallback path.
    assertVectorShape(query, this.vectorDimensions, "query");
    if (!this.extensionLoaded) {
      return this.searchFallback(query, options);
    }

    const { topK = 10, filter, scoreThreshold = 0 } = options;
    const db = this.database;
    const tableName = this.table;
    const vectorCol = String(this.vectorPropertyName);
    const metadataCol = this.metadataPropertyName ? String(this.metadataPropertyName) : null;

    try {
      const queryJson = this.encodeVectorJson(query);
      const queryBlob = db
        .prepare(`SELECT vector_as_${this.vectorTypeSuffix}(?) as v`)
        .get(queryJson) as { v: Buffer };

      if (filter && Object.keys(filter).length > 0) {
        // When filtering, use streaming mode (no k parameter) so we can filter rows
        const sql = `
          SELECT t.*, v.distance
          FROM ${escapeIdentifier(tableName)} AS t
          JOIN vector_full_scan(?, ?, ?) AS v
          ON t.rowid = v.rowid
          ORDER BY v.distance ASC
        `;
        const stmt = db.prepare(sql);
        const rows = stmt.all(tableName, vectorCol, queryBlob.v) as Array<
          Record<string, unknown> & { distance: number }
        >;

        const results: Array<Entity & { score: number }> = [];
        for (const row of rows) {
          // Convert distance to similarity score (cosine distance to cosine similarity)
          const score = 1 - row.distance;

          if (score < scoreThreshold) {
            continue;
          }

          // Convert SQL values to JS
          const entity = { ...row } as Record<string, unknown>;
          delete entity.distance;
          for (const k in this.schema.properties) {
            entity[k] = this.sqlToJsValue(k, entity[k] as any);
          }

          // Apply metadata filter (use empty object if no metadata column)
          const metadata = metadataCol ? (entity[metadataCol] as Metadata) : ({} as Metadata);
          if (filter && !matchesFilter(metadata, filter)) {
            continue;
          }

          results.push({ ...entity, score } as Entity & { score: number });

          if (results.length >= topK) {
            break;
          }
        }

        results.sort((a, b) => b.score - a.score);
        return emitSimilaritySearch(this.events, query, results.slice(0, topK));
      }

      // No filter - use top-k mode for efficiency
      const sql = `
        SELECT t.*, v.distance
        FROM ${escapeIdentifier(tableName)} AS t
        JOIN vector_full_scan(?, ?, ?, ?) AS v
        ON t.rowid = v.rowid
        ORDER BY v.distance ASC
      `;
      const stmt = db.prepare(sql);
      const rows = stmt.all(tableName, vectorCol, queryBlob.v, topK | 0) as Array<
        Record<string, unknown> & { distance: number }
      >;

      const results: Array<Entity & { score: number }> = [];
      for (const row of rows) {
        const score = 1 - row.distance;

        if (score < scoreThreshold) {
          continue;
        }

        const entity = { ...row } as Record<string, unknown>;
        delete entity.distance;
        for (const k in this.schema.properties) {
          entity[k] = this.sqlToJsValue(k, entity[k] as any);
        }

        results.push({ ...entity, score } as Entity & { score: number });
      }

      return emitSimilaritySearch(this.events, query, results);
    } catch (error) {
      // Fall back to in-memory similarity calculation if sqlite-vector fails
      console.warn("sqlite-vector query failed, falling back to in-memory search:", error);
      return this.searchFallback(query, options);
    }
  }

  /**
   * Fallback search using in-memory cosine similarity
   */
  private async searchFallback(query: TypedArray, options: VectorSearchOptions<Metadata>) {
    const { topK = 10, filter, scoreThreshold = 0 } = options;
    const allRows = (await this.getAll()) || [];
    const results: Array<Entity & { score: number }> = [];

    for (const row of allRows) {
      const vector = row[this.vectorPropertyName] as TypedArray;
      const metadata = this.metadataPropertyName
        ? (row[this.metadataPropertyName] as Metadata)
        : ({} as Metadata);

      if (filter && !matchesFilter(metadata, filter)) {
        continue;
      }

      const score = cosineSimilarity(query, vector);

      if (score >= scoreThreshold) {
        results.push({ ...row, score } as Entity & { score: number });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return emitSimilaritySearch(this.events, query, results.slice(0, topK));
  }
}
