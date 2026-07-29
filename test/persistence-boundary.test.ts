import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  InMemoryStore,
  type StoreSnapshot,
} from '../src/store/in-memory-store.js';

class RecordingStore extends InMemoryStore {
  commits = 0;
  failCommit = false;

  protected override async persistChanges(
    _before: StoreSnapshot,
    _after: StoreSnapshot,
  ): Promise<void> {
    this.commits += 1;
    if (this.failCommit) {
      throw new Error('Simulated database failure');
    }
  }
}

describe('request persistence boundary', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('commits a successful mutation once', async () => {
    const store = new RecordingStore();
    const app = await buildApp({ store, jwtSecret: 'test-secret' });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'saved@example.com',
        password: 'Password1!',
        displayName: 'Saved User',
        role: 'commissioner',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(store.commits).toBe(1);
    expect([...store.users.values()].map((user) => user.email)).toContain(
      'saved@example.com',
    );
  });

  it('rolls back a rejected mutation without writing', async () => {
    const store = new RecordingStore();
    const app = await buildApp({ store, jwtSecret: 'test-secret' });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'invalid@example.com',
        password: 'Password1!',
        displayName: 'Invalid Admin',
        role: 'admin',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(store.commits).toBe(0);
    expect(store.users.size).toBe(0);
  });

  it('restores memory and returns 500 when persistence fails', async () => {
    const store = new RecordingStore();
    store.failCommit = true;
    const app = await buildApp({ store, jwtSecret: 'test-secret' });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'not-saved@example.com',
        password: 'Password1!',
        displayName: 'Not Saved',
        role: 'commissioner',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(store.commits).toBe(1);
    expect(store.users.size).toBe(0);
  });
});
