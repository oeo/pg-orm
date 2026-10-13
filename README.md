[![Tests](https://img.shields.io/github/actions/workflow/status/oeo/pg-orm/test.yml?branch=master&style=for-the-badge)](https://github.com/oeo/pg-orm/actions/workflows/test.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Built with Bun](https://img.shields.io/badge/Built%20with%20Bun-000?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh)

# pg-orm

A minimalist PostgreSQL ORM that embraces JSON document storage with TypeScript.

## Features

**Core**
- Type-safe by design
- Native JSON document storage
- Automatic database and table creation
- Automatic schema validation
- Intelligent query building

**Data Integrity**
- ACID-compliant transactions
- Optimistic locking
- Field-level validation
- Automatic timestamps

**Developer Experience**
- Intuitive document references
- Smart ID generation
- Rich type inference
- Beautiful console output

## Installation

```bash
bun add github:oeo/pg-orm
```

Install from GitHub. The `pg-orm` name on npm belongs to an unrelated
package. The library ships as TypeScript source and is run with Bun.

## Quick Start

```typescript
import { defineSchema } from 'pg-orm';

// Define your models
const User = defineSchema('users', {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true }
});

const Lobby = defineSchema('lobbies', {
  name: { type: 'string', required: true },
  host: { type: 'ref', ref: 'users', required: true }
});

// Use them naturally
async function createGame(hostName: string, lobbyName: string) {
  const host = await User.create({ 
    name: hostName,
    email: `${hostName.toLowerCase()}@example.com` 
  });

  const lobby = await Lobby.create({
    name: lobbyName,
    host: host._id
  });

  await lobby.populate('host');
  return lobby;
}
```

## Core Concepts

### Documents

Every document is a plain object with automatic fields:

```typescript
{
  _id: string;        // prefixed identifier (e.g., 'user_123')
  _ctime: number;     // creation time, milliseconds since the epoch
  _mtime: number;     // last modification, milliseconds since the epoch
  _vers: number;      // optimistic lock version
  _deletedAt?: number // soft delete time in milliseconds (optional)
}
```

### Schemas

Define your data structure with validation and options:

```typescript
const Product = defineSchema('products', {
  name: { 
    type: 'string', 
    required: true,
    validate: (value) => {
      if (value.length < 3) throw new Error('Name too short');
    }
  }
}, {
  softDelete: true, // Enable soft deletes
  hooks: {
    preSave: function() { console.log('Saving...'); },
    postSave: function() { console.log('Saved!'); }
  }
});
```

### Queries

Build type-safe queries naturally:

```typescript
// Simple queries
const product = await Product.find1('product_123');
const products = await Product.find({ name: 'Gaming Mouse' });

// Find including soft-deleted items
const allProducts = await Product.find({}, { includeDeleted: true });

// Raw queries with type safety
interface Stats {
  category: string;
  revenue: number;
}

const stats = await Product.query<Stats>(`
  SELECT 
    data->>'category' as category,
    SUM((data->>'price')::numeric) as revenue
  FROM products 
  GROUP BY data->>'category'
`, [], { raw: true });
```

### Lifecycle Hooks

React to document events at every stage:

```typescript
const User = defineSchema('users', schema, {
  hooks: {
    preSave: async function() {
      if (this.isNew()) {
        this.history = ['Created'];
      }
    },
    postSave: async function() {
      console.log('User saved:', this._id);
    },
    preRemove: async function() {
      await cleanupUserData(this._id);
    }
  }
});
```

### Soft Deletes

Safely "delete" data without losing it:

```typescript
const Post = defineSchema('posts', schema, { softDelete: true });

const post = await Post.find1(id);
await post.remove(); // Sets _deletedAt, record stays in DB

// Regular queries filter out deleted items automatically
const activePosts = await Post.find({}); 

// Force include deleted items
const allPosts = await Post.find({}, { includeDeleted: true });
```

### Transactions

Ensure data consistency with automatic context propagation:

```typescript
import { transaction } from 'pg-orm';

await transaction(async () => {
  // All operations inside this callback share the same transaction
  // automatically via AsyncLocalStorage
  const [user, product] = await Promise.all([
    User.find1(userId),
    Product.find1(productId)
  ]);
  
  user.wallet -= product.price;
  product.stock -= 1;
  
  await Promise.all([
    user.save(),
    product.save()
  ]);
});
```

A nested `transaction()` joins the outer one; there are no savepoints.
`inTransaction()` reports whether one is active, and
`withoutTransaction(callback)` runs work outside it, for example a
fire-and-forget task started from a hook.

### Events

React to changes:

```typescript
import { pgorm } from 'pg-orm';

pgorm.events.on('products:created', (product) => {
  console.log('New product:', product.name);
});
```

Events are delivered after the surrounding transaction commits, and never
for one that rolls back. The listener receives a detached copy of the
document. Use `afterCommit(callback)` to defer your own work the same way.

### Row Locks

Inside a transaction, `find`, `findOne`, and `find1` can lock the rows they
read. Outside a transaction they throw, because the lock would be released
at once.

```typescript
import { transaction, advisoryLock } from 'pg-orm';

await transaction(async () => {
  const user = await User.find1(userId, { lock: 'update' });
  // 'nowait' raises instead of waiting, 'skipLocked' skips held rows

  await advisoryLock(`payout:${userId}`); // serialize on any string key
});
```

### Bulk Updates and Queue Claims

`updateOne` and `updateMany` accept `$set`, `$inc`, `$min`, and
`$setIfNull`. They skip hooks and events, and do not change `_vers` or
`_mtime`. On a soft-delete schema they also update soft-deleted rows.
`updateOne` updates one row the filter matches; `updateMany` updates all of
them. When another writer changes the chosen row so it no longer matches,
`updateOne` reports `modifiedCount: 0` even if other rows still match, so
claim queued work with `updateMany` and `lock: 'skipLocked'` as below.

With `sort`, `limit`, or `lock`, `updateMany` updates only the selected rows
in one statement:

```typescript
const { documents } = await Job.updateMany(
  { status: 'pending' },
  { $set: { status: 'processing' }, $inc: { attempts: 1 } },
  { sort: { _ctime: 1 }, limit: 50, lock: 'skipLocked', returning: true }
);
```

### Aggregates

```typescript
const rows = await Order.aggregate(
  { status: 'paid' },
  {
    by: { day: { $day: '_ctime' } },
    fields: {
      orders: { $count: true },
      buyers: { $countDistinct: 'userId' },
      revenue: { $sum: 'amount' },
      refunds: { $count: true, where: { refunded: true } }
    },
    sort: { day: 1 }
  }
);
```

Fields support `$count`, `$countDistinct`, `$sum`, `$min`, `$max`, and
`$bytes`. `$day` groups a millisecond timestamp by date in the database
session's time zone.

### More Query Options

```typescript
// plain objects holding only the named top-level fields
await User.find({}, { select: ['_id', 'email'] });

// case-insensitive equality; an index on lower(data->>'email') serves it
await User.findOne({ email: { $ieq: 'Ada@Example.com' } });

// insertion order
await User.find({}, { sort: { $natural: -1 } });

// insert unless a unique index rejects the row; returns null if it does
await User.create({ name, email }, { ifAbsent: true });
```

Full-text search needs `textFields` on the schema:

```typescript
const Article = defineSchema('articles', schema, {
  textFields: ['title', 'body']
});

await Article.find(
  { $text: { $search: 'postgres json' } },
  { sort: { $textScore: -1 } }
);
```

The search compiles to
`to_tsvector('english', coalesce(data->>'title', '') || ' ' || coalesce(data->>'body', ''))`.
Create a GIN index on that exact expression to serve it.

## Behavior Changes

These differ from earlier versions:

- Unknown filter and update operators, a non-array `$and`/`$or`/`$nor`,
  and a non-number `$inc` throw `QueryError` (`status` 400). They used to
  be logged and then dropped or replaced by a constant, which could widen
  an update or delete. `$where` already threw and now throws `QueryError`.
- Filter operands are bound as parameters instead of written into the SQL
  text, and quotes in filter, sort, and update keys are escaped.
- `$text` throws without `textFields`. It used to match every row.
- Malformed operands throw `QueryError` instead of compiling to a constant:
  a non-array `$in`, `$nin`, or `$all`, a bad `$mod`, `$size`, `$type`,
  `$elemMatch`, `$not`, or `$exists`, `$options` without `$regex`, and an
  empty `$and`, `$or`, or `$nor` array. `$all: []` matches nothing.
- `remove`, `updateOne`, and `updateMany` refuse a filter that selects every
  row by construction, such as `{ $and: [{}] }` or `{ f: { $nin: [] } }`.
  Pass a real predicate, for example `{ _id: { $exists: true } }`.
- `limit` and `offset` must be non-negative integers; `0` means none.
- An `$elemMatch` that holds only operators, such as
  `{ scores: { $elemMatch: { $gte: 95 } } }`, applies every operator to each
  element. `$eq: null` matches only arrays that contain null; it used to
  match every non-empty array. `$exists`, `$type`, `$size`, and a nested
  `$elemMatch` now work there.
- `updateOne` updates one row. It used to update every row the filter
  matched. With no valid update operator its `matchedCount` is 0 or 1.
- `$inc` on an array index, such as `{ $inc: { "scores.0": 5 } }`, adds to
  the element. It used to replace it with the increment. `$inc` also treats
  a stored JSON null as 0 and adds to a stored numeric string such as `"5"`.
  The string used to raise a cast error, and so did the null before
  PostgreSQL 18.
- An update key that contains `$` followed by digits, such as `a$10b`, is
  written as given. It used to be written under a shifted number.
- Sorting compares JSON values, so numbers order numerically, and documents
  missing the field sort last. It used to compare their text.
- Events fire after commit with a detached copy of the document. Listeners
  run outside the transaction, and an error a listener throws is logged
  instead of rejecting `save()` or `remove()`.
- A failure inside a nested `transaction()` rolls back the outer one even
  if the caller catches the error. A transaction that Postgres aborted
  throws at commit even if the callback swallowed the error.
- Document data must be structured-cloneable: a function-valued property
  throws `DataCloneError`.
- `create()` ignores a supplied `_vers`, so it always inserts.
- `isModified(path)` also reports a field assigned directly since load.
- The library no longer logs on connect or when it creates the database.

## Environment

The connection reads the standard Postgres variables. Each has a default:

```bash
PGHOST=localhost      # default localhost
PGPORT=5432           # default 5432
PGDATABASE=myapp      # default postgres
PGUSER=postgres       # default: your OS user
PGPASSWORD=secret     # default: none
```

The database is created if it does not exist, and each schema's table is
created on first use. The pool is fixed at 20 connections, a 30 second idle
timeout, and a 5 second connection timeout; no environment variable changes
it.

## License

MIT
