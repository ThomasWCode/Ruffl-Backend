import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import type {
  Commission,
  Conversation,
  Dispute,
  DisputeEvidence,
  MakerProfile,
  MaterialEntry,
  Message,
  Milestone,
  MilestoneUpdate,
  NegotiationEntry,
  Notification,
  Review,
  User,
  WaitlistEntry,
  Warning,
} from '../domain/types.js';
import { InMemoryStore, type StoreSnapshot } from './in-memory-store.js';

interface ConversationParticipant {
  key: string;
  conversationId: string;
  userId: string;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function changed<T>(
  before: T[],
  after: T[],
  key: (item: T) => string,
): { removed: T[]; upserted: T[] } {
  const beforeMap = new Map(before.map((item) => [key(item), item]));
  const afterMap = new Map(after.map((item) => [key(item), item]));
  return {
    removed: before.filter((item) => !afterMap.has(key(item))),
    upserted: after.filter((item) => {
      const previous = beforeMap.get(key(item));
      return !previous || JSON.stringify(previous) !== JSON.stringify(item);
    }),
  };
}

function milestones(snapshot: StoreSnapshot): Milestone[] {
  return snapshot.milestones.flatMap(([, items]) => items);
}

function milestoneUpdates(snapshot: StoreSnapshot): (MilestoneUpdate & { milestoneId: string })[] {
  return milestones(snapshot).flatMap((milestone) =>
    milestone.updates.map((update) => ({ ...update, milestoneId: milestone.id })),
  );
}

function disputeEvidence(snapshot: StoreSnapshot): (DisputeEvidence & { disputeId: string })[] {
  return snapshot.disputes.flatMap((dispute) =>
    dispute.evidence.map((evidence) => ({ ...evidence, disputeId: dispute.id })),
  );
}

function participants(snapshot: StoreSnapshot): ConversationParticipant[] {
  return snapshot.conversations.flatMap((conversation) =>
    conversation.participantIds.map((userId) => ({
      key: `${conversation.id}:${userId}`,
      conversationId: conversation.id,
      userId,
    })),
  );
}

export class PostgresStore extends InMemoryStore {
  override readonly persistent: boolean = true;

  private constructor(private readonly pool: Pool) {
    super();
  }

  static async connect(connectionString: string): Promise<PostgresStore> {
    const max = Number(process.env.DATABASE_POOL_MAX ?? 10);
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      throw new Error('DATABASE_POOL_MAX must be a whole number from 1 to 100.');
    }
    const pool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    const store = new PostgresStore(pool);
    await store.readinessCheck();
    await store.load();
    return store;
  }

  override async readinessCheck(): Promise<void> {
    await this.pool.query('select 1');
  }

  override async close(): Promise<void> {
    await this.pool.end();
  }

  private async load(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      this.clear();
      await this.loadUsers(client);
      await this.loadMakerProfiles(client);
      await this.loadCommissions(client);
      await this.loadMilestones(client);
      await this.loadNegotiations(client);
      await this.loadDisputes(client);
      await this.loadConversations(client);
      await this.loadMessages(client);
      await this.loadReviews(client);
      await this.loadMaterials(client);
      await this.loadWaitlist(client);
      await this.loadWarnings(client);
      await this.loadNotifications(client);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadUsers(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, email, password_hash, display_name, role, status, avatar_url, bio,
              push_token, suspended_until, suspension_reason, created_at
       from public.app_user`,
    );
    rows.forEach((row) => {
      const user: User = {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        createdAt: iso(row.created_at),
      };
      if (row.avatar_url) user.avatarUrl = row.avatar_url;
      if (row.bio) user.bio = row.bio;
      if (row.push_token) user.pushToken = row.push_token;
      if (row.suspended_until) user.suspendedUntil = iso(row.suspended_until);
      if (row.suspension_reason) user.suspensionReason = row.suspension_reason;
      this.users.set(user.id, user);
    });
  }

  private async loadMakerProfiles(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select user_id, bio, location, specialisms, base_prices, add_on_prices,
              turnaround_weeks, queue_open, verified, trusted, banner_url
       from public.maker_profile`,
    );
    rows.forEach((row) => {
      const profile: MakerProfile = {
        userId: row.user_id,
        bio: row.bio,
        location: row.location,
        specialisms: row.specialisms,
        basePrices: row.base_prices,
        addOnPrices: row.add_on_prices,
        turnaroundWeeks: row.turnaround_weeks,
        queueOpen: row.queue_open,
        verified: row.verified,
        trusted: row.trusted,
      };
      if (row.banner_url) profile.bannerUrl = row.banner_url;
      this.makerProfiles.set(profile.userId, profile);
    });
  }

  private async loadCommissions(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, commissioner_id, maker_id, title, suit_type, species, description,
              reference_notes, budget, proposed_price, agreed_total, deposit_amount,
              deposit_paid, status, tracking_number, created_at, updated_at
       from public.commission`,
    );
    rows.forEach((row) => {
      const commission: Commission = {
        id: row.id,
        commissionerId: row.commissioner_id,
        makerId: row.maker_id,
        title: row.title,
        suitType: row.suit_type,
        species: row.species,
        description: row.description,
        referenceNotes: row.reference_notes,
        budget: numberValue(row.budget),
        depositPaid: row.deposit_paid,
        status: row.status,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
      if (row.proposed_price !== null) commission.proposedPrice = numberValue(row.proposed_price);
      if (row.agreed_total !== null) commission.agreedTotal = numberValue(row.agreed_total);
      if (row.deposit_amount !== null) commission.depositAmount = numberValue(row.deposit_amount);
      if (row.tracking_number) commission.trackingNumber = row.tracking_number;
      this.commissions.set(commission.id, commission);
    });
  }

  private async loadMilestones(client: PoolClient): Promise<void> {
    const milestoneRows = (
      await client.query(
        `select id, commission_id, position, title, status, payment_amount
         from public.milestone
         order by commission_id, position`,
      )
    ).rows;
    const updateRows = (
      await client.query(
        `select id, milestone_id, author_id, notes, attachments, created_at
         from public.milestone_update
         order by created_at`,
      )
    ).rows;
    const updatesByMilestone = new Map<string, MilestoneUpdate[]>();
    updateRows.forEach((row) => {
      const items = updatesByMilestone.get(row.milestone_id) ?? [];
      items.push({
        id: row.id,
        authorId: row.author_id,
        notes: row.notes,
        attachments: row.attachments,
        createdAt: iso(row.created_at),
      });
      updatesByMilestone.set(row.milestone_id, items);
    });
    milestoneRows.forEach((row) => {
      const items = this.milestones.get(row.commission_id) ?? [];
      items.push({
        id: row.id,
        commissionId: row.commission_id,
        position: row.position,
        title: row.title,
        status: row.status,
        paymentAmount: numberValue(row.payment_amount),
        updates: updatesByMilestone.get(row.id) ?? [],
      });
      this.milestones.set(row.commission_id, items);
    });
  }

  private async loadNegotiations(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, commission_id, author_id, action, amount, note, created_at
       from public.negotiation_entry
       order by created_at`,
    );
    rows.forEach((row) => {
      const entry: NegotiationEntry = {
        id: row.id,
        commissionId: row.commission_id,
        authorId: row.author_id,
        action: row.action,
        createdAt: iso(row.created_at),
      };
      if (row.amount !== null) entry.amount = numberValue(row.amount);
      if (row.note) entry.note = row.note;
      this.negotiations.push(entry);
    });
  }

  private async loadDisputes(client: PoolClient): Promise<void> {
    const disputeRows = (
      await client.query(
        `select id, commission_id, raised_by_id, status, assigned_admin_id,
                explanation, outcome, resolution, created_at, resolved_at
         from public.dispute`,
      )
    ).rows;
    const evidenceRows = (
      await client.query(
        `select id, dispute_id, author_id, message, attachments, created_at
         from public.dispute_evidence
         order by created_at`,
      )
    ).rows;
    const evidenceByDispute = new Map<string, DisputeEvidence[]>();
    evidenceRows.forEach((row) => {
      const items = evidenceByDispute.get(row.dispute_id) ?? [];
      items.push({
        id: row.id,
        authorId: row.author_id,
        message: row.message,
        attachments: row.attachments,
        createdAt: iso(row.created_at),
      });
      evidenceByDispute.set(row.dispute_id, items);
    });
    disputeRows.forEach((row) => {
      const dispute: Dispute = {
        id: row.id,
        commissionId: row.commission_id,
        raisedById: row.raised_by_id,
        status: row.status,
        explanation: row.explanation,
        evidence: evidenceByDispute.get(row.id) ?? [],
        createdAt: iso(row.created_at),
      };
      if (row.assigned_admin_id) dispute.assignedAdminId = row.assigned_admin_id;
      if (row.outcome) dispute.outcome = row.outcome;
      if (row.resolution) dispute.resolution = row.resolution;
      if (row.resolved_at) dispute.resolvedAt = iso(row.resolved_at);
      this.disputes.set(dispute.id, dispute);
    });
  }

  private async loadConversations(client: PoolClient): Promise<void> {
    const conversationRows = (
      await client.query(
        `select id, kind, commission_id, dispute_id, created_at
         from public.conversation`,
      )
    ).rows;
    const participantRows = (
      await client.query(
        `select conversation_id, user_id
         from public.conversation_participant`,
      )
    ).rows;
    const participantsByConversation = new Map<string, string[]>();
    participantRows.forEach((row) => {
      const items = participantsByConversation.get(row.conversation_id) ?? [];
      items.push(row.user_id);
      participantsByConversation.set(row.conversation_id, items);
    });
    conversationRows.forEach((row) => {
      const conversation: Conversation = {
        id: row.id,
        kind: row.kind,
        participantIds: participantsByConversation.get(row.id) ?? [],
        createdAt: iso(row.created_at),
      };
      if (row.commission_id) conversation.commissionId = row.commission_id;
      if (row.dispute_id) conversation.disputeId = row.dispute_id;
      this.conversations.set(conversation.id, conversation);
    });
  }

  private async loadMessages(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, conversation_id, sender_id, body, attachments, created_at
       from public.message
       order by created_at`,
    );
    rows.forEach((row) =>
      this.messages.push({
        id: row.id,
        conversationId: row.conversation_id,
        senderId: row.sender_id,
        text: row.body,
        attachments: row.attachments,
        createdAt: iso(row.created_at),
      }),
    );
  }

  private async loadReviews(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, commission_id, reviewer_id, reviewee_id, quality, communication,
              accuracy, packaging, timeline, comment, created_at
       from public.review
       order by created_at`,
    );
    rows.forEach((row) =>
      this.reviews.push({
        id: row.id,
        commissionId: row.commission_id,
        reviewerId: row.reviewer_id,
        revieweeId: row.reviewee_id,
        quality: row.quality,
        communication: row.communication,
        accuracy: row.accuracy,
        packaging: row.packaging,
        timeline: row.timeline,
        comment: row.comment,
        createdAt: iso(row.created_at),
      }),
    );
  }

  private async loadMaterials(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, commission_id, maker_id, item, quantity, unit, cost_per_unit, created_at
       from public.material_entry
       order by created_at`,
    );
    rows.forEach((row) =>
      this.materials.push({
        id: row.id,
        commissionId: row.commission_id,
        makerId: row.maker_id,
        item: row.item,
        quantity: numberValue(row.quantity),
        unit: row.unit,
        costPerUnit: numberValue(row.cost_per_unit),
        createdAt: iso(row.created_at),
      }),
    );
  }

  private async loadWaitlist(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, maker_id, commissioner_id, message, created_at
       from public.waitlist_entry
       order by created_at`,
    );
    rows.forEach((row) =>
      this.waitlist.push({
        id: row.id,
        makerId: row.maker_id,
        commissionerId: row.commissioner_id,
        message: row.message,
        createdAt: iso(row.created_at),
      }),
    );
  }

  private async loadWarnings(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, user_id, admin_id, message, read, created_at
       from public.admin_warning
       order by created_at`,
    );
    rows.forEach((row) =>
      this.warnings.push({
        id: row.id,
        userId: row.user_id,
        adminId: row.admin_id,
        message: row.message,
        read: row.read,
        createdAt: iso(row.created_at),
      }),
    );
  }

  private async loadNotifications(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, user_id, type, title, body, read, created_at
       from public.notif×]º¶‰žËkºwµçA¡…¹•Ì¹Á…ÉÑ¥¥Á…¹ÑÌ¹É•µ½Ù•¤ì(€€€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€€€‘•±•Ñ”™É½´ÁÕ‰±¥Œ¹½¹Ù•ÉÍ…Ñ¥½¹}Á…ÉÑ¥¥Á…¹Ð(€€€€€€€€Ý¡•É”½¹Ù•ÉÍ…Ñ¥½¹}¥€ô€Ä…¹ÕÍ•É}¥€ô€É€°(€€€€€€€m¥Ñ•´¹½¹Ù•ÉÍ…Ñ¥½¹%°¥Ñ•´¹ÕÍ•É%‘t°(€€€€€€¤ì(€€€ô(€€€…Ý…¥ÐÉ•µ½Ù” É•Ù¥•Üœ°€¥œ°¡…¹•Ì¹É•Ù¥•ÝÌ¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€…Ý…¥ÐÉ•µ½Ù” µ…Ñ•É¥…±}•¹ÑÉäœ°€¥œ°¡…¹•Ì¹µ…Ñ•É¥…±Ì¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€…Ý…¥ÐÉ•µ½Ù” Ý…¥Ñ±¥ÍÑ}•¹ÑÉäœ°€¥œ°¡…¹•Ì¹Ý…¥Ñ±¥ÍÐ¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€…Ý…¥ÐÉ•µ½Ù” …‘µ¥¹}Ý…É¹¥¹œœ°€¥œ°¡…¹•Ì¹Ý…É¹¥¹Ì¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€…Ý…¥ÐÉ•µ½Ù” ¹½Ñ¥™¥…Ñ¥½¸œ°€¥œ°¡…¹•Ì¹¹½Ñ¥™¥…Ñ¥½¹Ì¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€…Ý…¥ÐÉ•µ½Ù” ½¹Ù•ÉÍ…Ñ¥½¸œ°€¥œ°¡…¹•Ì¹½¹Ù•ÉÍ…Ñ¥½¹Ì¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€…Ý…¥ÐÉ•µ½Ù” ‘¥ÍÁÕÑ”œ°€¥œ°¡…¹•Ì¹‘¥ÍÁÕÑ•Ì¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€…Ý…¥ÐÉ•µ½Ù” µ¥±•ÍÑ½¹”œ°€¥œ°¡…¹•Ì¹µ¥±•ÍÑ½¹•Ì¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€…Ý…¥ÐÉ•µ½Ù” ½µµ¥ÍÍ¥½¸œ°€¥œ°¡…¹•Ì¹½µµ¥ÍÍ¥½¹Ì¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€€€¥˜€¡¡…¹•Ì¹µ…­•ÉAÉ½™¥±•Ì¹É•µ½Ù•¹±•¹Ñ ¤ì(€€€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€€€‘•±•Ñ”™É½´ÁÕ‰±¥Œ¹µ…­•É}ÁÉ½™¥±”Ý¡•É”ÕÍ•É}¥€ô…¹ä ÄèéÕÕ¥‘mt¥€°(€€€€€€€m¡…¹•Ì¹µ…­•ÉAÉ½™¥±•Ì¹É•µ½Ù•¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹ÕÍ•É%¥t°(€€€€€€¤ì(€€€ô(€€€…Ý…¥ÐÉ•µ½Ù” …ÁÁ}ÕÍ•Èœ°€¥œ°¡…¹•Ì¹ÕÍ•ÉÌ¹É•µ½Ù•°€¡¥Ñ•´¤€ôø¥Ñ•´¹¥¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹Œ…ÁÁ±åUÁÍ•ÉÑÌ (€€€±¥•¹ÐèA½½±±¥•¹Ð°(€€€¡…¹•ÌèI•ÑÕÉ¹QåÁ”ñA½ÍÑÉ•ÍMÑ½É•l…±Õ±…Ñ•¡…¹•Ìtø°(€€¤èAÉ½µ¥Í”ñÙ½¥øì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹ÕÍ•ÉÌ¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑUÍ•È¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹µ…­•ÉAÉ½™¥±•Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ5…­•ÉAÉ½™¥±”¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹½µµ¥ÍÍ¥½¹Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ½µµ¥ÍÍ¥½¸¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹µ¥±•ÍÑ½¹•Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ5¥±•ÍÑ½¹”¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹µ¥±•ÍÑ½¹•UÁ‘…Ñ•Ì¹ÕÁÍ•ÉÑ•¤ì(€€€€€…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ5¥±•ÍÑ½¹•UÁ‘…Ñ”¡±¥•¹Ð°¥Ñ•´¤ì(€€€ô(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹¹•½Ñ¥…Ñ¥½¹Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ9•½Ñ¥…Ñ¥½¸¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹‘¥ÍÁÕÑ•Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ¥ÍÁÕÑ”¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹•Ù¥‘•¹”¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑÙ¥‘•¹”¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹½¹Ù•ÉÍ…Ñ¥½¹Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ½¹Ù•ÉÍ…Ñ¥½¸¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹Á…ÉÑ¥¥Á…¹ÑÌ¹ÕÁÍ•ÉÑ•¤ì(€€€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹½¹Ù•ÉÍ…Ñ¥½¹}Á…ÉÑ¥¥Á…¹Ð€¡½¹Ù•ÉÍ…Ñ¥½¹}¥°ÕÍ•É}¥¤(€€€€€€€€Ù…±Õ•Ì€ Ä°€È¤(€€€€€€€€½¸½¹™±¥Ð‘¼¹½Ñ¡¥¹€°(€€€€€€€m¥Ñ•´¹½¹Ù•ÉÍ…Ñ¥½¹%°¥Ñ•´¹ÕÍ•É%‘t°(€€€€€€¤ì(€€€ô(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹µ•ÍÍ…•Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ5•ÍÍ…”¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹É•Ù¥•ÝÌ¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑI•Ù¥•Ü¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹µ…Ñ•É¥…±Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ5…Ñ•É¥…°¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹Ý…¥Ñ±¥ÍÐ¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ]…¥Ñ±¥ÍÐ¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹Ý…É¹¥¹Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ]…É¹¥¹œ¡±¥•¹Ð°¥Ñ•´¤ì(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜¡…¹•Ì¹¹½Ñ¥™¥…Ñ¥½¹Ì¹ÕÁÍ•ÉÑ•¤…Ý…¥ÐÑ¡¥Ì¹ÕÁÍ•ÉÑ9½Ñ¥™¥…Ñ¥½¸¡±¥•¹Ð°¥Ñ•´¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑUÍ•È¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´èUÍ•È¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹…ÁÁ}ÕÍ•È€ (€€€€€€€€¥°•µ…¥°°Á…ÍÍÝ½É‘}¡…Í °‘¥ÍÁ±…å}¹…µ”°É½±”°ÍÑ…ÑÕÌ°…Ù…Ñ…É}ÕÉ°°‰¥¼°(€€€€€€€€ÁÕÍ¡}Ñ½­•¸°ÍÕÍÁ•¹‘•‘}Õ¹Ñ¥°°ÍÕÍÁ•¹Í¥½¹}É•…Í½¸°É•…Ñ•‘}…Ð°ÕÁ‘…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø°Ü°à°ä°ÄÀ°ÄÄ°ÄÈ±¹½Ü ¤¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€•µ…¥°€ô•á±Õ‘•¹•µ…¥°°(€€€€€€€€Á…ÍÍÝ½É‘}¡…Í €ô•á±Õ‘•¹Á…ÍÍÝ½É‘}¡…Í °(€€€€€€€€‘¥ÍÁ±…å}¹…µ”€ô•á±Õ‘•¹‘¥ÍÁ±…å}¹…µ”°(€€€€€€€€É½±”€ô•á±Õ‘•¹É½±”°(€€€€€€€€ÍÑ…ÑÕÌ€ô•á±Õ‘•¹ÍÑ…ÑÕÌ°(€€€€€€€€…Ù…Ñ…É}ÕÉ°€ô•á±Õ‘•¹…Ù…Ñ…É}ÕÉ°°(€€€€€€€€‰¥¼€ô•á±Õ‘•¹‰¥¼°(€€€€€€€€ÁÕÍ¡}Ñ½­•¸€ô•á±Õ‘•¹ÁÕÍ¡}Ñ½­•¸°(€€€€€€€€ÍÕÍÁ•¹‘•‘}Õ¹Ñ¥°€ô•á±Õ‘•¹ÍÕÍÁ•¹‘•‘}Õ¹Ñ¥°°(€€€€€€€€ÍÕÍÁ•¹Í¥½¹}É•…Í½¸€ô•á±Õ‘•¹ÍÕÍÁ•¹Í¥½¹}É•…Í½¸°(€€€€€€€€ÕÁ‘…Ñ•‘}…Ð€ô¹½Ü ¥€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹•µ…¥°°(€€€€€€€¥Ñ•´¹Á…ÍÍÝ½É‘!…Í °(€€€€€€€¥Ñ•´¹‘¥ÍÁ±…å9…µ”°(€€€€€€€¥Ñ•´¹É½±”°(€€€€€€€¥Ñ•´¹ÍÑ…ÑÕÌ°(€€€€€€€¥Ñ•´¹…Ù…Ñ…ÉUÉ°€üü¹Õ±°°(€€€€€€€¥Ñ•´¹‰¥¼€üü¹Õ±°°(€€€€€€€¥Ñ•´¹ÁÕÍ¡Q½­•¸€üü¹Õ±°°(€€€€€€€¥Ñ•´¹ÍÕÍÁ•¹‘•‘U¹Ñ¥°€üü¹Õ±°°(€€€€€€€¥Ñ•´¹ÍÕÍÁ•¹Í¥½¹I•…Í½¸€üü¹Õ±°°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ5…­•ÉAÉ½™¥±”¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è5…­•ÉAÉ½™¥±”¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹µ…­•É}ÁÉ½™¥±”€ (€€€€€€€€ÕÍ•É}¥°‰¥¼°±½…Ñ¥½¸°ÍÁ•¥…±¥ÍµÌ°‰…Í•}ÁÉ¥•Ì°…‘‘}½¹}ÁÉ¥•Ì°(€€€€€€€€ÑÕÉ¹…É½Õ¹‘}Ý••­Ì°ÅÕ•Õ•}½Á•¸°Ù•É¥™¥•°ÑÉÕÍÑ•°‰…¹¹•É}ÕÉ°(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø°Ü°à°ä°ÄÀ°ÄÄ¤(€€€€€€½¸½¹™±¥Ð€¡ÕÍ•É}¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€‰¥¼€ô•á±Õ‘•¹‰¥¼°(€€€€€€€€±½…Ñ¥½¸€ô•á±Õ‘•¹±½…Ñ¥½¸°(€€€€€€€€ÍÁ•¥…±¥ÍµÌ€ô•á±Õ‘•¹ÍÁ•¥…±¥ÍµÌ°(€€€€€€€€‰…Í•}ÁÉ¥•Ì€ô•á±Õ‘•¹‰…Í•}ÁÉ¥•Ì°(€€€€€€€€…‘‘}½¹}ÁÉ¥•Ì€ô•á±Õ‘•¹…‘‘}½¹}ÁÉ¥•Ì°(€€€€€€€€ÑÕÉ¹…É½Õ¹‘}Ý••­Ì€ô•á±Õ‘•¹ÑÕÉ¹…É½Õ¹‘}Ý••­Ì°(€€€€€€€€ÅÕ•Õ•}½Á•¸€ô•á±Õ‘•¹ÅÕ•Õ•}½Á•¸°(€€€€€€€€Ù•É¥™¥•€ô•á±Õ‘•¹Ù•É¥™¥•°(€€€€€€€€ÑÉÕÍÑ•€ô•á±Õ‘•¹ÑÉÕÍÑ•°(€€€€€€€€‰…¹¹•É}ÕÉ°€ô•á±Õ‘•¹‰…¹¹•É}ÕÉ±€°(€€€€€l(€€€€€€€¥Ñ•´¹ÕÍ•É%°(€€€€€€€¥Ñ•´¹‰¥¼°(€€€€€€€¥Ñ•´¹±½…Ñ¥½¸°(€€€€€€€¥Ñ•´¹ÍÁ•¥…±¥ÍµÌ°(€€€€€€€¥Ñ•´¹‰…Í•AÉ¥•Ì°(€€€€€€€¥Ñ•´¹…‘‘=¹AÉ¥•Ì°(€€€€€€€¥Ñ•´¹ÑÕÉ¹…É½Õ¹‘]••­Ì°(€€€€€€€¥Ñ•´¹ÅÕ•Õ•=Á•¸°(€€€€€€€¥Ñ•´¹Ù•É¥™¥•°(€€€€€€€¥Ñ•´¹ÑÉÕÍÑ•°(€€€€€€€¥Ñ•´¹‰…¹¹•ÉUÉ°€üü¹Õ±°°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ½µµ¥ÍÍ¥½¸¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è½µµ¥ÍÍ¥½¸¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹½µµ¥ÍÍ¥½¸€ (€€€€€€€€¥°½µµ¥ÍÍ¥½¹•É}¥°µ…­•É}¥°Ñ¥Ñ±”°ÍÕ¥Ñ}ÑåÁ”°ÍÁ•¥•Ì°‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€É•™•É•¹•}¹½Ñ•Ì°‰Õ‘•Ð°ÁÉ½Á½Í•‘}ÁÉ¥”°…É••‘}Ñ½Ñ…°°‘•Á½Í¥Ñ}…µ½Õ¹Ð°(€€€€€€€€‘•Á½Í¥Ñ}Á…¥°ÍÑ…ÑÕÌ°ÑÉ…­¥¹}¹Õµ‰•È°É•…Ñ•‘}…Ð°ÕÁ‘…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø°Ü°à°ä°ÄÀ°ÄÄ°ÄÈ°ÄÌ°ÄÐ°ÄÔ°ÄØ°ÄÜ¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€½µµ¥ÍÍ¥½¹•É}¥€ô•á±Õ‘•¹½µµ¥ÍÍ¥½¹•É}¥°(€€€€€€€€µ…­•É}¥€ô•á±Õ‘•¹µ…­•É}¥°(€€€€€€€€Ñ¥Ñ±”€ô•á±Õ‘•¹Ñ¥Ñ±”°(€€€€€€€€ÍÕ¥Ñ}ÑåÁ”€ô•á±Õ‘•¹ÍÕ¥Ñ}ÑåÁ”°(€€€€€€€€ÍÁ•¥•Ì€ô•á±Õ‘•¹ÍÁ•¥•Ì°(€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸€ô•á±Õ‘•¹‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€É•™•É•¹•}¹½Ñ•Ì€ô•á±Õ‘•¹É•™•É•¹•}¹½Ñ•Ì°(€€€€€€€€‰Õ‘•Ð€ô•á±Õ‘•¹‰Õ‘•Ð°(€€€€€€€€ÁÉ½Á½Í•‘}ÁÉ¥”€ô•á±Õ‘•¹ÁÉ½Á½Í•‘}ÁÉ¥”°(€€€€€€€€…É••‘}Ñ½Ñ…°€ô•á±Õ‘•¹…É••‘}Ñ½Ñ…°°(€€€€€€€€‘•Á½Í¥Ñ}…µ½Õ¹Ð€ô•á±Õ‘•¹‘•Á½Í¥Ñ}…µ½Õ¹Ð°(€€€€€€€€‘•Á½Í¥Ñ}Á…¥€ô•á±Õ‘•¹‘•Á½Í¥Ñ}Á…¥°(€€€€€€€€ÍÑ…ÑÕÌ€ô•á±Õ‘•¹ÍÑ…ÑÕÌ°(€€€€€€€€ÑÉ…­¥¹}¹Õµ‰•È€ô•á±Õ‘•¹ÑÉ…­¥¹}¹Õµ‰•È°(€€€€€€€€ÕÁ‘…Ñ•‘}…Ð€ô•á±Õ‘•¹ÕÁ‘…Ñ•‘}…Ñ€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹½µµ¥ÍÍ¥½¹•É%°(€€€€€€€¥Ñ•´¹µ…­•É%°(€€€€€€€¥Ñ•´¹Ñ¥Ñ±”°(€€€€€€€¥Ñ•´¹ÍÕ¥ÑQåÁ”°(€€€€€€€¥Ñ•´¹ÍÁ•¥•Ì°(€€€€€€€¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€¥Ñ•´¹É•™•É•¹•9½Ñ•Ì°(€€€€€€€¥Ñ•´¹‰Õ‘•Ð°(€€€€€€€¥Ñ•´¹ÁÉ½Á½Í•‘AÉ¥”€üü¹Õ±°°(€€€€€€€¥Ñ•´¹…É••‘Q½Ñ…°€üü¹Õ±°°(€€€€€€€¥Ñ•´¹‘•Á½Í¥Ñµ½Õ¹Ð€üü¹Õ±°°(€€€€€€€¥Ñ•´¹‘•Á½Í¥ÑA…¥°(€€€€€€€¥Ñ•´¹ÍÑ…ÑÕÌ°(€€€€€€€¥Ñ•´¹ÑÉ…­¥¹9Õµ‰•È€üü¹Õ±°°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€€€¥Ñ•´¹ÕÁ‘…Ñ•‘Ð°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ5¥±•ÍÑ½¹”¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è5¥±•ÍÑ½¹”¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹µ¥±•ÍÑ½¹”€ (€€€€€€€€¥°½µµ¥ÍÍ¥½¹}¥°Á½Í¥Ñ¥½¸°Ñ¥Ñ±”°ÍÑ…ÑÕÌ°Á…åµ•¹Ñ}…µ½Õ¹Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€½µµ¥ÍÍ¥½¹}¥€ô•á±Õ‘•¹½µµ¥ÍÍ¥½¹}¥°(€€€€€€€€Á½Í¥Ñ¥½¸€ô•á±Õ‘•¹Á½Í¥Ñ¥½¸°(€€€€€€€€Ñ¥Ñ±”€ô•á±Õ‘•¹Ñ¥Ñ±”°(€€€€€€€€ÍÑ…ÑÕÌ€ô•á±Õ‘•¹ÍÑ…ÑÕÌ°(€€€€€€€€Á…åµ•¹Ñ}…µ½Õ¹Ð€ô•á±Õ‘•¹Á…åµ•¹Ñ}…µ½Õ¹Ñ€°(€€€€€m¥Ñ•´¹¥°¥Ñ•´¹½µµ¥ÍÍ¥½¹%°¥Ñ•´¹Á½Í¥Ñ¥½¸°¥Ñ•´¹Ñ¥Ñ±”°¥Ñ•´¹ÍÑ…ÑÕÌ°¥Ñ•´¹Á…åµ•¹Ñµ½Õ¹Ñt°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ5¥±•ÍÑ½¹•UÁ‘…Ñ” (€€€±¥•¹ÐèA½½±±¥•¹Ð°(€€€¥Ñ•´è5¥±•ÍÑ½¹•UÁ‘…Ñ”€˜ìµ¥±•ÍÑ½¹•%èÍÑÉ¥¹œô°(€€¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹µ¥±•ÍÑ½¹•}ÕÁ‘…Ñ”€ (€€€€€€€€¥°µ¥±•ÍÑ½¹•}¥°…ÕÑ¡½É}¥°¹½Ñ•Ì°…ÑÑ…¡µ•¹ÑÌ°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€µ¥±•ÍÑ½¹•}¥€ô•á±Õ‘•¹µ¥±•ÍÑ½¹•}¥°(€€€€€€€€…ÕÑ¡½É}¥€ô•á±Õ‘•¹…ÕÑ¡½É}¥°(€€€€€€€€¹½Ñ•Ì€ô•á±Õ‘•¹¹½Ñ•Ì°(€€€€€€€€…ÑÑ…¡µ•¹ÑÌ€ô•á±Õ‘•¹…ÑÑ…¡µ•¹ÑÍ€°(€€€€€m¥Ñ•´¹¥°¥Ñ•´¹µ¥±•ÍÑ½¹•%°¥Ñ•´¹…ÕÑ¡½É%°¥Ñ•´¹¹½Ñ•Ì°¥Ñ•´¹…ÑÑ…¡µ•¹ÑÌ°¥Ñ•´¹É•…Ñ•‘Ñt°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ9•½Ñ¥…Ñ¥½¸¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è9•½Ñ¥…Ñ¥½¹¹ÑÉä¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹¹•½Ñ¥…Ñ¥½¹}•¹ÑÉä€ (€€€€€€€€¥°½µµ¥ÍÍ¥½¹}¥°…ÕÑ¡½É}¥°…Ñ¥½¸°…µ½Õ¹Ð°¹½Ñ”°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø°Ü¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€½µµ¥ÍÍ¥½¹}¥€ô•á±Õ‘•¹½µµ¥ÍÍ¥½¹}¥°(€€€€€€€€…ÕÑ¡½É}¥€ô•á±Õ‘•¹…ÕÑ¡½É}¥°(€€€€€€€€…Ñ¥½¸€ô•á±Õ‘•¹…Ñ¥½¸°(€€€€€€€€…µ½Õ¹Ð€ô•á±Õ‘•¹…µ½Õ¹Ð°(€€€€€€€€¹½Ñ”€ô•á±Õ‘•¹¹½Ñ•€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹½µµ¥ÍÍ¥½¹%°(€€€€€€€¥Ñ•´¹…ÕÑ¡½É%°(€€€€€€€¥Ñ•´¹…Ñ¥½¸°(€€€€€€€¥Ñ•´¹…µ½Õ¹Ð€üü¹Õ±°°(€€€€€€€¥Ñ•´¹¹½Ñ”€üü¹Õ±°°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ¥ÍÁÕÑ”¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è¥ÍÁÕÑ”¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹‘¥ÍÁÕÑ”€ (€€€€€€€€¥°½µµ¥ÍÍ¥½¹}¥°É…¥Í•‘}‰å}¥°ÍÑ…ÑÕÌ°…ÍÍ¥¹•‘}…‘µ¥¹}¥°(€€€€€€€€•áÁ±…¹…Ñ¥½¸°½ÕÑ½µ”°É•Í½±ÕÑ¥½¸°É•…Ñ•‘}…Ð°É•Í½±Ù•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø°Ü°à°ä°ÄÀ¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€½µµ¥ÍÍ¥½¹}¥€ô•á±Õ‘•¹½µµ¥ÍÍ¥½¹}¥°(€€€€€€€€É…¥Í•‘}‰å}¥€ô•á±Õ‘•¹É…¥Í•‘}‰å}¥°(€€€€€€€€ÍÑ…ÑÕÌ€ô•á±Õ‘•¹ÍÑ…ÑÕÌ°(€€€€€€€€…ÍÍ¥¹•‘}…‘µ¥¹}¥€ô•á±Õ‘•¹…ÍÍ¥¹•‘}…‘µ¥¹}¥°(€€€€€€€€•áÁ±…¹…Ñ¥½¸€ô•á±Õ‘•¹•áÁ±…¹…Ñ¥½¸°(€€€€€€€€½ÕÑ½µ”€ô•á±Õ‘•¹½ÕÑ½µ”°(€€€€€€€€É•Í½±ÕÑ¥½¸€ô•á±Õ‘•¹É•Í½±ÕÑ¥½¸°(€€€€€€€€É•Í½±Ù•‘}…Ð€ô•á±Õ‘•¹É•Í½±Ù•‘}…Ñ€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹½µµ¥ÍÍ¥½¹%°(€€€€€€€¥Ñ•´¹É…¥Í•‘	å%°(€€€€€€€¥Ñ•´¹ÍÑ…ÑÕÌ°(€€€€€€€¥Ñ•´¹…ÍÍ¥¹•‘‘µ¥¹%€üü¹Õ±°°(€€€€€€€¥Ñ•´¹•áÁ±…¹…Ñ¥½¸°(€€€€€€€¥Ñ•´¹½ÕÑ½µ”€üü¹Õ±°°(€€€€€€€¥Ñ•´¹É•Í½±ÕÑ¥½¸€üü¹Õ±°°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€€€¥Ñ•´¹É•Í½±Ù•‘Ð€üü¹Õ±°°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑÙ¥‘•¹” (€€€±¥•¹ÐèA½½±±¥•¹Ð°(€€€¥Ñ•´è¥ÍÁÕÑ•Ù¥‘•¹”€˜ì‘¥ÍÁÕÑ•%èÍÑÉ¥¹œô°(€€¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹‘¥ÍÁÕÑ•}•Ù¥‘•¹”€ (€€€€€€€€¥°‘¥ÍÁÕÑ•}¥°…ÕÑ¡½É}¥°µ•ÍÍ…”°…ÑÑ…¡µ•¹ÑÌ°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€‘¥ÍÁÕÑ•}¥€ô•á±Õ‘•¹‘¥ÍÁÕÑ•}¥°(€€€€€€€€…ÕÑ¡½É}¥€ô•á±Õ‘•¹…ÕÑ¡½É}¥°(€€€€€€€€µ•ÍÍ…”€ô•á±Õ‘•¹µ•ÍÍ…”°(€€€€€€€€…ÑÑ…¡µ•¹ÑÌ€ô•á±Õ‘•¹…ÑÑ…¡µ•¹ÑÍ€°(€€€€€m¥Ñ•´¹¥°¥Ñ•´¹‘¥ÍÁÕÑ•%°¥Ñ•´¹…ÕÑ¡½É%°¥Ñ•´¹µ•ÍÍ…”°¥Ñ•´¹…ÑÑ…¡µ•¹ÑÌ°¥Ñ•´¹É•…Ñ•‘Ñt°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ½¹Ù•ÉÍ…Ñ¥½¸¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è½¹Ù•ÉÍ…Ñ¥½¸¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹½¹Ù•ÉÍ…Ñ¥½¸€ (€€€€€€€€¥°­¥¹°½µµ¥ÍÍ¥½¹}¥°‘¥ÍÁÕÑ•}¥°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€­¥¹€ô•á±Õ‘•¹­¥¹°(€€€€€€€€½µµ¥ÍÍ¥½¹}¥€ô•á±Õ‘•¹½µµ¥ÍÍ¥½¹}¥°(€€€€€€€€‘¥ÍÁÕÑ•}¥€ô•á±Õ‘•¹‘¥ÍÁÕÑ•}¥‘€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹­¥¹°(€€€€€€€¥Ñ•´¹½µµ¥ÍÍ¥½¹%€üü¹Õ±°°(€€€€€€€¥Ñ•´¹‘¥ÍÁÕÑ•%€üü¹Õ±°°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ5•ÍÍ…”¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è5•ÍÍ…”¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹µ•ÍÍ…”€ (€€€€€€€€¥°½¹Ù•ÉÍ…Ñ¥½¹}¥°Í•¹‘•É}¥°‰½‘ä°…ÑÑ…¡µ•¹ÑÌ°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€½¹Ù•ÉÍ…Ñ¥½¹}¥€ô•á±Õ‘•¹½¹Ù•ÉÍ…Ñ¥½¹}¥°(€€€€€€€€Í•¹‘•É}¥€ô•á±Õ‘•¹Í•¹‘•É}¥°(€€€€€€€€‰½‘ä€ô•á±Õ‘•¹‰½‘ä°(€€€€€€€€…ÑÑ…¡µ•¹ÑÌ€ô•á±Õ‘•¹…ÑÑ…¡µ•¹ÑÍ€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹½¹Ù•ÉÍ…Ñ¥½¹%°(€€€€€€€¥Ñ•´¹Í•¹‘•É%°(€€€€€€€¥Ñ•´¹Ñ•áÐ°(€€€€€€€¥Ñ•´¹…ÑÑ…¡µ•¹ÑÌ°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑI•Ù¥•Ü¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´èI•Ù¥•Ü¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹É•Ù¥•Ü€ (€€€€€€€€¥°½µµ¥ÍÍ¥½¹}¥°É•Ù¥•Ý•É}¥°É•Ù¥•Ý••}¥°ÅÕ…±¥Ñä°½µµÕ¹¥…Ñ¥½¸°(€€€€€€€€…ÕÉ…ä°Á…­…¥¹œ°Ñ¥µ•±¥¹”°½µµ•¹Ð°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø°Ü°à°ä°ÄÀ°ÄÄ¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€ÅÕ…±¥Ñä€ô•á±Õ‘•¹ÅÕ…±¥Ñä°(€€€€€€€€½µµÕ¹¥…Ñ¥½¸€ô•á±Õ‘•¹½µµÕ¹¥…Ñ¥½¸°(€€€€€€€€…ÕÉ…ä€ô•á±Õ‘•¹…ÕÉ…ä°(€€€€€€€€Á…­…¥¹œ€ô•á±Õ‘•¹Á…­…¥¹œ°(€€€€€€€€Ñ¥µ•±¥¹”€ô•á±Õ‘•¹Ñ¥µ•±¥¹”°(€€€€€€€€½µµ•¹Ð€ô•á±Õ‘•¹½µµ•¹Ñ€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹½µµ¥ÍÍ¥½¹%°(€€€€€€€¥Ñ•´¹É•Ù¥•Ý•É%°(€€€€€€€¥Ñ•´¹É•Ù¥•Ý••%°(€€€€€€€¥Ñ•´¹ÅÕ…±¥Ñä°(€€€€€€€¥Ñ•´¹½µµÕ¹¥…Ñ¥½¸°(€€€€€€€¥Ñ•´¹…ÕÉ…ä°(€€€€€€€¥Ñ•´¹Á…­…¥¹œ°(€€€€€€€¥Ñ•´¹Ñ¥µ•±¥¹”°(€€€€€€€¥Ñ•´¹½µµ•¹Ð°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ5…Ñ•É¥…°¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è5…Ñ•É¥…±¹ÑÉä¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹µ…Ñ•É¥…±}•¹ÑÉä€ (€€€€€€€€¥°½µµ¥ÍÍ¥½¹}¥°µ…­•É}¥°¥Ñ•´°ÅÕ…¹Ñ¥Ñä°Õ¹¥Ð°½ÍÑ}Á•É}Õ¹¥Ð°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø°Ü°à¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€¥Ñ•´€ô•á±Õ‘•¹¥Ñ•´°(€€€€€€€€ÅÕ…¹Ñ¥Ñä€ô•á±Õ‘•¹ÅÕ…¹Ñ¥Ñä°(€€€€€€€€Õ¹¥Ð€ô•á±Õ‘•¹Õ¹¥Ð°(€€€€€€€€½ÍÑ}Á•É}Õ¹¥Ð€ô•á±Õ‘•¹½ÍÑ}Á•É}Õ¹¥Ñ€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹½µµ¥ÍÍ¥½¹%°(€€€€€€€¥Ñ•´¹µ…­•É%°(€€€€€€€¥Ñ•´¹¥Ñ•´°(€€€€€€€¥Ñ•´¹ÅÕ…¹Ñ¥Ñä°(€€€€€€€¥Ñ•´¹Õ¹¥Ð°(€€€€€€€¥Ñ•´¹½ÍÑA•ÉU¹¥Ð°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€t°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ]…¥Ñ±¥ÍÐ¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è]…¥Ñ±¥ÍÑ¹ÑÉä¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹Ý…¥Ñ±¥ÍÑ}•¹ÑÉä€ (€€€€€€€€¥°µ…­•É}¥°½µµ¥ÍÍ¥½¹•É}¥°µ•ÍÍ…”°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€µ…­•É}¥€ô•á±Õ‘•¹µ…­•É}¥°(€€€€€€€€½µµ¥ÍÍ¥½¹•É}¥€ô•á±Õ‘•¹½µµ¥ÍÍ¥½¹•É}¥°(€€€€€€€€µ•ÍÍ…”€ô•á±Õ‘•¹µ•ÍÍ…•€°(€€€€€m¥Ñ•´¹¥°¥Ñ•´¹µ…­•É%°¥Ñ•´¹½µµ¥ÍÍ¥½¹•É%°¥Ñ•´¹µ•ÍÍ…”°¥Ñ•´¹É•…Ñ•‘Ñt°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ]…É¹¥¹œ¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è]…É¹¥¹œ¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹…‘µ¥¹}Ý…É¹¥¹œ€ (€€€€€€€€¥°ÕÍ•É}¥°…‘µ¥¹}¥°µ•ÍÍ…”°É•…°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€µ•ÍÍ…”€ô•á±Õ‘•¹µ•ÍÍ…”°(€€€€€€€€É•…€ô•á±Õ‘•¹É•…‘€°(€€€€€m¥Ñ•´¹¥°¥Ñ•´¹ÕÍ•É%°¥Ñ•´¹…‘µ¥¹%°¥Ñ•´¹µ•ÍÍ…”°¥Ñ•´¹É•…°¥Ñ•´¹É•…Ñ•‘Ñt°(€€€€¤ì(€ô((€ÁÉ¥Ù…Ñ”…Íå¹ŒÕÁÍ•ÉÑ9½Ñ¥™¥…Ñ¥½¸¡±¥•¹ÐèA½½±±¥•¹Ð°¥Ñ•´è9½Ñ¥™¥…Ñ¥½¸¤èAÉ½µ¥Í”ñÙ½¥øì(€€€…Ý…¥Ð±¥•¹Ð¹ÅÕ•Éä (€€€€€¥¹Í•ÉÐ¥¹Ñ¼ÁÕ‰±¥Œ¹¹½Ñ¥™¥…Ñ¥½¸€ (€€€€€€€€¥°ÕÍ•É}¥°ÑåÁ”°Ñ¥Ñ±”°‰½‘ä°É•…°É•…Ñ•‘}…Ð(€€€€€€€¤Ù…±Õ•Ì€ Ä°È°Ì°Ð°Ô°Ø°Ü¤(€€€€€€½¸½¹™±¥Ð€¡¥¤‘¼ÕÁ‘…Ñ”Í•Ð(€€€€€€€€ÑåÁ”€ô•á±Õ‘•¹ÑåÁ”°(€€€€€€€€Ñ¥Ñ±”€ô•á±Õ‘•¹Ñ¥Ñ±”°(€€€€€€€€‰½‘ä€ô•á±Õ‘•¹‰½‘ä°(€€€€€€€€É•…€ô•á±Õ‘•¹É•…‘€°(€€€€€l(€€€€€€€¥Ñ•´¹¥°(€€€€€€€¥Ñ•´¹ÕÍ•É%°(€€€€€€€¥Ñ•´¹ÑåÁ”°(€€€€€€€¥Ñ•´¹Ñ¥Ñ±”°(€€€€€€€¥Ñ•´¹‰½‘ä°(€€€€€€€¥Ñ•´¹É•…°(€€€€€€€¥Ñ•´¹É•…Ñ•‘Ð°(€€€€€t°(€€€€¤ì(€ô)ô