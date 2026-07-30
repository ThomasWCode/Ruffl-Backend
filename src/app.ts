import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import * as Sentry from '@sentry/node';
import { createHash } from 'node:crypto';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import { DomainError, requireValue } from './domain/errors.js';
import type {
  AdminAuditEvent,
  Conversation,
  MediaAttachment,
  Message,
  User,
} from './domain/types.js';
import { AuthService, hashPassword, toPublicUser } from './services/auth-service.js';
import {
  accountPage,
  accountPageCss,
  accountPageScript,
} from './services/account-page.js';
import { CommissionService } from './services/commission-service.js';
import {
  ResendEmailService,
  type EmailDelivery,
} from './services/email-service.js';
import {
  MediaService,
  type MediaGateway,
} from './services/media-service.js';
import {
  ExpoPushGateway,
  isExpoPushToken,
  PushDeliveryWorker,
  type PushGateway,
} from './services/push-service.js';
import { InMemoryStore, type StoreMutation } from './store/in-memory-store.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      role: User['role'];
      scope?: 'csrf' | 'verify-email' | 'reset-password';
      email?: string;
      fingerprint?: string;
    };
    user: {
      sub: string;
      role: User['role'];
      scope?: 'csrf' | 'verify-email' | 'reset-password';
      email?: string;
      fingerprint?: string;
    };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    storeMutation?: StoreMutation;
    notificationIdsBefore?: Set<string>;
  }
}

interface AppOptions {
  store?: InMemoryStore;
  jwtSecret?: string;
  corsOrigins?: string[];
  seedDemoData?: boolean;
  logger?: boolean;
  nodeEnv?: string;
  emailDelivery?: EmailDelivery | null;
  publicBaseUrl?: string;
  requireEmailVerification?: boolean;
  pushGateway?: PushGateway | null;
  mediaGateway?: MediaGateway | null;
}

const activeStatuses = ['pending', 'negotiating', 'price_proposed', 'accepted', 'active', 'shipping', 'disputed'];
const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const videoTypes = ['video/mp4', 'video/quicktime', 'video/webm'];
const documentTypes = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function parseBody<T extends z.ZodType>(
  request: FastifyRequest,
  schema: T,
): z.infer<T> {
  if (!request.body || typeof request.body !== 'object') {
    throw new DomainError('A JSON request body is required.');
  }
  return parseValue(request.body, schema);
}

function parseValue<T extends z.ZodType>(
  value: unknown,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError(
      result.error.issues[0]?.message ?? 'The request body is invalid.',
      400,
      'INVALID_REQUEST',
    );
  }
  return result.data;
}

function assertOwnedMedia(
  media: MediaGateway | null,
  user: User,
  attachments: MediaAttachment[] | undefined,
): void {
  if (!attachments?.length) return;
  if (
    !media ||
    attachments.some(
      (attachment) =>
        !media.ownsPublicUrl(attachment.url, user.id, 'uploads'),
    )
  ) {
    throw new DomainError(
      'Attachments must use a media URL uploaded by this account.',
      400,
      'INVALID_MEDIA_URL',
    );
  }
}

const shortText = z.string().trim().min(1).max(160);
const noteText = z.string().max(5_000);
const mediaAttachmentSchema = z.object({
  url: z.string().url().max(2_048),
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
});
const attachmentsSchema = z.array(mediaAttachmentSchema).max(10).default([]);
const signupSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(128),
  displayName: shortText,
  role: z.enum(['commissioner', 'maker']),
});
const loginSchema = signupSchema.pick({ email: true, password: true });
const emailSchema = signupSchema.pick({ email: true });
const tokenSchema = z.object({ token: z.string().trim().min(1).max(4_096) });
const resetPasswordSchema = tokenSchema.extend({
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128),
});
const profileSchema = z.object({
  displayName: shortText.optional(),
  bio: z.string().trim().max(2_000).optional(),
  avatarUrl: z.string().url().max(2_048).optional(),
  pushToken: z
    .string()
    .trim()
    .max(512)
    .refine(
      (value) => value === '' || isExpoPushToken(value),
      'Enter a valid Expo push token.',
    )
    .optional(),
});
const priceSchema = z.object({
  head: z.number().finite().nonnegative(),
  partial: z.number().finite().nonnegative(),
  full: z.number().finite().nonnegative(),
});
const addOnPriceSchema = z.object({
  movingJaw: z.number().finite().nonnegative(),
  followMeEyes: z.number().finite().nonnegative(),
  coolingFan: z.number().finite().nonnegative(),
});
const makerProfileSchema = z.object({
  bio: z.string().trim().max(2_000).optional(),
  location: z.string().trim().max(160).optional(),
  specialisms: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  basePrices: priceSchema.optional(),
  addOnPrices: addOnPriceSchema.optional(),
  turnaroundWeeks: z.number().int().min(0).max(520).optional(),
  queueOpen: z.boolean().optional(),
  bannerUrl: z.string().url().max(2_048).optional(),
});
const commissionSchema = z.object({
  makerId: z.string().min(1).max(160),
  title: shortText,
  suitType: z.enum(['head', 'partial', 'full', 'custom']),
  species: shortText,
  description: z.string().trim().min(1).max(5_000),
  referenceNotes: z.string().trim().max(5_000).default(''),
  budget: z.number().finite().positive().max(10_000_000),
});
const reviewSchema = z.object({
  quality: z.number().int().min(1).max(5),
  communication: z.number().int().min(1).max(5),
  accuracy: z.number().int().min(1).max(5),
  packaging: z.number().int().min(1).max(5),
  timeline: z.number().int().min(1).max(5),
  comment: z.string().trim().max(5_000),
});
const messageSchema = z.object({
  text: noteText.optional().default(''),
  attachments: attachmentsSchema,
});

function credentialFingerprint(user: User): string {
  return createHash('sha256').update(user.passwordHash).digest('hex');
}

function getCurrentUser(request: FastifyRequest, store: InMemoryStore, auth: AuthService): User {
  if (request.user.scope) {
    throw new DomainError('Sign in to continue.', 401, 'UNAUTHENTICATED');
  }
  const user = store.users.get(request.user.sub);
  if (!user) {
    throw new DomainError('This account has been deleted.', 403, 'ACCOUNT_DELETED');
  }
  auth.ensureActive(user);
  if (request.user.fingerprint !== credentialFingerprint(user)) {
    throw new DomainError('Your session has expired. Sign in again.', 401, 'UNAUTHENTICATED');
  }
  return user;
}

function assertAdmin(user: User): void {
  if (user.role !== 'admin') {
    throw new DomainError('Admin access required.', 403, 'FORBIDDEN');
  }
}

function recordAdminAudit(
  store: InMemoryStore,
  admin: User,
  action: string,
  targetUserId?: string,
  details: AdminAuditEvent['details'] = {},
): void {
  const event: AdminAuditEvent = {
    id: crypto.randomUUID(),
    adminId: admin.id,
    action,
    details,
    createdAt: new Date().toISOString(),
  };
  if (targetUserId) event.targetUserId = targetUserId;
  store.adminAuditEvents.push(event);
}

function marketplaceUser(user: User) {
  const { email: _email, ...publicUser } = toPublicUser(user);
  return publicUser;
}

function getOrCreateAdminConversation(
  store: InMemoryStore,
  userId: string,
  adminId?: string,
): Conversation {
  const existing = [...store.conversations.values()].find(
    (conversation) =>
      conversation.kind === 'admin' && conversation.participantIds.includes(userId),
  );
  if (existing) {
    if (adminId && !existing.participantIds.includes(adminId)) {
      existing.participantIds.push(adminId);
    }
    return existing;
  }

  const conversation: Conversation = {
    id: crypto.randomUUID(),
    kind: 'admin',
    participantIds: adminId ? [userId, adminId] : [userId],
    createdAt: new Date().toISOString(),
  };
  store.conversations.set(conversation.id, conversation);
  return conversation;
}

function createMessage(
  store: InMemoryStore,
  conversation: Conversation,
  sender: User,
  text: string,
  attachments: MediaAttachment[] = [],
): Message {
  if ((!text.trim() && attachments.length === 0) || text.length > 5_000) {
    throw new DomainError('A message needs up to 5,000 characters or an attachment.');
  }
  if (attachments.length > 10) {
    throw new DomainError('A message can contain at most 10 attachments.');
  }

  const message: Message = {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    senderId: sender.id,
    text: text.trim(),
    attachments,
    createdAt: new Date().toISOString(),
  };
  store.messages.push(message);

  const recipientIds =
    conversation.kind === 'admin'
      ? [
          ...conversation.participantIds,
          ...[...store.users.values()]
            .filter((user) => user.role === 'admin' && user.status === 'active')
            .map((user) => user.id),
        ]
      : conversation.participantIds;
  [...new Set(recipientIds)]
    .filter((userId) => userId !== sender.id)
    .forEach((userId) => {
      store.notifications.push({
        id: crypto.randomUUID(),
        userId,
        type: 'message_received',
        title: conversation.kind === 'admin' ? 'New support message' : 'New message',
        body: message.text || 'An attachment was sent.',
        read: false,
        createdAt: message.createdAt,
      });
    });

  return message;
}

function serializeMaker(store: InMemoryStore, user: User) {
  const profile = requireValue(store.makerProfiles.get(user.id), 'Maker profile not found.');
  const reviews = store.reviews.filter((review) => review.revieweeId === user.id);
  const rating =
    reviews.length === 0
      ? null
      : reviews.reduce(
          (sum, review) =>
            sum +
            (review.quality +
              review.communication +
              review.accuracy +
              review.packaging +
              review.timeline) /
              5,
          0,
        ) / reviews.length;
  const completedCount = [...store.commissions.values()].filter(
    (commission) => commission.makerId === user.id && commission.status === 'complete',
  ).length;

  return {
    user: marketplaceUser(user),
    profile,
    rating,
    completedCount,
    reviews,
  };
}

async function seedStore(store: InMemoryStore): Promise<void> {
  if (store.users.size > 0) {
    return;
  }

  const createdAt = new Date().toISOString();
  const sharedPassword = await hashPassword('RufflDemo1!');
  const commissioner: User = {
    id: 'demo-commissioner',
    email: 'commissioner@demo.ruffl',
    passwordHash: sharedPassword,
    displayName: 'Jamie Fox',
    role: 'commissioner',
    status: 'active',
    bio: 'Looking for a bright, expressive partial suit.',
    emailVerifiedAt: createdAt,
    createdAt,
  };
  const maker: User = {
    id: 'demo-maker',
    email: 'maker@demo.ruffl',
    passwordHash: sharedPassword,
    displayName: 'Moonlit Makes',
    role: 'maker',
    status: 'active',
    bio: 'Expressive toony suits built in Bristol.',
    emailVerifiedAt: createdAt,
    createdAt,
  };
  const secondMaker: User = {
    id: 'demo-maker-2',
    email: 'maker2@demo.ruffl',
    passwordHash: sharedPassword,
    displayName: 'Northstar Studios',
    role: 'maker',
    status: 'active',
    bio: 'Realistic canines and lightweight full suits.',
    emailVerifiedAt: createdAt,
    createdAt,
  };
  const admin: User = {
    id: 'demo-admin',
    email: 'admin@demo.ruffl',
    passwordHash: sharedPassword,
    displayName: 'Ruffl Support',
    role: 'admin',
    status: 'active',
    emailVerifiedAt: createdAt,
    createdAt,
  };

  [commissioner, maker, secondMaker, admin].forEach((user) => store.users.set(user.id, user));
  store.makerProfiles.set(maker.id, {
    userId: maker.id,
    bio: maker.bio ?? '',
    location: 'Bristol, UK',
    specialisms: ['Toony', 'Canine', 'LED eyes'],
    basePrices: { head: 950, partial: 1800, full: 3600 },
    addOnPrices: { movingJaw: 175, followMeEyes: 90, coolingFan: 65 },
    turnaroundWeeks: 24,
    queueOpen: true,
    verified: true,
    trusted: true,
  });
  store.makerProfiles.set(secondMaker.id, {
    userId: secondMaker.id,
    bio: secondMaker.bio ?? '',
    location: 'Manchester, UK',
    specialisms: ['Realistic', 'Canine', 'Plantigrade'],
    basePrices: { head: 1200, partial: 2200, full: 4400 },
    addOnPrices: { movingJaw: 220, followMeEyes: 100, coolingFan: 75 },
    turnaroundWeeks: 32,
    queueOpen: false,
    verified: true,
    trusted: false,
  });
}

// Builds an isolated server so automated tests never need a listening network port.
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const jwtSecret =
    options.jwtSecret ??
    process.env.JWT_SECRET ??
    (nodeEnv === 'production' ? '' : 'development-only-secret-change-before-production');
  const seedDemoData = options.seedDemoData ?? process.env.SEED_DEMO_DATA === 'true';
  const requireEmailVerification =
    options.requireEmailVerification ?? nodeEnv === 'production';
  const publicBaseUrl = (
    options.publicBaseUrl ??
    process.env.BACKEND_PUBLIC_URL ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
  const corsOrigins =
    options.corsOrigins ??
    process.env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ??
    ['http://localhost:5173', 'http://localhost:8081'];

  if (nodeEnv === 'production' && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters in production.');
  }
  if (nodeEnv === 'production' && seedDemoData) {
    throw new Error('SEED_DEMO_DATA must be false in production.');
  }
  if (nodeEnv === 'production' && (corsOrigins.length === 0 || corsOrigins.includes('*'))) {
    throw new Error('CORS_ORIGINS must contain explicit trusted origins in production.');
  }
  for (const origin of corsOrigins) {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin.replace(/\/$/, '') ||
      (nodeEnv === 'production' && parsed.protocol !== 'https:')
    ) {
      throw new Error('CORS_ORIGINS entries must be exact trusted origins.');
    }
  }
  const parsedPublicBaseUrl = new URL(publicBaseUrl);
  if (
    parsedPublicBaseUrl.origin !== publicBaseUrl ||
    (nodeEnv === 'production' && parsedPublicBaseUrl.protocol !== 'https:')
  ) {
    throw new Error('BACKEND_PUBLIC_URL must be the exact public backend origin.');
  }

  const store = options.store ?? new InMemoryStore();
  const media =
    options.mediaGateway === undefined
      ? MediaService.fromEnvironment()
      : options.mediaGateway;
  const emailDelivery =
    options.emailDelivery === undefined
      ? ResendEmailService.fromEnvironment()
      : options.emailDelivery;
  const pushGateway =
    options.pushGateway === undefined
      ? ExpoPushGateway.fromEnvironment()
      : options.pushGateway;
  if (nodeEnv === 'production' && !media) {
    throw new Error('Cloudflare R2 configuration is required in production.');
  }
  if (nodeEnv === 'production' && !emailDelivery) {
    throw new Error('Resend email configuration is required in production.');
  }
  if (nodeEnv === 'production' && !pushGateway) {
    throw new Error('Expo Push access configuration is required in production.');
  }
  if (seedDemoData && store.persistent) {
    throw new Error('SEED_DEMO_DATA can only be used with the in-memory development store.');
  }
  if (seedDemoData) {
    await seedStore(store);
  }

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_000_000,
    trustProxy: 1,
  });
  const auth = new AuthService(store);
  const commissions = new CommissionService(store);
  const pushWorker = pushGateway
    ? new PushDeliveryWorker(store, pushGateway, (error) => {
        app.log.error(error, 'Push delivery worker failed');
        Sentry.captureException(error);
      })
    : null;
  pushWorker?.start();

  await app.register(helmet);
  await app.register(formbody);
  await app.register(cors, {
    origin: corsOrigins,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => {
      const error = new Error(`Too many requests. Try again in ${context.after}.`);
      Object.assign(error, {
        code: 'RATE_LIMITED',
        statusCode: context.statusCode,
      });
      return error;
    },
  });
  await app.register(jwt, {
    secret: jwtSecret,
    sign: { expiresIn: '30d' },
  });

  const sessionToken = (user: User) =>
    app.jwt.sign({
      sub: user.id,
      role: user.role,
      fingerprint: credentialFingerprint(user),
    });

  const accountLink = (
    user: User,
    scope: 'verify-email' | 'reset-password',
  ): { token: string; url: string } => {
    const token = app.jwt.sign(
      {
        sub: user.id,
        role: user.role,
        scope,
        email: user.email,
        ...(scope === 'reset-password'
          ? { fingerprint: credentialFingerprint(user) }
          : {}),
      },
      { expiresIn: scope === 'verify-email' ? '24h' : '30m' },
    );
    return {
      token,
      url: `${publicBaseUrl}/auth/${
        scope === 'verify-email' ? 'verify-email' : 'reset-password'
      }#token=${encodeURIComponent(token)}`,
    };
  };

  const resolveAccountToken = (
    token: string,
    scope: 'verify-email' | 'reset-password',
  ): User => {
    try {
      const payload = app.jwt.verify<{
        sub: string;
        role: User['role'];
        scope?: 'verify-email' | 'reset-password';
        email?: string;
        fingerprint?: string;
      }>(token);
      const user = store.users.get(payload.sub);
      if (
        !user ||
        user.status === 'deleted' ||
        payload.scope !== scope ||
        payload.email !== user.email ||
        (scope === 'verify-email' && Boolean(user.emailVerifiedAt)) ||
        (scope === 'reset-password' &&
          payload.fingerprint !== credentialFingerprint(user))
      ) {
        throw new Error('Account token claims no longer match.');
      }
      return user;
    } catch {
      throw new DomainError(
        'This account-security link is invalid or has expired. Request a new email.',
        400,
        'ACCOUNT_TOKEN_INVALID',
      );
    }
  };

  const sendVerificationEmail = async (user: User): Promise<string> => {
    const link = accountLink(user, 'verify-email');
    if (emailDelivery) {
      await emailDelivery.sendVerification({
        email: user.email,
        displayName: user.displayName,
        verificationUrl: link.url,
        idempotencyKey: `verify-${createHash('sha256')
          .update(link.token)
          .digest('hex')
          .slice(0, 48)}`,
      });
    }
    return link.url;
  };

  const sendPasswordResetEmail = async (user: User): Promise<string> => {
    const link = accountLink(user, 'reset-password');
    if (emailDelivery) {
      await emailDelivery.sendPasswordReset({
        email: user.email,
        displayName: user.displayName,
        resetUrl: link.url,
        idempotencyKey: `reset-${createHash('sha256')
          .update(link.token)
          .digest('hex')
          .slice(0, 48)}`,
      });
    }
    return link.url;
  };

  app.addHook('onRequest', async (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      request.storeMutation = await store.beginMutation();
      if (pushWorker) {
        request.notificationIdsBefore = new Set(
          store.notifications.map((notification) => notification.id),
        );
      }
    }
  });
  app.addHook('onError', async (request) => {
    request.storeMutation?.rollback();
    delete request.storeMutation;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const mutation = request.storeMutation;
    delete request.storeMutation;
    if (!mutation) return payload;
    if (reply.statusCode >= 400) {
      mutation.rollback();
      return payload;
    }
    let queuedPush = false;
    if (pushWorker && request.notificationIdsBefore) {
      for (const notification of store.notifications) {
        if (request.notificationIdsBefore.has(notification.id)) continue;
        const recipient = store.users.get(notification.userId);
        if (!recipient?.pushToken || recipient.status !== 'active') continue;
        if (!isExpoPushToken(recipient.pushToken)) {
          delete recipient.pushToken;
          continue;
        }
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        store.pushDeliveries.set(id, {
          id,
          notificationId: notification.id,
          userId: recipient.id,
          pushToken: recipient.pushToken,
          status: 'queued',
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
        });
        queuedPush = true;
      }
    }
    await mutation.commit();
    if (queuedPush) pushWorker?.wake();
    return payload;
  });

  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
      getCurrentUser(request, store, auth);
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      return reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'Sign in to continue.' });
    }
  });

  const requireAdminCsrf = async (request: FastifyRequest): Promise<void> => {
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string') {
      throw new DomainError('A current admin CSRF token is required.', 403, 'CSRF_REQUIRED');
    }
    try {
      const payload = app.jwt.verify<{ sub: string; role: User['role']; scope?: 'csrf' }>(token);
      if (payload.sub !== request.user.sub || payload.role !== 'admin' || payload.scope !== 'csrf') {
        throw new Error('Invalid CSRF claims');
      }
    } catch {
      throw new DomainError('The admin CSRF token is invalid or expired.', 403, 'CSRF_INVALID');
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }

    if (error instanceof Error) {
      const httpError = error as Error & { code?: string; statusCode?: number };
      const statusCode = httpError.statusCode ?? 500;
      if (statusCode >= 400 && statusCode < 500) {
        return reply.code(statusCode).send({
          code: httpError.code === 'RATE_LIMITED' ? httpError.code : 'INVALID_REQUEST',
          message: httpError.message,
        });
      }
    }

    app.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Something went wrong.' });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'ruffl-api' }));
  app.get('/ready', async () => {
    await store.readinessCheck();
    return {
      status: 'ready',
      service: 'ruffl-api',
      storage: store.persistent ? 'postgres' : 'memory',
      pushDelivery: pushWorker ? 'configured' : 'disabled',
    };
  });

  app.get('/auth/account.css', async (_request, reply) =>
    reply
      .header('Cache-Control', 'public, max-age=3600')
      .type('text/css; charset=utf-8')
      .send(accountPageCss),
  );

  app.get('/auth/account.js', async (_request, reply) =>
    reply
      .header('Cache-Control', 'public, max-age=3600')
      .type('application/javascript; charset=utf-8')
      .send(accountPageScript),
  );

  app.get('/auth/verify-email', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(
        accountPage({
          title: 'Verify your email',
          body: 'Confirm this email address before signing in to Ruffl.',
          form: 'verify',
        }),
      ),
  );

  app.post(
    '/auth/verify-email',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      try {
        const { token } = parseBody(request, tokenSchema);
        const user = resolveAccountToken(token, 'verify-email');
        user.emailVerifiedAt ??= new Date().toISOString();
        return reply
          .header('Cache-Control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(
            accountPage({
              title: 'Email verified',
              body: 'Your Ruffl account is ready. Return to the app and sign in.',
            }),
          );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return reply
          .code(error.statusCode)
          .header('Cache-Control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(
            accountPage({
              title: 'Verification link unavailable',
              body: 'Ruffl could not verify this email address.',
              error: error.message,
            }),
          );
      }
    },
  );

  app.get('/auth/reset-password', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(
        accountPage({
          title: 'Reset your password',
          body: 'Choose a new password containing at least eight characters.',
          form: 'reset',
        }),
      ),
  );

  app.post(
    '/auth/reset-password',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      try {
        const body = parseBody(request, resetPasswordSchema);
        if (body.password !== body.confirmPassword) {
          throw new DomainError(
            'The password confirmation does not match.',
            400,
            'PASSWORD_CONFIRMATION_MISMATCH',
          );
        }
        const user = resolveAccountToken(body.token, 'reset-password');
        user.passwordHash = await hashPassword(body.password);
        user.emailVerifiedAt ??= new Date().toISOString();
        return reply
          .header('Cache-Control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(
            accountPage({
              title: 'Password changed',
              body: 'Your previous password and reset link no longer work. Return to Ruffl and sign in.',
            }),
          );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return reply
          .code(error.statusCode)
          .header('Cache-Control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(
            accountPage({
              title: 'Reset link unavailable',
              body: 'Ruffl could not change this password.',
              error: error.message,
            }),
          );
      }
    },
  );

  app.post(
    '/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = parseBody(request, signupSchema);
      const user = await auth.signup(body);
      if (requireEmailVerification) {
        const developmentVerificationUrl = await sendVerificationEmail(user);
        return reply.code(201).send({
          requiresEmailVerification: true,
          message: 'Check your email to verify your Ruffl account.',
          ...(nodeEnv === 'development'
            ? { developmentVerificationUrl }
            : {}),
        });
      }
      user.emailVerifiedAt = new Date().toISOString();
      const token = sessionToken(user);
      return reply.code(201).send({ token, user: toPublicUser(user) });
    },
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = parseBody(request, loginSchema);
      const user = await auth.login(body.email, body.password);
      return { token: sessionToken(user), user: toPublicUser(user) };
    },
  );

  app.post(
    '/auth/resend-verification',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    async (request) => {
      const { email } = parseBody(request, emailSchema);
      const user = [...store.users.values()].find(
        (candidate) =>
          candidate.email === email.trim().toLowerCase() &&
          candidate.status === 'active',
      );
      let developmentVerificationUrl: string | undefined;
      if (user && !user.emailVerifiedAt) {
        developmentVerificationUrl = await sendVerificationEmail(user);
      }
      return {
        message:
          'If an unverified Ruffl account exists for that address, a verification email has been sent.',
        ...(nodeEnv === 'development' && developmentVerificationUrl
          ? { developmentVerificationUrl }
          : {}),
      };
    },
  );

  app.post(
    '/auth/forgot-password',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    async (request) => {
      const { email } = parseBody(request, emailSchema);
      const user = [...store.users.values()].find(
        (candidate) =>
          candidate.email === email.trim().toLowerCase() &&
          candidate.status !== 'deleted',
      );
      let developmentResetUrl: string | undefined;
      if (user) {
        developmentResetUrl = await sendPasswordResetEmail(user);
      }
      return {
        message:
          'If a Ruffl account exists for that address, a password-reset email has been sent.',
        ...(nodeEnv === 'development' && developmentResetUrl
          ? { developmentResetUrl }
          : {}),
      };
    },
  );

  app.get('/me', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    return {
      user: toPublicUser(user),
      makerProfile: store.makerProfiles.get(user.id) ?? null,
      warnings: store.warnings.filter((warning) => warning.userId === user.id && !warning.read),
    };
  });

  app.patch('/me', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const body = parseBody(request, profileSchema);
    if (body.displayName !== undefined) user.displayName = body.displayName.trim();
    if (body.bio !== undefined) user.bio = body.bio.trim();
    if (body.avatarUrl !== undefined) {
      if (!media?.ownsPublicUrl(body.avatarUrl, user.id, 'avatars')) {
        throw new DomainError(
          'The profile image must use a media URL uploaded by this account.',
          400,
          'INVALID_MEDIA_URL',
        );
      }
      user.avatarUrl = body.avatarUrl;
    }
    if (body.pushToken === '') {
      delete user.pushToken;
    } else if (body.pushToken !== undefined) {
      user.pushToken = body.pushToken;
    }
    return { user: toPublicUser(user) };
  });

  app.delete('/me', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const hasActiveCommission = [...store.commissions.values()].some(
      (commission) =>
        activeStatuses.includes(commission.status) &&
        (commission.makerId === user.id || commission.commissionerId === user.id),
    );
    if (hasActiveCommission) {
      throw new DomainError('Finish or cancel active commissions before deleting your account.');
    }
    user.status = 'deleted';
    delete user.pushToken;
    return { deleted: true };
  });

  app.get('/makers', async (request) => {
    const query = request.query as { search?: string; openOnly?: string };
    const search = query.search?.trim().toLowerCase() ?? '';
    return [...store.users.values()]
      .filter((user) => user.role === 'maker' && user.status === 'active')
      .map((user) => serializeMaker(store, user))
      .filter(({ user, profile }) => {
        const matchesSearch =
          !search ||
          user.displayName.toLowerCase().includes(search) ||
          profile.specialisms.some((tag) => tag.toLowerCase().includes(search));
        return matchesSearch && (query.openOnly !== 'true' || profile.queueOpen);
      })
      .sort((left, right) => left.user.displayName.localeCompare(right.user.displayName));
  });

  app.get('/makers/:makerId', async (request) => {
    const { makerId } = request.params as { makerId: string };
    const user = requireValue(store.users.get(makerId), 'Maker not found.');
    if (user.role !== 'maker' || user.status !== 'active') {
      throw new DomainError('Maker not found.', 404, 'NOT_FOUND');
    }
    return serializeMaker(store, user);
  });

  app.patch('/maker-profile', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    if (user.role !== 'maker') throw new DomainError('Maker access required.', 403, 'FORBIDDEN');
    const profile = requireValue(store.makerProfiles.get(user.id), 'Maker profile not found.');
    const body = parseBody(request, makerProfileSchema);
    if (body.bio !== undefined) profile.bio = body.bio.trim().slice(0, 2_000);
    if (body.location !== undefined) profile.location = body.location.trim().slice(0, 160);
    if (body.specialisms !== undefined) {
      if (
        !Array.isArray(body.specialisms) ||
        body.specialisms.length > 20 ||
        body.specialisms.some((item) => typeof item !== 'string' || !item.trim() || item.length > 60)
      ) {
        throw new DomainError('Specialisms must contain at most 20 short labels.');
      }
      profile.specialisms = body.specialisms.map((item) => item.trim());
    }
    if (body.basePrices !== undefined) {
      const values = Object.values(body.basePrices);
      if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new DomainError('Base prices must be valid positive amounts.');
      }
      profile.basePrices = body.basePrices;
    }
    if (body.addOnPrices !== undefined) {
      const values = Object.values(body.addOnPrices);
      if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new DomainError('Add-on prices must be valid positive amounts.');
      }
      profile.addOnPrices = body.addOnPrices;
    }
    if (body.turnaroundWeeks !== undefined) {
      if (
        !Number.isInteger(body.turnaroundWeeks) ||
        body.turnaroundWeeks < 0 ||
        body.turnaroundWeeks > 520
      ) {
        throw new DomainError('Turnaround must be a whole number from 0 to 520 weeks.');
      }
      profile.turnaroundWeeks = body.turnaroundWeeks;
    }
    if (body.queueOpen !== undefined) profile.queueOpen = body.queueOpen;
    if (body.bannerUrl !== undefined) {
      if (!media?.ownsPublicUrl(body.bannerUrl, user.id, 'banners')) {
        throw new DomainError(
          'The banner must use a media URL uploaded by this account.',
          400,
          'INVALID_MEDIA_URL',
        );
      }
      profile.bannerUrl = body.bannerUrl;
    }
    return { profile };
  });

  app.post('/makers/:makerId/waitlist', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = getCurrentUser(request, store, auth);
    const { makerId } = request.params as { makerId: string };
    const { message = '' } = parseBody(
      request,
      z.object({ message: z.string().trim().max(2_000).optional() }),
    );
    if (user.role !== 'commissioner') {
      throw new DomainError('Only commissioners can join a waitlist.', 403, 'FORBIDDEN');
    }
    const profile = requireValue(store.makerProfiles.get(makerId), 'Maker not found.');
    if (profile.queueOpen) throw new DomainError('This maker is currently accepting requests.');
    if (
      store.waitlist.some(
        (entry) => entry.makerId === makerId && entry.commissionerId === user.id,
      )
    ) {
      throw new DomainError('You are already on this waitlist.', 409, 'DUPLICATE_WAITLIST');
    }
    const entry = {
      id: crypto.randomUUID(),
      makerId,
      commissionerId: user.id,
      message: message.trim(),
      createdAt: new Date().toISOString(),
    };
    store.waitlist.push(entry);
    return reply.code(201).send({ entry });
  });

  app.get('/maker-profile/waitlist', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    if (user.role !== 'maker') throw new DomainError('Maker access required.', 403, 'FORBIDDEN');
    return store.waitlist.filter((entry) => entry.makerId === user.id);
  });

  app.post('/commissions', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = getCurrentUser(request, store, auth);
    const commission = commissions.create(
      user,
      parseBody(request, commissionSchema),
    );
    return reply.code(201).send({ commission });
  });

  app.get('/commissions', { onRequest: [app.authenticate] }, async (request) => ({
    commissions: commissions.listForUser(getCurrentUser(request, store, auth)),
  }));

  app.get('/commissions/:id', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const { id } = request.params as { id: string };
    return {
      ...commissions.getForUser(user, id),
      negotiations: store.negotiations.filter((entry) => entry.commissionId === id),
      materials: store.materials.filter((entry) => entry.commissionId === id),
      reviews: store.reviews.filter((review) => review.commissionId === id),
      dispute:
        [...store.disputes.values()]
          .filter((dispute) => dispute.commissionId === id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ??
        null,
    };
  });

  app.post('/commissions/:id/respond', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { accept } = parseBody(request, z.object({ accept: z.boolean() }));
    return { commission: commissions.respondToRequest(getCurrentUser(request, store, auth), id, accept) };
  });

  app.post('/commissions/:id/price', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { amount, note } = parseBody(
      request,
      z.object({
        amount: z.number().finite().positive().max(10_000_000),
        note: noteText.optional(),
      }),
    );
    return {
      commission: commissions.proposePrice(getCurrentUser(request, store, auth), id, amount, note),
    };
  });

  app.post('/commissions/:id/price-response', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { accept, note } = parseBody(
      request,
      z.object({ accept: z.boolean(), note: noteText.optional() }),
    );
    return {
      commission: commissions.respondToPrice(getCurrentUser(request, store, auth), id, accept, note),
    };
  });

  app.post('/commissions/:id/deposit', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    return { commission: commissions.payDeposit(getCurrentUser(request, store, auth), id) };
  });

  app.post(
    '/commissions/:id/milestones/:milestoneId/updates',
    { onRequest: [app.authenticate] },
    async (request) => {
      const { id, milestoneId } = request.params as { id: string; milestoneId: string };
      const { notes, attachments } = parseBody(
        request,
        z.object({
          notes: noteText,
          attachments: attachmentsSchema.optional(),
        }),
      );
      const user = getCurrentUser(request, store, auth);
      assertOwnedMedia(media, user, attachments);
      return {
        milestone: commissions.postMilestoneUpdate(
          user,
          id,
          milestoneId,
          notes,
          attachments,
        ),
      };
    },
  );

  app.post(
    '/commissions/:id/milestones/:milestoneId/approve',
    { onRequest: [app.authenticate] },
    async (request) => {
      const { id, milestoneId } = request.params as { id: string; milestoneId: string };
      return {
        milestone: commissions.approveMilestone(
          getCurrentUser(request, store, auth),
          id,
          milestoneId,
        ),
      };
    },
  );

  app.post('/commissions/:id/ship', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { trackingNumber } = parseBody(
      request,
      z.object({ trackingNumber: z.string().trim().max(255).optional() }),
    );
    return {
      commission: commissions.ship(getCurrentUser(request, store, auth), id, trackingNumber),
    };
  });

  app.post('/commissions/:id/receipt', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    return { commission: commissions.confirmReceipt(getCurrentUser(request, store, auth), id) };
  });

  app.post('/commissions/:id/cancel', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    return { commission: commissions.cancel(getCurrentUser(request, store, auth), id) };
  });

  app.post('/commissions/:id/reviews', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const review = commissions.addReview(
      getCurrentUser(request, store, auth),
      id,
      parseBody(request, reviewSchema),
    );
    return reply.code(201).send({ review });
  });

  app.post('/commissions/:id/materials', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = getCurrentUser(request, store, auth);
    const { id } = request.params as { id: string };
    const { commission } = commissions.getForUser(user, id);
    if (user.id !== commission.makerId) {
      throw new DomainError('Only the maker can track material costs.', 403, 'FORBIDDEN');
    }
    const body = parseBody(
      request,
      z.object({
        item: shortText,
        quantity: z.number().finite().positive().max(1_000_000),
        unit: shortText,
        costPerUnit: z.number().finite().nonnegative().max(10_000_000),
      }),
    );
    if (!body.item.trim() || body.quantity <= 0 || body.costPerUnit < 0) {
      throw new DomainError('Enter a valid item, quantity, and cost.');
    }
    const entry = {
      id: crypto.randomUUID(),
      commissionId: id,
      makerId: user.id,
      item: body.item.trim(),
      quantity: body.quantity,
      unit: body.unit.trim(),
      costPerUnit: body.costPerUnit,
      createdAt: new Date().toISOString(),
    };
    store.materials.push(entry);
    return reply.code(201).send({ entry });
  });

  app.post('/commissions/:id/disputes', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = getCurrentUser(request, store, auth);
    const { id } = request.params as { id: string };
    const { explanation, attachments } = parseBody(
      request,
      z.object({
        explanation: z.string().trim().min(1).max(10_000),
        attachments: attachmentsSchema.optional(),
      }),
    );
    assertOwnedMedia(media, user, attachments);
    return reply
      .code(201)
      .send({ dispute: commissions.raiseDispute(user, id, explanation, attachments) });
  });

  app.post('/disputes/:id/evidence', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const { id } = request.params as { id: string };
    const { message, attachments } = parseBody(
      request,
      z.object({
        message: noteText,
        attachments: attachmentsSchema.optional(),
      }),
    );
    assertOwnedMedia(media, user, attachments);
    return { dispute: commissions.addEvidence(user, id, message, attachments) };
  });

  app.get('/conversations', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const conversations = [...store.conversations.values()].filter(
      (conversation) =>
        user.role === 'admin' ||
        conversation.participantIds.includes(user.id),
    );
    return {
      conversations: conversations
        .map((conversation) => ({
          ...conversation,
          lastMessage:
            store.messages
              .filter((message) => message.conversationId === conversation.id)
              .at(-1) ?? null,
        }))
        .sort((left, right) =>
          (right.lastMessage?.createdAt ?? right.createdAt).localeCompare(
            left.lastMessage?.createdAt ?? left.createdAt,
          ),
        ),
    };
  });

  app.post('/conversations/direct', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = getCurrentUser(request, store, auth);
    const { participantId } = parseBody(
      request,
      z.object({ participantId: z.string().min(1).max(160) }),
    );
    const participant = requireValue(store.users.get(participantId), 'User not found.');
    if (
      user.role === 'admin' ||
      participant.role === 'admin' ||
      participant.status !== 'active' ||
      participant.id === user.id
    ) {
      throw new DomainError('Choose another active marketplace user.');
    }
    const existing = [...store.conversations.values()].find(
      (conversation) =>
        conversation.kind === 'direct' &&
        conversation.participantIds.length === 2 &&
        conversation.participantIds.includes(user.id) &&
        conversation.participantIds.includes(participant.id),
    );
    if (existing) return { conversation: existing };

    const conversation: Conversation = {
      id: crypto.randomUUID(),
      kind: 'direct',
      participantIds: [user.id, participant.id],
      createdAt: new Date().toISOString(),
    };
    store.conversations.set(conversation.id, conversation);
    return reply.code(201).send({ conversation });
  });

  app.post('/support/conversation', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = getCurrentUser(request, store, auth);
    if (user.role === 'admin') {
      throw new DomainError('Use the admin user tools to start a support conversation.', 403, 'FORBIDDEN');
    }
    const existing = [...store.conversations.values()].find(
      (conversation) =>
        conversation.kind === 'admin' && conversation.participantIds.includes(user.id),
    );
    const conversation = existing ?? getOrCreateAdminConversation(store, user.id);
    return reply.code(existing ? 200 : 201).send({ conversation });
  });

  app.get('/conversations/:id/messages', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const { id } = request.params as { id: string };
    const conversation = requireValue(store.conversations.get(id), 'Conversation not found.');
    if (user.role !== 'admin' && !conversation.participantIds.includes(user.id)) {
      throw new DomainError('You are not part of this conversation.', 403, 'FORBIDDEN');
    }
    return { messages: store.messages.filter((message) => message.conversationId === id) };
  });

  app.post(
    '/conversations/:id/messages',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const user = getCurrentUser(request, store, auth);
      const { id } = request.params as { id: string };
      const conversation = requireValue(store.conversations.get(id), 'Conversation not found.');
      if (user.role !== 'admin' && !conversation.participantIds.includes(user.id)) {
        throw new DomainError('You are not part of this conversation.', 403, 'FORBIDDEN');
      }
      if (user.role === 'admin') {
        await requireAdminCsrf(request);
      }
      const { text, attachments } = parseBody(request, messageSchema);
      if (conversation.kind === 'admin' && user.role === 'admin') {
        if (!conversation.participantIds.includes(user.id)) {
          conversation.participantIds.push(user.id);
        }
      }
      assertOwnedMedia(media, user, attachments);
      const message = createMessage(store, conversation, user, text, attachments);
      return reply.code(201).send({ message });
    },
  );

  app.get('/notifications', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    return { notifications: store.notifications.filter((item) => item.userId === user.id) };
  });

  app.post('/notifications/:id/read', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const { id } = request.params as { id: string };
    const notification = requireValue(
      store.notifications.find((item) => item.id === id && item.userId === user.id),
      'Notification not found.',
    );
    notification.read = true;
    return { notification };
  });

  app.post('/warnings/:id/read', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const { id } = request.params as { id: string };
    const warning = requireValue(
      store.warnings.find((item) => item.id === id && item.userId === user.id),
      'Warning not found.',
    );
    warning.read = true;
    return { warning };
  });

  app.post(
    '/uploads/slot',
    {
      onRequest: [app.authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (request) => {
      const user = getCurrentUser(request, store, auth);
      const { fileName, contentType, size, category } = parseBody(
        request,
        z.object({
          fileName: z.string().trim().min(1).max(255),
          contentType: z.string().trim().min(1).max(120),
          size: z.number().int().positive().max(100 * 1024 * 1024),
          category: z.enum(['image', 'video', 'document', 'avatar', 'banner']),
        }),
      );
      const allowed =
        category === 'video'
          ? videoTypes
          : category === 'document'
            ? documentTypes
            : imageTypes;
      const limit =
        category === 'video' ? 100 * 1024 * 1024 : category === 'document' ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
      if (!allowed.includes(contentType) || size <= 0 || size > limit) {
        throw new DomainError('This file type or size is not allowed.');
      }
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
      const objectKey =
        category === 'avatar' || category === 'banner'
          ? `${category}s/${user.id}/${crypto.randomUUID()}-${safeName}`
          : `uploads/${user.id}/${crypto.randomUUID()}-${safeName}`;
      if (!media) {
        throw new DomainError(
          'Media uploads are not configured in this environment.',
          503,
          'MEDIA_NOT_CONFIGURED',
        );
      }
      return {
        slot: await media.createUploadSlot(objectKey, contentType, size),
      };
    },
  );

  app.get('/admin/overview', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    assertAdmin(user);
    return {
      counts: {
        users: store.users.size,
        activeCommissions: [...store.commissions.values()].filter((commission) =>
          activeStatuses.includes(commission.status),
        ).length,
        openDisputes: [...store.disputes.values()].filter((dispute) =>
          ['open', 'under_review'].includes(dispute.status),
        ).length,
        unreadAdminChats: [...store.conversations.values()].filter((conversation) => {
          if (conversation.kind !== 'admin') return false;
          const lastMessage = store.messages
            .filter((message) => message.conversationId === conversation.id)
            .at(-1);
          return Boolean(
            lastMessage &&
              store.users.get(lastMessage.senderId)?.role !== 'admin',
          );
        }).length,
      },
      recentCommissions: [...store.commissions.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 5),
      recentDisputes: [...store.disputes.values()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 5),
    };
  });

  app.get('/admin/csrf', { onRequest: [app.authenticate] }, async (request) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    return {
      csrfToken: app.jwt.sign(
        { sub: admin.id, role: admin.role, scope: 'csrf' },
        { expiresIn: '10m' },
      ),
      expiresInSeconds: 600,
    };
  });

  app.get('/admin/users', { onRequest: [app.authenticate] }, async (request) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    const query = request.query as { search?: string; status?: User['status'] };
    const search = query.search?.toLowerCase() ?? '';
    return {
      users: [...store.users.values()]
        .filter(
          (user) =>
            (!query.status || user.status === query.status) &&
            (!search ||
              user.email.includes(search) ||
              user.displayName.toLowerCase().includes(search)),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(toPublicUser),
    };
  });

  app.get('/admin/audit', { onRequest: [app.authenticate] }, async (request) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    return {
      events: [...store.adminAuditEvents]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 500),
    };
  });

  app.post(
    '/admin/users/:id/warn',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request, reply) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    const { id } = request.params as { id: string };
    const { message } = parseBody(
      request,
      z.object({ message: z.string().trim().min(1).max(5_000) }),
    );
    const target = requireValue(store.users.get(id), 'User not found.');
    if (!message.trim()) throw new DomainError('Warning message is required.');
    const warning = {
      id: crypto.randomUUID(),
      userId: target.id,
      adminId: admin.id,
      message: message.trim(),
      read: false,
      createdAt: new Date().toISOString(),
    };
    store.warnings.push(warning);
    store.notifications.push({
      id: crypto.randomUUID(),
      userId: target.id,
      type: 'admin_warning',
      title: 'Message from Ruffl support',
      body: warning.message,
      read: false,
      createdAt: warning.createdAt,
    });
    createMessage(
      store,
      getOrCreateAdminConversation(store, target.id, admin.id),
      admin,
      `Warning from Ruffl support: ${warning.message}`,
    );
    recordAdminAudit(store, admin, 'user_warned', target.id, {
      warningId: warning.id,
      message: warning.message,
    });
    return reply.code(201).send({ warning });
    },
  );

  app.post(
    '/admin/users/:id/suspend',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    const { id } = request.params as { id: string };
    const { hours, reason } = parseBody(
      request,
      z.object({
        hours: z.number().finite().positive().max(24 * 365),
        reason: z.string().trim().min(1).max(5_000),
      }),
    );
    const target = requireValue(store.users.get(id), 'User not found.');
    if (target.role === 'admin' || hours <= 0 || !reason.trim()) {
      throw new DomainError('Enter a positive duration and reason for a non-admin user.');
    }
    target.status = 'suspended';
    target.suspendedUntil = new Date(Date.now() + hours * 3_600_000).toISOString();
    target.suspensionReason = reason.trim();
    createMessage(
      store,
      getOrCreateAdminConversation(store, target.id, admin.id),
      admin,
      `Your account has been suspended until ${target.suspendedUntil}. Reason: ${target.suspensionReason}`,
    );
    recordAdminAudit(store, admin, 'user_suspended', target.id, {
      hours,
      reason: target.suspensionReason,
      suspendedUntil: target.suspendedUntil,
    });
    return { user: toPublicUser(target) };
    },
  );

  app.post(
    '/admin/users/:id/unsuspend',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    const { id } = request.params as { id: string };
    const target = requireValue(store.users.get(id), 'User not found.');
    target.status = 'active';
    delete target.suspendedUntil;
    delete target.suspensionReason;
    recordAdminAudit(store, admin, 'user_unsuspended', target.id);
    return { user: toPublicUser(target) };
    },
  );

  app.delete(
    '/admin/users/:id',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    const { id } = request.params as { id: string };
    const body = parseValue(
      request.body ?? {},
      z.object({ permanent: z.boolean().optional() }),
    );
    const target = requireValue(store.users.get(id), 'User not found.');
    if (target.role === 'admin') throw new DomainError('Admin accounts cannot be removed here.');
    if (!body.permanent) {
      target.status = 'deleted';
      recordAdminAudit(store, admin, 'user_soft_deleted', target.id);
      return { deleted: true, permanent: false };
    }
    if (target.status !== 'deleted') {
      throw new DomainError('Soft-delete the account before permanent deletion.');
    }
    target.email = `deleted+${target.id}@deleted.invalid`;
    target.passwordHash = await hashPassword(`${crypto.randomUUID()}${crypto.randomUUID()}`);
    target.displayName = 'Deleted user';
    delete target.avatarUrl;
    delete target.bio;
    delete target.pushToken;
    delete target.suspendedUntil;
    delete target.suspensionReason;
    delete target.emailVerifiedAt;
    store.makerProfiles.delete(id);
    store.waitlist.splice(
      0,
      store.waitlist.length,
      ...store.waitlist.filter(
        (item) => item.makerId !== id && item.commissionerId !== id,
      ),
    );
    store.warnings.splice(
      0,
      store.warnings.length,
      ...store.warnings.filter((item) => item.userId !== id && item.adminId !== id),
    );
    store.notifications.splice(
      0,
      store.notifications.length,
      ...store.notifications.filter((item) => item.userId !== id),
    );
    recordAdminAudit(store, admin, 'user_anonymized', target.id);
    return { deleted: true, permanent: true, anonymized: true };
    },
  );

  app.get('/admin/disputes', { onRequest: [app.authenticate] }, async (request) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    return {
      disputes: [...store.disputes.values()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((dispute) => ({
          ...dispute,
          commission: store.commissions.get(dispute.commissionId),
          materials: store.materials.filter(
            (entry) => entry.commissionId === dispute.commissionId,
          ),
        })),
    };
  });

  app.post(
    '/admin/users/:id/conversation',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
      const admin = getCurrentUser(request, store, auth);
      assertAdmin(admin);
      const { id } = request.params as { id: string };
      const target = requireValue(store.users.get(id), 'User not found.');
      if (target.role === 'admin') {
        throw new DomainError('Choose a commissioner or maker.');
      }
      return {
        conversation: getOrCreateAdminConversation(store, target.id, admin.id),
      };
    },
  );

  app.post(
    '/admin/disputes/:id/assign',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const { id } = request.params as { id: string };
    const admin = getCurrentUser(request, store, auth);
    const dispute = commissions.assignDispute(admin, id);
    recordAdminAudit(store, admin, 'dispute_assigned', undefined, {
      disputeId: dispute.id,
      commissionId: dispute.commissionId,
    });
    return { dispute };
    },
  );

  app.post(
    '/admin/disputes/:id/resolve',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const { id } = request.params as { id: string };
    const { outcome, resolution } = parseBody(
      request,
      z.object({
        outcome: z.enum([
          'maker_favoured',
          'commissioner_favoured',
          'split_decision',
          'commission_cancelled',
          'no_resolution',
        ]),
        resolution: z.string().trim().min(1).max(10_000),
      }),
    );
    const admin = getCurrentUser(request, store, auth);
    const dispute = commissions.resolveDispute(
      admin,
      id,
      outcome,
      resolution,
    );
    recordAdminAudit(store, admin, 'dispute_resolved', undefined, {
      disputeId: dispute.id,
      commissionId: dispute.commissionId,
      outcome,
      resolution: dispute.resolution ?? resolution,
    });
    return { dispute };
    },
  );

  app.post(
    '/admin/disputes/:id/close',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const { id } = request.params as { id: string };
    const admin = getCurrentUser(request, store, auth);
    const dispute = commissions.closeDispute(admin, id);
    recordAdminAudit(store, admin, 'dispute_closed', undefined, {
      disputeId: dispute.id,
      commissionId: dispute.commissionId,
    });
    return { dispute };
    },
  );

  Sentry.setupFastifyErrorHandler(app);
  app.addHook('onClose', async () => {
    pushWorker?.stop();
    await store.close();
  });

  return app;
}
