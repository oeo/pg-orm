import { advisoryLock, events, transaction } from "./lib/connection";
import { Document, OptimisticLockError } from "./lib/document";
import { QueryError } from "./lib/mongo-converter";
import { defineSchema } from "./lib/schema";

// export individual items for those who need them
export * from "./lib";

// export unified API object for simpler usage
export const pgorm = {
  defineSchema,
  transaction,
  advisoryLock,
  events,
  Document,
  errors: {
    OptimisticLockError,
    QueryError,
  },
} as const;
