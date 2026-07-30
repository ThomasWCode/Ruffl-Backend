import './instrument.js';

import * as Sentry from '@sentry/node';

import { buildApp } from './app.js';
import { InMemoryStore } from './store/in-memory-store.js';
import { PostgresStore } from './store/postgres-store.js';

const nodeEnv = process.env.NODE_ENV ?? 'development';
const databaseUrl = process.env.DATABASE_URL?.trim();
if (nodeEnv === 'production' && !databaseUrl) {
  throw new Error('DATABASE_URL is required in production.');
}
if (nodeEnv === 'production' && !process.env.SENTRY_DSN?.trim()) {
  throw new Error('SENTRY_DSN is required in production.');
}
if (nodeEnv === 'production' && !process.env.SENTRY_RELEASE?.trim()) {
  throw new Error('SENTRY_RELEASE is required in production.');
}

const store = databaseUrl
  ? await PostgresStore.connect(databaseUrl)
  : new InMemoryStore();
const app = await buildApp({ logger: true, nodeEnv, store });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await Sentry.close(2_000);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  Sentry.captureException(error);
  await app.close();
  await Sentry.close(2_000);
  process.exit(1);
}
