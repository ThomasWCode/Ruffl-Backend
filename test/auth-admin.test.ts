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

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'commissioner@demo.ruffl', password: 'RufflDemo1!' },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
      message: expect.stringContaining('Account suspended until'),
    });
  });

  it('preserves rate-limit status and a useful client message', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'missing@example.com', password: 'WrongPassword1!' },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'missing@example.com', password: 'WrongPassword1!' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('Too many requests'),
    });
  });

  it('allows admin DELETE requests through browser CORS preflight', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/admin/users/demo-commissioner',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'authorization,x-csrf-token,content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
    expect(response.headers['access-control-allow-headers']?.toLowerCase()).toContain(
      'x-csrf-token',
    );
  });

  it('blocks an existing token immediately after soft deletion', async () => {
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

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/admin/users/demo-commissioner',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    expect(deleted.statusCode).toBe(200);

    const blocked = await app.inject({
      method: 'GET',
      url: '/commissions',
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('ACCOUNT_DELETED');

    const permanentlyDeleted = await app.inject({
      method: 'DELETE',
      url: '/admin/users/demo-commissioner',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
      payload: { permanent: true },
    });
    expect(permanentlyDeleted.statusCode).toBe(200);

    const stillBlocked = await app.inject({
      method: 'GET',
      url: '/commissions',
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(stillBlocked.statusCode).toBe(403);
    expect(stillBlocked.json().code).toBe('ACCOUNT_DELETED');
  });

  it('delivers new warnings through the live session endpoint and acknowledges them', async () => {
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

    const warned = await app.inject({
      method: 'POST',
      url: '/admin/users/demo-commissioner/warn',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
      payload: { message: 'Please review the marketplace rules.' },
    });
    const warningId = warned.json().warning.id as string;

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(me.json().warnings).toEqual([
      expect.objectContaining({
        id: warningId,
        message: 'Please review the marketplace rules.',
        read: false,
      }),
    ]);

    const acknowledged = await app.inject({
      method: 'POST',
      url: `/warnings/${warningId}/read`,
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(acknowledged.statusCode).toBe(200);

    const refreshed = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(refreshed.json().warnings).toEqual([]);
  });
});
