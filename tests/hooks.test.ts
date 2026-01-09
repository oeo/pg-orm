// tests for schema middleware/hooks
import { expect, test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { defineSchema, Document } from '../lib';
import { ensureDatabase } from '../lib/connection';
import type { SchemaDefinition } from '../lib/types';

interface IHookTest {
  _id?: string;
  name: string;
  history?: string[];
}

// Explicit type for the model return value
type HookTestModelType = ReturnType<typeof defineSchema<typeof HookTestSchema>>;

const HookTestSchema: SchemaDefinition = {
  name: { type: 'string', required: true },
  history: { type: 'array', of: { type: 'string' }, default: [] }
};

describe('Schema Hooks (Middleware)', () => {
  let HookTestModel: HookTestModelType | undefined;

  beforeAll(async () => {
    const db = await ensureDatabase();
    await db.query('DROP TABLE IF EXISTS hooktests');
    // Schema creation happens automatically via defineSchema/registerSchema in real app usage 
    // but in tests we might need to be careful if we are redefining same schema name.
    // However, defineSchema registers it. connection.ts creates tables if they don't exist on connect.
    // In this test suite, we are manually creating/dropping.
    await db.query(`
      CREATE TABLE IF NOT EXISTS hooktests (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS hooktests_id_idx ON hooktests ((data->>'_id'));
    `);
  });

  beforeEach(async () => {
    const db = await ensureDatabase();
    await db.query('DELETE FROM hooktests');

    HookTestModel = defineSchema<typeof HookTestSchema>('hooktests', HookTestSchema, {
      hooks: {
        async preSave(this: Document<IHookTest>) {
          const doc = this as unknown as IHookTest;
          if (!doc.history) doc.history = [];
          doc.history.push('preSave');
        },
        async postSave(this: Document<IHookTest>) {
          const doc = this as unknown as IHookTest;
          if (!doc.history) doc.history = [];
          doc.history.push('postSave');
        },
        async preRemove(this: Document<IHookTest>) {
          const doc = this as unknown as IHookTest;
          if (!doc.history) doc.history = [];
          doc.history.push('preRemove');
        },
        async postRemove(this: Document<IHookTest>) {
          const doc = this as unknown as IHookTest;
          if (!doc.history) doc.history = [];
          doc.history.push('postRemove');
        }
      }
    });
  });

  afterAll(async () => {
    const db = await ensureDatabase();
    await db.query('DROP TABLE IF EXISTS hooktests');
  });

  test('should execute preSave and postSave hooks on create', async () => {
    if (!HookTestModel) throw new Error("HookTestModel not defined");
    const doc = await HookTestModel.create({ name: 'Hook Test' });
    const history = (doc as any).history;
    
    expect(history).toContain('preSave');
    expect(history).toContain('postSave');
    
    // Order check: preSave should come before postSave
    const preIndex = history.indexOf('preSave');
    const postIndex = history.indexOf('postSave');
    expect(preIndex).toBeLessThan(postIndex);
  });

  test('should execute preSave and postSave hooks on update', async () => {
    if (!HookTestModel) throw new Error("HookTestModel not defined");
    const doc = await HookTestModel.create({ name: 'Hook Test Update' });
    
    // Clear history for clarity or check accumulation
    // (doc as any).history = []; 
    // Actually, create runs hooks, so history has ['preSave', 'postSave']
    
    doc.name = 'Updated Name';
    await doc.save();
    
    const history = (doc as any).history;
    expect(history.length).toBeGreaterThanOrEqual(4); // 2 from create, 2 from update
    
    // Check the last two entries
    expect(history[history.length - 2]).toBe('preSave');
    expect(history[history.length - 1]).toBe('postSave');
  });

  test('should execute preRemove and postRemove hooks on remove', async () => {
    if (!HookTestModel) throw new Error("HookTestModel not defined");
    const doc = await HookTestModel.create({ name: 'Hook Test Remove' });
    
    await doc.remove();
    
    const history = (doc as any).history;
    expect(history).toContain('preRemove');
    expect(history).toContain('postRemove');
    
    const preIndex = history.indexOf('preRemove');
    const postIndex = history.indexOf('postRemove');
    expect(preIndex).toBeLessThan(postIndex);
  });
});