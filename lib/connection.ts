import { Pool } from 'pg';
import { EventEmitter } from 'events';
import type { DbConfig, SchemaDefinition } from './types';

// event system for document changes
export const events = new EventEmitter();

// database connection management
class DatabaseManager {
  private static instance: Pool | null = null;
  private static schemas = new Map<string, SchemaDefinition>();

  static config: DbConfig = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'postgres',
    user: process.env.PGUSER || process.platform === 'win32' ? process.env.USERNAME : process.env.USER,
    password: process.env.PGPASSWORD,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 20
  };

  static registerSchema(name: string, schema: SchemaDefinition) {
    this.schemas.set(name, schema);
  }

  private static async createSchemas(db: Pool) {
    for (const [name] of this.schemas.entries()) {
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

  static async getConnection(): Promise<Pool> {
    if (this.instance) return this.instance;

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

export async function getConnection(): Promise<Pool> {
  return DatabaseManager.getConnection();
}

export function registerSchema(name: string, schema: SchemaDefinition): void {
  DatabaseManager.registerSchema(name, schema);
}

// transaction support
export async function transaction<T>(callback: () => Promise<T>): Promise<T> {
  const db = await DatabaseManager.getConnection();
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

// ensure database connection
export async function ensureDatabase(): Promise<Pool> {
  return DatabaseManager.getConnection();
} 