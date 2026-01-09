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
bun add pg-orm
```

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
  _ctime: number;     // creation time
  _mtime: number;     // last modification
  _vers: number;      // optimistic lock version
  _deletedAt?: number // soft delete timestamp (optional)
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

### Events

React to changes:

```typescript
pgorm.events.on('products:created', (product) => {
  console.log('New product:', product.name);
});
```

## Environment

```bash
# Required
PGHOST=localhost
PGPORT=5432
PGDATABASE=myapp
PGUSER=postgres
PGPASSWORD=secret

# Optional
PG_POOL_MAX=20
PG_POOL_IDLE_TIMEOUT=30000
PG_POOL_CONNECTION_TIMEOUT=5000
```

## License

MIT
