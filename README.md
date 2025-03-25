# pg-orm

A zen-like PostgreSQL ORM focused on simplicity, type safety, and developer experience.

## Philosophy

- **Simplicity**: Each feature serves a clear purpose with minimal complexity
- **Type Safety**: Full TypeScript support with automatic type inference
- **Developer Experience**: Intuitive API that follows the principle of least surprise
- **Flexibility**: Powerful features without sacrificing simplicity

## Installation

```bash
bun add pg-orm
```

## Quick Start

```typescript
import { defineSchema } from 'pg-orm';

// define your schema
const User = defineSchema('users', {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true },
  wallet: { type: 'number', default: 0 }
});

// create a user
const user = await User.create({
  name: 'John Doe',
  email: 'john@example.com'
});

// find users
const users = await User.find({ 
  name: 'John Doe' 
});

// query builder with sorting and pagination
const richUsers = await User
  .where('wallet', '>', 1000)
  .sort('name', 'asc')
  .limit(10)
  .offset(0)
  .execute();
```

## Schema Definition

Define your models with type inference:

```typescript
const Lobby = defineSchema('lobbies', {
  // basic types
  name: { type: 'string', required: true },
  status: { type: 'string', default: 'PENDING' },
  balance: { type: 'number', default: 0 },
  
  // references
  customerId: { type: 'ref', ref: 'users', required: true },
  
  // arrays
  pros: { 
    type: 'array', 
    of: { type: 'ref', ref: 'users' }, 
    default: [] 
  },
  
  // nested objects
  chat: {
    type: 'array',
    of: {
      type: 'object',
      schema: {
        type: { type: 'string' },
        userId: { type: 'ref', ref: 'users' },
        content: { type: 'string' }
      }
    },
    default: []
  }
});
```

## Core Operations

### Create

```typescript
const user = await User.create({
  name: 'John',
  email: 'john@example.com'
});
```

### Find

```typescript
// find by id
const user = await User.findById('user_123');

// find one
const user = await User.findOne({ email: 'john@example.com' });

// find many
const users = await User.find({ 
  name: 'John',
}, {
  sort: { wallet: 'desc' },
  limit: 10,
  offset: 0
});

// count documents
const total = await User.count();
const richUsers = await User.count({ wallet: { gt: 1000 }});
```

### Query Builder

```typescript
const users = await User
  .where('wallet', '>', 1000)
  .where('name', 'contains', 'John')
  .sort('wallet', 'desc')
  .limit(10)
  .offset(0)
  .execute();

// count with query builder
const count = await User
  .where('wallet', '>', 1000)
  .where('status', 'active')
  .count();
```

### Update

```typescript
const user = await User.findById('user_123');
user.wallet = 100;
await user.save();
```

### Remove

```typescript
// remove one document
const user = await User.findById('user_123');
await user.remove();

// remove many documents
await User.remove({ status: 'inactive' });
```

### Population

```typescript
const lobby = await Lobby.findById('lobby_123');
await lobby.populate('customerId');  // single field
await lobby.populate(['customerId', 'pros']);  // multiple fields
await lobby.populate(['chat.userId']);  // nested fields
```

### Transactions

```typescript
await transaction(async () => {
  user.wallet -= 100;
  lobby.balance += 100;
  
  await user.save();
  await lobby.save();
});
```

## Events

The ORM emits events for document operations:

- `{model}:created`
- `{model}:updated`
- `{model}:removed`

## Type Safety

Types are automatically inferred from your schema:

```typescript
type User = ReturnType<typeof User.create> extends Promise<infer T> ? T : never;
```

## Best Practices

1. **Define Schemas First**: Start with clear schema definitions
2. **Use TypeScript**: Let the type system guide you
3. **Handle Errors**: Always check for null on findOne/findById
4. **Use Transactions**: When modifying multiple documents
5. **Clean Up**: Remove documents when they're no longer needed

## License

MIT
