import { nanoid } from 'nanoid';
import type { SchemaDefinition } from './types';
import { getConnection } from './connection';
import { events } from './connection';

// simple pluralization rules for common cases
function singularize(word: string): string {
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

  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('es') && ['sh', 'ch', 'x', 's'].some(ending => word.slice(0, -2).endsWith(ending))) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s')) return word.slice(0, -1);

  return word;
}

// generate prefixed id
function generateId(collectionName: string): string {
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

  constructor(data: Partial<T>, schema: SchemaDefinition, collectionName: string) {
    Object.assign(this, data);
    this.#schema = schema;
    this.#collectionName = collectionName;
    this.#originalVersion = this.version;
    
    if (this.version === undefined) {
      this.version = 1;
    }
    
    Object.defineProperty(this, Symbol.for('nodejs.util.inspect.custom'), {
      enumerable: false,
      value: () => this.toJSON()
    });
  }

  toJSON() {
    return Object.fromEntries(
      Object.entries(this).filter(([_, value]) => typeof value !== 'function')
    );
  }

  async #validate(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const validationContext = this;

    for (const [field, config] of Object.entries(this.#schema)) {
      if (config.required && (this[field] === undefined || this[field] === null)) {
        errors.push(`${field} is required`);
        continue;
      }

      if (config.validate && this[field] !== undefined) {
        try {
          await Promise.resolve(config.validate.call(validationContext, this[field]));
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

    if (this._id) {
      this.mtime = Math.floor(Date.now() / 1000);
      
      const saveData = { ...this };
      for (const [field, config] of Object.entries(this.#schema)) {
        if (config.type === 'ref' && this.#_populated[field]) {
          saveData[field] = this[field]._id;
        }
      }

      saveData.version = (saveData.version || 1) + 1;

      const { rows } = await db.query(
        `UPDATE ${this.#collectionName} 
         SET data = $1 
         WHERE data->>'_id' = $2 
         AND (data->>'version')::int = $3
         RETURNING data`,
        [saveData, this._id, this.#originalVersion]
      );

      if (rows.length === 0) {
        throw new OptimisticLockError();
      }

      Object.assign(this, rows[0].data);
      this.#originalVersion = this.version;
      events.emit(`${this.#collectionName}:updated`, this);
    } else {
      this._id = generateId(this.#collectionName);
      this.ctime = Math.floor(Date.now() / 1000);
      this.mtime = this.ctime;
      this.version = 1;

      const { rows } = await db.query(
        `INSERT INTO ${this.#collectionName} (data) VALUES ($1) RETURNING data`,
        [this]
      );

      Object.assign(this, rows[0].data);
      this.#originalVersion = this.version;
      events.emit(`${this.#collectionName}:created`, this);
    }

    return this;
  }

  private async populateRef(field: string, fieldConfig: { type: 'ref'; ref: string }): Promise<void> {
    if (!this[field]) return;
    
    const db = await getConnection();
    const { rows } = await db.query(
      `SELECT data FROM ${fieldConfig.ref} WHERE data->>'_id' = $1`,
      [this[field]]
    );

    if (rows[0]) {
      this[field] = new Document(rows[0].data, this.#schema, fieldConfig.ref);
      this.#_populated[field] = true;
    }
  }

  private async populateArray(field: string, fieldConfig: { type: 'array'; of: any }): Promise<void> {
    if (!Array.isArray(this[field]) || this[field].length === 0) return;

    if (fieldConfig.of.type === 'ref') {
      const db = await getConnection();
      const { rows } = await db.query(
        `SELECT data FROM ${fieldConfig.of.ref} WHERE data->>'_id' = ANY($1)`,
        [this[field]]
      );

      const docsById = Object.fromEntries(
        rows.map(row => [
          row.data._id,
          new Document(row.data, this.#schema, fieldConfig.of.ref)
        ])
      );

      this[field] = this[field].map(id => docsById[id]).filter(Boolean);
      this.#_populated[field] = true;
    }
  }

  private async populateNestedRef(field: string, item: any, nestedField: string, refConfig: { type: 'ref'; ref: string }): Promise<void> {
    if (!item[nestedField]) return;

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
      const [rootField, nestedField] = field.split('.');
      const fieldConfig = this.#schema[rootField];
      
      if (!fieldConfig) continue;

      if (fieldConfig.type === 'ref') {
        await this.populateRef(rootField, fieldConfig as { type: 'ref'; ref: string });
      } else if (fieldConfig.type === 'array') {
        if (fieldConfig.of.type === 'ref') {
          await this.populateArray(rootField, fieldConfig);
        } else if (fieldConfig.of.type === 'object' && nestedField) {
          const nestedConfig = (fieldConfig.of as { type: 'object'; schema: SchemaDefinition }).schema[nestedField];
          if (nestedConfig?.type === 'ref') {
            for (const item of this[rootField]) {
              await this.populateNestedRef(rootField, item, nestedField, nestedConfig as { type: 'ref'; ref: string });
            }
          }
        }
      }
    }

    return this;
  }

  async remove(): Promise<void> {
    if (!this._id) return;
    const db = await getConnection();
    await db.query(
      `DELETE FROM ${this.#collectionName} WHERE data->>'_id' = $1`,
      [this._id]
    );
    events.emit(`${this.#collectionName}:removed`, this);
  }
} 