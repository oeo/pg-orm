# pg-orm

A simple and elegant PostgreSQL ORM with document-style querying.

## Setup

1. Install dependencies:
```bash
bun install
```

2. Configure environment:
```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your database credentials
nano .env  # or use your preferred editor
```

3. Run the example:
```bash
bun run index.ts
```

The database will be created automatically if it doesn't exist. You just need to ensure:
1. PostgreSQL is running
2. Your user has permission to create databases
3. You've configured the correct credentials in `.env`

## Features

- Document-style querying with TypeScript support
- Built-in connection pooling and error handling
- Automatic database creation
- Support for transactions
- Flexible schema definitions
- Relationship population (similar to MongoDB's populate)
- Event system for document changes

## Environment Variables

The following environment variables can be configured in your `.env` file:

- `PGHOST` - PostgreSQL host (default: localhost)
- `PGPORT` - PostgreSQL port (default: 5432)
- `PGDATABASE` - Database name (default: postgres)
- `PGUSER` - Database user (default: your system username)
- `PGPASSWORD` - Database password

Optional pool settings:
- `PG_CONNECTION_TIMEOUT` - Connection timeout in ms (default: 5000)
- `PG_IDLE_TIMEOUT` - Idle timeout in ms (default: 30000)
- `PG_MAX_POOL_SIZE` - Max pool size (default: 20)

This project was created using `bun init` in bun v1.2.4. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
