import {
  getConnection,
  inTransaction,
  registerModel,
  registerSchema,
} from "./connection";
import { Document } from "./document";
import { lockClause, MongoToPG, QueryError } from "./mongo-converter";
import type {
  AggregateOptions,
  FindOptions,
  LockMode,
  ModelStaticMethods,
  SchemaDefinition,
  SchemaOptions,
  SortDirection,
  UpdateManyOptions,
  UpdateResult,
} from "./types";
import { renumberPlaceholders } from "./utils";

export function defineSchema<DocType extends Record<string, any> = any>(
  name: string,
  schema: SchemaDefinition,
  options: SchemaOptions = {},
): ModelStaticMethods<DocType> {
  registerSchema(name, schema);
  const hooks = options?.hooks;
  const mongoToPg = new MongoToPG({ textFields: options?.textFields });
  const capturedOptions = { ...options };

  async function getDefaults(): Promise<Partial<DocType>> {
    const defaults: Record<string, any> = {};
    for (const [field, config] of Object.entries(schema)) {
      if (["_id", "_ctime", "_mtime", "_vers"].includes(field)) continue;

      if ("default" in config && config.default !== undefined) {
        if (typeof config.default === "function") {
          defaults[field] = await Promise.resolve(config.default.call({}));
        } else {
          defaults[field] = config.default;
        }
      } else if (config.type === "object" && "schema" in config) {
        const nestedDefaults: Record<string, any> = {};
        for (const [nestedField, nestedConfig] of Object.entries(
          config.schema,
        )) {
          if ("default" in nestedConfig && nestedConfig.default !== undefined) {
            if (typeof nestedConfig.default === "function") {
              nestedDefaults[nestedField] = await Promise.resolve(
                nestedConfig.default.call({}),
              );
            } else {
              nestedDefaults[nestedField] = nestedConfig.default;
            }
          }
        }
        if (Object.keys(nestedDefaults).length > 0) {
          defaults[field] = nestedDefaults;
        }
      }
    }
    return defaults as Partial<DocType>;
  }

  const createDocument = (data: Partial<DocType>) => {
    return new Document<DocType>(data, schema, name, capturedOptions);
  };

  // a row lock outside transaction() would be released as soon as the
  // statement ends, which silently protects nothing
  const requireLockTransaction = (lock?: LockMode) => {
    if (lock && !inTransaction())
      throw new Error(`${name}: lock "${lock}" requires a transaction`);
  };

  // A bulk write whose filter selects every row by construction (no
  // condition, or a constant TRUE) is refused. To mean every row, pass a real
  // predicate such as { _id: { $exists: true } }.
  const requireSelective = (whereClause: string, method: string) => {
    if (!whereClause || whereClause === "WHERE TRUE")
      throw new QueryError(
        `${name}.${method} requires a filter that selects rows`,
      );
  };

  const createDocumentFromRow = (data: any) => {
    if (!data) {
      console.error(
        "[createDocumentFromRow] Error: Received null/undefined data input.",
      );
      throw new Error("Cannot create document from null or undefined data.");
    }
    return new Document<DocType>(data, schema, name, capturedOptions);
  };

  const model = {
    async find1(
      id: string,
      options: Pick<FindOptions<DocType>, "lock"> = {},
    ): Promise<Document<DocType> | null> {
      requireLockTransaction(options.lock);
      const db = await getConnection();
      let sql = `SELECT data FROM "${name}" WHERE data->>'_id' = $1`;

      if (capturedOptions.softDelete) {
        sql += ` AND data->>'_deletedAt' IS NULL`;
      }

      sql += ` LIMIT 1`;
      if (options.lock) sql += ` ${lockClause(options.lock)}`;

      const { rows } = await db.query(sql, [id]);
      return rows[0] ? createDocumentFromRow(rows[0].data) : null;
    },

    async query<T = DocType>(
      sql: string,
      params: any[] = [],
      options: { raw?: boolean } = {},
    ): Promise<T[]> {
      const db = await getConnection();
      const { rows } = await db.query(sql, params);
      if (options.raw) {
        return rows as T[];
      }
      try {
        return rows.map((row) => {
          if (!row || typeof row.data !== "object" || row.data === null) {
            console.warn(
              "[query] Unexpected row structure:",
              JSON.stringify(row),
            );
            return row as T;
          }
          try {
            return row.data._id
              ? (createDocumentFromRow(row.data) as unknown as T)
              : (row.data as T);
          } catch (hydrationError) {
            console.warn(
              "[query] Failed to hydrate row, returning raw data:",
              hydrationError,
              row,
            );
            return row.data as T;
          }
        });
      } catch (err) {
        console.error("[query] Error mapping rows:", err);
        return rows as T[];
      }
    },

    async findOne(
      mongoQuery: Record<string, any> = {},
      options?: FindOptions<DocType>,
    ): Promise<Document<DocType> | null> {
      const results = await this.find(mongoQuery, { ...options, limit: 1 });
      return results[0] || null;
    },

    /**
     * With `select`, rows come back as plain objects holding only those
     * top-level fields (a missing field reads as null), never as Documents,
     * so a partial row cannot be saved over the full one.
     */
    async find(
      mongoQuery: Record<string, any> = {},
      options: FindOptions<DocType> = {},
    ): Promise<any[]> {
      requireLockTransaction(options.lock);
      if (options.select && options.lock)
        throw new QueryError(`${name}: select cannot be combined with lock`);
      const db = await getConnection();
      const converterOptions = {
        jsonField: capturedOptions?.jsonField || "data",
        limit: options.limit,
        offset: options.offset,
        sort: options.sort as Record<string, SortDirection> | undefined,
        lock: options.lock,
        select: options.select,
      };

      const effectiveQuery = { ...mongoQuery };
      if (capturedOptions.softDelete && !options.includeDeleted) {
        if (effectiveQuery._deletedAt === undefined) {
          effectiveQuery._deletedAt = null;
        }
      }

      const { sql, params } = mongoToPg.buildSelectQueryAndParams(
        name,
        effectiveQuery,
        converterOptions,
      );
      const { rows } = await db.query(sql, params);
      if (options.select)
        return rows.map((row) => row[converterOptions.jsonField]);
      return rows.map((row) => createDocumentFromRow(row.data));
    },

    /**
     * Insert a new document. With `{ ifAbsent: true }` the INSERT carries
     * `ON CONFLICT DO NOTHING`: a row that would violate any unique index is
     * skipped and create returns null, without aborting the surrounding
     * transaction the way a caught 23505 does.
     */
    async create(
      doc: Partial<DocType>,
      options: { ifAbsent?: boolean } = {},
    ): Promise<Document<DocType> | null> {
      // create() must always INSERT. A caller-supplied `_vers` would make the
      // Document constructor treat this as an existing row (isNew()=false) and
      // route save() to an UPDATE-by-_id, letting a caller overwrite an
      // arbitrary record. Strip it so create can never become an update.
      const { _vers, ...rest } = doc as any;
      const documentWithDefaults = { ...(await getDefaults()), ...rest };
      const document = createDocument(documentWithDefaults);
      return options.ifAbsent
        ? document.save({ ifAbsent: true })
        : document.save();
    },

    async count(
      mongoQuery: Record<string, any> = {},
      options: FindOptions<DocType> = {},
    ): Promise<number> {
      const db = await getConnection();
      const jsonField = capturedOptions?.jsonField || "data";

      const effectiveQuery = { ...mongoQuery };
      if (capturedOptions.softDelete && !options.includeDeleted) {
        if (effectiveQuery._deletedAt === undefined) {
          effectiveQuery._deletedAt = null;
        }
      }

      const { whereClause, params } = mongoToPg.buildWhereClauseAndParams(
        effectiveQuery,
        jsonField,
      );
      const countSql =
        `SELECT COUNT(*) as count FROM "${name}" ${whereClause}`.trim();
      const { rows } = await db.query(countSql, params);
      return parseInt(rows[0].count, 10);
    },

    /**
     * Grouped counts, sums, minimums, and maximums in one statement.
     * `by` names the group keys; each entry in `fields` is one output column
     * and may carry its own `where` filter. Without `by` the result is a
     * single row. Counts and sums come back as numbers (0 when nothing
     * matched), minimums and maximums as numbers or null, group keys as text.
     *
     *   await Visit.aggregate(
     *     { page: "/pricing" },
     *     {
     *       by: { day: { $day: "_ctime" } },
     *       fields: {
     *         users: { $countDistinct: "ip" },
     *         fromMac: { $count: true, where: { os: "macos" } },
     *       },
     *       sort: { day: 1 },
     *     },
     *   );
     */
    async aggregate(
      mongoQuery: Record<string, any>,
      options: AggregateOptions,
    ): Promise<Record<string, any>[]> {
      const db = await getConnection();
      const effectiveQuery = { ...mongoQuery };
      if (capturedOptions.softDelete && !options.includeDeleted) {
        if (effectiveQuery._deletedAt === undefined) {
          effectiveQuery._deletedAt = null;
        }
      }
      const { sql, params } = mongoToPg.buildAggregateQueryAndParams(
        name,
        effectiveQuery,
        options,
        capturedOptions?.jsonField || "data",
      );
      const { rows } = await db.query(sql, params);
      const fieldNames = Object.keys(options.fields);
      return rows.map((row) => {
        for (const key of fieldNames) {
          if (row[key] !== null) row[key] = Number(row[key]);
        }
        return row;
      });
    },

    async remove(
      mongoQuery: Record<string, any>,
    ): Promise<{ deletedCount: number }> {
      if (!mongoQuery || Object.keys(mongoQuery).length === 0) {
        throw new Error("Remove operation requires a non-empty query object.");
      }
      const db = await getConnection();
      const jsonField = capturedOptions?.jsonField || "data";

      // checked before the soft-delete condition below, which would hide it
      requireSelective(
        mongoToPg.buildWhereClauseAndParams(mongoQuery, jsonField).whereClause,
        "remove",
      );

      // For bulk remove, we typically want to affect only non-deleted items if soft delete is on, unless specified?
      // Typically remove() deletes from the visible set.
      const effectiveQuery = { ...mongoQuery };
      if (capturedOptions.softDelete) {
        if (effectiveQuery._deletedAt === undefined) {
          effectiveQuery._deletedAt = null;
        }
      }

      const { whereClause, params } = mongoToPg.buildWhereClauseAndParams(
        effectiveQuery,
        jsonField,
      );

      let querySql: string;
      let queryParams = params;

      if (capturedOptions.softDelete) {
        // Perform Soft Delete (Update)
        const now = Date.now();
        // We need to inject the update logic.
        // UPDATE "table" SET data = jsonb_set(data, '{_deletedAt}', to_jsonb(now)) WHERE ...
        querySql = `UPDATE "${name}" SET data = jsonb_set(data, '{_deletedAt}', to_jsonb($${params.length + 1}::numeric)) ${whereClause}`;
        queryParams = [...params, now];
      } else {
        querySql = `DELETE FROM "${name}" ${whereClause}`.trim();
      }

      const { rowCount } = await db.query(querySql, queryParams);
      return { deletedCount: rowCount ?? 0 };
    },

    /**
     * Updates a single document matching the filter using parameterization.
     */
    async updateOne(
      filter: Record<string, any>,
      updateOps: Record<string, any>,
    ): Promise<UpdateResult> {
      if (!filter || Object.keys(filter).length === 0) {
        console.warn(
          "[updateOne] Filter object is empty. No documents updated.",
        );
        return { matchedCount: 0, modifiedCount: 0 };
      }
      const db = await getConnection();
      const jsonField = capturedOptions?.jsonField || "data";
      const { whereClause, params: filterParams } =
        mongoToPg.buildWhereClauseAndParams(filter, jsonField);
      requireSelective(whereClause, "updateOne");

      const setExpressionResult = mongoToPg.buildUpdateSetExpressionAndParams(
        updateOps,
        jsonField,
      );

      if (!setExpressionResult) {
        console.warn("[updateOne] No valid update operators found.");
        const countSql =
          `SELECT COUNT(*) as count FROM "${name}" ${whereClause}`.trim();
        const { rows } = await db.query(countSql, filterParams);
        return { matchedCount: parseInt(rows[0].count, 10), modifiedCount: 0 };
      }

      const { expression: setExpression, params: updateParams } =
        setExpressionResult;

      // Construct final query parts
      const setClause = `SET ${jsonField} = ${renumberPlaceholders(setExpression, filterParams.length)}`;
      const finalSql = `UPDATE "${name}" ${setClause} ${whereClause}`.trim();
      const finalParams = [...filterParams, ...updateParams];
      const { rowCount } = await db.query(finalSql, finalParams);
      return { matchedCount: rowCount ?? 0, modifiedCount: rowCount ?? 0 };
    },

    /**
     * Updates multiple documents matching the filter using parameterization.
     * Supports `$set`, `$inc`, `$min`, and `$setIfNull`. Like updateOne, it
     * bypasses hooks and does not bump `_vers`.
     *
     * With `sort`, `limit`, or `lock` only the rows chosen by a locking
     * subquery are updated, in one statement. A queue claim:
     *
     *   const { documents } = await Email.updateMany(
     *     { status: "pending" },
     *     { $set: { status: "processing" }, $inc: { attempts: 1 } },
     *     { sort: { _ctime: 1 }, limit: 50, lock: "skipLocked", returning: true },
     *   );
     */
    async updateMany(
      filter: Record<string, any>,
      updateOps: Record<string, any>,
      options: UpdateManyOptions<DocType> = {},
    ): Promise<UpdateResult<DocType>> {
      if (!filter || Object.keys(filter).length === 0) {
        console.warn(
          "[updateMany] Filter object is empty. No documents updated.",
        );
        return { matchedCount: 0, modifiedCount: 0 };
      }
      const db = await getConnection();
      const jsonField = capturedOptions?.jsonField || "data";
      const { whereClause, params: filterParams } =
        mongoToPg.buildWhereClauseAndParams(filter, jsonField);
      requireSelective(whereClause, "updateMany");

      const setExpressionResult = mongoToPg.buildUpdateSetExpressionAndParams(
        updateOps,
        jsonField,
      );

      if (!setExpressionResult) {
        console.warn("[updateMany] No valid update operators found.");
        const countSql =
          `SELECT COUNT(*) as count FROM "${name}" ${whereClause}`.trim();
        const { rows } = await db.query(countSql, filterParams);
        return { matchedCount: parseInt(rows[0].count, 10), modifiedCount: 0 };
      }

      const { expression: setExpression, params: updateParams } =
        setExpressionResult;

      let target = whereClause;
      let targetParams = filterParams;
      if (options.sort || options.limit !== undefined || options.lock) {
        if (
          options.limit !== undefined &&
          (!Number.isSafeInteger(options.limit) || options.limit < 1)
        )
          throw new Error("updateMany limit must be a positive integer");
        const picked = mongoToPg.buildSelectQueryAndParams(name, filter, {
          jsonField,
          sort: options.sort as Record<string, SortDirection> | undefined,
          limit: options.limit,
          lock: options.lock,
          columns: "id",
        });
        target = `WHERE id IN (${picked.sql})`;
        targetParams = picked.params;
      }

      const finalSql =
        `UPDATE "${name}" SET data = ${renumberPlaceholders(setExpression, targetParams.length)} ${target}${options.returning ? " RETURNING data" : ""}`.trim();
      const finalParams = [...targetParams, ...updateParams];

      const { rows, rowCount } = await db.query(finalSql, finalParams);

      return {
        matchedCount: rowCount ?? 0,
        modifiedCount: rowCount ?? 0,
        ...(options.returning
          ? { documents: rows.map((row) => createDocumentFromRow(row.data)) }
          : {}),
      };
    },

    schema,
  } as ModelStaticMethods<DocType>;
  registerModel(name, model);
  return model;
}
