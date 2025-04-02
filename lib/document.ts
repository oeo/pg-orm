import { nanoid } from 'nanoid';
import type { SchemaDefinition, SchemaHooks } from './types';
import { getConnection } from './connection';
import { events } from './connection';
import { singularize } from './utils';

// generate prefixed id
function generateId(collectionName: string): string {
  if (!collectionName) return nanoid(); 
  const prefix = singularize(collectionName).toLowerCase();
  return `${prefix}_${nanoid()}`;
}

export class OptimisticLockError extends Error {
  constructor(message = 'Document was modified by another process') {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

export class Document<T> {
  [key: string]: any;
  #_populated: Record<string, boolean> = {};
  #schema: SchemaDefinition;
  #collectionName: string;
  #originalVersion?: number;
  #hooks?: SchemaHooks<T>;
  #modifiedPaths: Set<string> = new Set();

  constructor(
    data: Partial<T>, 
    schema: SchemaDefinition, 
    collectionName: string,
    hooks?: SchemaHooks<T>
  ) {
    Object.assign(this, data);
    this.#schema = schema;
    this.#collectionName = collectionName;
    this.#originalVersion = (typeof (data as any)._vers === 'number' && (data as any)._vers > 0) 
                              ? (data as any)._vers 
                              : undefined;
    this.#hooks = hooks;
    
    if (this._id === undefined) {
      this._id = generateId(collectionName);
    }
    if (this._ctime === undefined) {
      this._ctime = Date.now();
    }
     if (this._mtime === undefined) {
      this._mtime = this._ctime;
    }
    
    Object.defineProperty(this, Symbol.for('nodejs.util.inspect.custom'), {
      enumerable: false,
      value: () => this.toJSON()
    });
  }

  // Mark a path as modified
  markModified(path: string): void {
    if (path) {
      this.#modifiedPaths.add(path);
    }
  }

  // Method to check if the document is considered new (not yet saved or version 0)
  isNew(): boolean {
    // Based on the logic used in save(): considers new if originalVersion is undefined/0
    return !(typeof this.#originalVersion === 'number' && this.#originalVersion > 0 && this._id);
  }

  // Method to check if the document is being updated (opposite of new)
  isModified(path?: string): boolean {
    if (path === undefined) {
      // Original behavior: Is this an update operation?
      return !this.isNew();
    } else {
      // Check if the specific path or any parent path was marked modified
      if (this.#modifiedPaths.has(path)) return true;
      const parts = path.split('.');
      for (let i = parts.length - 1; i > 0; i--) {
        if (this.#modifiedPaths.has(parts.slice(0, i).join('.'))) {
          return true;
        }
      }
      return false;
    }
  }

  toJSON() {
    const baseFields = ['_id', '_vers', '_ctime', '_mtime'];
    const schemaFields = Object.keys(this.#schema);
    const allowedKeys = new Set([...baseFields, ...schemaFields]);
    return Object.fromEntries(
      Object.entries(this).filter(([key]) => allowedKeys.has(key))
    );
  }

  async #validate(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const validationContext = this;

    for (const [field, config] of Object.entries(this.#schema)) {
      const value = this[field];
      if (config.required && (value === undefined || value === null)) {
        errors.push(`${field} is required`);
        continue;
      }

      if (config.validate && value !== undefined) {
        try {
          await Promise.resolve(config.validate.call(validationContext, value));
        } catch (err) {
          errors.push(`${field}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    
    return { valid: errors.length === 0, errors };
  }

  async save(): Promise<Document<T>> {
    const db = await getConnection();
    const validation = await this.#validate();
    
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }

    // Use the helper method now
    const isUpdate = !this.isNew();

    if (this.#hooks?.preSave) {
      // The hook can now call this.isNew() or this.isModified()
      await Promise.resolve(this.#hooks.preSave.call(this));
    }

    if (isUpdate) {
      if (!this._id) throw new Error("Cannot update document without _id");
      if (typeof this.#originalVersion !== 'number') {
        throw new Error("Cannot update document without original version for optimistic locking.");
      }
      this._mtime = Date.now();
      const saveData = this.toJSON();
      saveData._vers = (this._vers || 0) + 1;

      for (const [field, config] of Object.entries(this.#schema)) {
        if (config.type === 'ref' && this.#_populated[field] && typeof this[field] === 'object' && this[field]?._id) {
          saveData[field] = this[field]._id; 
        }
        if (config.type === 'array' && config.of.type === 'ref' && this.#_populated[field] && Array.isArray(this[field])) {
           saveData[field] = this[field].map((item: any) => (typeof item === 'object' && item?._id) ? item._id : item);
        }
      }
      
      const { rows } = await db.query(
        `UPDATE ${this.#collectionName} SET data = $1 WHERE data->>'_id' = $2 AND (data->>'_vers')::int = $3 RETURNING data`,
        [saveData, this._id, this.#originalVersion]
      );

      if (rows.length === 0) {
        const existsCheck = await db.query(`SELECT data->>'_vers' as version FROM ${this.#collectionName} WHERE data->>'_id' = $1`, [this._id]);
        if (existsCheck.rowCount === 0) {
            throw new Error(`Document with _id ${this._id} not found for update.`);
        }
        const currentDbVersion = existsCheck.rows[0].version;
        throw new OptimisticLockError(`Optimistic lock failed for _id ${this._id}. Expected version ${this.#originalVersion}, but found ${currentDbVersion}.`);
      }

      this._vers = saveData._vers;
      this.#originalVersion = this._vers;
      this.#_populated = {};
      this.#modifiedPaths.clear();
      events.emit(`${this.#collectionName}:updated`, this);

    } else {
      this._id = this._id || generateId(this.#collectionName);
      const nowMillis = Date.now();
      this._ctime = this._ctime || nowMillis;
      this._mtime = this._mtime || nowMillis;
      this._vers = this._vers || 1;

      const saveData = this.toJSON();
      if (saveData._vers === undefined) saveData._vers = this._vers;

      for (const [field, config] of Object.entries(this.#schema)) {
        if (config.type === 'ref' && this.#_populated[field] && typeof this[field] === 'object' && this[field]?._id) {
          saveData[field] = this[field]._id; 
        }
         if (config.type === 'array' && config.of.type === 'ref' && this.#_populated[field] && Array.isArray(this[field])) {
           saveData[field] = this[field].map((item: any) => (typeof item === 'object' && item?._id) ? item._id : item);
        }
      }

      const { rows } = await db.query(
        `INSERT INTO ${this.#collectionName} (data) VALUES ($1) RETURNING data`,
        [saveData]
      );

      this.#originalVersion = this._vers;
      this.#_populated = {};
      this.#modifiedPaths.clear();
      events.emit(`${this.#collectionName}:created`, this);
    }

    return this;
  }

  async #checkExists(id: string | undefined = this._id, version?: number): Promise<boolean> {
    if (!id) return false;
    const db = await getConnection();
    let sql = `SELECT 1 FROM ${this.#collectionName} WHERE data->>'_id' = $1`;
    const params: any[] = [id];
    if (version !== undefined) {
      sql += ` AND (data->>'_vers')::int = $2`;
      params.push(version);
    }
    const { rowCount } = await db.query(sql, params);
    return (rowCount ?? 0) > 0;
  }

  private async populateRef(field: string, fieldConfig: { type: 'ref'; ref: string }): Promise<void> {
    if (!this[field] || typeof this[field] !== 'string') return;
    
    const db = await getConnection();
    const { rows } = await db.query(
      `SELECT data FROM ${fieldConfig.ref} WHERE data->>'_id' = $1`,
      [this[field]]
    );

    if (rows[0]) {
      this[field] = new Document(rows[0].data, this.#schema, fieldConfig.ref /*, this.#hooks */);
      this.#_populated[field] = true;
    }
  }

  private async populateArray(field: string, fieldConfig: { type: 'array'; of: any }): Promise<void> {
    if (!Array.isArray(this[field]) || this[field].length === 0) return;

    const idsToPopulate = this[field].filter(item => typeof item === 'string');
    if (idsToPopulate.length === 0) return;

    if (fieldConfig.of.type === 'ref') {
      const db = await getConnection();
      const { rows } = await db.query(
        `SELECT data FROM ${fieldConfig.of.ref} WHERE data->>'_id' = ANY($1::text[])`,
        [idsToPopulate]
      );

      const docsById = Object.fromEntries(
        rows.map(row => [
          row.data._id,
          new Document(row.data, this.#schema, fieldConfig.of.ref)
        ])
      );
      
      this[field] = this[field].map((item: any) => docsById[item] || item);
      this.#_populated[field] = true;
    }
  }

  private async populateNestedRef(field: string, item: any, nestedField: string, refConfig: { type: 'ref'; ref: string }): Promise<void> {
    if (!item || typeof item !== 'object' || !item[nestedField] || typeof item[nestedField] !== 'string') return;

    const db = await getConnection();
    const { rows } = await db.query(
      `SELECT data FROM ${refConfig.ref} WHERE data->>'_id' = $1`,
      [item[nestedField]]
    );

    if (rows[0]) {
      item[nestedField] = new Document(rows[0].data, this.#schema, refConfig.ref);
    }
  }

  async populate(fields: string | string[]): Promise<Document<T>> {
    const fieldsArray = Array.isArray(fields) ? fields : [fields];

    for (const field of fieldsArray) {
      const parts = field.split('.');
      const rootField = parts[0];
      const nestedField = parts[1];

      const fieldConfig = this.#schema[rootField];
      if (!fieldConfig) continue;

      if (parts.length === 1) {
        if (fieldConfig.type === 'ref') {
          await this.populateRef(rootField, fieldConfig as { type: 'ref'; ref: string });
        } else if (fieldConfig.type === 'array' && fieldConfig.of.type === 'ref') {
          await this.populateArray(rootField, fieldConfig as any);
        }
      } else if (parts.length === 2 && nestedField) {
        if (fieldConfig.type === 'array' && fieldConfig.of.type === 'object') {
          const nestedSchema = fieldConfig.of.schema;
          const nestedConfig = nestedSchema ? nestedSchema[nestedField] : undefined;

          if (nestedConfig?.type === 'ref') {
            if (Array.isArray(this[rootField])) {
              for (const item of this[rootField]) {
                await this.populateNestedRef(rootField, item, nestedField, nestedConfig as { type: 'ref'; ref: string });
              }
              this.#_populated[field] = true;
            }
          }
        }
      }
    }

    return this;
  }

  async remove(): Promise<void> {
    const db = await getConnection();
    await db.query(
      `DELETE FROM ${this.#collectionName} WHERE data->>'_id' = $1`,
      [this._id]
    );
    events.emit(`${this.#collectionName}:removed`, this);
    Object.freeze(this);
  }
} 