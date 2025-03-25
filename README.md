# pg-orm

A minimalist PostgreSQL ORM that embraces JSON document storage with TypeScript.

## Features

**Core**
- Type-safe by design
- Native JSON document storage
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
import { pgorm } from 'pg-orm';

// Define your models
const User = pgorm.defineSchema('users', {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true }
});

const Lobby = pgorm.defineSchema('lobbies', {
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
  _id: string;     // prefixed identifier (e.g., 'user_123')
  ctime: number;   // creation time
  mtime: number;   // last modification
  version: number; // optimistic lock
}
```

### Schemas

Define your data structure with validation:

```typescript
const Product = pgorm.defineSchema('products', {
  name: { 
    type: 'string', 
    required: true,
    validate: (value) => {
      if (value.length < 3) throw new Error('Name too short');
    }
  },
  
  metadata: {
    type: 'object',
    schema: {
      sku: { 
        type: 'string',
        default: async () => `SKU_${Date.now()}`
      },
      version: { type: 'number', default: 1 }
    }
  }
});
```

### Queries

Build type-safe queries naturally:

```typescript
// Simple queries
const product = await Product.findById('product_123');
const products = await Product.find({ name: 'Gaming Mouse' });

// Complex queries
const premiumProducts = await Product
  .where('price', '>', 100)
  .orWhere('category', 'premium')
  .sort('name', 'asc')
  .limit(10)
  .execute();

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

### References

Link and populate related documents:

```typescript
const Game = pgorm.defineSchema('games', {
  name: { type: 'string', required: true },
  creator: { type: 'ref', ref: 'users' },
  players: { 
    type: 'array', 
    of: { type: 'ref', ref: 'users' }
  }
});

const game = await Game.findById(gameId);
await game.populate(['creator', 'players']);
```

### Transactions

Ensure data consistency:

```typescript
await pgorm.transaction(async () => {
  const [user, product] = await Promise.all([
    User.findById(userId),
    Product.findById(productId)
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
