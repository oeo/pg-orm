import {
  expect,
  test,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { defineSchema, events, transaction } from "../lib";
import { ensureDatabase, getConnection } from "../lib/connection";
import type { SchemaDefinition } from "../lib/types";

const AccountSchema: SchemaDefinition = {
  name: { type: "string", required: true },
  balance: { type: "number", default: 0 },
};

describe("ACID Transactions", () => {
  let Account: any;

  beforeAll(async () => {
    const db = await ensureDatabase();
    await db.query("DROP TABLE IF EXISTS acid_accounts");
    await db.query(`
      CREATE TABLE IF NOT EXISTS acid_accounts (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS acid_accounts_id_idx ON acid_accounts ((data->>'_id'))`,
    );
  });

  beforeEach(async () => {
    const db = await ensureDatabase();
    await db.query("DELETE FROM acid_accounts");
    Account = defineSchema<typeof AccountSchema>(
      "acid_accounts",
      AccountSchema,
    );
  });

  afterAll(async () => {
    const db = await ensureDatabase();
    await db.query("DROP TABLE IF EXISTS acid_accounts");
  });

  test("should commit changes successfully", async () => {
    await transaction(async () => {
      await Account.create({ name: "Alice", balance: 100 });
      const alice = await Account.findOne({ name: "Alice" });
      expect(alice).not.toBeNull();
      expect(alice.balance).toBe(100);
    });

    const alice = await Account.findOne({ name: "Alice" });
    expect(alice).not.toBeNull();
  });

  test("should rollback changes on error", async () => {
    try {
      await transaction(async () => {
        await Account.create({ name: "Bob", balance: 200 });
        const bob = await Account.findOne({ name: "Bob" });
        expect(bob).not.toBeNull();
        throw new Error("Intentional Fail");
      });
    } catch (e) {
      // Expected
    }

    const bob = await Account.findOne({ name: "Bob" });
    expect(bob).toBeNull();
  });

  test("should provide isolation (changes not visible outside until commit)", async () => {
    // We need to coordinate two "threads"
    // 1. Start TX, create doc, signal waiting thread.
    // 2. Waiting thread checks for doc (should not exist).
    // 3. TX commits.
    // 4. Waiting thread checks again (should exist).

    // However, JS is single threaded event loop. We can use promises.

    let resolveTx: () => void;
    const txPromise = new Promise<void>((r) => (resolveTx = r));

    let resolveCheck: () => void;
    const checkPromise = new Promise<void>((r) => (resolveCheck = r));

    const txExecution = transaction(async () => {
      await Account.create({ name: "Charlie", balance: 300 });
      resolveCheck(); // Signal thread 2 to check
      await txPromise; // Wait for thread 2 to finish checking
    });

    // We can't easily pause execution inside transaction without explicit coordination like above.
    // But `await txPromise` blocks the transaction commit.

    // "Thread 2" logic
    await checkPromise; // Wait for TX to create data

    // Check outside TX (using global pool, which is distinct from TX client)
    const charlieOutside = await Account.findOne({ name: "Charlie" });
    expect(charlieOutside).toBeNull(); // Should not see it yet

    resolveTx!(); // Allow TX to commit
    await txExecution; // Wait for commit

    const charlieFinal = await Account.findOne({ name: "Charlie" });
    expect(charlieFinal).not.toBeNull();
  });

  test("nested transactions join the outer one", async () => {
    const attempt = transaction(async () => {
      await transaction(async () => {
        await Account.create({ name: "Inner", balance: 2 });
      });
      throw new Error("Outer Fail");
    });

    await expect(attempt).rejects.toThrow("Outer Fail");
    expect(await Account.count()).toBe(0);
  });

  test("a caught inner failure still rolls back the outer transaction", async () => {
    const attempt = transaction(async () => {
      await Account.create({ name: "Dana", balance: 400 });
      try {
        await transaction(async () => {
          throw new Error("Inner Fail");
        });
      } catch {
        // swallowed on purpose: there is no savepoint to return to
      }
    });

    await expect(attempt).rejects.toThrow("Inner Fail");
    expect(await Account.findOne({ name: "Dana" })).toBeNull();
  });

  test("events fire after commit with a detached copy, and not on rollback", async () => {
    const created: any[] = [];
    const listener = (doc: any) => created.push(doc);
    events.on("acid_accounts:created", listener);
    try {
      let live: any;
      await transaction(async () => {
        live = await Account.create({ name: "Erin", balance: 500 });
        expect(created).toHaveLength(0);
      });
      expect(created.map((doc) => doc.name)).toEqual(["Erin"]);
      expect(created[0]).not.toBe(live);

      await transaction(async () => {
        await Account.create({ name: "Frank", balance: 600 });
        throw new Error("Intentional Fail");
      }).catch(() => {});
      expect(created).toHaveLength(1);
    } finally {
      events.off("acid_accounts:created", listener);
    }
  });
});
