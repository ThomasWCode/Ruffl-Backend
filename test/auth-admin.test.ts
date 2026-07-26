import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { InMemoryStore } from '../src/store/in-memory-store.js';

describe('authentication and admin safety', () => {
  const store = new InMemoryStore();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    store.clear();
    app = await buildApp({ store, seedDemoData: true, jwtSecret: 'test-secret' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('does not allow public signup to create an admin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'attacker@example.com',
        password: 'Password1!',
        displayName: 'Attacker',
        role: 'admin',
      },
    });
    expect(response.statusCode).toBe(400);
    expect([...store.users.values()].some((user) => user.email === 'attacker@example.com')).toBe(false);
  });

  it('blocks every authenticated route immediately after suspension', async () => {
    const adminToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@demo.ruffl', password: 'RufflDemo1!' },
      })
    ).json().token;
    const commissionerToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'commissioner@demo.ruffl', password: 'RufflDemo1!' },
      })
    ).json().token;
    const csrfToken = (
      await app.inject({
        method: 'GET',
        url: '/admin/csrf',
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json().csrfToken;

    const suspended = await app.inject({
      method: 'POST',
      url: '/admin/users/demo-commissioner/suspend',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
      payload: { hours: 24, reason: 'Safety review' },
    });
    expect(suspended.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(me.statusCode).toBe(403);
    expect(me.json().code).toBe('ACCOUNT_SUSPENDED');
  });
});
