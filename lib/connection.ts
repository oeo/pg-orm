import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import type { DbConfig, ModelStaticMethods, SchemaDefinition } from "./types";

// event system for document changes
export const events = new EventEmitter();

// transaction context storage
const transactionContext = new AsyncLocalStorage<{
  client: PoolClient;
  observers: Array<() => unknown>;
  failed?: boolean;
  error?: unknown;
}>();

// database connection management
class DatabaseManager {
  private static instance: Pool | null = null;
  private static schemas = new Map<string, SchemaDefinition>();
  private static createdSchemas = new Set<string>();

  static config: DbConfig = {
    host: process.env.PGHOST || "localhost",
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE || "postgres",
    user:
      process.env.PGUSER ||
      (process.platform === "win32" ? process.env.USERNAME : process.env.USER),
    password: process.env.PGPASSWORD,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 20,
  };

  static registerSchema(name: string, schema: SchemaDefinition) {
    DatabaseManager.schemas.set(name, schema);
  }

  static models = new Map<string, ModelStaticMethods>();

  // in-flight table creation per name: two concurrent CREATE TABLE IF NOT
  // EXISTS for one new table race on pg_class and one of them fails
  private static creatingSchemas = new Map<string, Promise<void>>();

  private static async createSchemas(db: Pool | PoolClient) {
    for (const [name] of DatabaseManager.schemas.entries()) {
      if (DatabaseManager.createdSchemas.has(name)) continue;

      let creating = DatabaseManager.creatingSchemas.get(name);
      if (!creating) {
        creating = (async () => {
          await db.query(`
            CREATE TABLE IF NOT EXISTS "${name}" (
              id SERIAL PRIMARY KEY,
              data JSONB NOT NULL,
              created_at TIMESTAMPTZ DEFAULT NOW()
            )
          `);

          await db.query(`
            CREATE INDEX IF NOT EXISTS "${name}_id_idx" ON "${name}" ((data->>'_id'));
          `);

          DatabaseManager.createdSchemas.add(name);
        })().finally(() => DatabaseManager.creatingSchemas.delete(name));
        DatabaseManager.creatingSchemas.set(name, creating);
      }
      await creating;
    }
  }

  static async getConnection(): Promise<Pool> {
    if (DatabaseManager.instance) {
      await DatabaseManager.createSchemas(DatabaseManager.instance);
      return DatabaseManager.instance;
    }

    const tempConfig = { ...DatabaseManager.config, database: "postgres" };
    const tempPool = new Pool(tempConfig);

    try {
      const { rows } = await tempPool.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [DatabaseManager.config.database],
      );

      if (rows.length === 0) {
        await tempPool.query(
          `CREATE DATABASE ${DatabaseManager.config.database}`,
        );
      }
    } finally {
      await tempPool.end();
    }

    const db = new Pool(DatabaseManager.config);
    db.on("error", (err: Error) =>
      console.error("unexpected postgres pool error:", err),
    );
    await DatabaseManager.createSchemas(db);
    DatabaseManager.instance = db;
    return db;
  }
}

export async function getConnection(): Promise<Pool | PoolClient> {
  const client = transactionContext.getStore();
  if (client) return client.client;
  return DatabaseManager.getConnection();
}

export function registerSchema(name: string, schema: SchemaDefinition): void {
  DatabaseManager.registerSchema(name, schema);
}

// Fire-and-forget work started by a transaction hook must not inherit its
// single client and race the transaction's next query.
export function withoutTransaction<T>(callback: () => T): T {
  return transactionContext.exit(callback);
}

export function inTransaction(): boolean {
  return !!transactionContext.getStore();
}

/**
 * Serialize work on an arbitrary key for the rest of the current transaction.
 * Takes `pg_advisory_xact_lock(hashtextextended(key, 0))`, so a raw query
 * locking the same expression excludes this helper. Released at COMMIT or
 * ROLLBACK; throws outside a transaction, where the lock would be released
 * immediately.
 */
export async function advisoryLock(key: string): Promise<void> {
  const context = transactionContext.getStore();
  if (!context) throw new Error("advisoryLock requires a transaction");
  await context.client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [key],
  );
}

export function afterCommit(callback: () => unknown): void {
  const context = transactionContext.getStore();
  if (context) {
    context.observers.push(callback);
    return;
  }
  try {
    Promise.resolve(callback()).catch((error) =>
      console.error("post-commit observer failed", error),
    );
  } catch (error) {
    console.error("post-commit observer failed", error);
  }
}

export function registerModel(name: string, model: ModelStaticMethods): void {
  DatabaseManager.models.set(name, model);
}

/**
 * every (table, model) pair defined so far, for cross-table sweeps;
 * `model.schema` is the field definition
 */
export function registeredModels(): [string, ModelStaticMethods][] {
  return [...DatabaseManager.models.entries()];
}

// transaction support
export async function transaction<T>(callback: () => Promise<T>): Promise<T> {
  const existingClient = transactionContext.getStore();

  if (existingClient) {
    // Already in a transaction, reuse it (flattened)
    // Note: This does not implement SAVEPOINTs, so a failure here rolls back the whole transaction
    try {
      return await callback();
    } catch (error) {
      existingClient.failed = true;
      existingClient.error = error;
      throw error;
    }
  }

  const db = await DatabaseManager.getConnection();
  // We know db is a Pool here because getStore() returned undefined
  const pool = db as Pool;
  const client = await pool.connect();
  const context: {
    client: PoolClient;
    observers: Array<() => unknown>;
    failed?: boolean;
    error?: unknown;
  } = { client, observers: [] };

  try {
    await client.query("BEGIN");
    const result = await transactionContext.run(context, async () => {
      try {
        const result = await callback();
        if (context.failed) throw context.error;
        const committed = await client.query("COMMIT");
        if (committed.command !== "COMMIT")
          throw new Error("transaction was aborted before commit");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    withoutTransaction(() => {
      for (const observer of context.observers) afterCommit(observer);
    });
    return result;
  } catch (error) {
    // If BEGIN fails or final ROLLBACK fails (rare)
    if ((client as any)._connected) {
      // check if still connected
      try {
        await client.query("ROLLBACK");
      } catch {}
    }
    throw error;
  } finally {
    client.release();
  }
}

// ensure database connection
export async function ensureDatabase(): Promise<Pool> {
  return DatabaseManager.getConnection();
}
