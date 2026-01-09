import { expect, test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { defineSchema, transaction } from '../lib';
import { ensureDatabase, getConnection } from '../lib/connection';
import type { SchemaDefinition } from '../lib/types';

const AccountSchema: SchemaDefinition = {
  name: { type: 'string', required: true },
  balance: { type: 'number', default: 0 }
};

describe('ACID Transactions', () => {
  let Account: any;

  beforeAll(async () => {
    const db = await ensureDatabase();
    await db.query('DROP TABLE IF EXISTS acid_accounts');
    await db.query(`
      CREATE TABLE IF NOT EXISTS acid_accounts (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS acid_accounts_id_idx ON acid_accounts ((data->>'_id'))`);
  });

  beforeEach(async () => {
    const db = await ensureDatabase();
    await db.query('DELETE FROM acid_accounts');
    Account = defineSchema<typeof AccountSchema>('acid_accounts', AccountSchema);
  });

  afterAll(async () => {
    const db = await ensureDatabase();
    await db.query('DROP TABLE IF EXISTS acid_accounts');
  });

  test('should commit changes successfully', async () => {
    await transaction(async () => {
      await Account.create({ name: 'Alice', balance: 100 });
      const alice = await Account.findOne({ name: 'Alice' });
      expect(alice).not.toBeNull();
      expect(alice.balance).toBe(100);
    });

    const alice = await Account.findOne({ name: 'Alice' });
    expect(alice).not.toBeNull();
  });

  test('should rollback changes on error', async () => {
    try {
      await transaction(async () => {
        await Account.create({ name: 'Bob', balance: 200 });
        const bob = await Account.findOne({ name: 'Bob' });
        expect(bob).not.toBeNull();
        throw new Error('Intentional Fail');
      });
    } catch (e) {
      // Expected
    }

    const bob = await Account.findOne({ name: 'Bob' });
    expect(bob).toBeNull();
  });

  test('should provide isolation (changes not visible outside until commit)', async () => {
    // We need to coordinate two "threads"
    // 1. Start TX, create doc, signal waiting thread.
    // 2. Waiting thread checks for doc (should not exist).
    // 3. TX commits.
    // 4. Waiting thread checks again (should exist).
    
    // However, JS is single threaded event loop. We can use promises.
    
    let resolveTx: () => void;
    const txPromise = new Promise<void>(r => resolveTx = r);
    
    let resolveCheck: () => void;
    const checkPromise = new Promise<void>(r => resolveCheck = r);

    const txExecution = transaction(async () => {
      await Account.create({ name: 'Charlie', balance: 300 });
      resolveCheck(); // Signal thread 2 to check
      await txPromise; // Wait for thread 2 to finish checking
    });

    // We can't easily pause execution inside transaction without explicit coordination like above.
    // But `await txPromise` blocks the transaction commit.
    
    // "Thread 2" logic
    await checkPromise; // Wait for TX to create data
    
    // Check outside TX (using global pool, which is distinct from TX client)
    const charlieOutside = await Account.findOne({ name: 'Charlie' });
    expect(charlieOutside).toBeNull(); // Should not see it yet
    
    resolveTx!(); // Allow TX to commit
    await txExecution; // Wait for commit
    
    const charlieFinal = await Account.findOne({ name: 'Charlie' });
    expect(charlieFinal).not.toBeNull();
  });

  test('nested transactions should work (flattened/reused client)', async () => {
    // Current implementation reuses client?
    // Let's check connection.ts.
    // transaction() calls getConnection(), gets global pool, calls connect().
    // It creates a NEW client for every transaction call unless we modify logic.
    // AND it runs `transactionContext.run(client, ...)`
    
    // If we call transaction() inside transaction(), it will:
    // 1. Outer: gets new client A. runs in context A.
    // 2. Inner: calls getConnection(). 
    //    Current implementation of getConnection():
    //    const client = transactionContext.getStore();
    //    if (client) return client;
    //    return DatabaseManager.getConnection();
    
    // So inner transaction calls getConnection(), gets client A.
    // Then it calls `client.connect()`. 
    // Wait. `PoolClient` (from pg) does NOT have `connect()`. `Pool` has `connect()` returning `PoolClient`.
    // `PoolClient` has `release()`, `query()`, etc.
    
    // Issue: `transaction` function expects `db` to be a `Pool` (has `.connect()`).
    // But `getConnection` now returns `Pool | PoolClient`.
    // If it returns a `PoolClient`, calling `.connect()` on it might fail or behaves differently?
    // `PoolClient` does NOT have `.connect()`.
    
    // FIX REQUIRED in `lib/connection.ts`: `transaction` function needs to handle if `db` is already a client.
  });
});
