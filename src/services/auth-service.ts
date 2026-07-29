import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { DomainError, requireValue } from '../domain/errors.js';
import type { PublicUser, User, UserRole } from '../domain/types.js';
import type { InMemoryStore } from '../store/in-memory-store.js';

const scrypt = promisify(scryptCallback);

export function toPublicUser(user: User): PublicUser {
  const {
    passwordHash: _passwordHash,
    pushToken: _pushToken,
    ...publicUser
  } = user;
  return publicUser;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new DomainError('Password must contain at least 8 characters.');
  }
  if (password.length > 128) {
    throw new DomainError('Password must contain no more than 128 characters.');
  }

  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) {
    return false;
  }

  const expected = Buffer.from(key, 'hex');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class AuthService {
  constructor(private readonly store: InMemoryStore) {}

  async signup(input: {
    email: string;
    password: string;
    displayName: string;
    role: Exclude<UserRole, 'admin'>;
  }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    if (!email.includes('@')) {
      throw new DomainError('Enter a valid email address.');
    }
    if (!input.displayName.trim()) {
      throw new DomainError('Display name is required.');
    }
    if (input.role !== 'commissioner' && input.role !== 'maker') {
      throw new DomainError('Only commissioner and maker accounts can sign up.');
    }
    if ([...this.store.users.values()].some((user) => user.email === email)) {
      throw new DomainError('An account already exists for this email.', 409, 'EMAIL_TAKEN');
    }

    const now = new Date().toISOString();
    const user: User = {
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName.trim(),
      role: input.role,
      status: 'active',
      createdAt: now,
    };
    this.store.users.set(user.id, user);

    if (user.role === 'maker') {
      this.store.makerProfiles.set(user.id, {
        userId: user.id,
        bio: '',
        location: '',
        specialisms: [],
        basePrices: { head: 0, partial: 0, full: 0 },
        addOnPrices: { movingJaw: 0, followMeEyes: 0, coolingFan: 0 },
        turnaroundWeeks: 0,
        queueOpen: true,
        verified: false,
        trusted: false,
      });
    }

    return user;
  }

  async login(emailInput: string, password: string): Promise<User> {
    const email = emailInput.trim().toLowerCase();
    const user = [...this.store.users.values()].find((candidate) => candidate.email === email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new DomainError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
    }
    if (user.status === 'deleted') {
      throw new DomainError('This account has been deleted.', 403, 'ACCOUNT_DELETED');
    }
    this.ensureActive(user);
    return user;
  }

  getUser(userId: string): User {
    return requireValue(this.store.users.get(userId), 'User not found.');
  }

  ensureActive(user: User): void {
    if (
      user.status === 'suspended' &&
      user.suspendedUntil &&
      new Date(user.suspendedUntil).getTime() <= Date.now()
    ) {
      user.status = 'active';
      delete user.suspendedUntil;
      delete user.suspensionReason;
    }

    if (user.status === 'suspended') {
      throw new DomainError(
        `Account suspended until ${user.suspendedUntil ?? 'further notice'}.`,
        403,
        'ACCOUNT_SUSPENDED',
      );
    }
    if (user.status === 'deleted') {
      throw new DomainError('This account has been deleted.', 403, 'ACCOUNT_DELETED');
    }
  }
}
