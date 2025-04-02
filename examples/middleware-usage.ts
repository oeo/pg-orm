// examples/middleware-usage.ts - demonstrating preSave hooks
import { defineSchema, Document } from '../lib';
import { ensureDatabase } from '../lib/connection';
import type { SchemaDefinition } from '../lib/types';

// Define interface and schema at the top level
interface IExampleUser {
  name: string;
  email: string;
  loginCount?: number; // Add field for example
  tags?: string[];     // Add array for example
}

const ExampleUserSchema: SchemaDefinition = {
  name: { type: 'string', required: true },
  email: { 
    type: 'string', 
    required: true, 
    validate: (email: string) => {
      if (!email.includes('@')) throw new Error('invalid email format');
    } 
  },
  loginCount: { type: 'number', default: 0 }, // Add field to schema
  tags: { type: 'array', of: { type: 'string' }, default: [] } // Add array field
};

// Define the model at the top level, relying on implicit table creation
const ExampleUser = defineSchema<typeof ExampleUserSchema>('example_users', ExampleUserSchema, {
  hooks: {
    async preSave(this: Document<IExampleUser>) {
      console.log(`[Hook] preSave running for user: ${this.name}, isNew: ${this.isNew()}`);
      
      // Example: Log if specific fields were modified
      if (this.isModified('email')) {
        console.log('[Hook] Email was modified.');
        // Normalize email only if it actually changed
        this.email = this.email.toLowerCase();
      } else {
        console.log('[Hook] Email was NOT modified.');
      }
      
      if (this.isModified('tags')) {
         console.log('[Hook] Tags array was modified.');
         // Maybe perform validation or cleanup on tags array
         if (this.tags) {
            this.tags = this.tags
              .filter((tag: string) => tag.trim() !== '')
              .map((tag: string) => tag.trim());
         }
      }
      
      await new Promise(resolve => setTimeout(resolve, 5)); 
      console.log(`[Hook] preSave finished for user: ${this.name}`);
    }
  }
});

// Main example function
async function runExample() {
  console.log('connecting to database and ensuring schema...');
  // ensureDatabase will handle CREATE TABLE IF NOT EXISTS for 'example_users'
  const db = await ensureDatabase(); 
  
  console.log('clearing previous example data (DELETE FROM)...');
  // Use DELETE instead of DROP TABLE
  try {
      await db.query('DELETE FROM example_users'); 
  } catch (error) {
      // Ignore error if table doesn't exist on first run
      if (!(error instanceof Error && 'code' in error && error.code === '42P01')) {
        console.error('Error deleting from example_users:', error);
        // Decide if we should proceed or exit
      }
  }

  console.log('running middleware example...');

  console.log('\ncreating user alice...');
  const alice = await ExampleUser.create({
    name: 'Alice',
    email: 'ALICE@EXAMPLE.COM'
  });
  console.log('alice created:', alice.toJSON());
  expect(alice.email).toBe('alice@example.com'); 
  expect(alice._ctime).toBeDefined(); 
  expect(alice._mtime).toBe(alice._ctime); 
  expect(alice._vers).toBe(1);

  // Update only name - email hook should see email NOT modified
  console.log('\nupdating user alice (name only)...');
  const creationTime = alice._ctime; // Define creationTime before use
  alice.name = 'Alice B. Smith';
  alice.markModified('name'); 
  await alice.save();
  console.log('alice updated:', alice.toJSON());
  expect(alice.name).toBe('Alice B. Smith');
  expect(alice._ctime).toBe(creationTime); // ctime should not change
  expect(alice._mtime).toBeGreaterThan(creationTime); // mtime should be updated
  expect(alice._vers).toBe(2); // Version should be 2 after update

  // Update email and tags
  console.log('\nupdating user alice (email and tags)...');
  alice.email = 'Alice.Smith@EXAMPLE.CO.UK';
  alice.markModified('email'); 
  alice.tags = [' vip ', ' test ', ''];
  alice.markModified('tags'); 
  await alice.save();
  console.log('alice updated:', alice.toJSON());
  expect(alice.email).toBe('alice.smith@example.co.uk'); // Email normalized by hook
  expect(alice.tags).toEqual(['vip', 'test']); // Tags cleaned by hook
  
  const foundAlice = await ExampleUser.find1(alice._id);
  console.log('\nfound alice:', foundAlice?.toJSON());
  expect(foundAlice?._vers).toBe(3); // Version should be 3 after two updates

  console.log('\nexample finished.');
  // Optional: close pool if necessary for script exit
  // await db.end(); 
}

// simple assertion helper for example
function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        console.error(`Assertion failed: Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`);
        process.exit(1);
      }
    },
    toBeDefined: () => {
      if (actual === undefined || actual === null) {
        console.error(`Assertion failed: Expected value to be defined, but got ${actual}`);
        process.exit(1);
      }
    },
    toBeGreaterThan: (expected: any) => {
       if (!(actual > expected)) {
         console.error(`Assertion failed: Expected ${actual} to be greater than ${expected}`);
        process.exit(1);
      }
    },
    // Add toEqual for deep comparison (simple version)
    toEqual: (expected: any) => {
      try {
        // Use JSON stringify for simple deep comparison
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
           console.error(`Assertion failed: Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`);
           process.exit(1);
        }
      } catch (e) {
         console.error(`Assertion failed: Could not compare objects. Error: ${e}`);
         process.exit(1);
      }
    }
  };
}

runExample().catch(err => {
  console.error('example failed:', err);
  process.exit(1);
}); 