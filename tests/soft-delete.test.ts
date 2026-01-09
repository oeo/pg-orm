import { expect, test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { defineSchema, Document } from '../lib';
import { ensureDatabase } from '../lib/connection';
import type { SchemaDefinition } from '../lib/types';

interface ISoftItem {
  _id?: string;
  name: string;
  _deletedAt?: number | null;
}

const SoftItemSchema: SchemaDefinition = {
  name: { type: 'string', required: true }
};

describe('Soft Deletes', () => {
  let SoftItem: any;

  beforeAll(async () => {
    const db = await ensureDatabase();
    await db.query('DROP TABLE IF EXISTS soft_items');
    await db.query(`
      CREATE TABLE IF NOT EXISTS soft_items (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS soft_items_id_idx ON soft_items ((data->>'_id'))`);
  });

  beforeEach(async () => {
    const db = await ensureDatabase();
    await db.query('DELETE FROM soft_items');
    
    SoftItem = defineSchema<typeof SoftItemSchema>('soft_items', SoftItemSchema, {
      softDelete: true
    });
  });

  afterAll(async () => {
    const db = await ensureDatabase();
    await db.query('DROP TABLE IF EXISTS soft_items');
  });

  test('remove() should set _deletedAt and not delete record', async () => {
    const item = await SoftItem.create({ name: 'Soft Delete Me' });
    const id = item._id;

    await item.remove();

    // Verify instance state
    expect(item._deletedAt).toBeTypeOf('number');

    // Verify database state (raw query to bypass filtering)
    const db = await ensureDatabase();
    const { rows } = await db.query(`SELECT data FROM soft_items WHERE data->>'_id' = $1`, [id]);
    expect(rows.length).toBe(1);
    expect(rows[0].data._deletedAt).toBeTypeOf('number');
  });

  test('find() should filter out soft-deleted documents', async () => {
    const item1 = await SoftItem.create({ name: 'Item 1' });
    const item2 = await SoftItem.create({ name: 'Item 2' });

    await item1.remove();

    const results = await SoftItem.find({});
    expect(results.length).toBe(1);
    expect(results[0]._id).toBe(item2._id);
  });

  test('findOne() should not return soft-deleted document', async () => {
    const item = await SoftItem.create({ name: 'Find Me' });
    await item.remove();

    const found = await SoftItem.findOne({ _id: item._id });
    expect(found).toBeNull();
  });

  test('count() should exclude soft-deleted documents', async () => {
    await SoftItem.create({ name: 'A' });
    const b = await SoftItem.create({ name: 'B' });
    await b.remove();

    const count = await SoftItem.count();
    expect(count).toBe(1);
  });

  test('includeDeleted: true should return soft-deleted documents', async () => {
    const item = await SoftItem.create({ name: 'Include Me' });
    await item.remove();

    const found = await SoftItem.find({}, { includeDeleted: true });
    expect(found.length).toBe(1);
    expect(found[0]._id).toBe(item._id);
    
    // Test findOne with includeDeleted (needs overload support or check implementation)
    // The type definition for findOne in lib/types.ts might need updating to accept options or we rely on find().
    // Currently implementation: findOne(query) calls find(query, {limit:1}).
    // But findOne signature in lib/schema.ts is `findOne(mongoQuery, options?)`.
    // Let's check schema.ts again. Yes, I updated it: async findOne(mongoQuery = {}, options?)
    
    const foundOne = await SoftItem.findOne({ _id: item._id }, { includeDeleted: true });
    expect(foundOne).not.toBeNull();
    expect(foundOne?._id).toBe(item._id);
    
    // Count
    const count = await SoftItem.count({}, { includeDeleted: true });
    expect(count).toBe(1);
  });

  test('bulk remove should soft delete', async () => {
    await SoftItem.create({ name: 'Bulk A' });
    await SoftItem.create({ name: 'Bulk B' });

    const result = await SoftItem.remove({ name: { $regex: 'Bulk' } });
    expect(result.deletedCount).toBe(2);

    const count = await SoftItem.count();
    expect(count).toBe(0);

    const rawCount = await SoftItem.count({}, { includeDeleted: true });
    expect(rawCount).toBe(2);
  });
});
