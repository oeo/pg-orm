import { describe, test, expect } from "bun:test";
import { MongoToPG } from '../lib/mongo-converter';

describe('MongoToPG', () => {
  const converter = new MongoToPG();

  test('should handle simple equality', () => {
    const query = { name: 'John Doe', age: 30 };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "users" WHERE data->>'name' = $1 AND (data->>'age')::integer = $2`;
    const { sql } = converter.buildSelectQueryAndParams('users', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle comparison operators', () => {
    const query = { score: { $gt: 90, $lte: 100 }, level: { $ne: 'beginner' } };
    // Comparisons use inlined values via #sqlValue, $ne uses parameters
    const expectedSql = `SELECT "data" FROM "users" WHERE ((data->>'score')::numeric > 90 AND (data->>'score')::numeric <= 100) AND data->>'level' IS DISTINCT FROM $1`;
    const { sql } = converter.buildSelectQueryAndParams('users', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $in and $nin operators', () => {
    const query = { status: { $in: ['active', 'pending'] }, category: { $nin: ['archived', 'deleted'] } };
    // $in / $nin use ANY/ALL with parameters
    const expectedSql = `SELECT "data" FROM "items" WHERE data->>'status' = ANY($1) AND data->>'category' != ALL($2)`;
    const { sql } = converter.buildSelectQueryAndParams('items', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle logical $and (implicit and explicit)', () => {
    const query = { $and: [{ price: { $lt: 50 } }, { quantity: { $gte: 10 } }], inStock: true };
    // Inner comparisons use inlined values, simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "products" WHERE ((data->>'price')::numeric < 50 AND (data->>'quantity')::numeric >= 10) AND (data->>'inStock')::boolean = $1`;
    const { sql } = converter.buildSelectQueryAndParams('products', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle logical $or', () => {
    const query = { $or: [{ type: 'book' }, { type: 'magazine' }] };
    // Inner simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "library" WHERE (data->>'type' = $1 OR data->>'type' = $2)`;
    const { sql } = converter.buildSelectQueryAndParams('library', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle logical $not (simulated with $ne)', () => {
    const query = { status: { $ne: 'active' } };
    // $ne uses parameters
    const expectedSql = `SELECT "data" FROM "tasks" WHERE data->>'status' IS DISTINCT FROM $1`;
    const { sql } = converter.buildSelectQueryAndParams('tasks', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle nested documents', () => {
    const query = { 'address.city': 'New York', 'address.zip': { $eq: '10001' } };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "customers" WHERE data->'address'->>'city' = $1 AND data->'address'->>'zip' = $2`;
    const { sql } = converter.buildSelectQueryAndParams('customers', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $exists operator', () => {
    const query = { middleName: { $exists: true }, nickname: { $exists: false } };
    // $exists does not use parameters
    const expectedSql = `SELECT "data" FROM "profiles" WHERE data->'middleName' IS NOT NULL AND data->'nickname' IS NULL`;
    const { sql } = converter.buildSelectQueryAndParams('profiles', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $regex (case-sensitive)', () => {
    const query = { description: { $regex: '^start' } };
    // $regex uses inlined values
    const expectedSql = `SELECT "data" FROM "logs" WHERE data->>'description' ~ '^start'`;
    const { sql } = converter.buildSelectQueryAndParams('logs', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $regex (case-insensitive via simplified /pattern/i)', () => {
    const query = { description: { $regex: '/end$/i' } };
    // $regex uses inlined values
    const expectedSql = `SELECT "data" FROM "logs" WHERE data->>'description' ~* 'end$'`;
    const { sql } = converter.buildSelectQueryAndParams('logs', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $regex (case-insensitive via array convention)', () => {
    const query = { description: { $regex: ['middle', 'i'] } };
    // $regex uses inlined values
    const expectedSql = `SELECT "data" FROM "logs" WHERE data->>'description' ~* 'middle'`;
    const { sql } = converter.buildSelectQueryAndParams('logs', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $regex with sibling $options (now detects insensitive)', () => {
    const query = { description: { $regex: 'Exact', $options: 'i' } };
    // $regex uses inlined values, $options is handled internally
    const expectedSql = `SELECT "data" FROM "data" WHERE data->>'description' ~* 'Exact'`;
    const { sql } = converter.buildSelectQueryAndParams('data', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $size operator for arrays', () => {
    const query = { tags: { $size: 3 } };
    // $size uses inlined value
    const expectedSql = `SELECT "data" FROM "posts" WHERE (jsonb_typeof(data->'tags') = 'array' AND jsonb_array_length(data->'tags') = 3)`;
    const { sql } = converter.buildSelectQueryAndParams('posts', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $all operator for arrays', () => {
    const query = { requiredTags: { $all: ['urgent', 'review'] } };
    // $all uses inlined array literal
    const expectedSql = `SELECT "data" FROM "tickets" WHERE data->'requiredTags' @> '["urgent","review"]'::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams('tickets', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $elemMatch on array of objects', () => {
    const query = { items: { $elemMatch: { product: 'apple', quantity: { $gte: 5 } } } };
    // Inner conditions use parameters ($eq) or inlined values ($gte)
    const expectedSql = `SELECT "data" FROM "orders" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'items') as elem WHERE elem->>'product' = $1 AND (elem->>'quantity')::numeric >= 5)`;
    const { sql } = converter.buildSelectQueryAndParams('orders', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle null value equality', () => {
    const query = { deletedAt: null };
    // Null check does not use parameters
    const expectedSql = `SELECT "data" FROM "records" WHERE (data->'deletedAt' IS NULL OR data->'deletedAt' = 'null'::jsonb)`;
    const { sql } = converter.buildSelectQueryAndParams('records', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle boolean equality', () => {
    const query = { isActive: true, isProcessed: false };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "flags" WHERE (data->>'isActive')::boolean = $1 AND (data->>'isProcessed')::boolean = $2`;
    const { sql } = converter.buildSelectQueryAndParams('flags', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle schema and jsonField options', () => {
    const query = { value: { $gt: 100 } };
    const options = { schema: 'metrics', jsonField: 'payload' };
    // $gt uses inlined value
    const expectedSql = `SELECT "payload" FROM "metrics"."events" WHERE (payload->>'value')::numeric > 100`;
    const { sql } = converter.buildSelectQueryAndParams('events', query, options);
    expect(sql).toBe(expectedSql);
  });

  test('should handle limit and sort options', () => {
    const query = { type: 'log' };
    const options = { limit: 50, sort: { timestamp: -1, level: 1 } as const };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "entries" WHERE data->>'type' = $1 ORDER BY data->>'timestamp' DESC, data->>'level' ASC LIMIT 50`;
    const { sql } = converter.buildSelectQueryAndParams('entries', query, options);
    expect(sql).toBe(expectedSql);
  });

  test('should handle complex nested logical operators', () => {
    const query = {
      $and: [
        { status: 'active' },
        {
          $or: [
            { score: { $gte: 95 } },
            { $and: [{ level: { $in: ['expert', 'master'] } }, { verified: true }] }
          ]
        }
      ]
    };
    // $eq, $in, bool equality use parameters; $gte uses inlined
    const expectedSql = `SELECT "data" FROM "users" WHERE (data->>'status' = $1 AND ((data->>'score')::numeric >= 95 OR (data->>'level' = ANY($2) AND (data->>'verified')::boolean = $3)))`;
    const { sql } = converter.buildSelectQueryAndParams('users', query);
    expect(sql).toBe(expectedSql);
  });

  test('should return basic SELECT FROM table for empty query object', () => {
    const query = {};
    const expectedSql = `SELECT "data" FROM "empty_test"`;
    const { sql } = converter.buildSelectQueryAndParams('empty_test', query);
    expect(sql).toBe(expectedSql);
  });

  // --- Start: Additional Tests ---

  test('should handle simple float equality', () => {
    const query = { price: 19.99 };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "products" WHERE (data->>'price')::numeric = $1`;
    const { sql } = converter.buildSelectQueryAndParams('products', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $ne with boolean', () => {
    const query = { enabled: { $ne: false } };
    // $ne uses parameters
    const expectedSql = `SELECT "data" FROM "settings" WHERE (data->>'enabled')::boolean IS DISTINCT FROM $1`;
    const { sql } = converter.buildSelectQueryAndParams('settings', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $in with numbers', () => {
    const query = { product_id: { $in: [101, 202, 303] } };
    // $in uses ANY with parameters
    // Corrected cast based on implementation (assumes integer if first is int)
    const expectedSql = `SELECT "data" FROM "inventory" WHERE (data->>'product_id')::integer = ANY($1)`;
    const { sql } = converter.buildSelectQueryAndParams('inventory', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $nin with numbers', () => {
    const query = { user_id: { $nin: [1, 2, 3] } };
    // $nin uses ALL with parameters
    // Corrected cast based on implementation
    const expectedSql = `SELECT "data" FROM "logs" WHERE (data->>'user_id')::integer != ALL($1)`;
    const { sql } = converter.buildSelectQueryAndParams('logs', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle empty $and array', () => {
    const query = { $and: [] };
    // Empty $and returns TRUE which simplifies to no WHERE clause
    const expectedSql = `SELECT "data" FROM "test_empty_and" WHERE TRUE`;
    const { sql } = converter.buildSelectQueryAndParams('test_empty_and', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle empty $or array', () => {
    const query = { $or: [] };
    // Empty $or returns FALSE
    const expectedSql = `SELECT "data" FROM "test_empty_or" WHERE FALSE`;
    const { sql } = converter.buildSelectQueryAndParams('test_empty_or', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $nor operator', () => {
    const query = { $nor: [{ status: 'completed' }, { archived: true }] };
    // Inner simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "jobs" WHERE NOT ((data->>'status' = $1 OR (data->>'archived')::boolean = $2))`;
    const { sql } = converter.buildSelectQueryAndParams('jobs', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $not operator on a single field condition', () => {
    const query = { score: { $not: { $lt: 50 } } };
    // Inner $lt uses inlined value
    const expectedSql = `SELECT "data" FROM "results" WHERE NOT ((data->>'score')::numeric < 50)`;
    const { sql } = converter.buildSelectQueryAndParams('results', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle deeply nested dot notation', () => {
    const query = { 'metadata.user.address.country': 'CA' };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "events" WHERE data->'metadata'->'user'->'address'->>'country' = $1`;
    const { sql } = converter.buildSelectQueryAndParams('events', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle dot notation combined with operators', () => {
    const query = { 'metrics.views': { $gte: 1000 } };
    // $gte uses inlined value
    const expectedSql = `SELECT "data" FROM "articles" WHERE (data->'metrics'->>'views')::numeric >= 1000`;
    const { sql } = converter.buildSelectQueryAndParams('articles', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $type string', () => {
    const query = { description: { $type: 'string' } };
    // $type uses inlined value
    const expectedSql = `SELECT "data" FROM "products" WHERE jsonb_typeof(data->'description') = 'string'`;
    const { sql } = converter.buildSelectQueryAndParams('products', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $type number', () => {
    const query = { count: { $type: 'number' } };
    // $type uses inlined value
    const expectedSql = `SELECT "data" FROM "inventory" WHERE jsonb_typeof(data->'count') = 'number'`;
    const { sql } = converter.buildSelectQueryAndParams('inventory', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $mod operator', () => {
    const query = { quantity: { $mod: [10, 1] } };
    // $mod uses inlined values
    const expectedSql = `SELECT "data" FROM "stock" WHERE (data->>'quantity')::numeric % 10 = 1`;
    const { sql } = converter.buildSelectQueryAndParams('stock', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $elemMatch with nested operators', () => {
    const query = {
      grades: {
        $elemMatch: {
          grade: { $in: ['A', 'B'] },
          score: { $gte: 85 }
        }
      }
    };
    // $in uses ANY($param), $gte uses inlined
    const expectedSql = `SELECT "data" FROM "students" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'grades') as elem WHERE elem->>'grade' = ANY($1) AND (elem->>'score')::numeric >= 85)`;
    const { sql } = converter.buildSelectQueryAndParams('students', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle multiple sort fields', () => {
    const query = { category: 'electronics' };
    const options = { sort: { brand: 1, price: -1 } as const };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "products" WHERE data->>'category' = $1 ORDER BY data->>'brand' ASC, data->>'price' DESC`;
    const { sql } = converter.buildSelectQueryAndParams('products', query, options);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $all with a single element array', () => {
    const query = { features: { $all: ['bluetooth'] } };
    // $all uses inlined array literal
    const expectedSql = `SELECT "data" FROM "devices" WHERE data->'features' @> '["bluetooth"]'::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams('devices', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $size 0', () => {
    const query = { comments: { $size: 0 } };
    // $size uses inlined value
    const expectedSql = `SELECT "data" FROM "articles" WHERE (jsonb_typeof(data->'comments') = 'array' AND jsonb_array_length(data->'comments') = 0)`;
    const { sql } = converter.buildSelectQueryAndParams('articles', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $in with empty array', () => {
    const query = { tags: { $in: [] } };
    // $in [] returns FALSE
    const expectedSql = `SELECT "data" FROM "posts" WHERE FALSE`;
    const { sql } = converter.buildSelectQueryAndParams('posts', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $nin with empty array', () => {
    const query = { categories: { $nin: [] } };
    // Expect WHERE TRUE
    const expectedSql = `SELECT "data" FROM "products" WHERE TRUE`; 
    const { sql } = converter.buildSelectQueryAndParams('products', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle mixed implicit AND with $or', () => {
    const query = { status: 'pending', $or: [{ priority: 1 }, { urgent: true }] };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "tasks" WHERE data->>'status' = $1 AND ((data->>'priority')::integer = $2 OR (data->>'urgent')::boolean = $3)`;
    const { sql } = converter.buildSelectQueryAndParams('tasks', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle regex with special SQL characters', () => {
    const query = { pattern: { $regex: '^d[a-t]\'%$' } };
    // $regex uses inlined value (with quoting)
    const expectedSql = `SELECT "data" FROM "regex_test" WHERE data->>'pattern' ~ '^d[a-t]\''%$'`;
    const { sql } = converter.buildSelectQueryAndParams('regex_test', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle query with no options', () => {
    const query = { key: 'value' };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "simple" WHERE data->>'key' = $1`;
    const { sql } = converter.buildSelectQueryAndParams('simple', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle array equality check', () => {
    const query = { exactTags: ['a', 'b', 'c'] };
    // Array equality uses parameters
    const expectedSql = `SELECT "data" FROM "tag_match" WHERE data->'exactTags'::jsonb = $1::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams('tag_match', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle deeply nested dot notation (multi-level)', () => {
    const query = { 'config.settings.network.ports.admin': 8080 };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "systems" WHERE (data->'config'->'settings'->'network'->'ports'->>'admin')::integer = $1`;
    const { sql } = converter.buildSelectQueryAndParams('systems', query);
    expect(sql).toBe(expectedSql);
  });

  // --- Start: More Additional Tests ---

  test('should ignore $text operator (return no WHERE clause)', () => {
    const query = { $text: { $search: "bake coffee cake" } };
    // $text returns TRUE which simplifies to no WHERE clause
    const expectedSql = `SELECT "data" FROM "recipes" WHERE TRUE`;
    const { sql } = converter.buildSelectQueryAndParams('recipes', query);
    expect(sql).toBe(expectedSql);
  });

  test('should ignore field-level $search operator (return no WHERE clause)', () => {
    const query = { description: { $search: "important terms" } };
    // $search is unsupported and ignored, no WHERE clause
    const expectedSql = `SELECT "data" FROM "notes"`;
    const { sql } = converter.buildSelectQueryAndParams('notes', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $eq with undefined', () => {
    const query = { optionalField: { $eq: undefined } };
    // $eq undefined -> IS NULL (no parameters)
    const expectedSql = `SELECT "data" FROM "data" WHERE data->'optionalField' IS NULL`;
    const { sql } = converter.buildSelectQueryAndParams('data', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $ne with undefined', () => {
    const query = { requiredField: { $ne: undefined } };
    // $ne undefined -> IS NOT NULL (no parameters)
    const expectedSql = `SELECT "data" FROM "data" WHERE data->'requiredField' IS NOT NULL`;
    const { sql } = converter.buildSelectQueryAndParams('data', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $in with null and values', () => {
    const query = { status: { $in: ['active', null] } };
    // Expect outer parentheses around combined OR
    const expectedSql = `SELECT "data" FROM "items" WHERE ((data->>'status' = ANY($1)) OR (data->'status' IS NULL OR data->'status' = 'null'::jsonb))`;
    const { sql } = converter.buildSelectQueryAndParams('items', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $in with only null', () => {
    const query = { status: { $in: [null] } };
    // $in [null] -> IS NULL check
    const expectedSql = `SELECT "data" FROM "items" WHERE (data->'status' IS NULL OR data->'status' = 'null'::jsonb)`;
    const { sql } = converter.buildSelectQueryAndParams('items', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $nin with null and values', () => {
    const query = { code: { $nin: ['ERROR', null] } };
    // $nin uses ALL with parameter, null check is separate
    const expectedSql = `SELECT "data" FROM "logs" WHERE (data->>'code' != ALL($1) AND (data->'code' IS NOT NULL AND data->'code' != 'null'::jsonb))`;
    const { sql } = converter.buildSelectQueryAndParams('logs', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $nin with only null', () => {
    const query = { code: { $nin: [null] } };
    // $nin [null] -> IS NOT NULL check
    const expectedSql = `SELECT "data" FROM "logs" WHERE (data->'code' IS NOT NULL AND data->'code' != 'null'::jsonb)`;
    const { sql } = converter.buildSelectQueryAndParams('logs', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $or nested within $and', () => {
    const query = {
      $and: [
        { price: { $gt: 10 } },
        { $or: [ { category: "A" }, { status: "new" } ] }
      ]
    };
    // $gt uses inlined, $eq uses parameters
    const expectedSql = `SELECT "data" FROM "products" WHERE ((data->>'price')::numeric > 10 AND (data->>'category' = $1 OR data->>'status' = $2))`;
    const { sql } = converter.buildSelectQueryAndParams('products', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $and nested within $or', () => {
    const query = {
      $or: [
        { status: "urgent" },
        { $and: [ { priority: { $gte: 5 } }, { assigned: true } ] }
      ]
    };
    // $eq, bool eq use parameters; $gte uses inlined
    const expectedSql = `SELECT "data" FROM "tasks" WHERE (data->>'status' = $1 OR ((data->>'priority')::numeric >= 5 AND (data->>'assigned')::boolean = $2))`;
    const { sql } = converter.buildSelectQueryAndParams('tasks', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $not nested within field operators', () => {
    const query = { score: { $gte: 50, $not: { $in: [70, 80] } } };
    // $gte uses inlined, $in uses ANY($param)
    // Corrected cast based on implementation
    const expectedSql = `SELECT "data" FROM "results" WHERE ((data->>'score')::numeric >= 50 AND NOT ((data->>'score')::integer = ANY($1)))`;
    const { sql } = converter.buildSelectQueryAndParams('results', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $not at the top level with complex expression', () => {
    const query = { $not: { $or: [{ type: 'test' }, { value: null }] } };
    // $eq uses parameters, null check does not
    const expectedSql = `SELECT "data" FROM "data" WHERE NOT ((data->>'type' = $1 OR (data->'value' IS NULL OR data->'value' = 'null'::jsonb)))`;
    const { sql } = converter.buildSelectQueryAndParams('data', query);
    expect(sql).toBe(expectedSql);
  });

  // Array Interactions
  test('should handle matching specific array index (dot notation)', () => {
    const query = { 'tags.0': 'important' };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "items" WHERE data->'tags'->>0 = $1`;
    const { sql } = converter.buildSelectQueryAndParams('items', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $eq matching primitive array exactly', () => {
    const query = { codes: [10, 20, 30] };
    // Array equality uses parameters
    const expectedSql = `SELECT "data" FROM "records" WHERE data->'codes'::jsonb = $1::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams('records', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle $elemMatch on array of primitives', () => {
    const query = { scores: { $elemMatch: { $gte: 95 } } };
    // $gte uses inlined value
    const expectedSql = `SELECT "data" FROM "reports" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'scores') as elem_val WHERE (elem_val.value)::numeric >= 95)`;
    const { sql } = converter.buildSelectQueryAndParams('reports', query);
    expect(sql).toBe(expectedSql);
  });

  test('should handle dot notation within $elemMatch', () => {
    const query = {
      items: {
        $elemMatch: { 'details.status': 'active', price: { $lt: 100 } }
      }
    };
    // $eq uses parameters, $lt uses inlined
    const expectedSql = `SELECT "data" FROM "orders" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'items') as elem WHERE elem->'details'->>'status' = $1 AND (elem->>'price')::numeric < 100)`;
    const { sql } = converter.buildSelectQueryAndParams('orders', query);
    expect(sql).toBe(expectedSql);
  });

  // Deep Nesting
  test('Deep Nesting: $and > $or > $and', () => {
    const query = {
      $and: [
        { status: 'A' },
        {
          $or: [
            { value: { $gt: 100 } },
            {
              $and: [
                { category: { $in: ['X', 'Y'] } },
                { 'flags.active': true }
              ]
            }
          ]
        },
        { timestamp: { $lt: '2024-01-01T00:00:00Z' } }
      ]
    };
    // $eq, $in, bool eq use parameters; $gt, $lt use inlined
    const expectedSql = `SELECT "data" FROM "deep_test" WHERE (data->>'status' = $1 AND ((data->>'value')::numeric > 100 OR (data->>'category' = ANY($2) AND (data->'flags'->>'active')::boolean = $3)) AND data->>'timestamp' < '2024-01-01T00:00:00Z')`;
    const { sql } = converter.buildSelectQueryAndParams('deep_test', query);
    expect(sql).toBe(expectedSql);
  });

  test('Deep Nesting: $not > $or', () => {
    const query = {
      $not: {
        $or: [
          { score: { $lt: 10 } },
          { type: null },
          { 'user.verified': false }
        ]
      }
    };
    // $lt uses inlined, null check is inline, bool eq uses parameters
    const expectedSql = `SELECT "data" FROM "not_or_test" WHERE NOT (((data->>'score')::numeric < 10 OR (data->'type' IS NULL OR data->'type' = 'null'::jsonb) OR (data->'user'->>'verified')::boolean = $1))`;
    const { sql } = converter.buildSelectQueryAndParams('not_or_test', query);
    expect(sql).toBe(expectedSql);
  });

  // Field/Logical Combo
  test('Field/Logical Combo: $in within $and within $or', () => {
    const query = {
      $or: [
        { company: 'BigCorp' },
        {
          $and: [
            { region: 'EU' },
            { departments: { $in: ['Sales', 'Marketing', 'Support'] } }
          ]
        }
      ]
    };
    // $eq, $in use parameters
    const expectedSql = `SELECT "data" FROM "org_chart" WHERE (data->>'company' = $1 OR (data->>'region' = $2 AND data->>'departments' = ANY($3)))`;
    const { sql } = converter.buildSelectQueryAndParams('org_chart', query);
    expect(sql).toBe(expectedSql);
  });

  // Array Combo
  test('Array Combo: $all and $size', () => {
    const query = { requiredSkills: { $all: ['js', 'ts'], $size: 2 } };
    // $all uses inlined array literal, $size uses inlined number
    const expectedSql = `SELECT "data" FROM "candidates" WHERE (data->'requiredSkills' @> '["js","ts"]'::jsonb AND (jsonb_typeof(data->'requiredSkills') = 'array' AND jsonb_array_length(data->'requiredSkills') = 2))`;
    const { sql } = converter.buildSelectQueryAndParams('candidates', query);
    expect(sql).toBe(expectedSql);
  });

  test('Array Combo: $elemMatch containing $all', () => {
    const query = { projects: { $elemMatch: { name: 'Project X', requiredBadges: { $all: ['A', 'B'] } } } };
    // $eq uses parameters, $all uses inlined array literal
    const expectedSql = `SELECT "data" FROM "users" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'projects') as elem WHERE elem->>'name' = $1 AND elem->'requiredBadges' @> '["A","B"]'::jsonb)`;
    const { sql } = converter.buildSelectQueryAndParams('users', query);
    expect(sql).toBe(expectedSql);
  });

  // Complex $elemMatch
  test('Complex $elemMatch: nested $or', () => {
    const query = {
      inventory: {
        $elemMatch: {
          $or: [ { category: 'electronics' }, { price: { $lt: 10 } } ],
          onSale: true
        }
      }
    };
    // Fix: Remove outer parentheses from expectation
    const expectedSql = `SELECT "data" FROM "inventory" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'inventory') as elem WHERE (elem->>'category' = $1 OR (elem->>'price')::numeric < 10) AND (elem->>'onSale')::boolean = $2)`;
    const { sql } = converter.buildSelectQueryAndParams('inventory', query);
    expect(sql).toBe(expectedSql);
  });

  test('Complex $elemMatch: $not on field inside', () => {
    const query = {
      entries: {
        $elemMatch: {
          value: { $gt: 100 },
          status: { $not: { $eq: 'ignored' } }
        }
      }
    };
    // $gt uses inlined, $eq uses parameters
    const expectedSql = `SELECT "data" FROM "logs" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'entries') as elem WHERE (elem->>'value')::numeric > 100 AND NOT (elem->>'status' = $1))`;
    const { sql } = converter.buildSelectQueryAndParams('logs', query);
    expect(sql).toBe(expectedSql);
  });

  // $not Variations
  test('$not Variation: applied to $regex', () => {
    const query = { name: { $not: { $regex: '^Temp' } } };
    // $regex uses inlined value
    const expectedSql = `SELECT "data" FROM "files" WHERE NOT (data->>'name' ~ '^Temp')`;
    const { sql } = converter.buildSelectQueryAndParams('files', query);
    expect(sql).toBe(expectedSql);
  });

  test('$not Variation: applied to $exists: true', () => {
    const query = { deletedAt: { $not: { $exists: true } } };
    // $exists does not use parameters
    const expectedSql = `SELECT "data" FROM "records" WHERE NOT (data->'deletedAt' IS NOT NULL)`;
    const { sql } = converter.buildSelectQueryAndParams('records', query);
    expect(sql).toBe(expectedSql);
  });

  test('$not Variation: applied to $exists: false', () => {
    const query = { processedAt: { $not: { $exists: false } } };
    // $exists does not use parameters
    const expectedSql = `SELECT "data" FROM "jobs" WHERE NOT (data->'processedAt' IS NULL)`;
    const { sql } = converter.buildSelectQueryAndParams('jobs', query);
    expect(sql).toBe(expectedSql);
  });

  test('$not Variation: applied to $elemMatch', () => {
    const query = {
      tags: {
        $not: { $elemMatch: { $eq: 'critical' } }
      }
    };
    // $eq uses parameters
    const expectedSql = `SELECT "data" FROM "tickets" WHERE NOT (EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'tags') as elem_val WHERE elem_val.value = $1))`;
    const { sql } = converter.buildSelectQueryAndParams('tickets', query);
    expect(sql).toBe(expectedSql);
  });

  // Dot Notation Edge Cases
  test('Dot Notation Edge: non-existent path', () => {
    const query = { 'a.b.c.d': 'value' };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "test" WHERE data->'a'->'b'->'c'->>'d' = $1`;
    const { sql } = converter.buildSelectQueryAndParams('test', query);
    expect(sql).toBe(expectedSql);
  });

  test('Dot Notation Edge: array index with operator', () => {
    const query = { 'scores.0': { $gte: 100 } };
    // $gte uses inlined value
    const expectedSql = `SELECT "data" FROM "results" WHERE (data->'scores'->>0)::numeric >= 100`;
    const { sql } = converter.buildSelectQueryAndParams('results', query);
    expect(sql).toBe(expectedSql);
  });

  test('Dot Notation Edge: with $exists: true', () => {
    const query = { 'config.user': { $exists: true } };
    // $exists does not use parameters
    const expectedSql = `SELECT "data" FROM "settings" WHERE data->'config'->'user' IS NOT NULL`;
    const { sql } = converter.buildSelectQueryAndParams('settings', query);
    expect(sql).toBe(expectedSql);
  });

  // $type Combination
  test('$type Combination: with $or', () => {
    const query = { $or: [{ value: { $type: 'string' } }, { value: { $type: 'number' } }] };
    // $type uses inlined values
    const expectedSql = `SELECT "data" FROM "data" WHERE (jsonb_typeof(data->'value') = 'string' OR jsonb_typeof(data->'value') = 'number')`;
    const { sql } = converter.buildSelectQueryAndParams('data', query);
    expect(sql).toBe(expectedSql);
  });

  // Empty/Null Edge Cases
  test('Empty/Null Edge: $in with mixed types and null', () => {
    const query = { values: { $in: [1, 'two', null, 3.0] } };
    // Expect outer parentheses around combined OR, separate ANY for types
    const expectedSql = `SELECT "data" FROM "mixed" WHERE (((data->>'values')::integer = ANY($1) OR (data->>'values')::numeric = ANY($2) OR data->>'values' = ANY($3)) OR (data->'values' IS NULL OR data->'values' = 'null'::jsonb))`;
    const { sql, params } = converter.buildSelectQueryAndParams('mixed', query);
    expect(sql).toBe(expectedSql);
    expect(params).toEqual([[1], [3.0], ['two']]); 
  });

  test('Empty/Null Edge: $eq empty object', () => {
    const query = { metadata: {} };
    // Empty object eq uses inlined value
    const expectedSql = `SELECT "data" FROM "objects" WHERE data->'metadata'::jsonb = '{}'::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams('objects', query);
    expect(sql).toBe(expectedSql);
  });

  test('Empty/Null Edge: $ne empty object', () => {
    const query = { config: { $ne: {} } };
    // Empty object ne uses inlined value
    const expectedSql = `SELECT "data" FROM "configs" WHERE data->'config'::jsonb != '{}'::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams('configs', query);
    expect(sql).toBe(expectedSql);
  });

  test('Empty/Null Edge: $eq empty array', () => {
    const query = { tags: [] };
    // Empty array eq uses parameters
    const expectedSql = `SELECT "data" FROM "posts" WHERE data->'tags'::jsonb = $1::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams('posts', query);
    expect(sql).toBe(expectedSql);
  });

  // Options Interaction
  test('Options Interaction: Complex Sort with Complex Query', () => {
    const query = { $or: [{ status: 'A' }, { 'metrics.score': { $gt: 99 } }] };
    const options = { sort: { 'metrics.date': -1, status: 1 } as const, limit: 5 };
    // $eq uses parameters, $gt uses inlined
    const expectedSql = `SELECT "data" FROM "complex_sort" WHERE (data->>'status' = $1 OR (data->'metrics'->>'score')::numeric > 99) ORDER BY data->'metrics'->>'date' DESC, data->>'status' ASC LIMIT 5`;
    const { sql } = converter.buildSelectQueryAndParams('complex_sort', query, options);
    expect(sql).toBe(expectedSql);
  });

  // SQL Injection Potential (using parameters should prevent this)
  test('SQL Injection Potential: single quotes in value', () => {
    const query = { name: "Malicious' payload" };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "users" WHERE data->>'name' = $1`;
    const { sql } = converter.buildSelectQueryAndParams('users', query);
    expect(sql).toBe(expectedSql);
  });

  test('SQL Injection Potential: SQL keywords in value', () => {
    const query = { comment: "DROP TABLE users; --" };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "comments" WHERE data->>'comment' = $1`;
    const { sql } = converter.buildSelectQueryAndParams('comments', query);
    expect(sql).toBe(expectedSql);
  });
});