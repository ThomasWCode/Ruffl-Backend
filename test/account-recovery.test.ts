import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { EmailDelivery } from '../src/services/email-service.js';
import { InMemoryStore } from '../src/store/in-memory-store.js';

class RecordingEmailDelivery implements EmailDelivery {
  readonly verificationUrls: string[] = [];
  readonly resetUrls: string[] = [];

  async sendVerification(input: { verificationUrl: string }): Promise<void> {
    this.verificationUrls.push(input.verificationUrl);
  }

  async sendPasswordReset(input: { resetUrl: string }): Promise<void> {
    this.resetUrls.push(input.resetUrl);
  }
}

function tokenFrom(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('token') ?? '';
}

describe('email verification and account recovery', () => {
  const store = new InMemoryStore();
  const emailDelivery = new RecordingEmailDelivery();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    store.clear();
    emailDelivery.verificationUrls.length = 0;
    emailDelivery.resetUrls.length = 0;
    app = await buildApp({
      store,
      emailDelivery,
      jwtSecret: 'test-secret',
      nodeEnv: 'test',
      publicBaseUrl: 'https://backend.ruffl.example',
      requireEmailVerification: true,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires a one-time verification link before login', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'new-user@example.com',
        password: 'Password1!',
        displayName: 'New User',
        role: 'commissioner',
      },
    });

    expect(signup.statusCode).toBe(201);
    expect(signup.json()).toEqual({
      requiresEmailVerification: true,
      message: 'Check your email to verify your Ruffl account.',
    });
    expect(emailDelivery.verificationUrls).toHaveLength(1);
    expect(emailDelivery.verificationUrls[0]).toContain(
      'https://backend.ruffl.example/auth/verify-email#token=',
    );

    const verificationToken = tokenFrom(emailDelivery.verificationUrls[0] ?? '');
    const scopedTokenAsSession = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${verificationToken}` },
    });
    expect(scopedTokenAsSession.statusCode).toBe(401);
    expect(scopedTokenAsSession.json().code).toBe('UNAUTHENTICATED');

    const blockedLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'new-user@example.com', password: 'Password1!' },
    });
    expect(blockedLogin.statusCode).toBe(403);
    expect(blockedLogin.json().code).toBe('EMAIL_NOT_VERIFIED');

    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(verificationToken)}`,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.body).toContain('Email verified');

    const reused = await app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(verificationToken)}`,
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.body).toContain('invalid or has expired');

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'new-user@example.com', password: 'Password1!' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toEqual(expect.any(String));
  });

  it('does not reveal account existence and invalidates a reset link after use', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'reset-user@example.com',
        password: 'Password1!',
        displayName: 'Reset User',
        role: 'maker',
      },
    });
    expect(signup.statusCode).toBe(201);

    const verificationToken = tokenFrom(emailDelivery.verificationUrls[0] ?? '');
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(verificationToken)}`,
    });
    expect(verified.statusCode).toBe(200);

    const originalLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'reset-user@example.com', password: 'Password1!' },
    });
    expect(originalLogin.statusCode).toBe(200);
    const originalSession = originalLogin.json().token as string;

    const existing = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'reset-user@example.com' },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'missing@example.com' },
    });
    expect(existing.statusCode).toBe(200);
    expect(missing.statusCode).toBe(200);
    expect(existing.json()).toEqual(missing.json());
    expect(emailDelivery.resetUrls).toHaveLength(1);

    const resetToken = tokenFrom(emailDelivery.resetUrls[0] ?? '');
    const reset = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        token: resetToken,
        password: 'NewPassword2!',
        confirmPassword: 'NewPassword2!',
      }).toString(),
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.body).toContain('Password changed');

    const revokedSession = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${originalSession}` },
    });
    expect(revokedSession.statusCode).toBe(401);
    expect(revokedSession.json().code).toBe('UNAUTHENTICATED');

    const reused = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        token: resetToken,
        password: 'AnotherPassword3!',
        confirmPassword: 'AnotherPassword3!',
      }).toString(),
    });
    expect(reused.statusCode).toBe(400);

    const oldPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'reset-user@example.com', password: 'Password1!' },
    });
    const newPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'reset-user@example.com', password: 'NewPassword2!' },
    });
    expect(oldPassword.statusCode).toBe(401);
    expect(newPassword.statusCode).toBe(200);
  });
});
