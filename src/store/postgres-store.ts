import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import type {
  AdminAuditEvent,
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
  PushDelivery,
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
      await this.loadAdminAuditEvents(client);
      await this.loadNotifications(client);
      await this.loadPushDeliveries(client);
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
              push_token, suspended_until, suspension_reason, email_verified_at, created_at
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
      if (row.email_verified_at) user.emailVerifiedAt = iso(row.email_verified_at);
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
              deposit_paid, status, status_before_dispute, tracking_number,
              created_at, updated_at
       from public.commission
       order by created_at, id`,
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
      if (row.status_before_dispute) {
        commission.statusBeforeDispute = row.status_before_dispute;
      }
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
         from public.dispute
         order by created_at, id`,
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
         from public.conversation
         order by created_at, id`,
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

  private async loadAdminAuditEvents(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, admin_id, target_user_id, action, details, created_at
       from public.admin_audit_event
       order by created_at, id`,
    );
    rows.forEach((row) => {
      const event: AdminAuditEvent = {
        id: row.id,
        adminId: row.admin_id,
        action: row.action,
        details: row.details,
        createdAt: iso(row.created_at),
      };
      if (row.target_user_id) event.targetUserId = row.target_user_id;
      this.adminAuditEvents.push(event);
    });
  }

  private async loadNotifications(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, user_id, type, title, body, read, created_at
       from public.notification
       order by created_at`,
    );
    rows.forEach((row) =>
      this.notifications.push({
        id: row.id,
        userId: row.user_id,
        type: row.type,
        title: row.title,
        body: row.body,
        read: row.read,
        createdAt: iso(row.created_at),
      }),
    );
  }

  private async loadPushDeliveries(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select id, notification_id, user_id, push_token, status, receipt_id,
              attempts, next_attempt_at, last_error, created_at
       from public.push_delivery
       order by created_at`,
    );
    rows.forEach((row) => {
      const delivery: PushDelivery = {
        id: row.id,
        notificationId: row.notification_id,
        userId: row.user_id,
        pushToken: row.push_token,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: iso(row.next_attempt_at),
        createdAt: iso(row.created_at),
      };
      if (row.receipt_id) delivery.receiptId = row.receipt_id;
      if (row.last_error) delivery.lastError = row.last_error;
      this.pushDeliveries.set(delivery.id, delivery);
    });
  }

  protected override async persistChanges(
    before: StoreSnapshot,
    after: StoreSnapshot,
  ): Promise<void> {
    const changes = this.calculateChanges(before, after);
    if (!Object.values(changes).some((change) => change.removed.length || change.upserted.length)) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.applyDeletes(client, changes);
      await this.applyUpserts(client, changes);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private calculateChanges(before: StoreSnapshot, after: StoreSnapshot) {
    return {
      users: changed(before.users, after.users, (item) => item.id),
      makerProfiles: changed(
        before.makerProfiles,
        after.makerProfiles,
        (item) => item.userId,
      ),
      commissions: changed(before.commissions, after.commissions, (item) => item.id),
      milestones: changed(milestones(before), milestones(after), (item) => item.id),
      milestoneUpdates: changed(
        milestoneUpdates(before),
        milestoneUpdates(after),
        (item) => item.id,
      ),
      negotiations: changed(before.negotiations, after.negotiations, (item) => item.id),
      conversations: changed(before.conversations, after.conversations, (item) => item.id),
      participants: changed(participants(before), participants(after), (item) => item.key),
      messages: changed(before.messages, after.messages, (item) => item.id),
      reviews: changed(before.reviews, after.reviews, (item) => item.id),
      materials: changed(before.materials, after.materials, (item) => item.id),
      waitlist: changed(before.waitlist, after.waitlist, (item) => item.id),
      disputes: changed(before.disputes, after.disputes, (item) => item.id),
      evidence: changed(disputeEvidence(before), disputeEvidence(after), (item) => item.id),
      warnings: changed(before.warnings, after.warnings, (item) => item.id),
      adminAuditEvents: changed(
        before.adminAuditEvents,
        after.adminAuditEvents,
        (item) => item.id,
      ),
      notifications: changed(before.notifications, after.notifications, (item) => item.id),
      pushDeliveries: changed(
        before.pushDeliveries,
        after.pushDeliveries,
        (item) => item.id,
      ),
    };
  }

  private async applyDeletes(
    client: PoolClient,
    changes: ReturnType<PostgresStore['calculateChanges']>,
  ): Promise<void> {
    const remove = async <T>(
      table: string,
      column: string,
      items: T[],
      value: (item: T) => string,
    ) => {
      if (!items.length) return;
      await client.query(
        `delete from public.${table} where ${column} = any($1::uuid[])`,
        [items.map(value)],
      );
    };

    await remove('message', 'id', changes.messages.removed, (item) => item.id);
    await remove('dispute_evidence', 'id', changes.evidence.removed, (item) => item.id);
    await remove(
      'milestone_update',
      'id',
      changes.milestoneUpdates.removed,
      (item) => item.id,
    );
    await remove(
      'negotiation_entry',
      'id',
      changes.negotiations.removed,
      (item) => item.id,
    );
    for (const item of changes.participants.removed) {
      await client.query(
        `delete from public.conversation_participant
         where conversation_id = $1 and user_id = $2`,
        [item.conversationId, item.userId],
      );
    }
    await remove('review', 'id', changes.reviews.removed, (item) => item.id);
    await remove('material_entry', 'id', changes.materials.removed, (item) => item.id);
    await remove('waitlist_entry', 'id', changes.waitlist.removed, (item) => item.id);
    await remove('admin_warning', 'id', changes.warnings.removed, (item) => item.id);
    await remove(
      'admin_audit_event',
      'id',
      changes.adminAuditEvents.removed,
      (item) => item.id,
    );
    await remove(
      'push_delivery',
      'id',
      changes.pushDeliveries.removed,
      (item) => item.id,
    );
    await remove('notification', 'id', changes.notifications.removed, (item) => item.id);
    await remove('conversation', 'id', changes.conversations.removed, (item) => item.id);
    await remove('dispute', 'id', changes.disputes.removed, (item) => item.id);
    await remove('milestone', 'id', changes.milestones.removed, (item) => item.id);
    await remove('commission', 'id', changes.commissions.removed, (item) => item.id);
    if (changes.makerProfiles.removed.length) {
      await client.query(
        `delete from public.maker_profile where user_id = any($1::uuid[])`,
        [changes.makerProfiles.removed.map((item) => item.userId)],
      );
    }
    await remove('app_user', 'id', changes.users.removed, (item) => item.id);
  }

  private async applyUpserts(
    client: PoolClient,
    changes: ReturnType<PostgresStore['calculateChanges']>,
  ): Promise<void> {
    for (const item of changes.users.upserted) await this.upsertUser(client, item);
    for (const item of changes.makerProfiles.upserted) await this.upsertMakerProfile(client, item);
    for (const item of changes.commissions.upserted) await this.upsertCommission(client, item);
    for (const item of changes.milestones.upserted) await this.upsertMilestone(client, item);
    for (const item of changes.milestoneUpdates.upserted) {
      await this.upsertMilestoneUpdate(client, item);
    }
    for (const item of changes.negotiations.upserted) await this.upsertNegotiation(client, item);
    for (const item of changes.disputes.upserted) await this.upsertDispute(client, item);
    for (const item of changes.evidence.upserted) await this.upsertEvidence(client, item);
    for (const item of changes.conversations.upserted) await this.upsertConversation(client, item);
    for (const item of changes.participants.upserted) {
      await client.query(
        `insert into public.conversation_participant (conversation_id, user_id)
         values ($1, $2)
         on conflict do nothing`,
        [item.conversationId, item.userId],
      );
    }
    for (const item of changes.messages.upserted) await this.upsertMessage(client, item);
    for (const item of changes.reviews.upserted) await this.upsertReview(client, item);
    for (const item of changes.materials.upserted) await this.upsertMaterial(client, item);
    for (const item of changes.waitlist.upserted) await this.upsertWaitlist(client, item);
    for (const item of changes.warnings.upserted) await this.upsertWarning(client, item);
    for (const item of changes.adminAuditEvents.upserted) {
      await this.upsertAdminAuditEvent(client, item);
    }
    for (const item of changes.notifications.upserted) await this.upsertNotification(client, item);
    for (const item of changes.pushDeliveries.upserted) {
      await this.upsertPushDelivery(client, item);
    }
  }

  private async upsertUser(client: PoolClient, item: User): Promise<void> {
    await client.query(
      `insert into public.app_user (
         id, email, password_hash, display_name, role, status, avatar_url, bio,
         push_token, suspended_until, suspension_reason, email_verified_at, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       on conflict (id) do update set
         email = excluded.email,
         password_hash = excluded.password_hash,
         display_name = excluded.display_name,
         role = excluded.role,
         status = excluded.status,
         avatar_url = excluded.avatar_url,
         bio = excluded.bio,
         push_token = excluded.push_token,
         suspended_until = excluded.suspended_until,
         suspension_reason = excluded.suspension_reason,
         email_verified_at = excluded.email_verified_at,
         updated_at = now()`,
      [
        item.id,
        item.email,
        item.passwordHash,
        item.displayName,
        item.role,
        item.status,
        item.avatarUrl ?? null,
        item.bio ?? null,
        item.pushToken ?? null,
        item.suspendedUntil ?? null,
        item.suspensionReason ?? null,
        item.emailVerifiedAt ?? null,
        item.createdAt,
      ],
    );
  }

  private async upsertMakerProfile(client: PoolClient, item: MakerProfile): Promise<void> {
    await client.query(
      `insert into public.maker_profile (
         user_id, bio, location, specialisms, base_prices, add_on_prices,
         turnaround_weeks, queue_open, verified, trusted, banner_url
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (user_id) do update set
         bio = excluded.bio,
         location = excluded.location,
         specialisms = excluded.specialisms,
         base_prices = excluded.base_prices,
         add_on_prices = excluded.add_on_prices,
         turnaround_weeks = excluded.turnaround_weeks,
         queue_open = excluded.queue_open,
         verified = excluded.verified,
         trusted = excluded.trusted,
         banner_url = excluded.banner_url`,
      [
        item.userId,
        item.bio,
        item.location,
        item.specialisms,
        item.basePrices,
        item.addOnPrices,
        item.turnaroundWeeks,
        item.queueOpen,
        item.verified,
        item.trusted,
        item.bannerUrl ?? null,
      ],
    );
  }

  private async upsertCommission(client: PoolClient, item: Commission): Promise<void> {
    await client.query(
      `insert into public.commission (
         id, commissioner_id, maker_id, title, suit_type, species, description,
         reference_notes, budget, proposed_price, agreed_total, deposit_amount,
         deposit_paid, status, status_before_dispute, tracking_number,
         created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       on conflict (id) do update set
         commissioner_id = excluded.commissioner_id,
         maker_id = excluded.maker_id,
         title = excluded.title,
         suit_type = excluded.suit_type,
         species = excluded.species,
         description = excluded.description,
         reference_notes = excluded.reference_notes,
         budget = excluded.budget,
         proposed_price = excluded.proposed_price,
         agreed_total = excluded.agreed_total,
         deposit_amount = excluded.deposit_amount,
         deposit_paid = excluded.deposit_paid,
         status = excluded.status,
         status_before_dispute = excluded.status_before_dispute,
         tracking_number = excluded.tracking_number,
         updated_at = excluded.updated_at`,
      [
        item.id,
        item.commissionerId,
        item.makerId,
        item.title,
        item.suitType,
        item.species,
        item.description,
        item.referenceNotes,
        item.budget,
        item.proposedPrice ?? null,
        item.agreedTotal ?? null,
        item.depositAmount ?? null,
        item.depositPaid,
        item.status,
        item.statusBeforeDispute ?? null,
        item.trackingNumber ?? null,
        item.createdAt,
        item.updatedAt,
      ],
    );
  }

  private async upsertMilestone(client: PoolClient, item: Milestone): Promise<void> {
    await client.query(
      `insert into public.milestone (
         id, commission_id, position, title, status, payment_amount
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         commission_id = excluded.commission_id,
         position = excluded.position,
         title = excluded.title,
         status = excluded.status,
         payment_amount = excluded.payment_amount`,
      [item.id, item.commissionId, item.position, item.title, item.status, item.paymentAmount],
    );
  }

  private async upsertMilestoneUpdate(
    client: PoolClient,
    item: MilestoneUpdate & { milestoneId: string },
  ): Promise<void> {
    await client.query(
      `insert into public.milestone_update (
         id, milestone_id, author_id, notes, attachments, created_at
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         milestone_id = excluded.milestone_id,
         author_id = excluded.author_id,
         notes = excluded.notes,
         attachments = excluded.attachments`,
      [item.id, item.milestoneId, item.authorId, item.notes, item.attachments, item.createdAt],
    );
  }

  private async upsertNegotiation(client: PoolClient, item: NegotiationEntry): Promise<void> {
    await client.query(
      `insert into public.negotiation_entry (
         id, commission_id, author_id, action, amount, note, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set
         commission_id = excluded.commission_id,
         author_id = excluded.author_id,
         action = excluded.action,
         amount = excluded.amount,
         note = excluded.note`,
      [
        item.id,
        item.commissionId,
        item.authorId,
        item.action,
        item.amount ?? null,
        item.note ?? null,
        item.createdAt,
      ],
    );
  }

  private async upsertDispute(client: PoolClient, item: Dispute): Promise<void> {
    await client.query(
      `insert into public.dispute (
         id, commission_id, raised_by_id, status, assigned_admin_id,
         explanation, outcome, resolution, created_at, resolved_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do update set
         commission_id = excluded.commission_id,
         raised_by_id = excluded.raised_by_id,
         status = excluded.status,
         assigned_admin_id = excluded.assigned_admin_id,
         explanation = excluded.explanation,
         outcome = excluded.outcome,
         resolution = excluded.resolution,
         resolved_at = excluded.resolved_at`,
      [
        item.id,
        item.commissionId,
        item.raisedById,
        item.status,
        item.assignedAdminId ?? null,
        item.explanation,
        item.outcome ?? null,
        item.resolution ?? null,
        item.createdAt,
        item.resolvedAt ?? null,
      ],
    );
  }

  private async upsertEvidence(
    client: PoolClient,
    item: DisputeEvidence & { disputeId: string },
  ): Promise<void> {
    await client.query(
      `insert into public.dispute_evidence (
         id, dispute_id, author_id, message, attachments, created_at
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         dispute_id = excluded.dispute_id,
         author_id = excluded.author_id,
         message = excluded.message,
         attachments = excluded.attachments`,
      [item.id, item.disputeId, item.authorId, item.message, item.attachments, item.createdAt],
    );
  }

  private async upsertConversation(client: PoolClient, item: Conversation): Promise<void> {
    await client.query(
      `insert into public.conversation (
         id, kind, commission_id, dispute_id, created_at
       ) values ($1,$2,$3,$4,$5)
       on conflict (id) do update set
         kind = excluded.kind,
         commission_id = excluded.commission_id,
         dispute_id = excluded.dispute_id`,
      [
        item.id,
        item.kind,
        item.commissionId ?? null,
        item.disputeId ?? null,
        item.createdAt,
      ],
    );
  }

  private async upsertMessage(client: PoolClient, item: Message): Promise<void> {
    await client.query(
      `insert into public.message (
         id, conversation_id, sender_id, body, attachments, created_at
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         conversation_id = excluded.conversation_id,
         sender_id = excluded.sender_id,
         body = excluded.body,
         attachments = excluded.attachments`,
      [
        item.id,
        item.conversationId,
        item.senderId,
        item.text,
        item.attachments,
        item.createdAt,
      ],
    );
  }

  private async upsertReview(client: PoolClient, item: Review): Promise<void> {
    await client.query(
      `insert into public.review (
         id, commission_id, reviewer_id, reviewee_id, quality, communication,
         accuracy, packaging, timeline, comment, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (id) do update set
         quality = excluded.quality,
         communication = excluded.communication,
         accuracy = excluded.accuracy,
         packaging = excluded.packaging,
         timeline = excluded.timeline,
         comment = excluded.comment`,
      [
        item.id,
        item.commissionId,
        item.reviewerId,
        item.revieweeId,
        item.quality,
        item.communication,
        item.accuracy,
        item.packaging,
        item.timeline,
        item.comment,
        item.createdAt,
      ],
    );
  }

  private async upsertMaterial(client: PoolClient, item: MaterialEntry): Promise<void> {
    await client.query(
      `insert into public.material_entry (
         id, commission_id, maker_id, item, quantity, unit, cost_per_unit, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set
         item = excluded.item,
         quantity = excluded.quantity,
         unit = excluded.unit,
         cost_per_unit = excluded.cost_per_unit`,
      [
        item.id,
        item.commissionId,
        item.makerId,
        item.item,
        item.quantity,
        item.unit,
        item.costPerUnit,
        item.createdAt,
      ],
    );
  }

  private async upsertWaitlist(client: PoolClient, item: WaitlistEntry): Promise<void> {
    await client.query(
      `insert into public.waitlist_entry (
         id, maker_id, commissioner_id, message, created_at
       ) values ($1,$2,$3,$4,$5)
       on conflict (id) do update set
         maker_id = excluded.maker_id,
         commissioner_id = excluded.commissioner_id,
         message = excluded.message`,
      [item.id, item.makerId, item.commissionerId, item.message, item.createdAt],
    );
  }

  private async upsertWarning(client: PoolClient, item: Warning): Promise<void> {
    await client.query(
      `insert into public.admin_warning (
         id, user_id, admin_id, message, read, created_at
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         message = excluded.message,
         read = excluded.read`,
      [item.id, item.userId, item.adminId, item.message, item.read, item.createdAt],
    );
  }

  private async upsertAdminAuditEvent(
    client: PoolClient,
    item: AdminAuditEvent,
  ): Promise<void> {
    await client.query(
      `insert into public.admin_audit_event (
         id, admin_id, target_user_id, action, details, created_at
       ) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         admin_id = excluded.admin_id,
         target_user_id = excluded.target_user_id,
         action = excluded.action,
         details = excluded.details`,
      [
        item.id,
        item.adminId,
        item.targetUserId ?? null,
        item.action,
        item.details,
        item.createdAt,
      ],
    );
  }

  private async upsertNotification(client: PoolClient, item: Notification): Promise<void> {
    await client.query(
      `insert into public.notification (
         id, user_id, type, title, body, read, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set
         type = excluded.type,
         title = excluded.title,
         body = excluded.body,
         read = excluded.read`,
      [
        item.id,
        item.userId,
        item.type,
        item.title,
        item.body,
        item.read,
        item.createdAt,
      ],
    );
  }

  private async upsertPushDelivery(
    client: PoolClient,
    item: PushDelivery,
  ): Promise<void> {
    await client.query(
      `insert into public.push_delivery (
         id, notification_id, user_id, push_token, status, receipt_id,
         attempts, next_attempt_at, last_error, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do update set
         push_token = excluded.push_token,
         status = excluded.status,
         receipt_id = excluded.receipt_id,
         attempts = excluded.attempts,
         next_attempt_at = excluded.next_attempt_at,
         last_error = excluded.last_error`,
      [
        item.id,
        item.notificationId,
        item.userId,
        item.pushToken,
        item.status,
        item.receiptId ?? null,
        item.attempts,
        item.nextAttemptAt,
        item.lastError ?? null,
        item.createdAt,
      ],
    );
  }
}
