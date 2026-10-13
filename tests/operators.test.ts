// Operators checked against Postgres rather than against expected SQL text:
// numeric sort order and the comparison operands that are bound as parameters.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, getConnection, QueryError } from "../lib";

const Probe = defineSchema("orm_operator_probe", {
  label: { type: "string", required: true },
  count: { type: "number", default: 0 },
  tags: { type: "array", of: { type: "string" }, default: [] },
  meta: { type: "object" },
});

const labels = (rows: any[]) => rows.map((row) => row.label).sort();

beforeAll(async () => {
  await Probe.remove({ _id: { $exists: true } });
  const rows = [
    { label: "a", count: 9, tags: ["x"], meta: { "o'k": "x" } },
    { label: "b", count: 80, tags: ["x", "y"], meta: { list: [1, null] } },
    { label: "c", count: 100, tags: ["y"], meta: { list: [5, 7] } },
    { label: "d", count: 5, tags: [] },
    {
      label: "e",
      count: 1000,
      tags: ["x", "y", "z"],
      meta: { grid: [[1, 2], [9]] },
    },
  ];
  for (const row of rows) await Probe.create(row);
});

afterAll(async () => {
  await Probe.remove({ _id: { $exists: true } });
});

describe("sort on number fields", () => {
  test("orders numerically across digit widths", async () => {
    const desc = await Probe.find({}, { sort: { count: -1 } });
    expect(desc.map((row) => row.count)).toEqual([1000, 100, 80, 9, 5]);

    const asc = await Probe.find({}, { sort: { count: 1 } });
    expect(asc.map((row) => row.count)).toEqual([5, 9, 80, 100, 1000]);
  });
});

describe("bound operands", () => {
  test("$mod", async () => {
    expect(labels(await Probe.find({ count: { $mod: [10, 0] } }))).toEqual([
      "b",
      "c",
      "e",
    ]);
  });

  test("$type", async () => {
    expect(await Probe.count({ count: { $type: "number" } })).toBe(5);
    expect(await Probe.count({ count: { $type: "string" } })).toBe(0);
  });

  test("$all", async () => {
    expect(labels(await Probe.find({ tags: { $all: ["x", "y"] } }))).toEqual([
      "b",
      "e",
    ]);
  });

  test("string and number comparisons", async () => {
    expect(labels(await Probe.find({ label: { $lt: "c" } }))).toEqual([
      "a",
      "b",
    ]);
    expect(labels(await Probe.find({ count: { $gt: 9, $lte: 100 } }))).toEqual([
      "b",
      "c",
    ]);
  });

  test("an empty $in beside another condition matches nothing", async () => {
    expect(await Probe.find({ label: "a", tags: { $in: [] } })).toEqual([]);
    expect(
      labels(
        await Probe.find({ $or: [{ label: "a" }, { tags: { $in: [] } }] }),
      ),
    ).toEqual(["a"]);
  });

  test("a primitive $elemMatch reads each element", async () => {
    const find = async (operand: Record<string, any>) =>
      labels(await Probe.find({ "meta.list": { $elemMatch: operand } }));

    expect(await find({ $eq: null })).toEqual(["b"]);
    expect(await find({ $type: "number" })).toEqual(["b", "c"]);
    expect(await find({ $gt: 4, $lt: 6 })).toEqual(["c"]);
    expect(await find({ $in: [null, 7] })).toEqual(["b", "c"]);
    expect(
      labels(await Probe.find({ tags: { $elemMatch: { $eq: "z" } } })),
    ).toEqual(["e"]);
  });

  test("a nested primitive $elemMatch reads the inner array", async () => {
    const find = async (inner: Record<string, any>) =>
      labels(
        await Probe.find({
          "meta.grid": { $elemMatch: { $elemMatch: inner } },
        }),
      );

    expect(await find({ $gt: 8 })).toEqual(["e"]);
    expect(await find({ $gt: 9 })).toEqual([]);
  });

  test("an update key holding $ and digits is written as given", async () => {
    await Probe.updateOne({ label: "d" }, { $set: { a$10b: 1 } });
    await Probe.updateMany(
      { label: "d", count: 5 },
      { $inc: { a$10b: 2 } },
      { limit: 1 },
    );
    const db = await getConnection();
    const { rows } = await db.query(
      `SELECT data - '_mtime' AS doc FROM orm_operator_probe WHERE data->>'label' = 'd'`,
    );
    // the old placeholder renumbering wrote a$11b and a$12b instead
    expect(rows[0].doc.a$10b).toBe(3);
    expect(
      Object.keys(rows[0].doc).filter((key) => key.startsWith("a$")),
    ).toEqual(["a$10b"]);
  });

  test("$inc on an array index adds to the element", async () => {
    await Probe.updateMany(
      { label: "c" },
      { $inc: { "meta.list.0": 10, "meta.list.1": -2, "meta.hits": 1 } },
    );
    const [row] = await Probe.find({ label: "c" });
    expect(row.meta).toEqual({ list: [15, 5], hits: 1 });
    await Probe.updateMany(
      { label: "c" },
      { $inc: { "meta.list.0": -10, "meta.list.1": 2 } },
    );
  });

  test("a quote in a dotted key keeps its parent path", async () => {
    expect(labels(await Probe.find({ "meta.o'k": "x" }))).toEqual(["a"]);
  });
});

describe("bulk writes refuse a filter that selects every row by construction", () => {
  const unselective: Record<string, any>[] = [
    { $and: [{}] },
    { label: { $nin: [] } },
    { $or: [{}, { label: "a" }] },
    { $nor: [{ label: { $in: [], $gt: "a" } }] },
    { tags: { $not: { $elemMatch: { $in: [] } } } },
  ];
  const malformed: Record<string, any>[] = [
    { label: { $options: "i" } },
    { label: { $nin: "x" } },
    { label: { $not: { $in: "x" } } },
  ];

  test("remove, updateOne and updateMany reject and change nothing", async () => {
    for (const filter of [...unselective, ...malformed]) {
      const set = { $set: { count: -1 } };
      await expect(Probe.remove(filter)).rejects.toBeInstanceOf(QueryError);
      await expect(Probe.updateOne(filter, set)).rejects.toBeInstanceOf(
        QueryError,
      );
      await expect(Probe.updateMany(filter, set)).rejects.toBeInstanceOf(
        QueryError,
      );
    }
    expect(await Probe.count()).toBe(5);
    expect(await Probe.count({ count: -1 })).toBe(0);
  });

  test("a real predicate that matches every row still works", async () => {
    const result = await Probe.updateMany(
      { _id: { $exists: true } },
      { $set: { seen: true } },
    );
    expect(result.modifiedCount).toBe(5);
  });
});

describe("updateOne", () => {
  const Rows = defineSchema("orm_update_one_probe", {
    group: { type: "string", required: true },
    state: { type: "string" },
    n: { type: "number", default: 0 },
  });

  beforeAll(async () => {
    await Rows.remove({ _id: { $exists: true } });
    for (const n of [1, 2, 3])
      await Rows.create({ group: "g", state: "new", n });
  });

  afterAll(async () => {
    await Rows.remove({ _id: { $exists: true } });
  });

  test("updates exactly one of several matching rows", async () => {
    const result = await Rows.updateOne({ group: "g" }, { $inc: { n: 100 } });
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    const rows = await Rows.find({ group: "g" });
    expect(rows.filter((row) => row.n > 100)).toHaveLength(1);
    expect(rows.reduce((sum, row) => sum + row.n, 0)).toBe(106);
  });

  test("reports zero when nothing matches or no operator applies", async () => {
    expect(await Rows.updateOne({ group: "none" }, { $set: { n: 9 } })).toEqual(
      { matchedCount: 0, modifiedCount: 0 },
    );
    expect(await Rows.updateOne({ group: "g" }, {})).toEqual({
      matchedCount: 1,
      modifiedCount: 0,
    });
  });

  test("a compare-and-set has exactly one winner under concurrency", async () => {
    const doc = await Rows.create({ group: "cas", state: "old" });
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Rows.updateOne(
          { _id: doc._id, state: "old" },
          { $set: { state: `claimed-${i}` } },
        ),
      ),
    );
    expect(
      attempts.filter((result) => result.modifiedCount === 1),
    ).toHaveLength(1);
  });

  test("$inc treats a stored null as 0 and adds to a numeric string", async () => {
    const doc = await Rows.create({ group: "inc" });
    await Rows.updateOne(
      { _id: doc._id },
      { $set: { text: "5", empty: null } },
    );
    await Rows.updateOne({ _id: doc._id }, { $inc: { text: 1, empty: 2 } });
    const db = await getConnection();
    const { rows } = await db.query(
      `SELECT data->'text' AS text, data->'empty' AS empty FROM orm_update_one_probe WHERE data->>'_id' = $1`,
      [doc._id],
    );
    expect(rows[0]).toEqual({ text: 6, empty: 2 });
  });

  test("a filter with a top-level $or still updates one row", async () => {
    const result = await Rows.updateOne(
      { $or: [{ n: 2 }, { n: 3 }] },
      { $set: { state: "picked" } },
    );
    expect(result.modifiedCount).toBe(1);
    expect(await Rows.count({ state: "picked" })).toBe(1);
  });
});
