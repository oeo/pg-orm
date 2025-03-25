// db.ts - core database layer
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { EventEmitter } from 'events';
import { nanoid } from 'nanoid';

// schema field types
type BaseFieldType = 'string' | 'number' | 'boolean';

type FieldConfig<T extends BaseFieldType | 'ref' | 'array' | 'object', Extra = {}> = {
  type: T;
  required?: boolean;
  default?: any;
} & Extra;

type StringField = FieldConfig<'string'>;
type NumberField = FieldConfig<'number'>;
type BooleanField = FieldConfig<'boolean'>;
type RefField = FieldConfig<'ref', { ref: string }>;
type ArrayField = FieldConfig<'array', { of: FieldType }>;
type ObjectField = FieldConfig<'object', { schema: SchemaDefinition }>;

type FieldType = StringField | NumberField | BooleanField | RefField | ArrayField | ObjectField;
type SchemaDefinition = Record<string, FieldType>;

// type inference utilities
type InferFieldType<F extends FieldType> = F extends StringField
  ? string
  : F extends NumberField
  ? number
  : F extends BooleanField
  ? boolean
  : F extends RefField
  ? string
  : F extends ArrayField
  ? Array<InferFieldType<F['of']>>
  : F extends ObjectField
  ? InferSchemaType<F['schema']>
  : never;

type InferSchemaType<S extends SchemaDefinition> = {
  [K in keyof S]: InferFieldType<S[K]>;
} & {
  _id?: string;
  ctime?: number;
  mtime?: number;
};

// event system for document changes
export const events = new EventEmitter();

// database configuration
const dbConfig: PoolConfig = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || process.platform === 'win32' ? process.env.USERNAME : process.env.USER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 20
};

// database connection management
let pool: Pool | null = null;
const schemas = new Map<string, SchemaDefinition>();

// ensure database and tables exist
async function createSchemas(db: Pool) {
  for (const [name] of schemas.entries()) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${name} (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${name}_id_idx ON ${name} ((data->>'_id'));
    `);
  }
}

export async function ensureDatabase() {
  if (pool) return pool;

  const tempConfig = { ...dbConfig, database: 'postgres' };
  const tempPool = new Pool(tempConfig);

  try {
    const { rows } = await tempPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbConfig.database]
    );

    if (rows.length === 0) {
      console.log(`creating database "${dbConfig.database}"...`);
      await tempPool.query(`CREATE DATABASE ${dbConfig.database}`);
      console.log('database created successfully');
    }
  } finally {
    await tempPool.end();
  }

  const db = new Pool(dbConfig);
  db.on('error', (err: Error) => console.error('unexpected postgres pool error:', err));
  await createSchemas(db);
  console.log('successfully connected to postgres');
  pool = db;
  return db;
}

// document interface and implementation
interface DocumentMethods {
  save(): Promise<Document<any>>;
  populate(fields: string | string[]): Promise<Document<any>>;
  remove(): Promise<void>;
}

// simple pluralization rules for common cases
function singularize(word: string): string {
  // handle special cases
  const specialCases: Record<string, string> = {
    children: 'child',
    people: 'person',
    men: 'man',
    women: 'woman',
    teeth: 'tooth',
    feet: 'foot',
    mice: 'mouse',
    geese: 'goose'
  };

  if (specialCases[word.toLowerCase()]) {
    return specialCases[word.toLowerCase()];
  }

  // handle common plural endings
  if (word.endsWith('ies')) {
    return word.slice(0, -3) + 'y';
  }
  if (word.endsWith('es')) {
    // cases like 'classes' -> 'class'
    if (['sh', 'ch', 'x', 's'].some(ending => word.slice(0, -2).endsWith(ending))) {
      return word.slice(0, -2);
    }
  }
  if (word.endsWith('s')) {
    return word.slice(0, -1);
  }

  return word;
}

// generate prefixed id
function generateId(collectionName: string): string {
  const prefix = singularize(collectionName).toLowerCase();
  return `${prefix}_${nanoid()}`;
}

class Document<T> implements DocumentMethods {
  [key: string]: any;
  #_populated: Record<string, boolean> = {};
  #schema: SchemaDefinition;
  #collectionName: string;

  constructor(data: Partial<T>, schema: SchemaDefinition, collectionName: string) {
    Object.assign(this, data);
    this.#schema = schema;
    this.#collectionName = collectionName;
    
    // just add the custom inspect handler for clean console.log
    Object.defineProperty(this, Symbol.for('nodejs.util.inspect.custom'), {
      enumerable: false,
      value: () => this.toJSON()
    });
  }

  toJSON() {
    const cleanObj: Record<string, any> = {};
    for (const [key, value] of Object.entries(this)) {
      if (typeof value === 'function') continue;
      cleanObj[key] = value;
    }
    return cleanObj;
  }

  async save(): Promise<Document<T>> {
    return this.#save();
  }

  async populate(fields: string | string[]): Promise<Document<T>> {
    return this.#populate(fields);
  }

  async remove(): Promise<void> {
    if (!this._id) return;
    const db = await ensureDatabase();
    await db.query(
      `DELETE FROM ${this.#collectionName} WHERE data->>'_id' = $1`,
      [this._id]
    );
    events.emit(`${this.#collectionName}:removed`, this);
  }

  async #save(): Promise<Document<T>> {
    const db = await ensureDatabase();

    if (this._id) {
      this.mtime = Math.floor(Date.now() / 1000);
      
      const saveData = { ...this } as Record<string, any>;
      for (const [field, config] of Object.entries(this.#schema)) {
        if (config.type === 'ref' && this.#_populated[field]) {
          saveData[field] = this[field]._id;
        }
      }

      const { rows } = await db.query(
        `UPDATE ${this.#collectionName} SET data = $1 WHERE data->>'_id' = $2 RETURNING data`,
        [saveData, this._id]
      );

      Object.assign(this, rows[0].data);
      events.emit(`${this.#collectionName}:updated`, this);
    } else {
      this._id = generateId(this.#collectionName);
      this.ctime = Math.floor(Date.now() / 1000);
      this.mtime = this.ctime;

      const { rows } = await db.query(
        `INSERT INTO ${this.#collectionName} (data) VALUES ($1) RETURNING data`,
        [this]
      );

      Object.assign(this, rows[0].data);
      events.emit(`${this.#collectionName}:created`, this);
    }

    return this;
  }

  async #populate(fields: string | string[]): Promise<Document<T>> {
    const db = await ensureDatabase();
    
    const fieldsArray = Array.isArray(fields) ? fields : [fields];
    const populatedDocs: Record<string, Document<any>> = {};

    for (const field of fieldsArray) {
      const [rootField, nestedField] = field.split('.');
      const fieldConfig = this.#schema[rootField];
      
      if (!fieldConfig) continue;

      if (fieldConfig.type === 'ref' && this[rootField]) {
        if (!populatedDocs[this[rootField]]) {
          const { rows } = await db.query(
            `SELECT data FROM ${(fieldConfig as RefField).ref} WHERE data->>'_id' = $1`,
            [this[rootField]]
          );

          if (rows[0]) {
            populatedDocs[this[rootField]] = new Document(rows[0].data, this.#schema, (fieldConfig as RefField).ref);
          }
        }

        if (populatedDocs[this[rootField]]) {
          this[rootField] = populatedDocs[this[rootField]];
          this.#_populated[rootField] = true;
        }
      } else if (fieldConfig.type === 'array' && Array.isArray(this[rootField])) {
        if (fieldConfig.of.type === 'ref') {
          const ids = this[rootField];
          if (ids.length === 0) continue;

          const { rows } = await db.query(
            `SELECT data FROM ${(fieldConfig.of as RefField).ref} WHERE data->>'_id' = ANY($1)`,
            [ids]
          );

          const docsById: Record<string, Document<any>> = {};
          rows.forEach(row => {
            docsById[row.data._id] = new Document(row.data, this.#schema, (fieldConfig.of as RefField).ref);
          });

          this[rootField] = ids.map(id => docsById[id]).filter(Boolean);
          this.#_populated[rootField] = true;
        } else if (fieldConfig.of.type === 'object' && nestedField) {
          // handle nested objects in arrays
          for (const item of this[rootField]) {
            if (item[nestedField]) {
              const nestedConfig = (fieldConfig.of as ObjectField).schema[nestedField];
              if (nestedConfig?.type === 'ref') {
                const { rows } = await db.query(
                  `SELECT data FROM ${(nestedConfig as RefField).ref} WHERE data->>'_id' = $1`,
                  [item[nestedField]]
                );

                if (rows[0]) {
                  item[nestedField] = new Document(rows[0].data, this.#schema, (nestedConfig as RefField).ref);
                }
              }
            }
          }
        }
      }
    }

    return this;
  }
}

// add these types near the top with other type definitions
type SortDirection = 'asc' | 'desc';
type SortOptions<T> = Partial<Record<keyof T, SortDirection>>;
type FindOptions<T> = {
  sort?: SortOptions<T>;
  limit?: number;
  offset?: number;
};

// schema builder with type inference
export function defineSchema<S extends SchemaDefinition>(name: string, schema: S) {
  schemas.set(name, schema);
  type DocType = InferSchemaType<S>;

  function getDefaults(): Partial<DocType> {
    const defaults: Record<string, any> = {};
    for (const [field, config] of Object.entries(schema)) {
      if ('default' in config && config.default !== undefined) {
        defaults[field] = typeof config.default === 'function'
          ? config.default()
          : config.default;
      }
    }
    return defaults as Partial<DocType>;
  }

  function validate(doc: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const [field, config] of Object.entries(schema)) {
      if (config.required && (doc[field] === undefined || doc[field] === null)) {
        errors.push(`${field} is required`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  return {
    async findById(id: string): Promise<Document<DocType> | null> {
      const db = await ensureDatabase();
      const { rows } = await db.query(
        `SELECT data FROM ${name} WHERE data->>'_id' = $1`,
        [id]
      );
      return rows[0] ? new Document<DocType>(rows[0].data, schema, name) : null;
    },

    async findOne(query: Partial<DocType> = {}): Promise<Document<DocType> | null> {
      const db = await ensureDatabase();
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
      const db = await ensureDatabase();
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
      const documentWithDefaults = { ...getDefaults(), ...doc };
      const validation = validate(documentWithDefaults);
      
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
      }

      const document = new Document<DocType>(documentWithDefaults, schema, name);
      return document.save();
    },

    where(field: string & keyof DocType, operator: string | any, value?: any) {
      const conditions: Array<{field: string, op: string, value: any}> = [];
      conditions.push({ field, op: value === undefined ? '=' : operator, value: value === undefined ? operator : value });

      type QueryBuilder = {
        where: (field: string & keyof DocType, operator: string | any, value?: any) => QueryBuilder;
        sort: (field: keyof DocType, direction: SortDirection) => QueryBuilder;
        limit: (limit: number) => QueryBuilder;
        offset: (offset: number) => QueryBuilder;
        execute: () => Promise<Document<DocType>[]>;
      };

      let sortOptions: SortOptions<DocType> = {};
      let limit: number | undefined;
      let offset: number | undefined;

      const builder: QueryBuilder = {
        where: (field: string & keyof DocType, operator: string | any, value?: any) => {
          conditions.push({ field, op: value === undefined ? '=' : operator, value: value === undefined ? operator : value });
          return builder;
        },
        sort: (field: keyof DocType, direction: SortDirection) => {
          sortOptions = { ...sortOptions, [field]: direction };
          return builder;
        },
        limit: (value: number) => {
          limit = value;
          return builder;
        },
        offset: (value: number) => {
          offset = value;
          return builder;
        },
        execute: async () => {
          const db = await ensureDatabase();
          const params: any[] = [];
          const whereClauses = conditions.map(({field, op, value}, i) => {
            params.push(value);
            switch(op) {
              case '=': return `data->>'${field}' = $${i+1}`;
              case '<': return `(data->>'${field}')::numeric < $${i+1}`;
              case '>': return `(data->>'${field}')::numeric > $${i+1}`;
              case 'contains': return `data->>'${field}' LIKE '%' || $${i+1} || '%'`;
              default: return `data->>'${field}' = $${i+1}`;
            }
          });

          const sortClauses = Object.entries(sortOptions)
            .map(([field, direction]) => 
              `data->>'${String(field)}' ${direction?.toUpperCase() || 'ASC'}`
            );
          const sortClause = sortClauses.length ? `ORDER BY ${sortClauses.join(', ')}` : '';

          const paginationClause = limit
            ? `LIMIT ${limit} OFFSET ${offset || 0}`
            : '';

          const { rows } = await db.query(
            `SELECT data FROM ${name} WHERE ${whereClauses.join(' AND ')} ${sortClause} ${paginationClause}`,
            params
          );

          return rows.map(row => new Document<DocType>(row.data, schema, name));
        }
      };

      return builder;
    },

    async remove(query: Partial<DocType> = {}): Promise<void> {
      const db = await ensureDatabase();
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

// transaction support
export async function transaction<T>(callback: () => Promise<T>): Promise<T> {
  const db = await ensureDatabase();
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const result = await callback();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

