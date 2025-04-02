import { pgorm } from '../';
import type { Document, InferSchemaType } from '../';

// --- User Schema Definition ---
// a simple user schema
const UserSchema = {
  name: { type: 'string', required: true },
  email: { type: 'string', required: true },
  wallet: { type: 'number', default: 0 }
};

// Remove generic type for simplicity, rely on basic inference
// Use 'as any' on the schema to bypass strict validation for this example
const User = pgorm.defineSchema('users', UserSchema as any);

// --- Lobby Schema Definition ---
// a simple lobby schema referencing the user
const LobbySchema = {
  name: { type: 'string', required: true },
  customerId: { type: 'ref', ref: 'users', required: true }, // references the 'users' table
  maxPlayers: { type: 'number', default: 4 }
  // removed complex 'chat' field for simplicity
};

// Remove generic type for simplicity, rely on basic inference
// Use 'as any' on the schema to bypass strict validation for this example
const Lobby = pgorm.defineSchema('lobbies', LobbySchema as any);

// --- Basic Example Usage ---
async function main() {
  console.log('running basic example...');

  // 1. create a user
  console.log('\ncreating user...');
  const user = await User.create({
    name: 'John Doe',
    email: 'john@example.com',
    wallet: 100
  } as any); // using 'as any' temporarily to bypass type errors
  console.log('created user:', user.toJSON());

  // 2. create a lobby referencing the user
  console.log('\ncreating lobby...');
  const lobby = await Lobby.create({
    name: 'Game Room 1',
    customerId: user._id, // assign the user's id to the reference field
    maxPlayers: 5
  } as any); // using 'as any' temporarily to bypass type errors
  console.log('created lobby:', lobby.toJSON());

  // note: finding, updating, deleting, population, and events 
  // are shown in other examples or would be added here.

  console.log('\nbasic example finished.');
}

// run example if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

