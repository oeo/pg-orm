import { defineSchema } from './lib/schema';
import { transaction, events } from './lib/connection';
import { Document, OptimisticLockError } from './lib/document';

// export individual items for those who need them
export * from './lib';

// export unified API object for simpler usage
export const pgorm = {
  defineSchema,
  transaction,
  events,
  Document,
  errors: {
    OptimisticLockError
  }
} as const; 