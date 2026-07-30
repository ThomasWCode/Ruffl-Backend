import { runMigrations } from './migration-service.js';

const connectionString =
  process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required.');
}

const applied = await runMigrations(
  connectionString,
  undefined,
  process.env.DATABASE_RUNTIME_ROLE?.trim() || undefined,
);
console.log(
  applied.length
    ? `Applied migrations: ${applied.join(', ')}`
    : 'Database schema is already current.',
);
