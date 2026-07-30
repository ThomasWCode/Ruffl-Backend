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

  it('returns a validation error instead of 500 for malformed login fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 42, password: ['not', 'a', 'password'] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_REQUEST');
  });

  it('blocks self-deletion during active work and revokes the account after cancellation', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'delete-me@example.com',
        password: 'Password1!',
        displayName: 'Delete Me',
        role: 'commissioner',
      },
    });
    const { token, user } = signup.json() as {
      token: string;
      user: { id: string };
    };
    store.users.get(user.id)!.pushToken = 'ExponentPushToken[delete-me]';

    const commission = await app.inject({
      method: 'POST',
      url: '/commissions',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        makerId: 'demo-maker',
        title: 'Deletion safety commission',
        suitType: 'head',
        species: 'Fox',
        description: 'A commission used to protect active work during account deletion.',
        referenceNotes: '',
        budget: 1_000,
      },
    });
    expect(commission.statusCode).toBe(201);

    const blocked = await app.inject({
      method: 'DELETE',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toContain('active commissions');

    const cancelled = await app.inject({
      method: 'POST',
      url: `/commissions/${commission.json().commission.id}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.statusCode).toBe(200);
    expect(store.users.get(user.id)).toMatchObject({ status: 'deleted' });
    expect(store.users.get(user.id)?.pushToken).toBeUndefined();

    const revoked = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json().code).toBe('ACCOUNT_DELETED');
  });

  it('fails closed when production authentication configuration is unsafe', async () => {
    await expect(
      buildApp({
        nodeEnv: 'production',
        seedDemoData: false,
        corsOrigins: ['https://admin.ruffl.thomaswhite.me'],
      }),
    ).rejects.toThrow('JWT_SECRET');

    await expect(
      buildApp({
        nodeEnv: 'production',
        jwtSecret: 'a-production-secret-that-is-long-enough',
        seedDemoData: true,
        corsOrigins: ['https://admin.ruffl.thomaswhite.me'],
      }),
    ).rejects.toThrow('SEED_DEMO_DATA');
  });

  it('does not expose maker emails or allow makers to self-grant trust badges', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'new-maker@example.com',
        password: 'Password1!',
        displayName: 'New Maker',
        role: 'maker',
      },
    });
    const { token, user } = signup.json() as { token: string; user: { id: string } };

    const update = await app.inject({
      method: 'PATCH',
      url: '/maker-profile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        bio: 'Updated profile',
        verified: true,
        trusted: true,
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().profile).toMatchObject({
      bio: 'Updated profile',
      verified: false,
      trusted: false,
    });

    const publicMaker = await app.inject({
      method: 'GET',
      url: `/makers/${user.id}`,
    });
    expect(publicMaker.statusCode).toBe(200);
    expect(publicMaker.json().user.email).toBeUndefined();
  });

  it('keeps another user admin support conversation private', async () => {
    store.conversations.set('private-admin-chat', {
      id: 'private-admin-chat',
      kind: 'admin',
      participantIds: ['demo-maker', 'demo-admin'],
      createdAt: new Date().toISOString(),
    });
    const commissionerToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'commissioner@demo.ruffl', password: 'RufflDemo1!' },
      })
    ).json().token;

    const response = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${commissionerToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().conversations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'private-admin-chat' })]),
    );
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
    store.commissions.set('shared-record', {
      id: 'shared-record',
      commissionerId: 'demo-commissioner',
      makerId: 'demo-maker',
      title: 'Shared commission',
      suitType: 'head',
      species: 'Fox',
      description: 'Retained for the other party.',
      referenceNotes: '',
      budget: 1000,
      depositPaid: false,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

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
    expect(permanentlyDeleted.json()).toMatchObject({
      deleted: true,
      permanent: true,
      anonymized: true,
    });
    expect(store.users.get('demo-commissioner')).toMatchObject({
      displayName: 'Deleted user',
      status: 'deleted',
    });
    expect(store.commissions.has('shared-record')).toBe(true);

    const stillBlocked = await app.inject({
      method: 'GET',
      url: '/commissions',
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(stillBlocked.statusCode).toBe(403);
    expect(stillBlocked.json().code).toBe('ACCOUNT_DELETED');

    const audit = await app.inject({
      method: 'GET',
      url: '/admin/audit',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().events).toEqual([
      expect.objectContaining({
        action: 'user_anonymized',
        targetUserId: 'demo-commissioner',
      }),
      expect.objectContaining({
        action: 'user_soft_deleted',
        targetUserId: 'demo-commissioner',
      }),
    ]);
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
