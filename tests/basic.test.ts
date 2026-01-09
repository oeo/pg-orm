import { expect, test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { defineSchema } from '../lib/schema';
import { transaction, ensureDatabase } from '../lib/connection';
import { OptimisticLockError } from '../lib/document';
import type { Document } from '../lib/document';
import type { SchemaDefinition, InferSchemaType } from '../lib/types';

// test models
const UserSchema: SchemaDefinition = {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true },
  wallet: { type: 'number', default: 0 },
  profile: { 
    type: 'object', 
    schema: {
      level: { type: 'number', default: 1 },
      score: { type: 'number', default: 0 }
    },
    default: {} 
  }
};
const User = defineSchema<typeof UserSchema>('users', UserSchema);
type UserDocType = InferSchemaType<typeof UserSchema>;

const LobbySchema: SchemaDefinition = {
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
};
const Lobby = defineSchema<typeof LobbySchema>('lobbies', LobbySchema);
type LobbyDocType = InferSchemaType<typeof LobbySchema>;

// Add a new model with custom validation
const GameSchema: SchemaDefinition = {
  name: { type: 'string', required: true },
  status: { 
    type: 'string', 
    required: true,
    default: 'draft',
    validate(this: Document<InferSchemaType<typeof GameSchema>>, value: string) {
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
    validate: async function(this: Document<InferSchemaType<typeof GameSchema>>, value: number) {
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
};
const Game = defineSchema<typeof GameSchema>('games', GameSchema);
type GameDocType = InferSchemaType<typeof GameSchema>;

// Add a model with async defaults
const ProductSchema: SchemaDefinition = {
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
};
const Product = defineSchema<typeof ProductSchema>('products', ProductSchema);
type ProductDocType = InferSchemaType<typeof ProductSchema>;

// Define common test data at the describe scope
const usersData = [
  { name: 'User A', email: 'a@example.com', wallet: 100 },
  { name: 'User B', email: 'b@example.com', wallet: 200 },
  { name: 'User C', email: 'c@example.com', wallet: 300 },
  { name: 'User D', email: 'd@example.com', wallet: 400 },
  { name: 'User E', email: 'e@example.com', wallet: 500 }
];

describe('PostgreSQL ORM', () => {
  let testUser: Document<UserDocType>;
  let testLobby: Document<LobbyDocType>;

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
    await db.query('DELETE FROM games');
    await db.query('DELETE FROM products');
  });

  test('should create a user', async () => {
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    expect(testUser._id).toBeTypeOf('string');
    expect(testUser.name).toBe('Test User');
    expect(testUser.email).toBe('test@example.com');
    expect((testUser as any).wallet).toBe(0);
    expect(testUser._vers).toBe(1);
    expect(testUser._vers).toBe(testUser._vers);
  });

  test('should find a user by id', async () => {
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });
    const found = await User.find1(testUser._id);
    expect(found).toBeDefined();
    expect(found?._id).toBe(testUser._id);
    expect(found?.name).toBe(testUser.name);
    expect(found?._vers).toBe(1);
  });

  test('should create a lobby with reference', async () => {
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });

    testLobby = await Lobby.create({
      customerId: testUser._id,
      sku: 'test_game'
    });

    expect(testLobby._id).toBeTypeOf('string');
    expect(testLobby.customerId).toBe(testUser._id);
    expect(testLobby.status).toBe('PENDING');
    expect(testLobby.sku).toBe('test_game');
    expect(testLobby.pros).toEqual([]);
    expect((testLobby as any).balance).toBe(0);
    expect(testLobby._vers).toBe(1);
  });

  test('should populate referenced fields', async () => {
    testUser = await User.create({
      name: 'Test User',
      email: 'test@example.com'
    });
    testLobby = await Lobby.create({
      customerId: testUser._id,
      sku: 'test_game'
    });
    const lobby = await Lobby.findOne({ _id: testLobby._id });
    expect(lobby).toBeDefined();
    await lobby?.populate('customerId');
    expect(lobby?.customerId._id).toBe(testUser._id);
    expect(lobby?.customerId.name).toBe(testUser.name);
  });

  test('should handle array operations', async () => {
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
    const initialVersion = testLobby._vers;
    await testLobby.save();

    expect(testLobby._vers).toBe(initialVersion + 1);
    expect(testLobby.pros).toContain(pro._id);

    const lobbyPop = await Lobby.findOne({ _id: testLobby._id });
    expect(lobbyPop?.pros).toContain(pro._id);
    await lobbyPop?.populate('pros');
    expect(lobbyPop?.pros[0]._id).toBe(pro._id);
    expect(lobbyPop?.pros[0].name).toBe('Pro Player');
  });

  test('should handle transactions', async () => {
    testUser = await User.create({ name: 'TX User', email: 'tx@example.com' });
    testLobby = await Lobby.create({ customerId: testUser._id, sku: 'tx_game' });

    const initialUserVersion = testUser._vers;
    const initialLobbyVersion = testLobby._vers;

    await transaction(async () => {
      const userInTx = await User.find1(testUser._id);
      const lobbyInTx = await Lobby.find1(testLobby._id);
      if (!userInTx || !lobbyInTx) throw new Error("Docs not found in TX");

      userInTx.wallet = 100;
      lobbyInTx.balance = 50;

      await userInTx.save();
      await lobbyInTx.save();
    });

    const user = await User.findOne({ _id: testUser._id });
    const lobby = await Lobby.findOne({ _id: testLobby._id });

    expect(user?.wallet).toBe(100);
    expect(lobby?.balance).toBe(50);
    expect(user?._vers).toBeGreaterThan(initialUserVersion);
    expect(lobby?._vers).toBeGreaterThan(initialLobbyVersion);
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

    const lobby = await Lobby.findOne({ _id: testLobby._id });
    await lobby?.populate(['customerId', 'chat.userId']);

    expect(lobby?.chat).toHaveLength(1);
    expect(lobby?.chat[0].type).toBe('USER');
    expect(lobby?.chat[0].content).toBe('Hello!');
    expect(lobby?.chat[0].userId._id).toBe(testUser._id);
  });

  test('should handle document removal', async () => {
    const user1 = await User.create({ name: 'User 1', email: 'user1@example.com' });
    const user2 = await User.create({ name: 'User 2', email: 'user2@example.com' });

    await user1.remove();
    const foundUser1 = await User.findOne({ _id: user1._id });
    expect(foundUser1).toBeNull();

    const removeResult = await User.remove({ name: 'User 2' });
    expect(removeResult.deletedCount).toBe(1);
    const foundUser2 = await User.findOne({ name: 'User 2' });
    expect(foundUser2).toBeNull();
  });

  test('should handle sorting and pagination', async () => {
    // Create multiple users
    const users = await Promise.all(usersData.map((u: any) => User.create(u)));

    // Test sorting descending
    const sortedDesc = await User.find({}, {
      sort: { wallet: -1 } // Use -1 for descending
    });
    expect((sortedDesc[0] as any).wallet).toBe(500);

    // Test sorting ascending
    const sortedAsc = await User.find({}, {
      sort: { wallet: 1 } // Use 1 for ascending
    });
    expect((sortedAsc[0] as any).wallet).toBe(100);

    // Test pagination
    const page1 = await User.find({}, { 
      sort: { wallet: 1 }, // Sort by wallet ascending
      limit: 2 
    });
    expect(page1.length).toBe(2);
    expect((page1[0] as any).wallet).toBe(100);

    const page2 = await User.find({}, { 
      sort: { wallet: 1 }, // Sort by wallet ascending
      limit: 2, 
      offset: 2 
    });
    expect(page2.length).toBe(2);
    expect((page2[0] as any).wallet).toBe(300);
  });

  test('should handle count operations', async () => {
    await Promise.all(usersData.map((u: any) => User.create(u)));
    const totalCount = await User.count();
    expect(totalCount).toBe(usersData.length);

    const partialCount = await User.count({ wallet: { $gte: 300 } });
    expect(partialCount).toBe(3);
  });

  test('should handle optimistic locking', async () => {
    const user = await User.create({ name: 'Lock User', email: 'lock@example.com', wallet: 100 });
    const versionAfterFirstSave = user._vers;

    const sameUser = await User.findOne({ _id: user._id });
    if (!sameUser) throw new Error('User not found');
    expect(sameUser._vers).toBe(versionAfterFirstSave);

    user.wallet = 200;
    await user.save();
    const versionAfterConcurrentSave = user._vers;
    expect(versionAfterConcurrentSave).toBe(versionAfterFirstSave + 1);

    sameUser.wallet = 300;
    let lockError: Error | null = null;
    try {
      await sameUser.save();
    } catch (err) {
      lockError = err as Error;
    }
    expect(lockError).toBeDefined();
    expect(lockError).toBeInstanceOf(OptimisticLockError);
    expect(lockError?.message).toContain('Optimistic lock failed');

    expect(sameUser._vers).toBe(versionAfterFirstSave);

    const finalUser = await User.findOne({ _id: user._id });
    expect(finalUser?.wallet).toBe(200);
    expect(finalUser?._vers).toBe(versionAfterConcurrentSave);
  });

  test('should handle field-level validation', async () => {
    const game = await Game.create({
      name: 'Test Game',
      status: 'draft',
      price: 0
    } as any);
    expect(game._vers).toBe(1);
    
    game.status = 'published';
    let error: Error | null = null;
    try {
      await game.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('Cannot publish game that is not ready');
    
    game.isReady = true;
    error = null;
    try {
      await game.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('Published games must have a price');
    
    (game as any).price = 9.99;
    await game.save();
    expect(game.status).toBe('published');
    expect(game._vers).toBeGreaterThan(1);
    const publishedVersion = game._vers;
    
    game.status = 'invalid';
    error = null;
    try {
      await game.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('Status must be one of: draft, published, archived');
    expect(game._vers).toBe(publishedVersion);
    
    game.status = 'published';
    (game as any).price = -10;
    error = null;
    try {
      await game.save();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('Price cannot be negative');
    expect(game._vers).toBe(publishedVersion);
  });

  test('should handle async default values', async () => {
    const startTime = Date.now();
    
    const product = await Product.create({
      name: 'Test Product'
    });

    expect(product.sku).toMatch(/^SKU_\d+$/);
    expect(parseInt(product.sku.split('_')[1])).toBeGreaterThanOrEqual(startTime);
    
    expect(product.price).toBe(0);
    
    expect(product.lastUpdated).toBeGreaterThanOrEqual(startTime);
    
    expect(product.metadata.createdBy).toBe('system');
    expect(product.metadata.version).toBe(1);
    expect(product._vers).toBe(1);
  });

  test('should handle OR conditions', async () => {
    await Promise.all(usersData.map((u: any) => User.create(u)));
    const results = await User.find({
      $or: [
        { wallet: 100 },
        { wallet: 500 }
      ]
    });
    expect(results).toHaveLength(2);
    const wallets = results.map(u => (u as any).wallet).sort((a: number, b: number) => a - b);
    expect(wallets).toEqual([100, 500]);
  });

  test('should handle raw SQL queries', async () => {
    await Promise.all(usersData.map((u: any) => User.create(u)));
    const results = await User.query<any>(
      `SELECT SUM((data->>'wallet')::numeric) as total_wallet, 
              AVG((data->>'wallet')::numeric) as avg_wallet, 
              COUNT(*) as count 
       FROM users WHERE (data->>'wallet')::numeric > $1`,
      [150],
      { raw: true }
    );
    expect(results).toHaveLength(1);
    expect(Number(results[0].total_wallet)).toBe(1400);
    expect(Number(results[0].avg_wallet)).toBe(350);
    expect(Number(results[0].count)).toBe(4);
  });

  // New test block for update operations
  test('should handle updateOne and updateMany', async () => {
    // 1. Setup initial data
    const userA = await User.create({ name: 'Update User A', email: 'upa@example.com', wallet: 10 });
    const userB = await User.create({ name: 'Update User B', email: 'upb@example.com', wallet: 20 });
    const userC = await User.create({ name: 'Update User C', email: 'upc@example.com', wallet: 30 });

    // 2. Test updateOne with $set
    const setRes = await User.updateOne(
      { email: 'upa@example.com' }, 
      { $set: { wallet: 15, name: 'Update User A (Updated)' } }
    );
    expect(setRes.matchedCount).toBe(1);
    expect(setRes.modifiedCount).toBe(1); // Note: rowCount reflects matched in current implementation
    const updatedA = await User.find1(userA._id);
    expect(updatedA?.name).toBe('Update User A (Updated)');
    expect(updatedA?.wallet).toBe(15);

    // 3. Test updateOne with $inc
    const incRes = await User.updateOne(
      { email: 'upb@example.com' },
      { $inc: { wallet: 5 } }
    );
    expect(incRes.matchedCount).toBe(1);
    expect(incRes.modifiedCount).toBe(1);
    const updatedB = await User.find1(userB._id);
    expect(updatedB?.wallet).toBe(25);

    // 4. Test updateMany with $set
    const setManyRes = await User.updateMany(
      { wallet: { $gte: 25 } }, // Should match B (25) and C (30)
      { $set: { status: 'processed' } } // Add a new field
    );
    expect(setManyRes.matchedCount).toBe(2);
    expect(setManyRes.modifiedCount).toBe(2);
    const checkB = await User.find1(userB._id);
    const checkC = await User.find1(userC._id);
    expect((checkB as any)?.status).toBe('processed');
    expect((checkC as any)?.status).toBe('processed');

    // 5. Test updateMany with $inc
    const incManyRes = await User.updateMany(
      { wallet: { $lte: 25 } }, // Should match A (15) and B (25)
      { $inc: { loginCount: 1 } } // Increment a non-existent field
    );
    expect(incManyRes.matchedCount).toBe(2);
    expect(incManyRes.modifiedCount).toBe(2);
    const finalA = await User.find1(userA._id);
    const finalB = await User.find1(userB._id);
    expect((finalA as any)?.loginCount).toBe(1); // Should be initialized to 1
    expect((finalB as any)?.loginCount).toBe(1); // Should be initialized to 1
    
    // 6. Test $set with dot notation (assuming wallet is top-level, let's add a nested field)
    await User.updateOne({ _id: userA._id }, { $set: { 'profile.level': 5 } } );
    const nestedA = await User.find1(userA._id);
    expect((nestedA as any)?.profile?.level).toBe(5);
    
    // 7. Test $inc with dot notation
     await User.updateOne({ _id: userA._id }, { $inc: { 'profile.score': 10 } } ); // non-existent score
     const nestedIncA = await User.find1(userA._id);
     expect((nestedIncA as any)?.profile?.score).toBe(10); // Should be initialized to 10
     await User.updateOne({ _id: userA._id }, { $inc: { 'profile.score': 5 } } );
     const nestedIncA2 = await User.find1(userA._id);
     expect((nestedIncA2 as any)?.profile?.score).toBe(15); // Should be incremented
  });
}); 