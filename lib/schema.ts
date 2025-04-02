import type { SchemaDefinition, InferSchemaType, SchemaHooks, FieldConfig, UpdateResult, FindOptions, SchemaOptions, ModelStaticMethods, SortDirection } from './types';
import { Document } from './document';
import { getConnection, registerSchema } from './connection';
import { events } from './connection';
import { MongoToPG } from './mongo-converter';
import { renumberPlaceholders } from './utils';

export function defineSchema<DocType extends Record<string, any> = any>(
  name: string,
  schema: SchemaDefinition,
  options: SchemaOptions = {}
): ModelStaticMethods<DocType> {

  registerSchema(name, schema);
  const hooks = options?.hooks;
  const mongoToPg = new MongoToPG();
  const capturedOptions = { ...options };

  async function getDefaults(): Promise<Partial<DocType>> {
    const defaults: Record<string, any> = {};
    for (const [field, config] of Object.entries(schema)) {
      if (['_id', '_ctime', '_mtime', '_vers'].includes(field)) continue;
      
      if ('default' in config && config.default !== undefined) {
        if (typeof config.default === 'function') {
          defaults[field] = await Promise.resolve(config.default.call({}));
        } else {
          defaults[field] = config.default;
        }
      } else if (config.type === 'object' && 'schema' in config) {
        const nestedDefaults: Record<string, any> = {};
        for (const [nestedField, nestedConfig] of Object.entries(config.schema)) {
          if ('default' in nestedConfig && nestedConfig.default !== undefined) {
            if (typeof nestedConfig.default === 'function') {
              nestedDefaults[nestedField] = await Promise.resolve(nestedConfig.default.call({}));
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
    return new Document<DocType>(data, schema, name, hooks);
  };
  
  const createDocumentFromRow = (data: any) => {
    if (!data) {
        console.error('[createDocumentFromRow] Error: Received null/undefined data input.');
        throw new Error('Cannot create document from null or undefined data.');
    }
    return new Document<DocType>(data, schema, name, hooks);
  };

  return {
    async find1(id: string): Promise<Document<DocType> | null> {
      const db = await getConnection();
      const { rows } = await db.query(
        `SELECT data FROM "${name}" WHERE data->>'_id' = $1 LIMIT 1`,
        [id]
      );
      return rows[0] ? createDocumentFromRow(rows[0].data) : null;
    },

    async query<T = DocType>(
      sql: string, 
      params: any[] = [],
      options: { raw?: boolean } = {}
    ): Promise<T[]> {
       const db = await getConnection();
      const { rows } = await db.query(sql, params);
      if (options.raw) {
        return rows as T[];
      }
      try {
        return rows.map(row => {
          if (!row || typeof row.data !== 'object' || row.data === null) {
             console.warn('[query] Unexpected row structure:', JSON.stringify(row));
             return row as T; 
          }
          try {
            return row.data._id ? createDocumentFromRow(row.data) as unknown as T : row.data as T;
          } catch (hydrationError) {
            console.warn('[query] Failed to hydrate row, returning raw data:', hydrationError, row);
            return row.data as T;
          }
        });
      } catch (err) {
        console.error('[query] Error mapping rows:', err);
        return rows as T[];
      }
    },

    async findOne(mongoQuery: Record<string, any> = {}): Promise<Document<DocType> | null> {
      const results = await this.find(mongoQuery, { limit: 1 });
      return results[0] || null;
    },

    async find(
      mongoQuery: Record<string, any> = {},
      options: FindOptions<DocType> = {}
    ): Promise<Document<DocType>[]> {
      const db = await getConnection();
      const converterOptions = {
        jsonField: capturedOptions?.jsonField || 'data',
        limit: options.limit,
        offset: options.offset,
        sort: options.sort as Record<string, SortDirection> | undefined
      };
      
      const { sql, params } = mongoToPg.buildSelectQueryAndParams(name, mongoQuery, converterOptions);
      const { rows } = await db.query(sql, params);
      return rows.map(row => createDocumentFromRow(row.data));
    },

    async create(doc: Partial<DocType>): Promise<Document<DocType>> {
      const documentWithDefaults = { ...await getDefaults(), ...doc };
      const document = createDocument(documentWithDefaults);
      return document.save();
    },

    async count(mongoQuery: Record<string, any> = {}): Promise<number> {
      const db = await getConnection();
      const jsonField = capturedOptions?.jsonField || 'data';
      const { whereClause, params } = mongoToPg.buildWhereClauseAndParams(mongoQuery, jsonField);
      const countSql = `SELECT COUNT(*) as count FROM \"${name}\" ${whereClause}`.trim();
      const { rows } = await db.query(countSql, params);
      return parseInt(rows[0].count);
    },

    async remove(mongoQuery: Record<string, any>): Promise<{ deletedCount: number }> {
      if (!mongoQuery || Object.keys(mongoQuery).length === 0) {
        throw new Error('Remove operation requires a non-empty query object.');
      }
      const db = await getConnection();
      const jsonField = capturedOptions?.jsonField || 'data';
      const { whereClause, params } = mongoToPg.buildWhereClauseAndParams(mongoQuery, jsonField);
      if (!whereClause) {
        throw new Error('Could not construct WHERE clause for remove. Aborting to prevent deleting all.');
      }
      const deleteSql = `DELETE FROM \"${name}\" ${whereClause}`.trim();
      const { rowCount } = await db.query(deleteSql, params);
      return { deletedCount: rowCount ?? 0 };
    },

    /**
     * Updates a single document matching the filter using parameterization.
     */
    async updateOne(filter: Record<string, any>, updateOps: Record<string, any>): Promise<UpdateResult> {
      if (!filter || Object.keys(filter).length === 0) {
        console.warn('[updateOne] Filter object is empty. No documents updated.');
        return { matchedCount: 0, modifiedCount: 0 };
      }
      const db = await getConnection();
      const jsonField = capturedOptions?.jsonField || 'data';
      const { whereClause, params: filterParams } = mongoToPg.buildWhereClauseAndParams(filter, jsonField);

      const setExpressionResult = mongoToPg.buildUpdateSetExpressionAndParams(updateOps, jsonField);
      
      if (!setExpressionResult) {
          console.warn('[updateOne] No valid update operators found.');
          const countSql = `SELECT COUNT(*) as count FROM \"${name}\" ${whereClause}`.trim();
          const { rows } = await db.query(countSql, filterParams);
          return { matchedCount: parseInt(rows[0].count), modifiedCount: 0 };
      }

      const { expression: setExpression, params: updateParams } = setExpressionResult;
      
      // Construct final query parts
      const setClause = `SET ${jsonField} = ${renumberPlaceholders(setExpression, filterParams.length)}`;
      const finalSql = `UPDATE \"${name}\" ${setClause} ${whereClause}`.trim();
      const finalParams = [...filterParams, ...updateParams];

      // Add logging
      console.log('>>> [updateOne] SQL:', finalSql);
      console.log('>>> [updateOne] PARAMS:', finalParams);

      try {
        const { rowCount } = await db.query(finalSql, finalParams);
        return { matchedCount: rowCount ?? 0, modifiedCount: rowCount ?? 0 };
      } catch (error) {
          console.error('Error during updateOne execution:', error);
          console.error('Failed SQL:', finalSql);
          console.error('Failed PARAMS:', finalParams);
          throw error; // Re-throw after logging
      }
    },

    /**
     * Updates multiple documents matching the filter using parameterization.
     */
    async updateMany(filter: Record<string, any>, updateOps: Record<string, any>): Promise<UpdateResult> {
       if (!filter || Object.keys(filter).length === 0) {
         console.warn('[updateMany] Filter object is empty. No documents updated.');
          return { matchedCount: 0, modifiedCount: 0 };
       }
      const db = await getConnection();
      const jsonField = capturedOptions?.jsonField || 'data';
      const { whereClause, params: filterParams } = mongoToPg.buildWhereClauseAndParams(filter, jsonField);
      // console.log('>>> updateMany - jsonField:', jsonField, 'Type:', typeof jsonField, 'Update:', JSON.stringify(updateOps));

      const setExpressionResult = mongoToPg.buildUpdateSetExpressionAndParams(updateOps, jsonField);

      if (!setExpressionResult) {
          console.warn('[updateMany] No valid update operators found.');
         const countSql = `SELECT COUNT(*) as count FROM \"${name}\" ${whereClause}`.trim();
         const { rows } = await db.query(countSql, filterParams);
         return { matchedCount: parseInt(rows[0].count), modifiedCount: 0 };
      }

      const { expression: setExpression, params: updateParams } = setExpressionResult;

      const finalSql = `UPDATE \"${name}\" SET data = ${renumberPlaceholders(setExpression, filterParams.length)} ${whereClause}`.trim();
      const finalParams = [...filterParams, ...updateParams];

      const { rowCount } = await db.query(finalSql, finalParams);

      return { matchedCount: rowCount ?? 0, modifiedCount: rowCount ?? 0 };
    },

    schema
  } as ModelStaticMethods<DocType>;
}