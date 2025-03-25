# pg-orm

A lightweight, type-safe PostgreSQL ORM with support for JSON document storage, relationships, and advanced querying.

## Features

- 🎯 **Type-safe**: Full TypeScript support with type inference
- 🔄 **JSON Document Storage**: Store complex objects natively in PostgreSQL
- 🔗 **Relationships**: Reference and populate related documents
- 🔍 **Rich Querying**: Flexible query builder with sorting and pagination
- 🔒 **Transactions**: ACID-compliant transaction support
- ✨ **Events**: Subscribe to document changes
- 🔐 **Optimistic Locking**: Prevent concurrent modifications
- ✅ **Validation**: Field-level validation with async support
- 🎭 **Default Values**: Support for both static and async defaults
- 🔍 **Smart IDs**: Auto-generated, prefixed IDs for better debugging
- ⏰ **Timestamps**: Automatic creation and modification times
- 🎨 **Pretty Printing**: Beautiful console output for documents

## Installation

```bash
# Using bun
bun add pg-orm

# Using npm
npm install pg-orm

# Using yarn
yarn add pg-orm
```

## Quick Start

```typescript
import { pgorm } from 'pg-orm';

// Define schemas
const User = pgorm.defineSchema('users', {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true },
  wallet: { type: 'number', default: 0 }
});

const Lobby = pgorm.defineSchema('lobbies', {
  name: { type: 'string', required: true },
  customerId: { type: 'ref', ref: 'users', required: true },
  maxPlayers: { type: 'number', default: 4 }
});

// Create and query documents
async function main() {
  // Create a user
  const user = await User.create({
    name: 'John Doe',
    email: 'john@example.com'
  });

  // Create a lobby with transaction
  const lobby = await pgorm.transaction(async () => {
    const newLobby = await Lobby.create({
      name: 'Game Room 1',
      customerId: user._id
    });
    
    await newLobby.populate('customerId');
    return newLobby;
  });

  console.log(lobby);
}
```

## Detailed Features

### Schema Definition

```typescript
const Product = pgorm.defineSchema('products', {
  // Basic fields with validation
  name: { 
    type: 'string', 
    required: true,
    validate: (value) => {
      if (value.length < 3) throw new Error('Name too short');
    }
  },
  
  // Async default values
  sku: { 
    type: 'string',
    default: async () => {
      const timestamp = Date.now();
      return `SKU_${timestamp}`;
    }
  },
  
  // Nested objects
  metadata: {
    type: 'object',
    schema: {
      createdBy: { type: 'string', default: 'system' },
      version: { type: 'number', default: 1 }
    }
  },
  
  // Array of references
  tags: {
    type: 'array',
    of: { type: 'ref', ref: 'tags' }
  }
});
```

### CRUD Operations

```typescript
// Create
const product = await Product.create({
  name: 'Gaming Mouse',
  metadata: { createdBy: 'admin' }
});

// Read
const found = await Product.findById(product._id);
const products = await Product.find({ name: 'Gaming Mouse' });

// Update
product.name = 'Pro Gaming Mouse';
await product.save();

// Delete
await product.remove();
```

### Query Building

```typescript
// Complex queries
const products = await Product
  .where('price', '>', 100)
  .orWhere('category', 'premium')
  .sort('name', 'asc')
  .limit(10)
  .offset(20)
  .execute();

// Count results
const count = await Product
  .where('price', '>', 100)
  .count();

// Raw SQL queries
const results = await Product.query(`
  SELECT p.data, c.data as category 
  FROM products p 
  JOIN categories c ON c.data->>'_id' = p.data->>'categoryId'
  WHERE p.data->>'price' > $1
`, ['100']);
```

### Relationships and Population

```typescript
const Game = pgorm.defineSchema('games', {
  name: { type: 'string', required: true },
  creator: { type: 'ref', ref: 'users' },
  players: { 
    type: 'array', 
    of: { type: 'ref', ref: 'users' }
  },
  chat: {
    type: 'array',
    of: {
      type: 'object',
      schema: {
        userId: { type: 'ref', ref: 'users' },
        message: { type: 'string' },
        timestamp: { type: 'number', default: () => Date.now() }
      }
    }
  }
});

// Populate single reference
const game = await Game.findById(gameId);
await game.populate('creator');

// Populate multiple references
await game.populate(['creator', 'players']);

// Populate nested references
await game.populate(['creator', 'players', 'chat.userId']);
```

### Transactions

```typescript
const result = await pgorm.transaction(async () => {
  const user = await User.findById(userId);
  const product = await Product.findById(productId);
  
  user.wallet -= product.price;
  product.stock -= 1;
  
  await user.save();
  await product.save();
  
  return { user, product };
});
```

### Event System

```typescript
// Subscribe to model events
pgorm.events.on('products:created', (product) => {
  console.log('New product created:', product);
});

pgorm.events.on('products:updated', (product) => {
  console.log('Product updated:', product);
});

pgorm.events.on('products:removed', (product) => {
  console.log('Product removed:', product);
});
```

### Optimistic Locking

Prevents concurrent modifications to the same document. Each document has a version number that increments on every save:

```typescript
// Two different parts of your code load the same user
const userInTab1 = await User.findById('user_123');    // version = 1
const userInTab2 = await User.findById('user_123');    // version = 1

// Tab 1 makes changes and saves
userInTab1.wallet += 100;
await userInTab1.save();   // success: version -> 2

// Tab 2 tries to save its changes, but the version has changed
userInTab2.wallet -= 50;
try {
  await userInTab2.save();  // fails: expected version 1, but found 2
} catch (err) {
  if (err instanceof pgorm.errors.OptimisticLockError) {
    // Handle the conflict - typically by:
    // 1. Reload the latest document
    // 2. Re-apply the changes
    // 3. Save again
    const freshUser = await User.findById('user_123');  // version = 2
    freshUser.wallet -= 50;
    await freshUser.save();  // success: version -> 3
  }
}
```

This is useful in scenarios like:
- Multiple browser tabs editing the same document
- Multiple server processes handling concurrent requests
- Race conditions in distributed systems

## Environment Variables

```bash
# PostgreSQL connection settings
PGHOST=localhost
PGPORT=5432
PGDATABASE=myapp
PGUSER=postgres
PGPASSWORD=secret

# Optional connection pool settings
PG_POOL_MAX=20
PG_POOL_IDLE_TIMEOUT=30000
PG_POOL_CONNECTION_TIMEOUT=5000
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Core Concepts

### Document Lifecycle

Every document automatically gets:

```typescript
{
  _id: string;        // auto-generated, prefixed (e.g., 'user_123')
  ctime: number;      // creation timestamp
  mtime: number;      // last modification timestamp
  version: number;    // optimistic locking version
}
```

### Smart ID Generation

IDs are automatically generated with meaningful prefixes:

```typescript
const user = await User.create({ name: 'John' });
console.log(user._id);  // 'user_Ax7Hy9...'

const lobby = await Lobby.create({ name: 'Game 1' });
console.log(lobby._id); // 'lobby_Bk9Lm2...'
```

The prefix is intelligently derived from the collection name:
- Handles plural forms (lobbies → lobby)
- Supports irregular plurals (people → person)
- Always lowercase for consistency

### Query Operators

The query builder supports various operators:

```typescript
// Equality
const docs = await Model.where('field', value);           // field = value
const docs = await Model.where('field', '=', value);      // same as above

// Numeric comparisons
const docs = await Model.where('price', '>', 100);        // price > 100
const docs = await Model.where('stock', '<', 50);         // stock < 50

// Text search
const docs = await Model.where('name', 'contains', 'john'); // LIKE %john%

// Logical OR
const docs = await Model
  .where('status', 'active')
  .orWhere('role', 'admin')
  .execute();
```

### Raw Queries with Type Safety

Execute raw SQL queries while maintaining type safety:

```typescript
interface CategoryStats {
  name: string;
  productCount: number;
  totalRevenue: number;
}

const stats = await Product.query<CategoryStats>(`
  SELECT 
    c.data->>'name' as name,
    COUNT(*) as "productCount",
    SUM((p.data->>'price')::numeric) as "totalRevenue"
  FROM products p
  JOIN categories c ON c.data->>'_id' = p.data->>'categoryId'
  GROUP BY c.data->>'name'
`, [], { raw: true });

// stats is typed as CategoryStats[]
```

### Document Methods

Every document instance has helpful methods:

```typescript
const doc = await Model.findById('123');

// Convert to plain object
const plain = doc.toJSON();

// Check if a reference is populated
if (doc.isPopulated('creator')) {
  console.log(doc.creator.name);
}

// Save with validation
try {
  await doc.save();
} catch (err) {
  console.log(err.errors);  // validation errors array
}
```
