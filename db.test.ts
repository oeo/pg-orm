import { expect, test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { defineSchema, transaction, ensureDatabase } from './db';

// test models
const User = defineSchema('users', {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true },
  wallet: { type: 'number', default: 0 }
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
}); 