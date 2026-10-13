// Row locks, advisory locks, $min/$setIfNull, locked updateMany claims,
// aggregate(), create({ ifAbsent }), $natural, $text, $ieq, select and
// fail-closed operators, against Postgres. Probe tables only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { advisoryLock, Document, defineSchema, transaction } from "..";
import { getConnection, registeredModels } from "../lib/connection";
import { MongoToPG, QueryError } from "../lib/mongo-converter";

const Probe = defineSchema("orm_ext_probe", {
  label: { type: "string" },
  n: { type: "number" },
  status: { type: "string" },
  attempts: { type: "number" },
  os: { type: "string" },
  ip: { type: "string" },
  amount: { type: "number" },
  at: { type: "number" },
  note: { type: "string" },
  meta: { type: "object" },
});

const Unique = defineSchema("orm_ext_unique", {
  key: { type: "string", required: true },
});

const TEXT_FIELDS = ["title", "metaDescription", "slug", "keywords"];
const Searchable = defineSchema(
  "orm_ext_text",
  {
    title: { type: "string" },
    metaDescription: { type: "string" },
    slug: { type: "string" },
    keywords: { type: "array", of: { type: "string" } },
  },
  { textFields: TEXT_FIELDS },
);

const everything = { _id: { $exists: true } };

// a transaction that holds its locks until release() is called
function holdTransaction(work: () => Promise<unknown>) {
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = transaction(async () => {
    await work();
    ready();
    await held;
  });
  return { acquired, release, done };
}

beforeAll(async () => {
  await Unique.find({});
  const db = await getConnection();
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_orm_ext_unique_key ON orm_ext_unique ((data->>'key'))`,
  );
});

afterAll(async () => {
  await Probe.remove(everything);
  await Unique.remove(everything);
  await Searchable.remove(everything);
});

describe("row locks", () => {
  test("refuse to run outside a transaction", async () => {
    await expect(Probe.find({}, { lock: "update" })).rejects.toThrow(
      "requires a transaction",
    );
    await expect(Probe.find1("probe_x", { lock: "update" })).rejects.toThrow(
      "requires a transaction",
    );
  });

  test("nowait raises while another transaction holds the row", async () => {
    const doc = await Probe.create({ label: "lock-nowait" });
    const holder = holdTransaction(() =>
      Probe.find1(doc._id, { lock: "update" }),
    );
    await holder.acquired;
    try {
      await expect(
        transaction(() => Probe.find1(doc._id, { lock: "nowait" })),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      holder.release();
      await holder.done;
    }
    const again = await transaction(() =>
      Probe.find1(doc._id, { lock: "nowait" }),
    );
    expect(again?._id).toBe(doc._id);
  });

  test("skipLocked passes over rows another transaction holds", async () => {
    const a = await Probe.create({ label: "lock-skip", n: 1 });
    const b = await Probe.create({ label: "lock-skip", n: 2 });
    const holder = holdTransaction(() =>
      Probe.find({ _id: a._id }, { lock: "update" }),
    );
    await holder.acquired;
    try {
      const free = await transaction(() =>
        Probe.find(
          { label: "lock-skip" },
          { lock: "skipLocked", sort: { n: 1 } },
        ),
      );
      expect(free.map((doc) => doc._id)).toEqual([b._id]);
    } finally {
      holder.release();
      await holder.done;
    }
  });

  test("jsonb _id order matches text order, so multi-row lock order is unchanged", async () => {
    const ids = ["user_Zb", "user_a1", "user_B_2", "user_aa", "user_9x"];
    for (const _id of ids) await Probe.create({ _id, label: "lock-order" });
    const viaOrm = await Probe.find(
      { label: "lock-order" },
      { sort: { _id: 1 } },
    );
    const db = await getConnection();
    const { rows } = await db.query(
      `SELECT data->>'_id' AS id FROM orm_ext_probe
       WHERE data->>'label' = 'lock-order' ORDER BY data->>'_id'`,
    );
    expect(viaOrm.map((doc) => doc._id)).toEqual(rows.map((row) => row.id));
  });
});

describe("advisoryLock", () => {
  test("refuses to run outside a transaction", async () => {
    await expect(advisoryLock("orm-ext")).rejects.toThrow(
      "requires a transaction",
    );
  });

  test("shares a key space with a raw hashtextextended lock", async () => {
    const holder = holdTransaction(() => advisoryLock("orm-ext:shared"));
    await holder.acquired;
    try {
      const taken = await transaction(async () => {
        const db = await getConnection();
        const { rows } = await db.query(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok",
          ["orm-ext:shared"],
        );
        return rows[0].ok;
      });
      expect(taken).toBe(false);
    } finally {
      holder.release();
      await holder.done;
    }
  });

  test("serializes transactions on the same key", async () => {
    const order: string[] = [];
    const holder = holdTransaction(async () => {
      await advisoryLock("orm-ext:serial");
      order.push("first");
    });
    await holder.acquired;
    const second = transaction(async () => {
      await advisoryLock("orm-ext:serial");
      order.push("second");
    });
    await Bun.sleep(50);
    expect(order).toEqual(["first"]);
    holder.release();
    await holder.done;
    await second;
    expect(order).toEqual(["first", "second"]);
  });
});

describe("update operators", () => {
  test("$min keeps the smaller number and fills a missing one", async () => {
    // jsonb_set creates only the last path segment, so the parent must exist
    const doc = await Probe.create({ label: "min", at: 5, meta: {} });
    await Probe.updateMany({ _id: doc._id }, { $min: { at: 3 } });
    expect((await Probe.find1(doc._id))?.at).toBe(3);
    await Probe.updateMany({ _id: doc._id }, { $min: { at: 9 } });
    expect((await Probe.find1(doc._id))?.at).toBe(3);
    await Probe.updateMany(
      { _id: doc._id },
      { $min: { "meta.firstAt": 7, n: 4 } },
    );
    const updated = await Probe.find1(doc._id);
    expect(updated?.meta).toEqual({ firstAt: 7 });
    expect(updated?.n).toBe(4);
  });

  test("$setIfNull writes only missing or null values", async () => {
    const doc = await Probe.create({ label: "set-if-null", note: "kept" });
    await Probe.updateMany({ _id: doc._id }, { $set: { status: null } });
    await Probe.updateMany(
      { _id: doc._id },
      { $setIfNull: { note: "replaced", status: "filled", os: "macos" } },
    );
    const updated = await Probe.find1(doc._id);
    expect(updated?.note).toBe("kept");
    expect(updated?.status).toBe("filled");
    expect(updated?.os).toBe("macos");
  });
});

describe("updateMany claims", () => {
  test("sort + limit + skipLocked claims the oldest rows in one statement", async () => {
    for (const n of [3, 1, 4, 2]) {
      await Probe.create({ label: "claim", status: "pending", n });
    }
    const result = await Probe.updateMany(
      { label: "claim", status: "pending" },
      { $set: { status: "processing" }, $inc: { attempts: 1 } },
      { sort: { n: 1 }, limit: 2, lock: "skipLocked", returning: true },
    );
    expect(result.matchedCount).toBe(2);
    expect(result.documents?.map((doc) => doc.n).sort()).toEqual([1, 2]);
    expect(result.documents?.every((doc) => doc.status === "processing")).toBe(
      true,
    );
    expect(result.documents?.every((doc) => doc.attempts === 1)).toBe(true);
    expect(await Probe.count({ label: "claim", status: "pending" })).toBe(2);
  });

  test("a claim skips rows another transaction has locked", async () => {
    const held = await Probe.create({
      label: "claim-held",
      status: "pending",
      n: 1,
    });
    const free = await Probe.create({
      label: "claim-held",
      status: "pending",
      n: 2,
    });
    const holder = holdTransaction(() =>
      Probe.find1(held._id, { lock: "update" }),
    );
    await holder.acquired;
    try {
      const result = await Probe.updateMany(
        { label: "claim-held", status: "pending" },
        { $set: { status: "processing" } },
        { sort: { n: 1 }, limit: 1, lock: "skipLocked", returning: true },
      );
      expect(result.documents?.map((doc) => doc._id)).toEqual([free._id]);
    } finally {
      holder.release();
      await holder.done;
    }
  });

  test("returning without a limit returns every updated row", async () => {
    await Probe.create({ label: "returning", status: "a" });
    await Probe.create({ label: "returning", status: "a" });
    const result = await Probe.updateMany(
      { label: "returning" },
      { $set: { status: "b" } },
      { returning: true },
    );
    expect(result.documents).toHaveLength(2);
    expect(result.documents?.every((doc) => doc.status === "b")).toBe(true);
  });

  test("without options the result has no documents field", async () => {
    await Probe.create({ label: "plain-update" });
    const result = await Probe.updateMany(
      { label: "plain-update" },
      { $set: { status: "x" } },
    );
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
  });
});

describe("$natural sort", () => {
  test("orders by insertion", async () => {
    for (const label of ["natural-c", "natural-a", "natural-b"]) {
      await Probe.create({ label, status: "natural" });
    }
    const asc = await Probe.find(
      { status: "natural" },
      { sort: { $natural: 1 } },
    );
    expect(asc.map((doc) => doc.label)).toEqual([
      "natural-c",
      "natural-a",
      "natural-b",
    ]);
    const desc = await Probe.find(
      { status: "natural" },
      { sort: { $natural: -1 }, limit: 1 },
    );
    expect(desc.map((doc) => doc.label)).toEqual(["natural-b"]);
  });
});

describe("aggregate", () => {
  const day = (iso: string) => Date.parse(iso);

  beforeAll(async () => {
    const rows = [
      {
        os: "macos",
        ip: "1.1.1.1",
        amount: 100,
        _ctime: day("2026-09-01T10:00:00Z"),
      },
      {
        os: "macos",
        ip: "1.1.1.1",
        amount: 50,
        _ctime: day("2026-09-01T11:00:00Z"),
      },
      {
        os: "windows",
        ip: "2.2.2.2",
        amount: 25,
        _ctime: day("2026-09-02T10:00:00Z"),
      },
      { os: "linux", ip: "3.3.3.3", _ctime: day("2026-09-02T12:00:00Z") },
    ];
    for (const row of rows) await Probe.create({ label: "agg", ...row });
  });

  test("single row with filtered columns, numbers out", async () => {
    const [row] = await Probe.aggregate(
      { label: "agg" },
      {
        fields: {
          total: { $count: true },
          mac: { $count: true, where: { os: "macos" } },
          visitors: { $countDistinct: "ip" },
          revenue: { $sum: "amount" },
          nonMacRevenue: { $sum: "amount", where: { os: { $ne: "macos" } } },
          first: { $min: "_ctime" },
          largest: { $max: "amount" },
        },
      },
    );
    expect(row).toEqual({
      total: 4,
      mac: 2,
      visitors: 3,
      revenue: 175,
      nonMacRevenue: 25,
      first: day("2026-09-01T10:00:00Z"),
      largest: 100,
    });
  });

  test("empty input: counts and sums are 0, min and max are null", async () => {
    const [row] = await Probe.aggregate(
      { label: "agg-none" },
      {
        fields: {
          total: { $count: true },
          revenue: { $sum: "amount" },
          first: { $min: "_ctime" },
        },
      },
    );
    expect(row).toEqual({ total: 0, revenue: 0, first: null });
  });

  test("groups by a field with sort and limit", async () => {
    const rows = await Probe.aggregate(
      { label: "agg" },
      {
        by: { os: "os" },
        fields: { events: { $count: true } },
        sort: { events: -1, os: 1 },
        limit: 2,
      },
    );
    expect(rows).toEqual([
      { os: "macos", events: 2 },
      { os: "linux", events: 1 },
    ]);
  });

  test("groups by day", async () => {
    // the day is the session's; pin it so the result is deterministic
    const rows = await transaction(async () => {
      const db = await getConnection();
      await db.query("SET LOCAL TIME ZONE 'UTC'");
      return Probe.aggregate(
        { label: "agg" },
        {
          by: { date: { $day: "_ctime" } },
          fields: { users: { $countDistinct: "ip" } },
          sort: { date: 1 },
        },
      );
    });
    expect(rows).toEqual([
      { date: "2026-09-01", users: 1 },
      { date: "2026-09-02", users: 2 },
    ]);
  });

  test("rejects a sort on a name that is not an output", async () => {
    await expect(
      Probe.aggregate(
        { label: "agg" },
        { fields: { total: { $count: true } }, sort: { os: 1 } },
      ),
    ).rejects.toThrow("not an output");
  });

  test("filter values are parameters, not SQL", async () => {
    const hostile = "x'); DROP TABLE orm_ext_probe; --";
    const [row] = await Probe.aggregate(
      { label: "agg" },
      { fields: { hits: { $count: true, where: { os: hostile } } } },
    );
    expect(row.hits).toBe(0);
    expect(await Probe.count({ label: "agg" })).toBe(4);
  });
});

describe("create ifAbsent", () => {
  test("returns null on a unique conflict without aborting the transaction", async () => {
    await Unique.create({ key: "dup" });
    const result = await transaction(async () => {
      const skipped = await Unique.create({ key: "dup" }, { ifAbsent: true });
      const next = await Unique.create({ key: "after" }, { ifAbsent: true });
      return { skipped, next };
    });
    expect(result.skipped).toBeNull();
    expect(result.next?.key).toBe("after");
    expect(await Unique.count({ key: "dup" })).toBe(1);
    expect(await Unique.count({ key: "after" })).toBe(1);
  });

  test("a plain create still raises the unique violation", async () => {
    await expect(Unique.create({ key: "dup" })).rejects.toMatchObject({
      code: "23505",
    });
  });
});

describe("$text", () => {
  beforeAll(async () => {
    await Searchable.create({
      title: "keyboard remap",
      metaDescription: "remap any keyboard key",
      slug: "keyboard-remap",
      keywords: ["keyboard"],
    });
    await Searchable.create({
      title: "mouse inverter",
      metaDescription: "invert the mouse, keyboard optional",
      slug: "mouse-inverter",
      keywords: ["mouse"],
    });
    await Searchable.create({
      title: "controller deadzone",
      metaDescription: "tune stick drift",
      slug: "deadzone",
      keywords: ["controller"],
    });
  });

  test("matches and ranks by relevance", async () => {
    const results = await Searchable.find(
      { $text: { $search: "keyboard" } },
      { sort: { $textScore: -1 } },
    );
    expect(results.map((doc) => doc.slug)).toEqual([
      "keyboard-remap",
      "mouse-inverter",
    ]);
    expect(await Searchable.count({ $text: { $search: "keyboard" } })).toBe(2);
    expect(await Searchable.count({ $text: { $search: "joystick" } })).toBe(0);
  });

  test("throws instead of matching every row when the schema has no textFields", async () => {
    await expect(Probe.find({ $text: { $search: "x" } })).rejects.toThrow(
      "textFields",
    );
    await expect(Probe.find({}, { sort: { $textScore: -1 } })).rejects.toThrow(
      "$text filter",
    );
  });
});

describe("fail closed", () => {
  test("an unknown filter operator throws a 400 QueryError", async () => {
    const attempt = Probe.find({ label: { $bogus: 1 } });
    await expect(attempt).rejects.toBeInstanceOf(QueryError);
    await expect(attempt).rejects.toMatchObject({ status: 400 });
    await expect(Probe.find({ $bogus: [] })).rejects.toThrow(
      "unsupported operator",
    );
    await expect(Probe.find({ $and: { label: "x" } })).rejects.toThrow(
      "$and requires an array",
    );
  });

  test("an unknown update operator or a non-number increment throws, writing nothing", async () => {
    const doc = await Probe.create({ label: "fail-closed", n: 1 });
    await expect(
      Probe.updateMany({ label: "fail-closed" }, { $push: { n: 2 } }),
    ).rejects.toThrow("unsupported update operator");
    await expect(
      Probe.updateMany({ label: "fail-closed" }, { $inc: { n: "2" } }),
    ).rejects.toThrow("must be a number");
    expect((await Probe.find1(doc._id))?.n).toBe(1);
  });

  test("$regex with $options still works", async () => {
    await Probe.create({ label: "Regex-Options" });
    const found = await Probe.find({
      label: { $regex: "^regex-opt", $options: "i" },
    });
    expect(found.map((row) => row.label)).toEqual(["Regex-Options"]);
  });
});

describe("$ieq", () => {
  test("matches regardless of case, strings only", async () => {
    await Probe.create({ label: "ieq", ip: "Mixed@Case.Example" });
    const found = await Probe.find({ ip: { $ieq: "mixed@case.example" } });
    expect(found.map((row) => row.ip)).toEqual(["Mixed@Case.Example"]);
    await expect(Probe.find({ ip: { $ieq: 1 } })).rejects.toThrow(
      "$ieq requires a string",
    );
  });

  test("uses an index on lower(data->>'field')", async () => {
    const plan = await transaction(async () => {
      const db = await getConnection();
      await db.query(
        `CREATE INDEX IF NOT EXISTS idx_orm_ext_probe_ip_lower ON orm_ext_probe ((lower(data->>'ip')))`,
      );
      await db.query("SET LOCAL enable_seqscan = off");
      const { sql, params } = new MongoToPG().buildSelectQueryAndParams(
        "orm_ext_probe",
        { ip: { $ieq: "x@y.z" } },
      );
      const { rows } = await db.query(`EXPLAIN ${sql}`, params);
      return rows.map((row: any) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("idx_orm_ext_probe_ip_lower");
  });
});

describe("select", () => {
  test("returns plain objects with only the named fields", async () => {
    const doc = await Probe.create({
      label: "select",
      note: "long body",
      os: "linux",
    });
    const [row] = await Probe.find(
      { _id: doc._id },
      { select: ["_id", "os", "status"] },
    );
    expect(row).toEqual({ _id: doc._id, os: "linux", status: null });
    expect(row).not.toBeInstanceOf(Document);
    const one = await Probe.findOne({ _id: doc._id }, { select: ["label"] });
    expect(one).toEqual({ label: "select" });
  });

  test("rejects nested paths, more than 50 fields, and a lock", async () => {
    await expect(Probe.find({}, { select: ["meta.firstAt"] })).rejects.toThrow(
      "top-level",
    );
    const many = Array.from({ length: 51 }, (_, i) => `f${i}`);
    await expect(Probe.find({}, { select: many })).rejects.toThrow(
      "at most 50 fields",
    );
    await expect(
      transaction(() => Probe.find({}, { select: ["_id"], lock: "update" })),
    ).rejects.toThrow("select cannot be combined with lock");
  });
});

describe("$bytes", () => {
  test("sums the stored document size", async () => {
    await Probe.create({ label: "bytes", note: "a".repeat(100) });
    await Probe.create({ label: "bytes", note: "b".repeat(200) });
    const [row] = await Probe.aggregate(
      { label: "bytes" },
      {
        fields: {
          bytes: { $bytes: true },
          none: { $bytes: true, where: { label: "x" } },
        },
      },
    );
    const db = await getConnection();
    const { rows } = await db.query(
      `SELECT sum(octet_length(data::text))::int AS bytes FROM orm_ext_probe WHERE data->>'label' = 'bytes'`,
    );
    expect(row).toEqual({ bytes: rows[0].bytes, none: 0 });
  });
});

describe("registeredModels", () => {
  test("maps each table to its model", () => {
    const models = new Map(registeredModels());
    expect(models.get("orm_ext_probe")).toBe(Probe);
    expect(Object.keys(models.get("orm_ext_probe")!.schema)).toContain("label");
  });
});
