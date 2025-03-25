import { defineSchema, transaction } from './db';

// define the user model
const User = defineSchema('users', {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true },
  wallet: { type: 'number', default: 0 }
});

// define the lobby model with relationships
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

// infer types from schema
type User = ReturnType<typeof User.create> extends Promise<infer T> ? T : never;
type Lobby = ReturnType<typeof Lobby.create> extends Promise<infer T> ? T : never;

async function runExample() {
  try {
    // Example 1: Create a User
    console.log('\n1. Creating a user...');
    const user = await User.create({
      name: 'Zen Master',
      email: 'zen@monastery.org'
    });
    console.log('User created:', user._id);
    console.log('User:', JSON.stringify(user, null, 2));

    // Example 2: Create a Lobby
    console.log('\n2. Creating a lobby...');
    const lobby = await Lobby.create({
      customerId: user._id,
      sku: 'game_coaching'
    });
    console.log('Lobby created:', lobby._id);
    console.log('Lobby:', lobby);
    console.log('Lobby:', JSON.stringify(lobby, null, 2));

    // Example 3: Document methods
    console.log('\n3. Updating lobby status...');
    if (!lobby.chat) lobby.chat = [];
    lobby.chat.push({
      type: 'SYSTEM',
      content: 'Lobby is now matching with pros.'
    });
    await lobby.save();
    console.log('Lobby updated');

    // Example 4: Population
    console.log('\n4. Finding and populating lobby...');
    const foundLobby = await Lobby.findById(lobby._id);
    if (!foundLobby) {
      throw new Error('Could not find lobby');
    }
    await foundLobby.populate('customerId');
    console.log('Found lobby with customer:', foundLobby.customerId.name);

    // Example 5: Adding a pro
    console.log('\n5. Adding a pro...');
    const pro = await User.create({
      name: 'Pro Player',
      email: 'pro@example.com'
    });
    if (!foundLobby.pros) foundLobby.pros = [];
    foundLobby.pros.push(pro._id);
    await foundLobby.save();
    console.log('Pro added to lobby');

    // Example 6: Use transactions
    console.log('\n6. Running transaction...');
    await transaction(async () => {
      const completingLobby = await Lobby.findById(foundLobby._id);
      if (!completingLobby) {
        throw new Error('Lobby not found');
      }

      const customer = await User.findById(completingLobby.customerId);
      if (!customer) {
        throw new Error('Customer not found');
      }

      // Update multiple documents atomically
      completingLobby.status = 'COMPLETED';
      completingLobby.endTime = Math.floor(Date.now() / 1000);

      customer.wallet += completingLobby.balance;
      completingLobby.balance = 0;

      await Promise.all([
        customer.save(),
        completingLobby.save()
      ]);
    });
    console.log('Transaction completed successfully');

    // Example 7: Query with where
    console.log('\n7. Running where query...');
    const matchingLobbies = await Lobby.where('status', 'COMPLETED')
      .where('balance', '=', 0)
      .execute();
    console.log('Found completed lobbies:', matchingLobbies.length);
    console.log('Lobbies:', JSON.stringify(matchingLobbies, null, 2));

    console.log('\nAll examples completed successfully!');
  } catch (err) {
    console.error('\nError running examples:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// run the examples
runExample();

