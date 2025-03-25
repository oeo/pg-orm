import { pgorm } from '../';

// define user schema
const User = pgorm.defineSchema('users', {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true },
  wallet: { type: 'number', default: 0 }
});

// define lobby schema
const Lobby = pgorm.defineSchema('lobbies', {
  name: { type: 'string', required: true },
  customerId: { type: 'ref', ref: 'users', required: true },
  maxPlayers: { type: 'number', default: 4 },
  chat: {
    type: 'array',
    of: {
      type: 'object',
      schema: {
        userId: { type: 'ref', ref: 'users', required: true },
        message: { type: 'string', required: true },
        timestamp: { 
          type: 'number', 
          default: () => Math.floor(Date.now() / 1000),
          required: false 
        }
      }
    }
  }
});

// example usage
async function main() {
  // create a user
  const user = await User.create({
    name: 'John Doe',
    email: 'john@example.com',
    wallet: 100
  });

  // create a lobby with transaction
  const lobby = await pgorm.transaction(async () => {
    const newLobby = await Lobby.create({
      name: 'Game Room 1',
      customerId: user._id,
      chat: [{
        userId: user._id,
        message: 'Hello everyone!',
        timestamp: Math.floor(Date.now() / 1000)  // explicitly set timestamp
      }]
    });

    // populate the customer and chat users
    await newLobby.populate(['customerId', 'chat.userId']);
    return newLobby;
  });

  console.log('Lobby with populated data:', lobby);

  // subscribe to lobby updates
  pgorm.events.on('lobbies:updated', (updatedLobby) => {
    console.log('Lobby updated:', updatedLobby);
  });

  // find lobbies with query builder
  const activeLobbies = await Lobby.where('maxPlayers', '>', 2)
    .sort('name', 'asc')
    .limit(10)
    .execute();
  
  console.log('Active lobbies:', activeLobbies);
}

// run example if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

