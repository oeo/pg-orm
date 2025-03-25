import { expect, test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { defineSchema } from './schema';
import { transaction, ensureDatabase } from './connection';
import { OptimisticLockError } from './document';

// test models
const User = defineSchema('users', {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true },
  wallet: { type: 'number', default: 0 },
  version: { type: 'number', default: 1 }
});

const Lobby = defineSchema('lobbies', {
  customerId: { type: 'ref', ref: 'users', required: true },
  status: { type: 'string', default: 'PENDING' },
  sku: { type: 'string', required: true },
  pros: { type: 'array', of: { type: 'ref', ref: 'users' }, default: [] },
  balance: { type: 'number', default: 0 },
  startTime: { type: 'number' },
  endTime: { type: 'number' },
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

// Add a new model with custom validation
const Game = defineSchema('games', {
  name: { type: 'string', required: true },
  status: { 
    type: 'string', 
    required: true,
    default: 'draft',
    validate(value: string) {
      const allowedStatuses = ['draft', 'published', 'archived'];
      if (!allowedStatuses.includes(value)) {
        throw new Error(`Status must be one of: ${allowedStatuses.join(', ')}`);
      }
      
      // can access other fields using 'this'
      if (value === 'published' && !this.isReady) {
        throw new Error('Cannot publish game that is not ready');
      }
    }
  },
  isReady: { type: 'boolean', default: false },
  price: { 
    type: 'number',
    validate: async function(value: number) {
      if (value < 0) {
        throw new Error('Price cannot be negative');
      }
      
      // demonstrate async validation
      await new Promise(resolve => setTimeout(resolve, 10));
      
      if (this.status === 'published' && value === 0) {
        throw new Error('Published games must have a price');
      }
    }
  }
});

// Add a model with async defaults
const Product = defineSchema('products', {
  name: { type: 'string', required: true },
  sku: { 
    type: 'string', 
    default: async () => {
      const timestamp = Date.now();
      return `SKU_${timestamp}`;
    }
  },
  price: { type: 'number', default: 0 },
  lastUpdated: { 
    type: 'number', 
    default: () => Date.now() 
  },
  metadata: {
    type: 'object',
    schema: {
      createdBy: { type: 'string', default: 'system' },
      version: { 
        type: 'number', 
        default: async () => 1 
      }
    }
  }
});

describe('PostgreSQL ORM', () => {
  let testUser: any;
  let testLobby: any;

  // clean up before each test
  beforeEach(async () => {
    const db = await ensureDatabase();
    await db.query('DELETE FROM users');
    await db.query('DELETE FROM lobbies');
  });

  // clean up after all tests
  afterAll(async () => {
    const db = await ensureDatabase();
    await db.query('DELETE FROM users');
    await db.query('DELETE FROM lobbies');
  });

  test('should create a user', async () => {
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    expect(testUser._id).toBeDefined();
    expect(testUser.name).toBe('Test User');
    expect(testUser.email).toBe('test@example.com');
    expect(testUser.wallet).toBe(0);  // default value
    expect(testUser.ctime).toBeDefined();
    expect(testUser.mtime).toBeDefined();
  });

  test('should find a user by id', async () => {
    // create test user first
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    const found = await User.findById(testUser._id);
    expect(found).toBeDefined();
    expect(found?._id).toBe(testUser._id);
    expect(found?.name).toBe(testUser.name);
  });

  test('should create a lobby with reference', async () => {
    // create test user first
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    testLobby = await Lobby.create({
      customerId: testUser._id,
      sku: 'test_game'
    });

    expect(testLobby._id).toBeDefined();
    expect(testLobby.customerId).toBe(testUser._id);
    expect(testLobby.status).toBe('PENDING');  // default value
    expect(testLobby.sku).toBe('test_game');
    expect(testLobby.pros).toEqual([]);  // default value
    expect(testLobby.balance).toBe(0);  // default value
  });

  test('should populate referenced fields', async () => {
    // create test data first
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    testLobby = await Lobby.create({
      customerId: testUser._id,
      sku: 'test_game'
    });

    const lobby = await Lobby.findById(testLobby._id);
    expect(lobby).toBeDefined();
    
    await lobby?.populate('customerId');
    expect(lobby?.customerId._id).toBe(testUser._id);
    expect(lobby?.customerId.name).toBe(testUser.name);
  });

  test('should handle array operations', async () => {
    // create test data first
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    testLobby = await Lobby.create({
      customerId: testUser._id,
      sku: 'test_game'
    });

    const pro = await User.create({
      name: 'Pro Player',
      email: 'pro@example.com'
    });

    if (!testLobby.pros) testLobby.pros = [];
    testLobby.pros.push(pro._id);
    await testLobby.save();

    expect(testLobby.pros).toContain(pro._id);

    await testLobby.populate('pros');
    expect(testLobby.pros[0]._id).toBe(pro._id);
    expect(testLobby.pros[0].name).toBe('Pro Player');
  });

  test('should handle transactions', async () => {
    // create test data first
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    testLobby = await Lobby.create({
      customerId: testUser._id,
      sku: 'test_game'
    });

    await transaction(async () => {
      testUser.wallet = 100;
      testLobby.balance = 50;

      await testUser.save();
      await testLobby.save();
    });

    const user = await User.findById(testUser._id);
    const lobby = await Lobby.findById(testLobby._id);

    expect(user?.wallet).toBe(100);
    expect(lobby?.balance).toBe(50);
  });

  test('should handle query builder', async () => {
    // create test data first
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    testLobby = await Lobby.create({
      customerId: testUser._id,
      sku: 'test_game',
      balance: 50
    });

    const lobbies = await Lobby
      .where('status', 'PENDING')
      .where('balance', '=', 50)
      .execute();

    expect(lobbies).toHaveLength(1);
    expect(lobbies[0]._id).toBe(testLobby._id);
  });

  test('should validate required fields', async () => {
    let error: Error | null = null;
    try {
      await User.create({
        email: 'missing.name@example.com'
      });
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('name is required');
  });

  test('should handle chat messages', async () => {
    // create test data first
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    testLobby = await Lobby.create({
      customerId: testUser._id,
      sku: 'test_game'
    });

    if (!testLobby.chat) testLobby.chat = [];
    testLobby.chat.push({
      type: 'USER',
      content: 'Hello!',
      userId: testUser._id
    });
    await testLobby.save();

    const lobby = await Lobby.findById(testLobby._id);
    await lobby?.populate(['customerId', 'chat.userId']);

    expect(lobby?.chat).toHaveLength(1);
    expect(lobby?.chat[0].type).toBe('USER');
    expect(lobby?.chat[0].content).toBe('Hello!');
    expect(lobby?.chat[0].userId._id).toBe(testUser._id);
  });

  test('should handle document removal', async () => {
    // create test data first
    const user1 = await User.create({
      name: 'User 1',
      email: 'user1@example.com'
    });

    const user2 = await User.create({
      name: 'User 2',
      email: 'user2@example.com'
    });

    // test instance remove
    await user1.remove();
    const foundUser1 = await User.findById(user1._id);
    expect(foundUser1).toBeNull();

    // test static remove
    await User.remove({ name: 'User 2' });
    const foundUser2 = await User.findById(user2._id);
    expect(foundUser2).toBeNull();
  });

  test('should handle sorting and pagination', async () => {
    // create test users with different wallet amounts
    const users = await Promise.all([
      User.create({ name: 'User A', email: 'a@example.com', wallet: 100 }),
      User.create({ name: 'User B', email: 'b@example.com', wallet: 200 }),
      User.create({ name: 'User C', email: 'c@example.com', wallet: 300 }),
      User.create({ name: 'User D', email: 'd@example.com', wallet: 400 }),
      User.create({ name: 'User E', email: 'e@example.com', wallet: 500 })
    ]);

    // test sorting
    const sortedDesc = await User.find({}, { 
      sort: { wallet: 'desc' } 
    });
    expect(sortedDesc[0].wallet).toBe(500);
    expect(sortedDesc[4].wallet).toBe(100);

    const sortedAsc = await User.find({}, { 
      sort: { wallet: 'asc' } 
    });
    expect(sortedAsc[0].wallet).toBe(100);
    expect(sortedAsc[4].wallet).toBe(500);

    // test pagination
    const page1 = await User.find({}, { 
      sort: { wallet: 'asc' },
      limit: 2,
      offset: 0
    });
    expect(page1).toHaveLength(2);
    expect(page1[0].wallet).toBe(100);
    expect(page1[1].wallet).toBe(200);

    const page2 = await User.find({}, { 
      sort: { wallet: 'asc' },
      limit: 2,
      offset: 2
    });
    expect(page2).toHaveLength(2);
    expect(page2[0].wallet).toBe(300);
    expect(page2[1].wallet).toBe(400);

    // test query builder with sort and pagination
    const queryResult = await User
      .where('wallet', '>', 200)
      .sort('name', 'asc')
      .limit(2)
      .offset(0)
      .execute();

    expect(queryResult).toHaveLength(2);
    expect(queryResult[0].name).toBe('User C');
    expect(queryResult[1].name).toBe('User D');
  });

  test('should handle count operations', async () => {
    // create test users with different wallet amounts
    await Promise.all([
      User.create({ name: 'User A', email: 'a@example.com', wallet: 100 }),
      User.create({ name: 'User B', email: 'b@example.com', wallet: 200 }),
      User.create({ name: 'User C', email: 'c@example.com', wallet: 300 }),
      User.create({ name: 'User D', email: 'd@example.com', wallet: 400 }),
      User.create({ name: 'User E', email: 'e@example.com', wallet: 500 })
    ]);

    // test direct count
    const totalCount = await User.count();
    expect(totalCount).toBe(5);

    const richCount = await User.count({ wallet: 300 });
    expect(richCount).toBe(1);

    // test query builder count
    const builderCount = await User
      .where('wallet', '>', 200)
      .count();
    expect(builderCount).toBe(3);

    const complexCount = await User
      .where('wallet', '>', 200)
      .where('wallet', '<', 500)
      .count();
    expect(complexCount).toBe(2);
  });

  test('should handle optimistic locking', async () => {
    // create initial user
    const user = await User.create({
      name: 'Test User',
      email: 'test@example.com',
      wallet: 100
    });
    expect(user.version).toBe(1);

    // first update succeeds
    user.wallet = 200;
    await user.save();
    expect(user.version).toBe(2);

    // simulate concurrent modification
    const sameUser = await User.findById(user._id);
    if (!sameUser) throw new Error('User not found');
    
    sameUser.wallet = 300;
    await sameUser.save();
    expect(sameUser.version).toBe(3);

    // attempt to save outdated version
    user.wallet = 400;
    let error: Error | null = null;
    try {
      await user.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeInstanceOf(OptimisticLockError);

    // verify final state
    const finalUser = await User.findById(user._id);
    expect(finalUser?.wallet).toBe(300);
    expect(finalUser?.version).toBe(3);
  });

  test('should handle field-level validation', async () => {
    // create a game
    const game = await Game.create({
      name: 'Test Game',
      status: 'draft',
      price: 0
    });
    expect(game.status).toBe('draft');
    
    // try to publish without being ready
    game.status = 'published';
    let error: Error | null = null;
    try {
      await game.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('Cannot publish game that is not ready');
    
    // make game ready but try to publish with zero price
    game.isReady = true;
    error = null;
    try {
      await game.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('Published games must have a price');
    
    // set valid price and publish
    game.price = 9.99;
    await game.save();
    expect(game.status).toBe('published');
    
    // try invalid status
    game.status = 'invalid';
    error = null;
    try {
      await game.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('Status must be one of: draft, published, archived');
    
    // try negative price
    game.status = 'published';
    game.price = -10;
    error = null;
    try {
      await game.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('Price cannot be negative');
  });

  test('should handle async default values', async () => {
    const startTime = Date.now();
    
    const product = await Product.create({
      name: 'Test Product'
    });

    // verify async SKU generation
    expect(product.sku).toMatch(/^SKU_\d+$/);
    expect(parseInt(product.sku.split('_')[1])).toBeGreaterThanOrEqual(startTime);
    
    // verify sync default
    expect(product.price).toBe(0);
    
    // verify function default
    expect(product.lastUpdated).toBeGreaterThanOrEqual(startTime);
    
    // verify nested async default
    expect(product.metadata.createdBy).toBe('system');
    expect(product.metadata.version).toBe(1);
  });

  test('should handle OR conditions', async () => {
    // create test users with different wallet amounts
    await Promise.all([
      User.create({ name: 'User A', email: 'a@example.com', wallet: 100 }),
      User.create({ name: 'User B', email: 'b@example.com', wallet: 200 }),
      User.create({ name: 'User C', email: 'c@example.com', wallet: 300 }),
      User.create({ name: 'User D', email: 'd@example.com', wallet: 400 }),
      User.create({ name: 'User E', email: 'e@example.com', wallet: 500 })
    ]);

    // test OR conditions
    const result = await User
      .where('wallet', '>', 400)
      .orWhere('wallet', '<', 200)
      .execute();

    // should find User A (wallet: 100) and User E (wallet: 500)
    expect(result).toHaveLength(2);
    expect(result.map(u => u.wallet).sort()).toEqual([100, 500]);

    // test mixed AND/OR conditions
    const mixedResult = await User
      .where('wallet', '>', 200)
      .where('wallet', '<', 500)  // 300, 400
      .orWhere('name', '=', 'User A')  // or name = 'User A'
      .execute();

    // should find User A, User C, and User D
    expect(mixedResult).toHaveLength(3);
    expect(mixedResult.map(u => u.name).sort()).toEqual(['User A', 'User C', 'User D']);

    // test count with OR conditions
    const count = await User
      .where('wallet', '>', 400)
      .orWhere('wallet', '<', 200)
      .count();

    expect(count).toBe(2);
  });

  test('should handle raw SQL queries', async () => {
    // create test users
    const users = await Promise.all([
      User.create({ name: 'User A', email: 'a@example.com', wallet: 100 }),
      User.create({ name: 'User B', email: 'b@example.com', wallet: 200 }),
      User.create({ name: 'User C', email: 'c@example.com', wallet: 300 })
    ]);

    // test raw query returning documents
    const richUsers = await User.query(
      `
      SELECT data 
      FROM users 
      WHERE (data->>'wallet')::numeric > $1
      ORDER BY (data->>'wallet')::numeric ASC
      `,
      [150]
    );
    expect(richUsers).toHaveLength(2);
    expect(richUsers[0].wallet).toBe(200);
    expect(richUsers[1].wallet).toBe(300);

    // test raw query with custom type
    interface WalletSummary {
      total_wallet: number;
      avg_wallet: number;
      count: number;
    }
    const [summary] = await User.query<WalletSummary>(
      `
      SELECT 
        SUM((data->>'wallet')::numeric)::float as total_wallet,
        AVG((data->>'wallet')::numeric)::float as avg_wallet,
        COUNT(*)::int as count
      FROM users
      `,
      []
    );
    expect(summary.total_wallet).toBe(600);
    expect(summary.avg_wallet).toBe(200);
    expect(summary.count).toBe(3);

    // test raw query with joins and automatic type conversion
    type UserDoc = Awaited<ReturnType<typeof User.create>>;
    type LobbyDoc = Awaited<ReturnType<typeof Lobby.create>>;
    
    interface UserWithLobbies extends UserDoc {
      lobbies: LobbyDoc[] | null;
    }
    
    const userWithLobbies = await User.query<UserWithLobbies>(
      `
      SELECT 
        jsonb_build_object(
          '_id', u.data->>'_id',
          'name', u.data->>'name',
          'email', u.data->>'email',
          'wallet', (u.data->>'wallet')::int,
          'version', (u.data->>'version')::int,
          'lobbies', COALESCE(
            NULLIF(
              (json_agg(l.data) FILTER (WHERE l.data IS NOT NULL))::jsonb,
              NULL::jsonb
            ),
            '[]'::jsonb
          )::json
        ) as data
      FROM users u
      LEFT JOIN lobbies l ON l.data->>'customerId' = u.data->>'_id'
      WHERE u.data->>'name' = $1
      GROUP BY u.data
      `,
      ['User A']
    );
    console.log('userWithLobbies:', JSON.stringify(userWithLobbies, null, 2));
    expect(userWithLobbies[0].name).toBe('User A');
    expect(userWithLobbies[0].wallet).toBe(100);  // automatically converted by PostgreSQL
    expect(Array.isArray(userWithLobbies[0].lobbies)).toBe(true);
  });
}); 