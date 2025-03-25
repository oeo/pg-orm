// core type definitions
import type { PoolConfig } from 'pg';

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
  _id?: string;
  ctime?: number;
  mtime?: number;
  version?: number;
};

export type InferFieldType<F extends FieldConfig> = 
  F extends { type: 'string' } ? string :
  F extends { type: 'number' } ? number :
  F extends { type: 'boolean' } ? boolean :
  F extends { type: 'ref' } ? string :
  F extends { type: 'array'; of: FieldConfig } ? Array<InferFieldType<F['of']>> :
  F extends { type: 'object'; schema: SchemaDefinition } ? InferSchemaType<F['schema']> :
  never;

export type InferSchemaType<S extends SchemaDefinition> = BaseDocument & {
  [K in keyof S]: S[K] extends { default: any } | { required: false }
    ? InferFieldType<S[K]> | undefined
    : InferFieldType<S[K]>;
};

// query types
export type SortDirection = 'asc' | 'desc';
export type SortOptions<T> = Partial<Record<keyof T, SortDirection>>;
export type FindOptions<T> = {
  sort?: SortOptions<T>;
  limit?: number;
  offset?: number;
};

// database config type
export type DbConfig = PoolConfig; 