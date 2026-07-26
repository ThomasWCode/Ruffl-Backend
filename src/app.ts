import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import { DomainError, requireValue } from './domain/errors.js';
import type {
  DisputeOutcome,
  MediaAttachment,
  Review,
  SuitType,
  User,
} from './domain/types.js';
import { AuthService, hashPassword, toPublicUser } from './services/auth-service.js';
import { CommissionService } from './services/commission-service.js';
import { InMemoryStore } from './store/in-memory-store.js';

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
}

interface AppOptions {
  store?: InMemoryStore;
  jwtSecret?: string;
  corsOrigins?: string[];
  seedDemoData?: boolean;
  logger?: boolean;
}

interface AuthBody {
  email: string;
  password: string;
  displayName: string;
  role: 'commissioner' | 'maker';
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

function requireBody<T>(request: FastifyRequest): T {
  if (!request.body || typeof request.body !== 'object') {
    throw new DomainError('A JSON request body is required.');
  }
  return request.body as T;
}

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
    user: toPublicUser(user),
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
  const store = options.store ?? new InMemoryStore();
  if (options.seedDemoData ?? process.env.SEED_DEMO_DATA !== 'false') {
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
    origin:
      options.corsOrigins ??
      process.env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()) ??
      ['http://localhost:5173', 'http://localhost:8081'],
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
    secret:
      options.jwtSecret ??
      process.env.JWT_SECRET ??
      'development-only-secret-change-before-production',
    sign: { expiresIn: '30d' },
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

  app.post(
    '/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = requireBody<AuthBody>(request);
      const user = await auth.signup(body);
      const token = app.jwt.sign({ sub: user.id, role: user.role });
      return reply.code(201).send({ token, user: toPublicUser(user) });
    },
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = requireBody<Pick<AuthBody, 'email' | 'password'>>(request);
      const user = await auth.login(body.email, body.password);
      return { token: app.jwt.sign({ sub: user.id, role: user.role }), user: toPublicUser(user) };
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
    const body = requireBody<{
      displayName?: string;
      bio?: string;
      avatarUrl?: string;
      pushToken?: string;
    }>(request);
    if (body.displayName !== undefined) user.displayName = body.displayName.trim();
    if (body.bio !== undefined) user.bio = body.bio.trim();
    if (body.avatarUrl !== undefined) user.avatarUrl = body.avatarUrl;
    if (body.pushToken !== undefined) user.pushToken = body.pushToken;
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
      });
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
    const body = requireBody<Partial<typeof profile>>(request);
    Object.assign(profile, body, { userId: user.id });
    return { profile };
  });

  app.post('/makers/:makerId/waitlist', { onRequest: [app.authenticate] }, async (request, reply) => {
    const user = getCurrentUser(request, store, auth);
    const { makerId } = request.params as { makerId: string };
    const { message = '' } = requireBody<{ message?: string }>(request);
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
      requireBody<{
        makerId: string;
        title: string;
        suitType: SuitType;
        species: string;
        description: string;
        referenceNotes?: string;
        budget: number;
      }>(request),
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
      dispute: [...store.disputes.values()].find((dispute) => dispute.commissionId === id) ?? null,
    };
  });

  app.post('/commissions/:id/respond', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { accept } = requireBody<{ accept: boolean }>(request);
    return { commission: commissions.respondToRequest(getCurrentUser(request, store, auth), id, accept) };
  });

  app.post('/commissions/:id/price', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { amount, note } = requireBody<{ amount: number; note?: string }>(request);
    return {
      commission: commissions.proposePrice(getCurrentUser(request, store, auth), id, amount, note),
    };
  });

  app.post('/commissions/:id/price-response', { onRequest: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const { accept, note } = requireBody<{ accept: boolean; note?: string }>(request);
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
      const { notes, attachments } = requireBody<{
        notes: string;
        attachments?: MediaAttachment[];
      }>(request);
      return {
        milestone: commissions.postMilestoneUpdate(
          getCurrentUser(request, store, auth),
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
    const { trackingNumber } = requireBody<{ trackingNumber?: string }>(request);
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
      requireBody<Omit<Review, 'id' | 'commissionId' | 'reviewerId' | 'revieweeId' | 'createdAt'>>(
        request,
      ),
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
    const body = requireBody<{
      item: string;
      quantity: number;
      unit: string;
      costPerUnit: number;
    }>(request);
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
    const { explanation, attachments } = requireBody<{
      explanation: string;
      attachments?: MediaAttachment[];
    }>(request);
    return reply
      .code(201)
      .send({ dispute: commissions.raiseDispute(user, id, explanation, attachments) });
  });

  app.post('/disputes/:id/evidence', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const { id } = request.params as { id: string };
    const { message, attachments } = requireBody<{
      message: string;
      attachments?: MediaAttachment[];
    }>(request);
    return { dispute: commissions.addEvidence(user, id, message, attachments) };
  });

  app.get('/conversations', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    const conversations = [...store.conversations.values()].filter(
      (conversation) =>
        user.role === 'admin' ||
        conversation.participantIds.includes(user.id) ||
        conversation.kind === 'admin',
    );
    return {
      conversations: conversations.map((conversation) => ({
        ...conversation,
        lastMessage:
          store.messages
            .filter((message) => message.conversationId === conversation.id)
            .at(-1) ?? null,
      })),
    };
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
      const { text = '', attachments = [] } = requireBody<{
        text?: string;
        attachments?: MediaAttachment[];
      }>(request);
      if (!text.trim() && attachments.length === 0) {
        throw new DomainError('A message needs text or an attachment.');
      }
      const message = {
        id: crypto.randomUUID(),
        conversationId: id,
        senderId: user.id,
        text: text.trim(),
        attachments,
        createdAt: new Date().toISOString(),
      };
      store.messages.push(message);
      return reply.code(201).send({ message });
    },
  );

  app.get('/notifications', { onRequest: [app.authenticate] }, async (request) => {
    const user = getCurrentUser(request, store, auth);
    return { notifications: store.notifications.filter((item) => item.userId === user.id) };
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
      const { fileName, contentType, size, category } = requireBody<{
        fileName: string;
        contentType: string;
        size: number;
        category: 'image' | 'video' | 'document' | 'avatar' | 'banner';
      }>(request);
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
          ? `${category}s/${user.id}`
          : `uploads/${user.id}/${crypto.randomUUID()}-${safeName}`;
      const publicBase = process.env.R2_PUBLIC_URL ?? 'https://media.example.test';
      return {
        slot: {
          uploadUrl: `${publicBase}/development-upload/${objectKey}`,
          publicUrl: `${publicBase}/${objectKey}`,
          expiresInSeconds: 300,
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          developmentOnly: !process.env.R2_ACCOUNT_ID,
        },
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
        unreadAdminChats: 0,
      },
      recentCommissions: [...store.commissions.values()].slice(-5).reverse(),
      recentDisputes: [...store.disputes.values()].slice(-5).reverse(),
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
        .map(toPublicUser),
    };
  });

  app.post(
    '/admin/users/:id/warn',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request, reply) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    const { id } = request.params as { id: string };
    const { message } = requireBody<{ message: string }>(request);
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
    const { hours, reason } = requireBody<{ hours: number; reason: string }>(request);
    const target = requireValue(store.users.get(id), 'User not found.');
    if (target.role === 'admin' || hours <= 0 || !reason.trim()) {
      throw new DomainError('Enter a positive duration and reason for a non-admin user.');
    }
    target.status = 'suspended';
    target.suspendedUntil = new Date(Date.now() + hours * 3_600_000).toISOString();
    target.suspensionReason = reason.trim();
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
    const body = (request.body ?? {}) as { permanent?: boolean };
    const target = requireValue(store.users.get(id), 'User not found.');
    if (target.role === 'admin') throw new DomainError('Admin accounts cannot be removed here.');
    if (!body.permanent) {
      target.status = 'deleted';
      return { deleted: true, permanent: false };
    }
    if (target.status !== 'deleted') {
      throw new DomainError('Soft-delete the account before permanent deletion.');
    }
    const commissionIds = new Set(
      [...store.commissions.values()]
        .filter((commission) => commission.makerId === id || commission.commissionerId === id)
        .map((commission) => commission.id),
    );
    const disputeIds = new Set(
      [...store.disputes.values()]
        .filter((dispute) => commissionIds.has(dispute.commissionId) || dispute.raisedById === id)
        .map((dispute) => dispute.id),
    );
    const conversationIds = new Set(
      [...store.conversations.values()]
        .filter(
          (conversation) =>
            conversation.participantIds.includes(id) ||
            (conversation.commissionId ? commissionIds.has(conversation.commissionId) : false) ||
            (conversation.disputeId ? disputeIds.has(conversation.disputeId) : false),
        )
        .map((conversation) => conversation.id),
    );

    commissionIds.forEach((commissionId) => {
      store.commissions.delete(commissionId);
      store.milestones.delete(commissionId);
    });
    disputeIds.forEach((disputeId) => store.disputes.delete(disputeId));
    conversationIds.forEach((conversationId) => store.conversations.delete(conversationId));
    store.users.delete(id);
    store.makerProfiles.delete(id);
    store.negotiations.splice(
      0,
      store.negotiations.length,
      ...store.negotiations.filter(
        (item) => item.authorId !== id && !commissionIds.has(item.commissionId),
      ),
    );
    store.messages.splice(
      0,
      store.messages.length,
      ...store.messages.filter(
        (item) => item.senderId !== id && !conversationIds.has(item.conversationId),
      ),
    );
    store.reviews.splice(
      0,
      store.reviews.length,
      ...store.reviews.filter(
        (item) =>
          item.reviewerId !== id &&
          item.revieweeId !== id &&
          !commissionIds.has(item.commissionId),
      ),
    );
    store.materials.splice(
      0,
      store.materials.length,
      ...store.materials.filter(
        (item) => item.makerId !== id && !commissionIds.has(item.commissionId),
      ),
    );
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
    return { deleted: true, permanent: true };
    },
  );

  app.get('/admin/disputes', { onRequest: [app.authenticate] }, async (request) => {
    const admin = getCurrentUser(request, store, auth);
    assertAdmin(admin);
    return {
      disputes: [...store.disputes.values()].map((dispute) => ({
        ...dispute,
        commission: store.commissions.get(dispute.commissionId),
        materials: store.materials.filter((entry) => entry.commissionId === dispute.commissionId),
      })),
    };
  });

  app.post(
    '/admin/disputes/:id/assign',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const { id } = request.params as { id: string };
    return { dispute: commissions.assignDispute(getCurrentUser(request, store, auth), id) };
    },
  );

  app.post(
    '/admin/disputes/:id/resolve',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const { id } = request.params as { id: string };
    const { outcome, resolution } = requireBody<{
      outcome: DisputeOutcome;
      resolution: string;
    }>(request);
    return {
      dispute: commissions.resolveDispute(
        getCurrentUser(request, store, auth),
        id,
        outcome,
        resolution,
      ),
    };
    },
  );

  app.post(
    '/admin/disputes/:id/close',
    { onRequest: [app.authenticate], preHandler: [requireAdminCsrf] },
    async (request) => {
    const { id } = request.params as { id: string };
    return { dispute: commissions.closeDispute(getCurrentUser(request, store, auth), id) };
    },
  );

  return app;
}
