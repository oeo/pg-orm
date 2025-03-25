import type { SchemaDefinition, InferSchemaType, FindOptions } from './types';
import { Document } from './document';
import { getConnection, registerSchema } from './connection';
import { events } from './connection';

type QueryCondition = {
  field: string;
  op: string;
  value: any;
  type: 'and' | 'or';
};

class QueryBuilder<DocType> {
  private conditions: QueryCondition[] = [];
  private sortOptions: Record<string, 'asc' | 'desc'> = {};
  private limitValue?: number;
  private offsetValue?: number;

  constructor(
    private collectionName: string,
    private schema: SchemaDefinition
  ) {}

  where(field: string & keyof DocType, operator: string | any, value?: any): this {
    this.conditions.push({ 
      field, 
      op: value === undefined ? '=' : operator, 
      value: value === undefined ? operator : value,
      type: 'and'
    });
    return this;
  }

  orWhere(field: string & keyof DocType, operator: string | any, value?: any): this {
    this.conditions.push({ 
      field, 
      op: value === undefined ? '=' : operator, 
      value: value === undefined ? operator : value,
      type: 'or'
    });
    return this;
  }

  sort(field: keyof DocType, direction: 'asc' | 'desc'): this {
    this.sortOptions[String(field)] = direction;
    return this;
  }

  limit(value: number): this {
    this.limitValue = value;
    return this;
  }

  offset(value: number): this {
    this.offsetValue = value;
    return this;
  }

  private buildQuery(
    conditions: QueryCondition[] = [], 
    sort: Record<string, 'asc' | 'desc'> = {}, 
    limit?: number, 
    offset?: number
  ): { sql: string; params: any[] } {
    const params: any[] = [];
    const andConditions: string[] = [];
    const orConditions: string[] = [];
    
    conditions.forEach(({field, op, value, type}, i) => {
      params.push(value);
      let clause: string;
      switch(op) {
        case '=': clause = `data->>'${field}' = $${i+1}`; break;
        case '<': clause = `(data->>'${field}')::numeric < $${i+1}`; break;
        case '>': clause = `(data->>'${field}')::numeric > $${i+1}`; break;
        case 'contains': clause = `data->>'${field}' LIKE '%' || $${i+1} || '%'`; break;
        default: clause = `data->>'${field}' = $${i+1}`;
      }
      if (type === 'and') {
        andConditions.push(clause);
      } else {
        orConditions.push(clause);
      }
    });

    const whereComponents = [
      andConditions.length ? `(${andConditions.join(' AND ')})` : null,
      orConditions.length ? `(${orConditions.join(' OR ')})` : null
    ].filter(Boolean);

    const whereClause = whereComponents.length ? `WHERE ${whereComponents.join(' OR ')}` : '';
    const sortClause = Object.entries(sort)
      .map(([field, direction]) => `data->>'${field}' ${direction.toUpperCase()}`)
      .join(', ');
    const orderByClause = sortClause ? `ORDER BY ${sortClause}` : '';
    const paginationClause = limit ? `LIMIT ${limit} OFFSET ${offset || 0}` : '';

    return { 
      sql: `SELECT data FROM ${this.collectionName} ${whereClause} ${orderByClause} ${paginationClause}`.trim(),
      params 
    };
  }

  async execute(): Promise<Document<DocType>[]> {
    const db = await getConnection();
    const { sql, params } = this.buildQuery(
      this.conditions,
      this.sortOptions,
      this.limitValue,
      this.offsetValue
    );

    const { rows } = await db.query(sql, params);
    return rows.map(row => new Document<DocType>(row.data, this.schema, this.collectionName));
  }

  async count(): Promise<number> {
    const db = await getConnection();
    const { sql, params } = this.buildQuery(this.conditions);
    const countSql = `SELECT COUNT(*) as count FROM (${sql}) as subquery`;

    const { rows } = await db.query(countSql, params);
    return parseInt(rows[0].count);
  }
}

export function defineSchema<S extends SchemaDefinition>(name: string, schema: S) {
  registerSchema(name, schema);
  type DocType = InferSchemaType<S>;

  async function getDefaults(): Promise<Partial<DocType>> {
    const defaults: Record<string, any> = {};
    for (const [field, config] of Object.entries(schema)) {
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

  return {
    async findById(id: string): Promise<Document<DocType> | null> {
      const db = await getConnection();
      const { rows } = await db.query(
        `SELECT data FROM ${name} WHERE data->>'_id' = $1`,
        [id]
      );
      return rows[0] ? new Document<DocType>(rows[0].data, schema, name) : null;
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
          const data = row.data || row;
          if (data._id || data.data?._id) {
            return new Document<DocType>(data, schema, name) as unknown as T;
          }
          return data as T;
        });
      } catch (err) {
        return rows as T[];
      }
    },

    async findOne(query: Partial<DocType> = {}): Promise<Document<DocType> | null> {
      const db = await getConnection();
      const conditions = Object.entries(query).map(([k, v], i) => `data->>'${String(k)}' = $${i+1}`);
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await db.query(
        `SELECT data FROM ${name} ${whereClause} LIMIT 1`,
        Object.values(query)
      );
      return rows[0] ? new Document<DocType>(rows[0].data, schema, name) : null;
    },

    async find(
      query: Partial<DocType> = {}, 
      options: FindOptions<DocType> = {}
    ): Promise<Document<DocType>[]> {
      const db = await getConnection();
      const conditions = Object.entries(query).map(([k, v], i) => `data->>'${String(k)}' = $${i+1}`);
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      
      const sortClauses = options.sort 
        ? Object.entries(options.sort)
            .map(([field, direction]) => 
              `data->>'${String(field)}' ${direction?.toUpperCase() || 'ASC'}`
            )
        : [];
      const sortClause = sortClauses.length ? `ORDER BY ${sortClauses.join(', ')}` : '';
      
      const paginationClause = options.limit
        ? `LIMIT ${options.limit} OFFSET ${options.offset || 0}`
        : '';

      const { rows } = await db.query(
        `SELECT data FROM ${name} ${whereClause} ${sortClause} ${paginationClause}`,
        Object.values(query)
      );
      return rows.map(row => new Document<DocType>(row.data, schema, name));
    },

    async create(doc: Partial<DocType>): Promise<Document<DocType>> {
      const documentWithDefaults = { ...await getDefaults(), ...doc };
      const document = new Document<DocType>(documentWithDefaults, schema, name);
      return document.save();
    },

    async count(query: Partial<DocType> = {}): Promise<number> {
      const db = await getConnection();
      const conditions = Object.entries(query).map(([k, v], i) => `data->>'${String(k)}' = $${i+1}`);
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      
      const { rows } = await db.query(
        `SELECT COUNT(*) as count FROM ${name} ${whereClause}`,
        Object.values(query)
      );
      return parseInt(rows[0].count);
    },

    where(field: string & keyof DocType, operator: string | any, value?: any) {
      return new QueryBuilder<DocType>(name, schema).where(field, operator, value);
    },

    async remove(query: Partial<DocType> = {}): Promise<void> {
      const db = await getConnection();
      const conditions = Object.entries(query).map(([k, v], i) => `data->>'${String(k)}' = $${i+1}`);
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      await db.query(
        `DELETE FROM ${name} ${whereClause}`,
        Object.values(query)
      );
      events.emit(`${name}:removed`, query);
    },

    schema
  };
} 