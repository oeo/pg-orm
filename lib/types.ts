// core type definitions
import type { PoolConfig } from "pg";
import type { Document } from "./document";

// validation and default value types
export type ValidationFunction<T = any> = (
  this: T,
  value: any,
) => Promise<void> | void;
export type DefaultFunction<T = any> = (this: T) => Promise<any> | any;

// field configuration types
export type BaseFieldConfig = {
  required?: boolean;
  default?: any | DefaultFunction;
  validate?: ValidationFunction;
};

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "ref"
  | "array"
  | "object";

export type FieldConfig =
  | (BaseFieldConfig & { type: "string" | "number" | "boolean" })
  | (BaseFieldConfig & { type: "ref"; ref: string })
  | (BaseFieldConfig & { type: "array"; of: FieldConfig })
  | (BaseFieldConfig & { type: "object"; schema: SchemaDefinition })
  | (BaseFieldConfig & { type: "object" });

export type SchemaDefinition = Record<string, FieldConfig>;

// type inference utilities
type BaseDocument = {
  _id: string;
  _ctime?: number;
  _mtime?: number;
  _vers: number;
};

export type InferFieldType<F extends FieldConfig> = F extends { type: "string" }
  ? string
  : F extends { type: "number" }
    ? number
    : F extends { type: "boolean" }
      ? boolean
      : F extends { type: "ref" }
        ? string
        : F extends { type: "array"; of: FieldConfig }
          ? Array<InferFieldType<F["of"]>>
          : F extends { type: "object"; schema: SchemaDefinition }
            ? InferSchemaType<F["schema"]>
            : F extends { type: "object" }
              ? Record<string, any>
              : never;

type RawSchemaType<S extends SchemaDefinition> = {
  [K in keyof S]: S[K] extends { required: true }
    ? InferFieldType<S[K]>
    : InferFieldType<S[K]> | undefined;
};

// combine BaseDocument and RawSchemaType
export type InferSchemaType<S extends SchemaDefinition> = BaseDocument & {
  [K in keyof S]: S[K] extends { default: any } | { required: false }
    ? InferFieldType<S[K]> | undefined
    : InferFieldType<S[K]>;
};

// query types
export type SortDirection = 1 | -1;
// `$natural` orders by insertion (the serial row id). `$textScore` orders by
// full-text relevance and needs a `$text` filter in the same query.
export type SortOptions<T> = Partial<
  Record<keyof T | "$natural" | "$textScore", SortDirection>
>;

// Row lock taken by the SELECT: FOR UPDATE, FOR UPDATE NOWAIT (raises
// 55P03 instead of waiting), or FOR UPDATE SKIP LOCKED (skips rows another
// transaction holds).
export type LockMode = "update" | "nowait" | "skipLocked";

export type FindOptions<T> = {
  sort?: SortOptions<T>;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
  /** lock the matched rows until the transaction ends; requires transaction() */
  lock?: LockMode;
  /** return plain objects with only these top-level fields; not with lock */
  select?: string[];
};

export type UpdateManyOptions<T> = {
  /**
   * With sort, limit, or lock, only the rows picked by
   * `SELECT id ... ORDER BY ... LIMIT ...` are updated, in the same statement.
   * `lock` adds `FOR UPDATE [NOWAIT | SKIP LOCKED]` to that subquery and needs
   * no transaction: outside one the lock lasts for the statement, which is
   * what a queue claim needs.
   */
  sort?: SortOptions<T>;
  limit?: number;
  lock?: LockMode;
  /** return the updated documents as `documents` */
  returning?: boolean;
};

// one output column of aggregate(). `where` narrows the rows that column
// counts (COUNT(*) FILTER (WHERE ...)), on top of the query-level filter.
// $sum, $min, and $max cast the field to numeric; a stored non-number fails
// the query.
export type AggregateField = (
  | { $count: true }
  | { $countDistinct: string }
  | { $sum: string }
  | { $min: string }
  | { $max: string }
  // total stored document size, octet_length(data::text)
  | { $bytes: true }
) & { where?: Record<string, any> };

export type AggregateOptions = {
  /**
   * group keys by output name: a field path (grouped and returned as text),
   * or `{ $day: path }`, the date of a unix-milliseconds field in the database
   * session's time zone, returned as `YYYY-MM-DD`
   */
  by?: Record<string, string | { $day: string }>;
  fields: Record<string, AggregateField>;
  /** sort by output names (group keys or fields) */
  sort?: Record<string, SortDirection>;
  limit?: number;
  includeDeleted?: boolean;
};

// database config type
export type DbConfig = PoolConfig;

// hook types
export type PreSaveHook<T> = (this: Document<T>) => Promise<void> | void;
export type PostSaveHook<T> = (this: Document<T>) => Promise<void> | void;
export type PreRemoveHook<T> = (this: Document<T>) => Promise<void> | void;
export type PostRemoveHook<T> = (this: Document<T>) => Promise<void> | void;

export type SchemaHooks<T> = {
  preSave?: PreSaveHook<T>;
  postSave?: PostSaveHook<T>;
  preRemove?: PreRemoveHook<T>;
  postRemove?: PostRemoveHook<T>;
};

// Schema options type
export type SchemaOptions = {
  jsonField?: string;
  hooks?: SchemaHooks<any>; // Use 'any' here, specific type will be inferred in defineSchema
  softDelete?: boolean;
  /**
   * fields `$text` searches, in order. The query compiles to
   * `to_tsvector('english', coalesce(data->>'a', '') || ' ' || ...)`, so a GIN
   * index on that exact expression serves it.
   */
  textFields?: string[];
};

// Represents the static methods returned by defineSchema
export type ModelStaticMethods<T extends Record<string, any> = any> = {
  find1(
    id: string,
    options?: Pick<FindOptions<T>, "lock">,
  ): Promise<Document<T> | null>;
  query<U = T>(
    sql: string,
    params?: any[],
    options?: { raw?: boolean },
  ): Promise<U[]>;
  findOne<K extends string>(
    mongoQuery: Record<string, any>,
    options: FindOptions<T> & { select: K[] },
  ): Promise<Record<K, any> | null>;
  findOne(
    mongoQuery?: Record<string, any>,
    options?: FindOptions<T>,
  ): Promise<Document<T> | null>;
  find<K extends string>(
    mongoQuery: Record<string, any>,
    options: FindOptions<T> & { select: K[] },
  ): Promise<Record<K, any>[]>;
  find(
    mongoQuery?: Record<string, any>,
    options?: FindOptions<T>,
  ): Promise<Document<T>[]>;
  create(doc: Partial<T>): Promise<Document<T>>;
  create(
    doc: Partial<T>,
    options: { ifAbsent: true },
  ): Promise<Document<T> | null>;
  count(
    mongoQuery?: Record<string, any>,
    options?: Pick<FindOptions<T>, "includeDeleted">,
  ): Promise<number>;
  aggregate<R = Record<string, any>>(
    mongoQuery: Record<string, any>,
    options: AggregateOptions,
  ): Promise<R[]>;
  remove(mongoQuery: Record<string, any>): Promise<{ deletedCount: number }>;
  updateOne(
    filter: Record<string, any>,
    updateOps: Record<string, any>,
  ): Promise<UpdateResult>;
  updateMany(
    filter: Record<string, any>,
    updateOps: Record<string, any>,
    options?: UpdateManyOptions<T>,
  ): Promise<UpdateResult<T>>;
  schema: SchemaDefinition;
};

// Update result type for updateOne/updateMany
export type UpdateResult<T = any> = {
  matchedCount: number;
  modifiedCount: number;
  /** set only when updateMany ran with `returning: true` */
  documents?: Document<T>[];
};
