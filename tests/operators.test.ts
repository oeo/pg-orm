// Operators checked against Postgres rather than against expected SQL text:
// numeric sort order and the comparison operands that are bound as parameters.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema } from "../lib";

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
    { label: "b", count: 80, tags: ["x", "y"] },
    { label: "c", count: 100, tags: ["y"] },
    { label: "d", count: 5, tags: [] },
    { label: "e", count: 1000, tags: ["x", "y", "z"] },
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

  test("a quote in a dotted key keeps its parent path", async () => {
    expect(labels(await Probe.find({ "meta.o'k": "x" }))).toEqual(["a"]);
  });
});
