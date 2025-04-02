// core type definitions
import type { PoolConfig } from 'pg';
import type { Document } from './document';

// validation and default value types
export type ValidationFunction<T = any> = (this: T, value: any) => Promise<void> | void;
export type DefaultFunction<T = any> = (this: T) => Promise<any> | any;

// field configuration types
export type BaseFieldConfig = {
  required?: boolean;
  default?: any | DefaultFunction;
  validate?: ValidationFunction;
};

export type FieldType = 'string' | 'number' | 'boolean' | 'ref' | 'array' | 'object';

export type FieldConfig = 
  | (BaseFieldConfig & { type: 'string' | 'number' | 'boolean' })
  | (BaseFieldConfig & { type: 'ref'; ref: string })
  | (BaseFieldConfig & { type: 'array'; of: FieldConfig })
  | (BaseFieldConfig & { type: 'object'; schema: SchemaDefinition });

export type SchemaDefinition = Record<string, FieldConfig>;

// type inference utilities
type BaseDocument = {
  _id: string;
  _ctime?: number;
  _mtime?: number;
  _vers: number;
};

export type InferFieldType<F extends FieldConfig> = 
  F extends { type: 'string' } ? string :
  F extends { type: 'number' } ? number :
  F extends { type: 'boolean' } ? boolean :
  F extends { type: 'ref' } ? string :
  F extends { type: 'array'; of: FieldConfig } ? Array<InferFieldType<F['of']>> :
  F extends { type: 'object'; schema: SchemaDefinition } ? InferSchemaType<F['schema']> :
  never;

type RawSchemaType<S extends SchemaDefinition> = {
  [K in keyof S]: S[K] extends { required: true } 
    ? InferFieldType<S[K]> 
    : (InferFieldType<S[K]> | undefined);
};

// combine BaseDocument and RawSchemaType
export type InferSchemaType<S extends SchemaDefinition> = BaseDocument & {
  [K in keyof S]: S[K] extends { default: any } | { required: false }
    ? InferFieldType<S[K]> | undefined
    : InferFieldType<S[K]>;
};

// query types
export type SortDirection = 1 | -1;
export type SortOptions<T> = Partial<Record<keyof T, SortDirection>>;
export type FindOptions<T> = {
  sort?: SortOptions<T>;
  limit?: number;
  offset?: number;
};

// database config type
export type DbConfig = PoolConfig;

// hook types
export type PreSaveHook<T> = (this: Document<T>) => Promise<void> | void;
export type SchemaHooks<T> = {
  preSave?: PreSaveHook<T>;
  // potentially add other hooks like postSave, preRemove etc. here
};

// Schema options type
export type SchemaOptions = {
  jsonField?: string;
  hooks?: SchemaHooks<any>; // Use 'any' here, specific type will be inferred in defineSchema
};

// Represents the static methods returned by defineSchema
export type ModelStaticMethods<T extends Record<string, any> = any> = {
  find1(id: string): Promise<Document<T> | null>;
  query<U = T>(sql: string, params?: any[], options?: { raw?: boolean }): Promise<U[]>;
  findOne(mongoQuery?: Record<string, any>): Promise<Document<T> | null>;
  find(mongoQuery?: Record<string, any>, options?: FindOptions<T>): Promise<Document<T>[]>;
  create(doc: Partial<T>): Promise<Document<T>>;
  count(mongoQuery?: Record<string, any>): Promise<number>;
  remove(mongoQuery: Record<string, any>): Promise<{ deletedCount: number }>;
  updateOne(filter: Record<string, any>, updateOps: Record<string, any>): Promise<UpdateResult>;
  updateMany(filter: Record<string, any>, updateOps: Record<string, any>): Promise<UpdateResult>;
  schema: SchemaDefinition;
};

// Update result type for updateOne/updateMany
export type UpdateResult = {
  matchedCount: number;
  modifiedCount: number;
}; 