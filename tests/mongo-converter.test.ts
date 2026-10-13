import { describe, test, expect } from "bun:test";
import { MongoToPG, QueryError } from "../lib/mongo-converter";

describe("MongoToPG", () => {
  const converter = new MongoToPG();

  test("should handle simple equality", () => {
    const query = { name: "John Doe", age: 30 };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "users" WHERE data->>'name' = $1 AND (data->>'age')::integer = $2`;
    const { sql } = converter.buildSelectQueryAndParams("users", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle comparison operators", () => {
    const query = { score: { $gt: 90, $lte: 100 }, level: { $ne: "beginner" } };
    const expectedSql = `SELECT "data" FROM "users" WHERE ((data->>'score')::numeric > $1 AND (data->>'score')::numeric <= $2) AND data->>'level' IS DISTINCT FROM $3`;
    const { sql } = converter.buildSelectQueryAndParams("users", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $in and $nin operators", () => {
    const query = {
      status: { $in: ["active", "pending"] },
      category: { $nin: ["archived", "deleted"] },
    };
    // $in / $nin use ANY/ALL with parameters
    const expectedSql = `SELECT "data" FROM "items" WHERE data->>'status' = ANY($1) AND data->>'category' != ALL($2)`;
    const { sql } = converter.buildSelectQueryAndParams("items", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle logical $and (implicit and explicit)", () => {
    const query = {
      $and: [{ price: { $lt: 50 } }, { quantity: { $gte: 10 } }],
      inStock: true,
    };
    const expectedSql = `SELECT "data" FROM "products" WHERE ((data->>'price')::numeric < $1 AND (data->>'quantity')::numeric >= $2) AND (data->>'inStock')::boolean = $3`;
    const { sql } = converter.buildSelectQueryAndParams("products", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle logical $or", () => {
    const query = { $or: [{ type: "book" }, { type: "magazine" }] };
    // Inner simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "library" WHERE (data->>'type' = $1 OR data->>'type' = $2)`;
    const { sql } = converter.buildSelectQueryAndParams("library", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle logical $not (simulated with $ne)", () => {
    const query = { status: { $ne: "active" } };
    // $ne uses parameters
    const expectedSql = `SELECT "data" FROM "tasks" WHERE data->>'status' IS DISTINCT FROM $1`;
    const { sql } = converter.buildSelectQueryAndParams("tasks", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle nested documents", () => {
    const query = {
      "address.city": "New York",
      "address.zip": { $eq: "10001" },
    };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "customers" WHERE data->'address'->>'city' = $1 AND data->'address'->>'zip' = $2`;
    const { sql } = converter.buildSelectQueryAndParams("customers", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $exists operator", () => {
    const query = {
      middleName: { $exists: true },
      nickname: { $exists: false },
    };
    // $exists does not use parameters
    const expectedSql = `SELECT "data" FROM "profiles" WHERE data->'middleName' IS NOT NULL AND data->'nickname' IS NULL`;
    const { sql } = converter.buildSelectQueryAndParams("profiles", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $regex (case-sensitive)", () => {
    const query = { description: { $regex: "^start" } };
    const expectedSql = `SELECT "data" FROM "logs" WHERE data->>'description' ~ $1`;
    const { sql } = converter.buildSelectQueryAndParams("logs", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $regex (case-insensitive via simplified /pattern/i)", () => {
    const query = { description: { $regex: "/end$/i" } };
    const expectedSql = `SELECT "data" FROM "logs" WHERE data->>'description' ~* $1`;
    const { sql } = converter.buildSelectQueryAndParams("logs", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $regex (case-insensitive via array convention)", () => {
    const query = { description: { $regex: ["middle", "i"] } };
    const expectedSql = `SELECT "data" FROM "logs" WHERE data->>'description' ~* $1`;
    const { sql } = converter.buildSelectQueryAndParams("logs", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $regex with sibling $options (now detects insensitive)", () => {
    const query = { description: { $regex: "Exact", $options: "i" } };
    const expectedSql = `SELECT "data" FROM "data" WHERE data->>'description' ~* $1`;
    const { sql } = converter.buildSelectQueryAndParams("data", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $size operator for arrays", () => {
    const query = { tags: { $size: 3 } };
    // $size uses inlined value
    const expectedSql = `SELECT "data" FROM "posts" WHERE (jsonb_typeof(data->'tags') = 'array' AND jsonb_array_length(data->'tags') = 3)`;
    const { sql } = converter.buildSelectQueryAndParams("posts", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $all operator for arrays", () => {
    const query = { requiredTags: { $all: ["urgent", "review"] } };
    const expectedSql = `SELECT "data" FROM "tickets" WHERE data->'requiredTags' @> $1::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams("tickets", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $elemMatch on array of objects", () => {
    const query = {
      items: { $elemMatch: { product: "apple", quantity: { $gte: 5 } } },
    };
    const expectedSql = `SELECT "data" FROM "orders" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'items') as elem WHERE elem->>'product' = $1 AND (elem->>'quantity')::numeric >= $2)`;
    const { sql } = converter.buildSelectQueryAndParams("orders", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle null value equality", () => {
    const query = { deletedAt: null };
    // Null check does not use parameters
    const expectedSql = `SELECT "data" FROM "records" WHERE (data->'deletedAt' IS NULL OR data->'deletedAt' = 'null'::jsonb)`;
    const { sql } = converter.buildSelectQueryAndParams("records", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle boolean equality", () => {
    const query = { isActive: true, isProcessed: false };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "flags" WHERE (data->>'isActive')::boolean = $1 AND (data->>'isProcessed')::boolean = $2`;
    const { sql } = converter.buildSelectQueryAndParams("flags", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle schema and jsonField options", () => {
    const query = { value: { $gt: 100 } };
    const options = { schema: "metrics", jsonField: "payload" };
    const expectedSql = `SELECT "payload" FROM "metrics"."events" WHERE (payload->>'value')::numeric > $1`;
    const { sql } = converter.buildSelectQueryAndParams(
      "events",
      query,
      options,
    );
    expect(sql).toBe(expectedSql);
  });

  test("should handle limit and sort options", () => {
    const query = { type: "log" };
    const options = { limit: 50, sort: { timestamp: -1, level: 1 } as const };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "entries" WHERE data->>'type' = $1 ORDER BY data->'timestamp' DESC NULLS LAST, data->'level' ASC NULLS LAST LIMIT 50`;
    const { sql } = converter.buildSelectQueryAndParams(
      "entries",
      query,
      options,
    );
    expect(sql).toBe(expectedSql);
  });

  test("should handle complex nested logical operators", () => {
    const query = {
      $and: [
        { status: "active" },
        {
          $or: [
            { score: { $gte: 95 } },
            {
              $and: [
                { level: { $in: ["expert", "master"] } },
                { verified: true },
              ],
            },
          ],
        },
      ],
    };
    const expectedSql = `SELECT "data" FROM "users" WHERE (data->>'status' = $1 AND ((data->>'score')::numeric >= $2 OR (data->>'level' = ANY($3) AND (data->>'verified')::boolean = $4)))`;
    const { sql } = converter.buildSelectQueryAndParams("users", query);
    expect(sql).toBe(expectedSql);
  });

  test("should return basic SELECT FROM table for empty query object", () => {
    const query = {};
    const expectedSql = `SELECT "data" FROM "empty_test"`;
    const { sql } = converter.buildSelectQueryAndParams("empty_test", query);
    expect(sql).toBe(expectedSql);
  });

  // --- Start: Additional Tests ---

  test("should handle simple float equality", () => {
    const query = { price: 19.99 };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "products" WHERE (data->>'price')::numeric = $1`;
    const { sql } = converter.buildSelectQueryAndParams("products", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $ne with boolean", () => {
    const query = { enabled: { $ne: false } };
    // $ne uses parameters
    const expectedSql = `SELECT "data" FROM "settings" WHERE (data->>'enabled')::boolean IS DISTINCT FROM $1`;
    const { sql } = converter.buildSelectQueryAndParams("settings", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $in with numbers", () => {
    const query = { product_id: { $in: [101, 202, 303] } };
    // $in uses ANY with parameters
    // Corrected cast based on implementation (assumes integer if first is int)
    const expectedSql = `SELECT "data" FROM "inventory" WHERE (data->>'product_id')::integer = ANY($1)`;
    const { sql } = converter.buildSelectQueryAndParams("inventory", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $nin with numbers", () => {
    const query = { user_id: { $nin: [1, 2, 3] } };
    // $nin uses ALL with parameters
    // Corrected cast based on implementation
    const expectedSql = `SELECT "data" FROM "logs" WHERE (data->>'user_id')::integer != ALL($1)`;
    const { sql } = converter.buildSelectQueryAndParams("logs", query);
    expect(sql).toBe(expectedSql);
  });

  test("should reject empty logical arrays and non-object members", () => {
    for (const query of [
      { $and: [] },
      { $or: [] },
      { $nor: [] },
      { $and: [5] },
      { $or: [null] },
      { $nor: [["x"]] },
    ]) {
      expect(() => converter.buildWhereClauseAndParams(query)).toThrow(
        QueryError,
      );
    }
  });

  test("should fold constants in logical operators", () => {
    const where = (query: Record<string, any>) =>
      converter.buildWhereClauseAndParams(query).whereClause;
    const all = { tags: { $nin: [] } };
    const none = { tags: { $in: [] } };

    expect(where({ $and: [{}] })).toBe("WHERE TRUE");
    expect(where({ $and: [all, { a: 1 }] })).toBe(
      "WHERE (data->>'a')::integer = $1",
    );
    expect(where({ $and: [none, { a: 1 }] })).toBe("WHERE FALSE");
    expect(where({ $or: [{}, { a: 1 }] })).toBe("WHERE TRUE");
    expect(where({ $or: [all, { a: 1 }] })).toBe("WHERE TRUE");
    expect(where({ $or: [none, { a: 1 }] })).toBe(
      "WHERE (data->>'a')::integer = $1",
    );
    expect(where({ $or: [none] })).toBe("WHERE FALSE");
    expect(where({ $nor: [{}, { a: 1 }] })).toBe("WHERE FALSE");
    expect(where({ $nor: [none] })).toBe("WHERE TRUE");
    expect(where({ $not: { $or: [{}] } })).toBe("WHERE FALSE");
    // a FALSE among one field's operators decides, so its negation is TRUE
    expect(where({ $nor: [{ f: { $in: [], $gt: 1 } }] })).toBe("WHERE TRUE");
    expect(where({ f: { $not: { $in: [], $exists: true } } })).toBe(
      "WHERE TRUE",
    );
    expect(where({ f: { $not: { $elemMatch: { $in: [] } } } })).toBe(
      "WHERE TRUE",
    );
  });

  test("should drop the parameters of a folded sub-filter", () => {
    const build = (query: Record<string, any>) =>
      converter.buildWhereClauseAndParams(query);

    expect(build({ a: 1, f: { $in: [] } })).toEqual({
      whereClause: "WHERE FALSE",
      params: [],
    });
    expect(build({ $or: [{ a: 1 }, {}] })).toEqual({
      whereClause: "WHERE TRUE",
      params: [],
    });
    expect(
      build({ $or: [{ $and: [{ b: 2 }, { f: { $in: [] } }] }, { a: 1 }] }),
    ).toEqual({
      whereClause: "WHERE (data->>'a')::integer = $1",
      params: [1],
    });
    expect(build({ $nor: [{ f: { $in: [], $gt: 1 } }], a: 1 })).toEqual({
      whereClause: "WHERE (data->>'a')::integer = $1",
      params: [1],
    });
  });

  test("should handle $nor operator", () => {
    const query = { $nor: [{ status: "completed" }, { archived: true }] };
    // Inner simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "jobs" WHERE NOT ((data->>'status' = $1 OR (data->>'archived')::boolean = $2))`;
    const { sql } = converter.buildSelectQueryAndParams("jobs", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $not operator on a single field condition", () => {
    const query = { score: { $not: { $lt: 50 } } };
    const expectedSql = `SELECT "data" FROM "results" WHERE NOT ((data->>'score')::numeric < $1)`;
    const { sql } = converter.buildSelectQueryAndParams("results", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle deeply nested dot notation", () => {
    const query = { "metadata.user.address.country": "CA" };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "events" WHERE data->'metadata'->'user'->'address'->>'country' = $1`;
    const { sql } = converter.buildSelectQueryAndParams("events", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle dot notation combined with operators", () => {
    const query = { "metrics.views": { $gte: 1000 } };
    const expectedSql = `SELECT "data" FROM "articles" WHERE (data->'metrics'->>'views')::numeric >= $1`;
    const { sql } = converter.buildSelectQueryAndParams("articles", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $type string", () => {
    const query = { description: { $type: "string" } };
    const expectedSql = `SELECT "data" FROM "products" WHERE jsonb_typeof(data->'description') = $1`;
    const { sql } = converter.buildSelectQueryAndParams("products", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $type number", () => {
    const query = { count: { $type: "number" } };
    const expectedSql = `SELECT "data" FROM "inventory" WHERE jsonb_typeof(data->'count') = $1`;
    const { sql } = converter.buildSelectQueryAndParams("inventory", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $mod operator", () => {
    const query = { quantity: { $mod: [10, 1] } };
    const expectedSql = `SELECT "data" FROM "stock" WHERE (data->>'quantity')::numeric % $1 = $2`;
    const { sql } = converter.buildSelectQueryAndParams("stock", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $elemMatch with nested operators", () => {
    const query = {
      grades: {
        $elemMatch: {
          grade: { $in: ["A", "B"] },
          score: { $gte: 85 },
        },
      },
    };
    const expectedSql = `SELECT "data" FROM "students" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'grades') as elem WHERE elem->>'grade' = ANY($1) AND (elem->>'score')::numeric >= $2)`;
    const { sql } = converter.buildSelectQueryAndParams("students", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle multiple sort fields", () => {
    const query = { category: "electronics" };
    const options = { sort: { brand: 1, price: -1 } as const };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "products" WHERE data->>'category' = $1 ORDER BY data->'brand' ASC NULLS LAST, data->'price' DESC NULLS LAST`;
    const { sql } = converter.buildSelectQueryAndParams(
      "products",
      query,
      options,
    );
    expect(sql).toBe(expectedSql);
  });

  test("should handle $all with a single element array", () => {
    const query = { features: { $all: ["bluetooth"] } };
    const expectedSql = `SELECT "data" FROM "devices" WHERE data->'features' @> $1::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams("devices", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $size 0", () => {
    const query = { comments: { $size: 0 } };
    // $size uses inlined value
    const expectedSql = `SELECT "data" FROM "articles" WHERE (jsonb_typeof(data->'comments') = 'array' AND jsonb_array_length(data->'comments') = 0)`;
    const { sql } = converter.buildSelectQueryAndParams("articles", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $in with empty array", () => {
    const query = { tags: { $in: [] } };
    // $in [] returns FALSE
    const expectedSql = `SELECT "data" FROM "posts" WHERE FALSE`;
    const { sql } = converter.buildSelectQueryAndParams("posts", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $nin with empty array", () => {
    const query = { categories: { $nin: [] } };
    // Expect WHERE TRUE
    const expectedSql = `SELECT "data" FROM "products" WHERE TRUE`;
    const { sql } = converter.buildSelectQueryAndParams("products", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle mixed implicit AND with $or", () => {
    const query = {
      status: "pending",
      $or: [{ priority: 1 }, { urgent: true }],
    };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "tasks" WHERE data->>'status' = $1 AND ((data->>'priority')::integer = $2 OR (data->>'urgent')::boolean = $3)`;
    const { sql } = converter.buildSelectQueryAndParams("tasks", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle regex with special SQL characters", () => {
    const query = { pattern: { $regex: "^d[a-t]'%$" } };
    const expectedSql = `SELECT "data" FROM "regex_test" WHERE data->>'pattern' ~ $1`;
    const { sql } = converter.buildSelectQueryAndParams("regex_test", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle query with no options", () => {
    const query = { key: "value" };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "simple" WHERE data->>'key' = $1`;
    const { sql } = converter.buildSelectQueryAndParams("simple", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle array equality check", () => {
    const query = { exactTags: ["a", "b", "c"] };
    // Array equality uses parameters
    const expectedSql = `SELECT "data" FROM "tag_match" WHERE data->'exactTags'::jsonb = $1::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams("tag_match", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle deeply nested dot notation (multi-level)", () => {
    const query = { "config.settings.network.ports.admin": 8080 };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "systems" WHERE (data->'config'->'settings'->'network'->'ports'->>'admin')::integer = $1`;
    const { sql } = converter.buildSelectQueryAndParams("systems", query);
    expect(sql).toBe(expectedSql);
  });

  // --- Start: More Additional Tests ---

  test("should reject $text when no textFields are configured", () => {
    expect(() =>
      converter.buildSelectQueryAndParams("recipes", {
        $text: { $search: "bake coffee cake" },
      }),
    ).toThrow("$text requires SchemaOptions.textFields");
  });

  test("should search textFields for $text", () => {
    const { sql, params } = new MongoToPG({
      textFields: ["title", "body"],
    }).buildSelectQueryAndParams("recipes", { $text: { $search: "cake" } });
    expect(sql).toBe(
      `SELECT "data" FROM "recipes" WHERE to_tsvector('english', coalesce(data->>'title', '') || ' ' || coalesce(data->>'body', '')) @@ websearch_to_tsquery('english', $1)`,
    );
    expect(params).toEqual(["cake"]);
  });

  test("should reject unknown operators instead of dropping them", () => {
    expect(() =>
      converter.buildSelectQueryAndParams("notes", {
        description: { $search: "important terms" },
      }),
    ).toThrow(QueryError);
    expect(() =>
      converter.buildSelectQueryAndParams("notes", { $bogus: 1 }),
    ).toThrow("unsupported operator: $bogus");
    expect(() =>
      converter.buildUpdateSetExpressionAndParams({ $push: { tags: "x" } }),
    ).toThrow("unsupported update operator: $push");
  });

  test("should handle $eq with undefined", () => {
    const query = { optionalField: { $eq: undefined } };
    // $eq undefined -> IS NULL (no parameters)
    const expectedSql = `SELECT "data" FROM "data" WHERE data->'optionalField' IS NULL`;
    const { sql } = converter.buildSelectQueryAndParams("data", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $ne with undefined", () => {
    const query = { requiredField: { $ne: undefined } };
    // $ne undefined -> IS NOT NULL (no parameters)
    const expectedSql = `SELECT "data" FROM "data" WHERE data->'requiredField' IS NOT NULL`;
    const { sql } = converter.buildSelectQueryAndParams("data", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $in with null and values", () => {
    const query = { status: { $in: ["active", null] } };
    // Expect outer parentheses around combined OR
    const expectedSql = `SELECT "data" FROM "items" WHERE ((data->>'status' = ANY($1)) OR (data->'status' IS NULL OR data->'status' = 'null'::jsonb))`;
    const { sql } = converter.buildSelectQueryAndParams("items", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $in with only null", () => {
    const query = { status: { $in: [null] } };
    // $in [null] -> IS NULL check
    const expectedSql = `SELECT "data" FROM "items" WHERE (data->'status' IS NULL OR data->'status' = 'null'::jsonb)`;
    const { sql } = converter.buildSelectQueryAndParams("items", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $nin with null and values", () => {
    const query = { code: { $nin: ["ERROR", null] } };
    // $nin uses ALL with parameter, null check is separate
    const expectedSql = `SELECT "data" FROM "logs" WHERE (data->>'code' != ALL($1) AND (data->'code' IS NOT NULL AND data->'code' != 'null'::jsonb))`;
    const { sql } = converter.buildSelectQueryAndParams("logs", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $nin with only null", () => {
    const query = { code: { $nin: [null] } };
    // $nin [null] -> IS NOT NULL check
    const expectedSql = `SELECT "data" FROM "logs" WHERE (data->'code' IS NOT NULL AND data->'code' != 'null'::jsonb)`;
    const { sql } = converter.buildSelectQueryAndParams("logs", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $or nested within $and", () => {
    const query = {
      $and: [
        { price: { $gt: 10 } },
        { $or: [{ category: "A" }, { status: "new" }] },
      ],
    };
    const expectedSql = `SELECT "data" FROM "products" WHERE ((data->>'price')::numeric > $1 AND (data->>'category' = $2 OR data->>'status' = $3))`;
    const { sql } = converter.buildSelectQueryAndParams("products", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $and nested within $or", () => {
    const query = {
      $or: [
        { status: "urgent" },
        { $and: [{ priority: { $gte: 5 } }, { assigned: true }] },
      ],
    };
    const expectedSql = `SELECT "data" FROM "tasks" WHERE (data->>'status' = $1 OR ((data->>'priority')::numeric >= $2 AND (data->>'assigned')::boolean = $3))`;
    const { sql } = converter.buildSelectQueryAndParams("tasks", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $not nested within field operators", () => {
    const query = { score: { $gte: 50, $not: { $in: [70, 80] } } };
    // Corrected cast based on implementation
    const expectedSql = `SELECT "data" FROM "results" WHERE ((data->>'score')::numeric >= $1 AND NOT ((data->>'score')::integer = ANY($2)))`;
    const { sql } = converter.buildSelectQueryAndParams("results", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $not at the top level with complex expression", () => {
    const query = { $not: { $or: [{ type: "test" }, { value: null }] } };
    // $eq uses parameters, null check does not
    const expectedSql = `SELECT "data" FROM "data" WHERE NOT ((data->>'type' = $1 OR (data->'value' IS NULL OR data->'value' = 'null'::jsonb)))`;
    const { sql } = converter.buildSelectQueryAndParams("data", query);
    expect(sql).toBe(expectedSql);
  });

  // Array Interactions
  test("should handle matching specific array index (dot notation)", () => {
    const query = { "tags.0": "important" };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "items" WHERE data->'tags'->>0 = $1`;
    const { sql } = converter.buildSelectQueryAndParams("items", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $eq matching primitive array exactly", () => {
    const query = { codes: [10, 20, 30] };
    // Array equality uses parameters
    const expectedSql = `SELECT "data" FROM "records" WHERE data->'codes'::jsonb = $1::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams("records", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle $elemMatch on array of primitives", () => {
    const query = { scores: { $elemMatch: { $gte: 95 } } };
    const expectedSql = `SELECT "data" FROM "reports" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'scores') as elem WHERE ((elem #>> '{}'))::numeric >= $1)`;
    const { sql } = converter.buildSelectQueryAndParams("reports", query);
    expect(sql).toBe(expectedSql);
  });

  test("should handle dot notation within $elemMatch", () => {
    const query = {
      items: {
        $elemMatch: { "details.status": "active", price: { $lt: 100 } },
      },
    };
    const expectedSql = `SELECT "data" FROM "orders" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'items') as elem WHERE elem->'details'->>'status' = $1 AND (elem->>'price')::numeric < $2)`;
    const { sql } = converter.buildSelectQueryAndParams("orders", query);
    expect(sql).toBe(expectedSql);
  });

  // Deep Nesting
  test("Deep Nesting: $and > $or > $and", () => {
    const query = {
      $and: [
        { status: "A" },
        {
          $or: [
            { value: { $gt: 100 } },
            {
              $and: [
                { category: { $in: ["X", "Y"] } },
                { "flags.active": true },
              ],
            },
          ],
        },
        { timestamp: { $lt: "2024-01-01T00:00:00Z" } },
      ],
    };
    const expectedSql = `SELECT "data" FROM "deep_test" WHERE (data->>'status' = $1 AND ((data->>'value')::numeric > $2 OR (data->>'category' = ANY($3) AND (data->'flags'->>'active')::boolean = $4)) AND data->>'timestamp' < $5)`;
    const { sql } = converter.buildSelectQueryAndParams("deep_test", query);
    expect(sql).toBe(expectedSql);
  });

  test("Deep Nesting: $not > $or", () => {
    const query = {
      $not: {
        $or: [
          { score: { $lt: 10 } },
          { type: null },
          { "user.verified": false },
        ],
      },
    };
    const expectedSql = `SELECT "data" FROM "not_or_test" WHERE NOT (((data->>'score')::numeric < $1 OR (data->'type' IS NULL OR data->'type' = 'null'::jsonb) OR (data->'user'->>'verified')::boolean = $2))`;
    const { sql } = converter.buildSelectQueryAndParams("not_or_test", query);
    expect(sql).toBe(expectedSql);
  });

  // Field/Logical Combo
  test("Field/Logical Combo: $in within $and within $or", () => {
    const query = {
      $or: [
        { company: "BigCorp" },
        {
          $and: [
            { region: "EU" },
            { departments: { $in: ["Sales", "Marketing", "Support"] } },
          ],
        },
      ],
    };
    // $eq, $in use parameters
    const expectedSql = `SELECT "data" FROM "org_chart" WHERE (data->>'company' = $1 OR (data->>'region' = $2 AND data->>'departments' = ANY($3)))`;
    const { sql } = converter.buildSelectQueryAndParams("org_chart", query);
    expect(sql).toBe(expectedSql);
  });

  // Array Combo
  test("Array Combo: $all and $size", () => {
    const query = { requiredSkills: { $all: ["js", "ts"], $size: 2 } };
    const expectedSql = `SELECT "data" FROM "candidates" WHERE (data->'requiredSkills' @> $1::jsonb AND (jsonb_typeof(data->'requiredSkills') = 'array' AND jsonb_array_length(data->'requiredSkills') = 2))`;
    const { sql } = converter.buildSelectQueryAndParams("candidates", query);
    expect(sql).toBe(expectedSql);
  });

  test("Array Combo: $elemMatch containing $all", () => {
    const query = {
      projects: {
        $elemMatch: { name: "Project X", requiredBadges: { $all: ["A", "B"] } },
      },
    };
    const expectedSql = `SELECT "data" FROM "users" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'projects') as elem WHERE elem->>'name' = $1 AND elem->'requiredBadges' @> $2::jsonb)`;
    const { sql } = converter.buildSelectQueryAndParams("users", query);
    expect(sql).toBe(expectedSql);
  });

  // Complex $elemMatch
  test("Complex $elemMatch: nested $or", () => {
    const query = {
      inventory: {
        $elemMatch: {
          $or: [{ category: "electronics" }, { price: { $lt: 10 } }],
          onSale: true,
        },
      },
    };
    // Fix: Remove outer parentheses from expectation
    const expectedSql = `SELECT "data" FROM "inventory" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'inventory') as elem WHERE (elem->>'category' = $1 OR (elem->>'price')::numeric < $2) AND (elem->>'onSale')::boolean = $3)`;
    const { sql } = converter.buildSelectQueryAndParams("inventory", query);
    expect(sql).toBe(expectedSql);
  });

  test("Complex $elemMatch: $not on field inside", () => {
    const query = {
      entries: {
        $elemMatch: {
          value: { $gt: 100 },
          status: { $not: { $eq: "ignored" } },
        },
      },
    };
    const expectedSql = `SELECT "data" FROM "logs" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'entries') as elem WHERE (elem->>'value')::numeric > $1 AND NOT (elem->>'status' = $2))`;
    const { sql } = converter.buildSelectQueryAndParams("logs", query);
    expect(sql).toBe(expectedSql);
  });

  // $not Variations
  test("$not Variation: applied to $regex", () => {
    const query = { name: { $not: { $regex: "^Temp" } } };
    const expectedSql = `SELECT "data" FROM "files" WHERE NOT (data->>'name' ~ $1)`;
    const { sql } = converter.buildSelectQueryAndParams("files", query);
    expect(sql).toBe(expectedSql);
  });

  test("$not Variation: applied to $exists: true", () => {
    const query = { deletedAt: { $not: { $exists: true } } };
    // $exists does not use parameters
    const expectedSql = `SELECT "data" FROM "records" WHERE NOT (data->'deletedAt' IS NOT NULL)`;
    const { sql } = converter.buildSelectQueryAndParams("records", query);
    expect(sql).toBe(expectedSql);
  });

  test("$not Variation: applied to $exists: false", () => {
    const query = { processedAt: { $not: { $exists: false } } };
    // $exists does not use parameters
    const expectedSql = `SELECT "data" FROM "jobs" WHERE NOT (data->'processedAt' IS NULL)`;
    const { sql } = converter.buildSelectQueryAndParams("jobs", query);
    expect(sql).toBe(expectedSql);
  });

  test("$not Variation: applied to $elemMatch", () => {
    const query = {
      tags: {
        $not: { $elemMatch: { $eq: "critical" } },
      },
    };
    // $eq uses parameters
    const expectedSql = `SELECT "data" FROM "tickets" WHERE NOT (EXISTS (SELECT 1 FROM jsonb_array_elements(data->'tags') as elem WHERE (elem #>> '{}') = $1))`;
    const { sql } = converter.buildSelectQueryAndParams("tickets", query);
    expect(sql).toBe(expectedSql);
  });

  // Dot Notation Edge Cases
  test("Dot Notation Edge: non-existent path", () => {
    const query = { "a.b.c.d": "value" };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "test" WHERE data->'a'->'b'->'c'->>'d' = $1`;
    const { sql } = converter.buildSelectQueryAndParams("test", query);
    expect(sql).toBe(expectedSql);
  });

  test("Dot Notation Edge: array index with operator", () => {
    const query = { "scores.0": { $gte: 100 } };
    const expectedSql = `SELECT "data" FROM "results" WHERE (data->'scores'->>0)::numeric >= $1`;
    const { sql } = converter.buildSelectQueryAndParams("results", query);
    expect(sql).toBe(expectedSql);
  });

  test("Dot Notation Edge: with $exists: true", () => {
    const query = { "config.user": { $exists: true } };
    // $exists does not use parameters
    const expectedSql = `SELECT "data" FROM "settings" WHERE data->'config'->'user' IS NOT NULL`;
    const { sql } = converter.buildSelectQueryAndParams("settings", query);
    expect(sql).toBe(expectedSql);
  });

  // $type Combination
  test("$type Combination: with $or", () => {
    const query = {
      $or: [{ value: { $type: "string" } }, { value: { $type: "number" } }],
    };
    const expectedSql = `SELECT "data" FROM "data" WHERE (jsonb_typeof(data->'value') = $1 OR jsonb_typeof(data->'value') = $2)`;
    const { sql } = converter.buildSelectQueryAndParams("data", query);
    expect(sql).toBe(expectedSql);
  });

  // Empty/Null Edge Cases
  test("Empty/Null Edge: $in with mixed types and null", () => {
    const query = { values: { $in: [1, "two", null, 3.0] } };
    // Expect outer parentheses around combined OR, separate ANY for types
    // Note: 3.0 is treated as integer 3 in JS, so it goes into the integer bucket
    const expectedSql = `SELECT "data" FROM "mixed" WHERE ((((data->>'values')::integer = ANY($1) OR data->>'values' = ANY($2))) OR (data->'values' IS NULL OR data->'values' = 'null'::jsonb))`;
    const { sql, params } = converter.buildSelectQueryAndParams("mixed", query);
    expect(sql).toBe(expectedSql);
    expect(params).toEqual([[1, 3], ["two"]]);
  });

  test("Empty/Null Edge: $eq empty object", () => {
    const query = { metadata: {} };
    // Empty object eq uses inlined value
    const expectedSql = `SELECT "data" FROM "objects" WHERE data->'metadata'::jsonb = '{}'::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams("objects", query);
    expect(sql).toBe(expectedSql);
  });

  test("Empty/Null Edge: $ne empty object", () => {
    const query = { config: { $ne: {} } };
    // Empty object ne uses inlined value
    const expectedSql = `SELECT "data" FROM "configs" WHERE data->'config'::jsonb != '{}'::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams("configs", query);
    expect(sql).toBe(expectedSql);
  });

  test("Empty/Null Edge: $eq empty array", () => {
    const query = { tags: [] };
    // Empty array eq uses parameters
    const expectedSql = `SELECT "data" FROM "posts" WHERE data->'tags'::jsonb = $1::jsonb`;
    const { sql } = converter.buildSelectQueryAndParams("posts", query);
    expect(sql).toBe(expectedSql);
  });

  // Options Interaction
  test("Options Interaction: Complex Sort with Complex Query", () => {
    const query = { $or: [{ status: "A" }, { "metrics.score": { $gt: 99 } }] };
    const options = {
      sort: { "metrics.date": -1, status: 1 } as const,
      limit: 5,
    };
    const expectedSql = `SELECT "data" FROM "complex_sort" WHERE (data->>'status' = $1 OR (data->'metrics'->>'score')::numeric > $2) ORDER BY data->'metrics'->'date' DESC NULLS LAST, data->'status' ASC NULLS LAST LIMIT 5`;
    const { sql } = converter.buildSelectQueryAndParams(
      "complex_sort",
      query,
      options,
    );
    expect(sql).toBe(expectedSql);
  });

  // SQL Injection Potential (using parameters should prevent this)
  test("SQL Injection Potential: single quotes in value", () => {
    const query = { name: "Malicious' payload" };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "users" WHERE data->>'name' = $1`;
    const { sql } = converter.buildSelectQueryAndParams("users", query);
    expect(sql).toBe(expectedSql);
  });

  test("SQL Injection Potential: SQL keywords in value", () => {
    const query = { comment: "DROP TABLE users; --" };
    // Simple equality uses parameters
    const expectedSql = `SELECT "data" FROM "comments" WHERE data->>'comment' = $1`;
    const { sql } = converter.buildSelectQueryAndParams("comments", query);
    expect(sql).toBe(expectedSql);
  });

  test("SQL Injection Potential: operands are bound, never spliced", () => {
    const hostile = "x' OR '1'='1";
    const { sql, params } = converter.buildSelectQueryAndParams("users", {
      name: { $gt: hostile },
      tags: { $all: [hostile] },
      bio: { $regex: hostile },
    });
    expect(sql).not.toContain(hostile);
    expect(params).toEqual([hostile, JSON.stringify([hostile]), hostile]);
  });

  test("SQL Injection Potential: single quotes in filter and sort keys", () => {
    const { sql } = converter.buildSelectQueryAndParams(
      "users",
      { "a'b": 1, "x.c'd": "v" },
      { sort: { "e'f": 1, "y.g'h": -1 } },
    );
    expect(sql).toBe(
      `SELECT "data" FROM "users" WHERE (data->>'a''b')::integer = $1 AND data->'x'->>'c''d' = $2 ORDER BY data->'e''f' ASC NULLS LAST, data->'y'->'g''h' DESC NULLS LAST`,
    );
  });

  test("SQL Injection Potential: single quotes in update paths", () => {
    const built = converter.buildUpdateSetExpressionAndParams({
      $set: { "a'b": 1 },
    });
    expect(built?.expression).toBe(
      `jsonb_set_lax("data"::jsonb, '{"a''b"}', $1::jsonb, true)`,
    );
  });

  test("malformed operands throw instead of compiling to a constant", () => {
    const malformed: Record<string, any>[] = [
      { s: { $in: "x" } },
      { s: { $nin: "x" } },
      { s: { $all: "x" } },
      { s: { $mod: "x" } },
      { s: { $mod: [2] } },
      { s: { $size: "x" } },
      { s: { $size: 1.5 } },
      { s: { $type: "bogus" } },
      { s: { $type: "toString" } },
      { s: { $elemMatch: 5 } },
      { s: { $elemMatch: [] } },
      { s: { $elemMatch: { $options: "i" } } },
      { s: { $not: 5 } },
      { s: { $not: {} } },
      { s: { $options: "i" } },
      { s: { $exists: "false" } },
      { $not: 5 },
      { $not: { $in: [] } },
    ];
    // a constant FALSE would flip to match-all under negation
    const negated = malformed
      .filter((query) => "s" in query)
      .flatMap((query) => [
        { s: { $not: query.s } },
        { $not: query },
        { $nor: [query] },
      ]);

    for (const query of [...malformed, ...negated]) {
      expect(() => converter.buildWhereClauseAndParams(query)).toThrow(
        QueryError,
      );
    }
  });

  test("should keep the legitimate constant operands", () => {
    const where = (query: Record<string, any>) =>
      converter.buildWhereClauseAndParams(query).whereClause;

    expect(where({ s: { $all: [] } })).toBe("WHERE FALSE");
    expect(where({ s: { $exists: 1 } })).toBe("WHERE data->'s' IS NOT NULL");
    expect(where({ s: { $exists: 0 } })).toBe("WHERE data->'s' IS NULL");
    expect(where({ s: { $mod: [4.5, 0] } })).toBe(
      "WHERE (data->>'s')::numeric % $1 = $2",
    );
  });

  test("should apply every operator of a primitive $elemMatch", () => {
    const { sql, params } = converter.buildSelectQueryAndParams("reports", {
      scores: { $elemMatch: { $gt: 1, $lt: 5 } },
    });
    expect(sql).toBe(
      `SELECT "data" FROM "reports" WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(data->'scores') as elem WHERE ((elem #>> '{}'))::numeric > $1 AND ((elem #>> '{}'))::numeric < $2)`,
    );
    expect(params).toEqual([1, 5]);
  });

  test("limit and offset must be non-negative integers", () => {
    const build = (options: Record<string, any>) =>
      converter.buildSelectQueryAndParams("t", {}, options).sql;

    for (const bad of [1.5, -1, Infinity, NaN, "5", "0x10", [5], true]) {
      expect(() => build({ limit: bad })).toThrow("limit must be");
      expect(() => build({ offset: bad })).toThrow("offset must be");
    }
    expect(build({ limit: 0, offset: 0 })).toBe(`SELECT "data" FROM "t"`);
    expect(build({ limit: null, offset: undefined })).toBe(
      `SELECT "data" FROM "t"`,
    );
    expect(build({ limit: 5, offset: 10 })).toBe(
      `SELECT "data" FROM "t" LIMIT 5 OFFSET 10`,
    );
  });

  test("a primitive $elemMatch gives every operator the element as its path", () => {
    const inner = (operand: Record<string, any>) => {
      const { whereClause } = converter.buildWhereClauseAndParams({
        t: { $elemMatch: operand },
      });
      return whereClause.replace(
        /^WHERE EXISTS \(SELECT 1 FROM jsonb_array_elements\(data->'t'\) as elem WHERE (.*)\)$/,
        "$1",
      );
    };

    expect(inner({ $eq: null })).toBe("(elem IS NULL OR elem = 'null'::jsonb)");
    expect(inner({ $exists: true })).toBe("elem IS NOT NULL");
    expect(inner({ $type: "string" })).toBe("jsonb_typeof(elem) = $1");
    expect(inner({ $size: 2 })).toBe(
      "(jsonb_typeof(elem) = 'array' AND jsonb_array_length(elem) = 2)",
    );
    expect(inner({ $eq: "x" })).toBe("(elem #>> '{}') = $1");
  });

  test("update placeholders continue after seeded params", () => {
    const built = converter.buildUpdateSetExpressionAndParams(
      { $set: { a$10b: 1 }, $inc: { "n.$1": 2 } },
      "data",
      ["p1", "p2"],
    );
    expect(built?.expression).toBe(
      `jsonb_set_lax(jsonb_set_lax("data"::jsonb, '{"a$10b"}', $3::jsonb, true)::jsonb, '{"n","$1"}', to_jsonb(COALESCE(("data" #>> '{"n","$1"}')::numeric, 0) + $4::numeric), true)`,
    );
    expect(built?.params).toEqual(["p1", "p2", "1", 2]);
  });
});
