import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import * as Sentry from '@sentry/node';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import { DomainError, requireValue } from './domain/errors.js';
import type {
  Conversation,
  MediaAttachment,
  Message,
  User,
} from './domain/types.js';
import { AuthService, hashPassword, toPublicUser } from './services/auth-service.js';
import { CommissionService } from './services/commission-service.js';
import { MediaService } from './services/media-service.js';
import { InMemoryStore, type StoreMutation } from './store/in-memory-store.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: User['role']; scope?: 'csrf' };
    user: { sub: string; role: User['role']; scope?: 'csrf' };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    storeMutation?: StoreMutation;
  }
}

interface AppOptions {
  store?: InMemoryStore;
  jwtSecret?: string;
  corsOrigins?: string[];
  seedDemoData?: boolean;
  logger?: boolean;
  nodeEnv?: string;
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
const profileSchema = z.object({
  displayName: shortText.optional(),
  bio: z.string().trim().max(2_000).optional(),
  avatarUrl: z.string().url().max(2_048).optional(),
  pushToken: z.string().trim().max(512).optional(),
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

function getCurrentUser(request: FastifyRequest, store: InMemoryStore, auth: AuthService): User {
  const user = store.users.get(request.user.sub);
  if (!user) {
    throw new DomainError('This account has been deleted.', 403, 'ACCOUNT_DELETED');
  }
  auth.ensureActive(user);
  return user;
}

function assertAdmin(user: User): void {
  if (user.role !== 'admin') {
    throw new DomainError('Admin access required.', 403, 'FORBIDDEN');
  }
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
    createdAt,
  };
  const admin: User = {
    id: 'demo-admin',
    email: 'admin@demo.ruffl',
    passwordHash: sharedPassword,
    displayName: 'Ruffl Support',
    role: 'admin',
    status: 'active',
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

  const store = options.store ?? new InMemoryStore();
  const media = MediaService.fromEnvironment();
  if (nodeEnv === 'production' && !media) {
    throw new Error('Cloudflare R2 configuration is required in production.');
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
    trustProxy: true,
  });
  const auth = new AuthService(store);
  const commissions = new CommissionService(store);

  await app.register(helmet);
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

  app.addHook('onRequest', async (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      request.storeMutation = await store.beginMutation();
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
    await mutation.commit();
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

  app.sç}w¶‰žËkºwµçM¥Á…¹Ð¹¥€ôôôÕÍ•È¹¥(€€€€¤ì(€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È ¡½½Í”…¹½Ñ¡•È…Ñ¥Ù”µ…É­•ÑÁ±…”ÕÍ•È¸œ¤ì(€€€ô(€€€½¹ÍÐ•á¥ÍÑ¥¹œ€ôl¸¸¹ÍÑ½É”¹½¹Ù•ÉÍ…Ñ¥½¹Ì¹Ù…±Õ•Ì ¥t¹™¥¹ (€€€€€€¡½¹Ù•ÉÍ…Ñ¥½¸¤€ôø(€€€€€€€½¹Ù•ÉÍ…Ñ¥½¸¹­¥¹€ôôô€‘¥É•Ðœ€˜˜(€€€€€€€½¹Ù•ÉÍ…Ñ¥½¸¹Á…ÉÑ¥¥Á…¹Ñ%‘Ì¹±•¹Ñ €ôôô€È€˜˜(€€€€€€€½¹Ù•ÉÍ…Ñ¥½¸¹Á…ÉÑ¥¥Á…¹Ñ%‘Ì¹¥¹±Õ‘•Ì¡ÕÍ•È¹¥¤€˜˜(€€€€€€€½¹Ù•ÉÍ…Ñ¥½¸¹Á…ÉÑ¥¥Á…¹Ñ%‘Ì¹¥¹±Õ‘•Ì¡Á…ÉÑ¥¥Á…¹Ð¹¥¤°(€€€€¤ì(€€€¥˜€¡•á¥ÍÑ¥¹œ¤É•ÑÕÉ¸ì½¹Ù•ÉÍ…Ñ¥½¸è•á¥ÍÑ¥¹œôì((€€€½¹ÍÐ½¹Ù•ÉÍ…Ñ¥½¸è½¹Ù•ÉÍ…Ñ¥½¸€ôì(€€€€€¥èÉåÁÑ¼¹É…¹‘½µUU% ¤°(€€€€€­¥¹è€‘¥É•Ðœ°(€€€€€Á…ÉÑ¥¥Á…¹Ñ%‘ÌèmÕÍ•È¹¥°Á…ÉÑ¥¥Á…¹Ð¹¥‘t°(€€€€€É•…Ñ•‘Ðè¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€€€ôì(€€€ÍÑ½É”¹½¹Ù•ÉÍ…Ñ¥½¹Ì¹Í•Ð¡½¹Ù•ÉÍ…Ñ¥½¸¹¥°½¹Ù•ÉÍ…Ñ¥½¸¤ì(€€€É•ÑÕÉ¸É•Á±ä¹½‘” ÈÀÄ¤¹Í•¹¡ì½¹Ù•ÉÍ…Ñ¥½¸ô¤ì(€ô¤ì((€…ÁÀ¹Á½ÍÐ œ½ÍÕÁÁ½ÉÐ½½¹Ù•ÉÍ…Ñ¥½¸œ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ°É•Á±ä¤€ôøì(€€€½¹ÍÐÕÍ•È€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€¥˜€¡ÕÍ•È¹É½±”€ôôô€…‘µ¥¸œ¤ì(€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È UÍ”Ñ¡”…‘µ¥¸ÕÍ•ÈÑ½½±ÌÑ¼ÍÑ…ÉÐ„ÍÕÁÁ½ÉÐ½¹Ù•ÉÍ…Ñ¥½¸¸œ°€ÐÀÌ°€=I	%8œ¤ì(€€€ô(€€€½¹ÍÐ•á¥ÍÑ¥¹œ€ôl¸¸¹ÍÑ½É”¹½¹Ù•ÉÍ…Ñ¥½¹Ì¹Ù…±Õ•Ì ¥t¹™¥¹ (€€€€€€¡½¹Ù•ÉÍ…Ñ¥½¸¤€ôø(€€€€€€€½¹Ù•ÉÍ…Ñ¥½¸¹­¥¹€ôôô€…‘µ¥¸œ€˜˜½¹Ù•ÉÍ…Ñ¥½¸¹Á…ÉÑ¥¥Á…¹Ñ%‘Ì¹¥¹±Õ‘•Ì¡ÕÍ•È¹¥¤°(€€€€¤ì(€€€½¹ÍÐ½¹Ù•ÉÍ…Ñ¥½¸€ô•á¥ÍÑ¥¹œ€üü•Ñ=ÉÉ•…Ñ•‘µ¥¹½¹Ù•ÉÍ…Ñ¥½¸¡ÍÑ½É”°ÕÍ•È¹¥¤ì(€€€É•ÑÕÉ¸É•Á±ä¹½‘”¡•á¥ÍÑ¥¹œ€ü€ÈÀÀ€è€ÈÀÄ¤¹Í•¹¡ì½¹Ù•ÉÍ…Ñ¥½¸ô¤ì(€ô¤ì((€…ÁÀ¹•Ð œ½½¹Ù•ÉÍ…Ñ¥½¹Ì¼é¥½µ•ÍÍ…•Ìœ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐÕÍ•È€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€½¹ÍÐ½¹Ù•ÉÍ…Ñ¥½¸€ôÉ•ÅÕ¥É•Y…±Õ”¡ÍÑ½É”¹½¹Ù•ÉÍ…Ñ¥½¹Ì¹•Ð¡¥¤°€½¹Ù•ÉÍ…Ñ¥½¸¹½Ð™½Õ¹¸œ¤ì(€€€¥˜€¡ÕÍ•È¹É½±”€„ôô€…‘µ¥¸œ€˜˜€…½¹Ù•ÉÍ…Ñ¥½¸¹Á…ÉÑ¥¥Á…¹Ñ%‘Ì¹¥¹±Õ‘•Ì¡ÕÍ•È¹¥¤¤ì(€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È e½Ô…É”¹½ÐÁ…ÉÐ½˜Ñ¡¥Ì½¹Ù•ÉÍ…Ñ¥½¸¸œ°€ÐÀÌ°€=I	%8œ¤ì(€€€ô(€€€É•ÑÕÉ¸ìµ•ÍÍ…•ÌèÍÑ½É”¹µ•ÍÍ…•Ì¹™¥±Ñ•È ¡µ•ÍÍ…”¤€ôøµ•ÍÍ…”¹½¹Ù•ÉÍ…Ñ¥½¹%€ôôô¥¤ôì(€ô¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½½¹Ù•ÉÍ…Ñ¥½¹Ì¼é¥½µ•ÍÍ…•Ìœ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ°É•Á±ä¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ½¹Ù•ÉÍ…Ñ¥½¸€ôÉ•ÅÕ¥É•Y…±Õ”¡ÍÑ½É”¹½¹Ù•ÉÍ…Ñ¥½¹Ì¹•Ð¡¥¤°€½¹Ù•ÉÍ…Ñ¥½¸¹½Ð™½Õ¹¸œ¤ì(€€€€€¥˜€¡ÕÍ•È¹É½±”€„ôô€…‘µ¥¸œ€˜˜€…½¹Ù•ÉÍ…Ñ¥½¸¹Á…ÉÑ¥¥Á…¹Ñ%‘Ì¹¥¹±Õ‘•Ì¡ÕÍ•È¹¥¤¤ì(€€€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È e½Ô…É”¹½ÐÁ…ÉÐ½˜Ñ¡¥Ì½¹Ù•ÉÍ…Ñ¥½¸¸œ°€ÐÀÌ°€=I	%8œ¤ì(€€€€€ô(€€€€€¥˜€¡ÕÍ•È¹É½±”€ôôô€…‘µ¥¸œ¤ì(€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•‘µ¥¹ÍÉ˜¡É•ÅÕ•ÍÐ¤ì(€€€€€ô(€€€€€½¹ÍÐìÑ•áÐ°…ÑÑ…¡µ•¹ÑÌô€ôÁ…ÉÍ•	½‘ä¡É•ÅÕ•ÍÐ°µ•ÍÍ…•M¡•µ„¤ì(€€€€€¥˜€¡½¹Ù•ÉÍ…Ñ¥½¸¹­¥¹€ôôô€…‘µ¥¸œ€˜˜ÕÍ•È¹É½±”€ôôô€…‘µ¥¸œ¤ì(€€€€€€€¥˜€ …½¹Ù•ÉÍ…Ñ¥½¸¹Á…ÉÑ¥¥Á…¹Ñ%‘Ì¹¥¹±Õ‘•Ì¡ÕÍ•È¹¥¤¤ì(€€€€€€€€€½¹Ù•ÉÍ…Ñ¥½¸¹Á…ÉÑ¥¥Á…¹Ñ%‘Ì¹ÁÕÍ ¡ÕÍ•È¹¥¤ì(€€€€€€€ô(€€€€€ô(€€€€€½¹ÍÐµ•ÍÍ…”€ôÉ•…Ñ•5•ÍÍ…”¡ÍÑ½É”°½¹Ù•ÉÍ…Ñ¥½¸°ÕÍ•È°Ñ•áÐ°…ÑÑ…¡µ•¹ÑÌ¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹½‘” ÈÀÄ¤¹Í•¹¡ìµ•ÍÍ…”ô¤ì(€€€ô°(€€¤ì((€…ÁÀ¹•Ð œ½¹½Ñ¥™¥…Ñ¥½¹Ìœ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐÕÍ•È€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€É•ÑÕÉ¸ì¹½Ñ¥™¥…Ñ¥½¹ÌèÍÑ½É”¹¹½Ñ¥™¥…Ñ¥½¹Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÕÍ•É%€ôôôÕÍ•È¹¥¤ôì(€ô¤ì((€…ÁÀ¹Á½ÍÐ œ½¹½Ñ¥™¥…Ñ¥½¹Ì¼é¥½É•…œ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐÕÍ•È€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€½¹ÍÐ¹½Ñ¥™¥…Ñ¥½¸€ôÉ•ÅÕ¥É•Y…±Õ” (€€€€€ÍÑ½É”¹¹½Ñ¥™¥…Ñ¥½¹Ì¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹¥€ôôô¥€˜˜¥Ñ•´¹ÕÍ•É%€ôôôÕÍ•È¹¥¤°(€€€€€€9½Ñ¥™¥…Ñ¥½¸¹½Ð™½Õ¹¸œ°(€€€€¤ì(€€€¹½Ñ¥™¥…Ñ¥½¸¹É•…€ôÑÉÕ”ì(€€€É•ÑÕÉ¸ì¹½Ñ¥™¥…Ñ¥½¸ôì(€ô¤ì((€…ÁÀ¹Á½ÍÐ œ½Ý…É¹¥¹Ì¼é¥½É•…œ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐÕÍ•È€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€½¹ÍÐÝ…É¹¥¹œ€ôÉ•ÅÕ¥É•Y…±Õ” (€€€€€ÍÑ½É”¹Ý…É¹¥¹Ì¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹¥€ôôô¥€˜˜¥Ñ•´¹ÕÍ•É%€ôôôÕÍ•È¹¥¤°(€€€€€€]…É¹¥¹œ¹½Ð™½Õ¹¸œ°(€€€€¤ì(€€€Ý…É¹¥¹œ¹É•…€ôÑÉÕ”ì(€€€É•ÑÕÉ¸ìÝ…É¹¥¹œôì(€ô¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½ÕÁ±½…‘Ì½Í±½Ðœ°(€€€ì(€€€€€½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°(€€€€€½¹™¥œèìÉ…Ñ•1¥µ¥Ðèìµ…àè€ÈÀ°Ñ¥µ•]¥¹‘½Üè€œÄ¡½ÕÈœôô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€€€½¹ÍÐì™¥±•9…µ”°½¹Ñ•¹ÑQåÁ”°Í¥é”°…Ñ•½Éäô€ôÁ…ÉÍ•	½‘ä (€€€€€€€É•ÅÕ•ÍÐ°(€€€€€€€è¹½‰©•Ð¡ì(€€€€€€€€€™¥±•9…µ”èè¹ÍÑÉ¥¹œ ¤¹ÑÉ¥´ ¤¹µ¥¸ Ä¤¹µ…à ÈÔÔ¤°(€€€€€€€€€½¹Ñ•¹ÑQåÁ”èè¹ÍÑÉ¥¹œ ¤¹ÑÉ¥´ ¤¹µ¥¸ Ä¤¹µ…à ÄÈÀ¤°(€€€€€€€€€Í¥é”èè¹¹Õµ‰•È ¤¹¥¹Ð ¤¹Á½Í¥Ñ¥Ù” ¤¹µ…à ÄÀÀ€¨€ÄÀÈÐ€¨€ÄÀÈÐ¤°(€€€€€€€€€…Ñ•½Éäèè¹•¹Õ´¡l¥µ…”œ°€Ù¥‘•¼œ°€‘½Õµ•¹Ðœ°€…Ù…Ñ…Èœ°€‰…¹¹•Èt¤°(€€€€€€€ô¤°(€€€€€€¤ì(€€€€€½¹ÍÐ…±±½Ý•€ô(€€€€€€€…Ñ•½Éä€ôôô€Ù¥‘•¼œ(€€€€€€€€€€üÙ¥‘•½QåÁ•Ì(€€€€€€€€€€è…Ñ•½Éä€ôôô€‘½Õµ•¹Ðœ(€€€€€€€€€€€€ü‘½Õµ•¹ÑQåÁ•Ì(€€€€€€€€€€€€è¥µ…•QåÁ•Ìì(€€€€€½¹ÍÐ±¥µ¥Ð€ô(€€€€€€€…Ñ•½Éä€ôôô€Ù¥‘•¼œ€ü€ÄÀÀ€¨€ÄÀÈÐ€¨€ÄÀÈÐ€è…Ñ•½Éä€ôôô€‘½Õµ•¹Ðœ€ü€ÈÔ€¨€ÄÀÈÐ€¨€ÄÀÈÐ€è€ÄÀ€¨€ÄÀÈÐ€¨€ÄÀÈÐì(€€€€€¥˜€ ……±±½Ý•¹¥¹±Õ‘•Ì¡½¹Ñ•¹ÑQåÁ”¤ñðÍ¥é”€ðô€ÀñðÍ¥é”€ø±¥µ¥Ð¤ì(€€€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È Q¡¥Ì™¥±”ÑåÁ”½ÈÍ¥é”¥Ì¹½Ð…±±½Ý•¸œ¤ì(€€€€€ô(€€€€€½¹ÍÐÍ…™•9…µ”€ô™¥±•9…µ”¹É•Á±…” ½my„µéµhÀ´ä¹|µt½œ°€œ´œ¤ì(€€€€€½¹ÍÐ½‰©•Ñ-•ä€ô(€€€€€€€…Ñ•½Éä€ôôô€…Ù…Ñ…Èœñð…Ñ•½Éä€ôôô€‰…¹¹•Èœ(€€€€€€€€€€ü€‘í…Ñ•½ÉåõÌ¼‘íÕÍ•È¹¥‘ô¼‘íÉåÁÑ¼¹É…¹‘½µUU% ¥ô´‘íÍ…™•9…µ•õ€(€€€€€€€€€€èÕÁ±½…‘Ì¼‘íÕÍ•È¹¥‘ô¼‘íÉåÁÑ¼¹É…¹‘½µUU% ¥ô´‘íÍ…™•9…µ•õ€ì(€€€€€¥˜€ …µ•‘¥„¤ì(€€€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È (€€€€€€€€€€5•‘¥„ÕÁ±½…‘Ì…É”¹½Ð½¹™¥ÕÉ•¥¸Ñ¡¥Ì•¹Ù¥É½¹µ•¹Ð¸œ°(€€€€€€€€€€ÔÀÌ°(€€€€€€€€€€5%}9=Q}=9%UIœ°(€€€€€€€€¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸ìÍ±½Ðè…Ý…¥Ðµ•‘¥„¹É•…Ñ•UÁ±½…‘M±½Ð¡½‰©•Ñ-•ä°½¹Ñ•¹ÑQåÁ”¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹•Ð œ½…‘µ¥¸½½Ù•ÉÙ¥•Üœ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐÕÍ•È€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€…ÍÍ•ÉÑ‘µ¥¸¡ÕÍ•È¤ì(€€€É•ÑÕÉ¸ì(€€€€€½Õ¹ÑÌèì(€€€€€€€ÕÍ•ÉÌèÍÑ½É”¹ÕÍ•ÉÌ¹Í¥é”°(€€€€€€€…Ñ¥Ù•½µµ¥ÍÍ¥½¹Ìèl¸¸¹ÍÑ½É”¹½µµ¥ÍÍ¥½¹Ì¹Ù…±Õ•Ì ¥t¹™¥±Ñ•È ¡½µµ¥ÍÍ¥½¸¤€ôø(€€€€€€€€€…Ñ¥Ù•MÑ…ÑÕÍ•Ì¹¥¹±Õ‘•Ì¡½µµ¥ÍÍ¥½¸¹ÍÑ…ÑÕÌ¤°(€€€€€€€€¤¹±•¹Ñ °(€€€€€€€½Á•¹¥ÍÁÕÑ•Ìèl¸¸¹ÍÑ½É”¹‘¥ÍÁÕÑ•Ì¹Ù…±Õ•Ì ¥t¹™¥±Ñ•È ¡‘¥ÍÁÕÑ”¤€ôø(€€€€€€€€€l½Á•¸œ°€Õ¹‘•É}É•Ù¥•Üt¹¥¹±Õ‘•Ì¡‘¥ÍÁÕÑ”¹ÍÑ…ÑÕÌ¤°(€€€€€€€€¤¹±•¹Ñ °(€€€€€€€Õ¹É•…‘‘µ¥¹¡…ÑÌèl¸¸¹ÍÑ½É”¹½¹Ù•ÉÍ…Ñ¥½¹Ì¹Ù…±Õ•Ì ¥t¹™¥±Ñ•È ¡½¹Ù•ÉÍ…Ñ¥½¸¤€ôøì(€€€€€€€€€¥˜€¡½¹Ù•ÉÍ…Ñ¥½¸¹­¥¹€„ôô€…‘µ¥¸œ¤É•ÑÕÉ¸™…±Í”ì(€€€€€€€€€½¹ÍÐ±…ÍÑ5•ÍÍ…”€ôÍÑ½É”¹µ•ÍÍ…•Ì(€€€€€€€€€€€€¹™¥±Ñ•È ¡µ•ÍÍ…”¤€ôøµ•ÍÍ…”¹½¹Ù•ÉÍ…Ñ¥½¹%€ôôô½¹Ù•ÉÍ…Ñ¥½¸¹¥¤(€€€€€€€€€€€€¹…Ð ´Ä¤ì(€€€€€€€€€É•ÑÕÉ¸	½½±•…¸ (€€€€€€€€€€€±…ÍÑ5•ÍÍ…”€˜˜(€€€€€€€€€€€€€ÍÑ½É”¹ÕÍ•ÉÌ¹•Ð¡±…ÍÑ5•ÍÍ…”¹Í•¹‘•É%¤ü¹É½±”€„ôô€…‘µ¥¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô¤¹±•¹Ñ °(€€€€€ô°(€€€€€É••¹Ñ½µµ¥ÍÍ¥½¹Ìèl¸¸¹ÍÑ½É”¹½µµ¥ÍÍ¥½¹Ì¹Ù…±Õ•Ì ¥t¹Í±¥” ´Ô¤¹É•Ù•ÉÍ” ¤°(€€€€€É••¹Ñ¥ÍÁÕÑ•Ìèl¸¸¹ÍÑ½É”¹‘¥ÍÁÕÑ•Ì¹Ù…±Õ•Ì ¥t¹Í±¥” ´Ô¤¹É•Ù•ÉÍ” ¤°(€€€ôì(€ô¤ì((€…ÁÀ¹•Ð œ½…‘µ¥¸½ÍÉ˜œ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐ…‘µ¥¸€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€…ÍÍ•ÉÑ‘µ¥¸¡…‘µ¥¸¤ì(€€€É•ÑÕÉ¸ì(€€€€€ÍÉ™Q½­•¸è…ÁÀ¹©ÝÐ¹Í¥¸ (€€€€€€€ìÍÕˆè…‘µ¥¸¹¥°É½±”è…‘µ¥¸¹É½±”°Í½Á”è€ÍÉ˜œô°(€€€€€€€ì•áÁ¥É•Í%¸è€œÄÁ´œô°(€€€€€€¤°(€€€€€•áÁ¥É•Í%¹M•½¹‘Ìè€ØÀÀ°(€€€ôì(€ô¤ì((€…ÁÀ¹•Ð œ½…‘µ¥¸½ÕÍ•ÉÌœ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐ…‘µ¥¸€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€…ÍÍ•ÉÑ‘µ¥¸¡…‘µ¥¸¤ì(€€€½¹ÍÐÅÕ•Éä€ôÉ•ÅÕ•ÍÐ¹ÅÕ•Éä…ÌìÍ•…É üèÍÑÉ¥¹œìÍÑ…ÑÕÌüèUÍ•ÉlÍÑ…ÑÕÌtôì(€€€½¹ÍÐÍ•…É €ôÅÕ•Éä¹Í•…É ü¹Ñ½1½Ý•É…Í” ¤€üü€œœì(€€€É•ÑÕÉ¸ì(€€€€€ÕÍ•ÉÌèl¸¸¹ÍÑ½É”¹ÕÍ•ÉÌ¹Ù…±Õ•Ì ¥t(€€€€€€€€¹™¥±Ñ•È (€€€€€€€€€€¡ÕÍ•È¤€ôø(€€€€€€€€€€€€ …ÅÕ•Éä¹ÍÑ…ÑÕÌñðÕÍ•È¹ÍÑ…ÑÕÌ€ôôôÅÕ•Éä¹ÍÑ…ÑÕÌ¤€˜˜(€€€€€€€€€€€€ …Í•…É ñð(€€€€€€€€€€€€€ÕÍ•È¹•µ…¥°¹¥¹±Õ‘•Ì¡Í•…É ¤ñð(€€€€€€€€€€€€€ÕÍ•È¹‘¥ÍÁ±…å9…µ”¹Ñ½1½Ý•É…Í” ¤¹¥¹±Õ‘•Ì¡Í•…É ¤¤°(€€€€€€€€¤(€€€€€€€€¹µ…À¡Ñ½AÕ‰±¥UÍ•È¤°(€€€ôì(€ô¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…‘µ¥¸½ÕÍ•ÉÌ¼é¥½Ý…É¸œ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°ÁÉ•!…¹‘±•ÈèmÉ•ÅÕ¥É•‘µ¥¹ÍÉ™tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ°É•Á±ä¤€ôøì(€€€½¹ÍÐ…‘µ¥¸€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€…ÍÍ•ÉÑ‘µ¥¸¡…‘µ¥¸¤ì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€½¹ÍÐìµ•ÍÍ…”ô€ôÁ…ÉÍ•	½‘ä (€€€€€É•ÅÕ•ÍÐ°(€€€€€è¹½‰©•Ð¡ìµ•ÍÍ…”èè¹ÍÑÉ¥¹œ ¤¹ÑÉ¥´ ¤¹µ¥¸ Ä¤¹µ…à Õ|ÀÀÀ¤ô¤°(€€€€¤ì(€€€½¹ÍÐÑ…É•Ð€ôÉ•ÅÕ¥É•Y…±Õ”¡ÍÑ½É”¹ÕÍ•ÉÌ¹•Ð¡¥¤°€UÍ•È¹½Ð™½Õ¹¸œ¤ì(€€€¥˜€ …µ•ÍÍ…”¹ÑÉ¥´ ¤¤Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È ]…É¹¥¹œµ•ÍÍ…”¥ÌÉ•ÅÕ¥É•¸œ¤ì(€€€½¹ÍÐÝ…É¹¥¹œ€ôì(€€€€€¥èÉåÁÑ¼¹É…¹‘½µUU% ¤°(€€€€€ÕÍ•É%èÑ…É•Ð¹¥°(€€€€€…‘µ¥¹%è…‘µ¥¸¹¥°(€€€€€µ•ÍÍ…”èµ•ÍÍ…”¹ÑÉ¥´ ¤°(€€€€€É•…è™…±Í”°(€€€€€É•…Ñ•‘Ðè¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€€€ôì(€€€ÍÑ½É”¹Ý…É¹¥¹Ì¹ÁÕÍ ¡Ý…É¹¥¹œ¤ì(€€€ÍÑ½É”¹¹½Ñ¥™¥…Ñ¥½¹Ì¹ÁÕÍ ¡ì(€€€€€¥èÉåÁÑ¼¹É…¹‘½µUU% ¤°(€€€€€ÕÍ•É%èÑ…É•Ð¹¥°(€€€€€ÑåÁ”è€…‘µ¥¹}Ý…É¹¥¹œœ°(€€€€€Ñ¥Ñ±”è€5•ÍÍ…”™É½´IÕ™™°ÍÕÁÁ½ÉÐœ°(€€€€€‰½‘äèÝ…É¹¥¹œ¹µ•ÍÍ…”°(€€€€€É•…è™…±Í”°(€€€€€É•…Ñ•‘ÐèÝ…É¹¥¹œ¹É•…Ñ•‘Ð°(€€€ô¤ì(€€€É•…Ñ•5•ÍÍ…” (€€€€€ÍÑ½É”°(€€€€€•Ñ=ÉÉ•…Ñ•‘µ¥¹½¹Ù•ÉÍ…Ñ¥½¸¡ÍÑ½É”°Ñ…É•Ð¹¥°…‘µ¥¸¹¥¤°(€€€€€…‘µ¥¸°(€€€€€]…É¹¥¹œ™É½´IÕ™™°ÍÕÁÁ½ÉÐè€‘íÝ…É¹¥¹œ¹µ•ÍÍ…•õ€°(€€€€¤ì(€€€É•ÑÕÉ¸É•Á±ä¹½‘” ÈÀÄ¤¹Í•¹¡ìÝ…É¹¥¹œô¤ì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…‘µ¥¸½ÕÍ•ÉÌ¼é¥½ÍÕÍÁ•¹œ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°ÁÉ•!…¹‘±•ÈèmÉ•ÅÕ¥É•‘µ¥¹ÍÉ™tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐ…‘µ¥¸€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€…ÍÍ•ÉÑ‘µ¥¸¡…‘µ¥¸¤ì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€½¹ÍÐì¡½ÕÉÌ°É•…Í½¸ô€ôÁ…ÉÍ•	½‘ä (€€€€€É•ÅÕ•ÍÐ°(€€€€€è¹½‰©•Ð¡ì(€€€€€€€¡½ÕÉÌèè¹¹Õµ‰•È ¤¹™¥¹¥Ñ” ¤¹Á½Í¥Ñ¥Ù” ¤¹µ…à ÈÐ€¨€ÌØÔ¤°(€€€€€€€É•…Í½¸èè¹ÍÑÉ¥¹œ ¤¹ÑÉ¥´ ¤¹µ¥¸ Ä¤¹µ…à Õ|ÀÀÀ¤°(€€€€€ô¤°(€€€€¤ì(€€€½¹ÍÐÑ…É•Ð€ôÉ•ÅÕ¥É•Y…±Õ”¡ÍÑ½É”¹ÕÍ•ÉÌ¹•Ð¡¥¤°€UÍ•È¹½Ð™½Õ¹¸œ¤ì(€€€¥˜€¡Ñ…É•Ð¹É½±”€ôôô€…‘µ¥¸œñð¡½ÕÉÌ€ðô€Àñð€…É•…Í½¸¹ÑÉ¥´ ¤¤ì(€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È ¹Ñ•È„Á½Í¥Ñ¥Ù”‘ÕÉ…Ñ¥½¸…¹É•…Í½¸™½È„¹½¸µ…‘µ¥¸ÕÍ•È¸œ¤ì(€€€ô(€€€Ñ…É•Ð¹ÍÑ…ÑÕÌ€ô€ÍÕÍÁ•¹‘•œì(€€€Ñ…É•Ð¹ÍÕÍÁ•¹‘•‘U¹Ñ¥°€ô¹•Ü…Ñ”¡…Ñ”¹¹½Ü ¤€¬¡½ÕÉÌ€¨€Í|ØÀÁ|ÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤ì(€€€Ñ…É•Ð¹ÍÕÍÁ•¹Í¥½¹I•…Í½¸€ôÉ•…Í½¸¹ÑÉ¥´ ¤ì(€€€É•…Ñ•5•ÍÍ…” (€€€€€ÍÑ½É”°(€€€€€•Ñ=ÉÉ•…Ñ•‘µ¥¹½¹Ù•ÉÍ…Ñ¥½¸¡ÍÑ½É”°Ñ…É•Ð¹¥°…‘µ¥¸¹¥¤°(€€€€€…‘µ¥¸°(€€€€€e½ÕÈ…½Õ¹Ð¡…Ì‰••¸ÍÕÍÁ•¹‘•Õ¹Ñ¥°€‘íÑ…É•Ð¹ÍÕÍÁ•¹‘•‘U¹Ñ¥±ô¸I•…Í½¸è€‘íÑ…É•Ð¹ÍÕÍÁ•¹Í¥½¹I•…Í½¹õ€°(€€€€¤ì(€€€É•ÑÕÉ¸ìÕÍ•ÈèÑ½AÕ‰±¥UÍ•È¡Ñ…É•Ð¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…‘µ¥¸½ÕÍ•ÉÌ¼é¥½Õ¹ÍÕÍÁ•¹œ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°ÁÉ•!…¹‘±•ÈèmÉ•ÅÕ¥É•‘µ¥¹ÍÉ™tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐ…‘µ¥¸€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€…ÍÍ•ÉÑ‘µ¥¸¡…‘µ¥¸¤ì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€½¹ÍÐÑ…É•Ð€ôÉ•ÅÕ¥É•Y…±Õ”¡ÍÑ½É”¹ÕÍ•ÉÌ¹•Ð¡¥¤°€UÍ•È¹½Ð™½Õ¹¸œ¤ì(€€€Ñ…É•Ð¹ÍÑ…ÑÕÌ€ô€…Ñ¥Ù”œì(€€€‘•±•Ñ”Ñ…É•Ð¹ÍÕÍÁ•¹‘•‘U¹Ñ¥°ì(€€€‘•±•Ñ”Ñ…É•Ð¹ÍÕÍÁ•¹Í¥½¹I•…Í½¸ì(€€€É•ÑÕÉ¸ìÕÍ•ÈèÑ½AÕ‰±¥UÍ•È¡Ñ…É•Ð¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹‘•±•Ñ” (€€€€œ½…‘µ¥¸½ÕÍ•ÉÌ¼é¥œ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°ÁÉ•!…¹‘±•ÈèmÉ•ÅÕ¥É•‘µ¥¹ÍÉ™tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐ…‘µ¥¸€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€…ÍÍ•ÉÑ‘µ¥¸¡…‘µ¥¸¤ì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€½¹ÍÐ‰½‘ä€ôÁ…ÉÍ•Y…±Õ” (€€€€€É•ÅÕ•ÍÐ¹‰½‘ä€üüíô°(€€€€€è¹½‰©•Ð¡ìÁ•Éµ…¹•¹Ðèè¹‰½½±•…¸ ¤¹½ÁÑ¥½¹…° ¤ô¤°(€€€€¤ì(€€€½¹ÍÐÑ…É•Ð€ôÉ•ÅÕ¥É•Y…±Õ”¡ÍÑ½É”¹ÕÍ•ÉÌ¹•Ð¡¥¤°€UÍ•È¹½Ð™½Õ¹¸œ¤ì(€€€¥˜€¡Ñ…É•Ð¹É½±”€ôôô€…‘µ¥¸œ¤Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È ‘µ¥¸…½Õ¹ÑÌ…¹¹½Ð‰”É•µ½Ù•¡•É”¸œ¤ì(€€€¥˜€ …‰½‘ä¹Á•Éµ…¹•¹Ð¤ì(€€€€€Ñ…É•Ð¹ÍÑ…ÑÕÌ€ô€‘•±•Ñ•œì(€€€€€É•ÑÕÉ¸ì‘•±•Ñ•èÑÉÕ”°Á•Éµ…¹•¹Ðè™…±Í”ôì(€€€ô(€€€¥˜€¡Ñ…É•Ð¹ÍÑ…ÑÕÌ€„ôô€‘•±•Ñ•œ¤ì(€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È M½™Ðµ‘•±•Ñ”Ñ¡”…½Õ¹Ð‰•™½É”Á•Éµ…¹•¹Ð‘•±•Ñ¥½¸¸œ¤ì(€€€ô(€€€Ñ…É•Ð¹•µ…¥°€ô‘•±•Ñ•¬‘íÑ…É•Ð¹¥‘õ‘•±•Ñ•¹¥¹Ù…±¥‘€ì(€€€Ñ…É•Ð¹Á…ÍÍÝ½É‘!…Í €ô…Ý…¥Ð¡…Í¡A…ÍÍÝ½É¡€‘íÉåÁÑ¼¹É…¹‘½µUU% ¥ô‘íÉåÁÑ¼¹É…¹‘½µUU% ¥õ€¤ì(€€€Ñ…É•Ð¹‘¥ÍÁ±…å9…µ”€ô€•±•Ñ•ÕÍ•Èœì(€€€‘•±•Ñ”Ñ…É•Ð¹…Ù…Ñ…ÉUÉ°ì(€€€‘•±•Ñ”Ñ…É•Ð¹‰¥¼ì(€€€‘•±•Ñ”Ñ…É•Ð¹ÁÕÍ¡Q½­•¸ì(€€€‘•±•Ñ”Ñ…É•Ð¹ÍÕÍÁ•¹‘•‘U¹Ñ¥°ì(€€€‘•±•Ñ”Ñ…É•Ð¹ÍÕÍÁ•¹Í¥½¹I•…Í½¸ì(€€€ÍÑ½É”¹µ…­•ÉAÉ½™¥±•Ì¹‘•±•Ñ”¡¥¤ì(€€€ÍÑ½É”¹Ý…¥Ñ±¥ÍÐ¹ÍÁ±¥” (€€€€€€À°(€€€€€ÍÑ½É”¹Ý…¥Ñ±¥ÍÐ¹±•¹Ñ °(€€€€€€¸¸¹ÍÑ½É”¹Ý…¥Ñ±¥ÍÐ¹™¥±Ñ•È (€€€€€€€€¡¥Ñ•´¤€ôø¥Ñ•´¹µ…­•É%€„ôô¥€˜˜¥Ñ•´¹½µµ¥ÍÍ¥½¹•É%€„ôô¥°(€€€€€€¤°(€€€€¤ì(€€€ÍÑ½É”¹Ý…É¹¥¹Ì¹ÍÁ±¥” (€€€€€€À°(€€€€€ÍÑ½É”¹Ý…É¹¥¹Ì¹±•¹Ñ °(€€€€€€¸¸¹ÍÑ½É”¹Ý…É¹¥¹Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÕÍ•É%€„ôô¥€˜˜¥Ñ•´¹…‘µ¥¹%€„ôô¥¤°(€€€€¤ì(€€€ÍÑ½É”¹¹½Ñ¥™¥…Ñ¥½¹Ì¹ÍÁ±¥” (€€€€€€À°(€€€€€ÍÑ½É”¹¹½Ñ¥™¥…Ñ¥½¹Ì¹±•¹Ñ °(€€€€€€¸¸¹ÍÑ½É”¹¹½Ñ¥™¥…Ñ¥½¹Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹ÕÍ•É%€„ôô¥¤°(€€€€¤ì(€€€É•ÑÕÉ¸ì‘•±•Ñ•èÑÉÕ”°Á•Éµ…¹•¹ÐèÑÉÕ”°…¹½¹åµ¥é•èÑÉÕ”ôì(€€€ô°(€€¤ì((€…ÁÀ¹•Ð œ½…‘µ¥¸½‘¥ÍÁÕÑ•Ìœ°ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•tô°…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐ…‘µ¥¸€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€…ÍÍ•ÉÑ‘µ¥¸¡…‘µ¥¸¤ì(€€€É•ÑÕÉ¸ì(€€€€€‘¥ÍÁÕÑ•Ìèl¸¸¹ÍÑ½É”¹‘¥ÍÁÕÑ•Ì¹Ù…±Õ•Ì ¥t¹µ…À ¡‘¥ÍÁÕÑ”¤€ôø€¡ì(€€€€€€€€¸¸¹‘¥ÍÁÕÑ”°(€€€€€€€½µµ¥ÍÍ¥½¸èÍÑ½É”¹½µµ¥ÍÍ¥½¹Ì¹•Ð¡‘¥ÍÁÕÑ”¹½µµ¥ÍÍ¥½¹%¤°(€€€€€€€µ…Ñ•É¥…±ÌèÍÑ½É”¹µ…Ñ•É¥…±Ì¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹½µµ¥ÍÍ¥½¹%€ôôô‘¥ÍÁÕÑ”¹½µµ¥ÍÍ¥½¹%¤°(€€€€€ô¤¤°(€€€ôì(€ô¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…‘µ¥¸½ÕÍ•ÉÌ¼é¥½½¹Ù•ÉÍ…Ñ¥½¸œ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°ÁÉ•!…¹‘±•ÈèmÉ•ÅÕ¥É•‘µ¥¹ÍÉ™tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐ…‘µ¥¸€ô•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤ì(€€€€€…ÍÍ•ÉÑ‘µ¥¸¡…‘µ¥¸¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐÑ…É•Ð€ôÉ•ÅÕ¥É•Y…±Õ”¡ÍÑ½É”¹ÕÍ•ÉÌ¹•Ð¡¥¤°€UÍ•È¹½Ð™½Õ¹¸œ¤ì(€€€€€¥˜€¡Ñ…É•Ð¹É½±”€ôôô€…‘µ¥¸œ¤ì(€€€€€€€Ñ¡É½Ü¹•Ü½µ…¥¹ÉÉ½È ¡½½Í”„½µµ¥ÍÍ¥½¹•È½Èµ…­•È¸œ¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸ì(€€€€€€€½¹Ù•ÉÍ…Ñ¥½¸è•Ñ=ÉÉ•…Ñ•‘µ¥¹½¹Ù•ÉÍ…Ñ¥½¸¡ÍÑ½É”°Ñ…É•Ð¹¥°…‘µ¥¸¹¥¤°(€€€€€ôì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…‘µ¥¸½‘¥ÍÁÕÑ•Ì¼é¥½…ÍÍ¥¸œ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°ÁÉ•!…¹‘±•ÈèmÉ•ÅÕ¥É•‘µ¥¹ÍÉ™tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€É•ÑÕÉ¸ì‘¥ÍÁÕÑ”è½µµ¥ÍÍ¥½¹Ì¹…ÍÍ¥¹¥ÍÁÕÑ”¡•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤°¥¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…‘µ¥¸½‘¥ÍÁÕÑ•Ì¼é¥½É•Í½±Ù”œ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°ÁÉ•!…¹‘±•ÈèmÉ•ÅÕ¥É•‘µ¥¹ÍÉ™tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€½¹ÍÐì½ÕÑ½µ”°É•Í½±ÕÑ¥½¸ô€ôÁ…ÉÍ•	½‘ä (€€€€€É•ÅÕ•ÍÐ°(€€€€€è¹½‰©•Ð¡ì(€€€€€€€½ÕÑ½µ”èè¹•¹Õ´¡l(€€€€€€€€€€µ…­•É}™…Ù½ÕÉ•œ°(€€€€€€€€€€½µµ¥ÍÍ¥½¹•É}™…Ù½ÕÉ•œ°(€€€€€€€€€€ÍÁ±¥Ñ}‘•¥Í¥½¸œ°(€€€€€€€€€€½µµ¥ÍÍ¥½¹}…¹•±±•œ°(€€€€€€€€€€¹½}É•Í½±ÕÑ¥½¸œ°(€€€€€€€t¤°(€€€€€€€É•Í½±ÕÑ¥½¸èè¹ÍÑÉ¥¹œ ¤¹ÑÉ¥´ ¤¹µ¥¸ Ä¤¹µ…à ÄÁ|ÀÀÀ¤°(€€€€€ô¤°(€€€€¤ì(€€€É•ÑÕÉ¸ì(€€€€€‘¥ÍÁÕÑ”è½µµ¥ÍÍ¥½¹Ì¹É•Í½±Ù•¥ÍÁÕÑ” (€€€€€€€•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤°(€€€€€€€¥°(€€€€€€€½ÕÑ½µ”°(€€€€€€€É•Í½±ÕÑ¥½¸°(€€€€€€¤°(€€€ôì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…‘µ¥¸½‘¥ÍÁÕÑ•Ì¼é¥½±½Í”œ°(€€€ì½¹I•ÅÕ•ÍÐèm…ÁÀ¹…ÕÑ¡•¹Ñ¥…Ñ•t°ÁÉ•!…¹‘±•ÈèmÉ•ÅÕ¥É•‘µ¥¹ÍÉ™tô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€É•ÑÕÉ¸ì‘¥ÍÁÕÑ”è½µµ¥ÍÍ¥½¹Ì¹±½Í•¥ÍÁÕÑ”¡•ÑÕÉÉ•¹ÑUÍ•È¡É•ÅÕ•ÍÐ°ÍÑ½É”°…ÕÑ ¤°¥¤ôì(€€€ô°(€€¤ì((€M•¹ÑÉä¹Í•ÑÕÁ…ÍÑ¥™åÉÉ½É!…¹‘±•È¡…ÁÀ¤ì(€…ÁÀ¹…‘‘!½½¬ ½¹±½Í”œ°…Íå¹Œ€ ¤€ôøì(€€€…Ý…¥ÐÍÑ½É”¹±½Í” ¤ì(€ô¤ì((€É•ÑÕÉ¸…ÁÀì)ô