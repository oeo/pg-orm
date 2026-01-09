import { Pool, PoolClient } from 'pg';
import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';
import type { DbConfig, SchemaDefinition } from './types';

// event system for document changes
export const events = new EventEmitter();

// transaction context storage
const transactionContext = new AsyncLocalStorage<PoolClient>();

// database connection management
class DatabaseManager {
  private static instance: Pool | null = null;
  private static schemas = new Map<string, SchemaDefinition>();
  private static createdSchemas = new Set<string>();

  static config: DbConfig = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'postgres',
    user: process.env.PGUSER || (process.platform === 'win32' ? process.env.USERNAME : process.env.USER),
    password: process.env.PGPASSWORD,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 20
  };

  static registerSchema(name: string, schema: SchemaDefinition) {
    this.schemas.set(name, schema);
  }

  private static async createSchemas(db: Pool | PoolClient) {
    for (const [name] of this.schemas.entries()) {
      if (this.createdSchemas.has(name)) continue;

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
      
      this.createdSchemas.add(name);
    }
  }

  static async getConnection(): Promise<Pool> {
    if (this.instance) {
      await this.createSchemas(this.instance);
      return this.instance;
    }

    const tempConfig = { ...this.config, database: 'postgres' };
    const tempPool = new Pool(tempConfig);

    try {
      const { rows } = await tempPool.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [this.config.database]
      );

      if (rows.length === 0) {
        console.log(`creating database "${this.config.database}"...`);
        await tempPool.query(`CREATE DATABASE ${this.config.database}`);
        console.log('database created successfully');
      }
    } finally {
      await tempPool.end();
    }

    const db = new Pool(this.config);
    db.on('error', (err: Error) => console.error('unexpected postgres pool error:', err));
    await this.createSchemas(db);
    console.log('successfully connected to postgres');
    this.instance = db;
    return db;
  }
}

export async function getConnection(): Promise<Pool | PoolClient> {
  const client = transactionContext.getStore();
  if (client) return client;
  return DatabaseManager.getConnection();
}

export function registerSchema(name: string, schema: SchemaDefinition): void {
  DatabaseManager.registerSchema(name, schema);
}

// transaction support
export async function transaction<T>(callback: () => Promise<T>): Promise<T> {
  const existingClient = transactionContext.getStore();
  
  if (existingClient) {
    // Already in a transaction, reuse it (flattened)
    // Note: This does not implement SAVEPOINTs, so a failure here rolls back the whole transaction
    return await callback();
  }

  const db = await DatabaseManager.getConnection();
  // We know db is a Pool here because getStore() returned undefined
  const pool = db as Pool; 
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    return await transactionContext.run(client, async () => {
      try {
        const result = await callback();
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    // If BEGIN fails or final ROLLBACK fails (rare)
    if ((client as any)._connected) { // check if still connected
        try { await client.query('ROLLBACK'); } catch {}
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