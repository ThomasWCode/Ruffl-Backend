import { DomainError, requireValue } from '../domain/errors.js';
import { createMilestones, splitMilestonePayments } from '../domain/milestones.js';
import type {
  Commission,
  Dispute,
  DisputeOutcome,
  MediaAttachment,
  Milestone,
  Review,
  SuitType,
  User,
} from '../domain/types.js';
import type { InMemoryStore } from '../store/in-memory-store.js';

function now(): string {
  return new Date().toISOString();
}

function assertParty(commission: Commission, userId: string): void {
  if (commission.makerId !== userId && commission.commissionerId !== userId) {
    throw new DomainError('Only the commission parties can perform this action.', 403, 'FORBIDDEN');
  }
}

export class CommissionService {
  constructor(private readonly store: InMemoryStore) {}

  create(
    commissioner: User,
    input: {
      makerId: string;
      title: string;
      suitType: SuitType;
      species: string;
      description: string;
      referenceNotes?: string;
      budget: number;
    },
  ): Commission {
    if (commissioner.role !== 'commissioner') {
      throw new DomainError('Only commissioners can request a commission.', 403, 'FORBIDDEN');
    }
    const maker = requireValue(this.store.users.get(input.makerId), 'Maker not found.');
    const profile = requireValue(this.store.makerProfiles.get(input.makerId), 'Maker profile not found.');
    if (maker.role !== 'maker' || !profile.queueOpen) {
      throw new DomainError('This maker is not accepting commission requests.');
    }
    if (!input.title.trim() || !input.description.trim() || input.budget <= 0) {
      throw new DomainError('Title, description, and a positive budget are required.');
    }

    const timestamp = now();
    const commission: Commission = {
      id: crypto.randomUUID(),
      commissionerId: commissioner.id,
      makerId: maker.id,
      title: input.title.trim(),
      suitType: input.suitType,
      species: input.species.trim(),
      description: input.description.trim(),
      referenceNotes: input.referenceNotes?.trim() ?? '',
      budget: input.budget,
      depositPaid: false,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.commissions.set(commission.id, commission);
    this.store.milestones.set(commission.id, createMilestones(commission.id, commission.suitType));
    this.createCommissionConversation(commission);
    this.notify(maker.id, 'commission_requested', 'New commission request', commission.title);
    return commission;
  }

  listForUser(user: User): Commission[] {
    const values = [...this.store.commissions.values()];
    return user.role === 'admin'
      ? values
      : values.filter(
          (commission) =>
            commission.makerId === user.id || commission.commissionerId === user.id,
        );
  }

  getForUser(user: User, commissionId: string): { commission: Commission; milestones: Milestone[] } {
    const commission = this.get(commissionId);
    if (user.role !== 'admin') {
      assertParty(commission, user.id);
    }
    return {
      commission,
      milestones: this.store.milestones.get(commission.id) ?? [],
    };
  }

  respondToRequest(maker: User, commissionId: string, accept: boolean): Commission {
    const commission = this.get(commissionId);
    if (maker.id !== commission.makerId) {
      throw new DomainError('Only the selected maker can respond.', 403, 'FORBIDDEN');
    }
    if (commission.status !== 'pending') {
      throw new DomainError('This request has already been handled.');
    }
    commission.status = accept ? 'negotiating' : 'cancelled';
    commission.updatedAt = now();
    this.notify(
      commission.commissionerId,
      accept ? 'commission_accepted' : 'commission_declined',
      accept ? 'Request accepted' : 'Request declined',
      commission.title,
    );
    return commission;
  }

  proposePrice(maker: User, commissionId: string, amount: number, note?: string): Commission {
    const commission = this.get(commissionId);
    if (maker.id !== commission.makerId) {
      throw new DomainError('Only the maker can propose a price.', 403, 'FORBIDDEN');
    }
    if (commission.status !== 'negotiating' || amount <= 0) {
      throw new DomainError('A positive price can only be proposed while negotiating.');
    }
    commission.proposedPrice = amount;
    commission.status = 'price_proposed';
    commission.updatedAt = now();
    const entry = {
      id: crypto.randomUUID(),
      commissionId,
      authorId: maker.id,
      action: 'proposal' as const,
      amount,
      createdAt: now(),
    };
    this.store.negotiations.push(note?.trim() ? { ...entry, note: note.trim() } : entry);
    this.notify(commission.commissionerId, 'price_proposed', 'Price proposed', `£${amount}`);
    return commission;
  }

  respondToPrice(
    commissioner: User,
    commissionId: string,
    accept: boolean,
    note?: string,
  ): Commission {
    const commission = this.get(commissionId);
    if (commissioner.id !== commission.commissionerId) {
      throw new DomainError('Only the commissioner can respond to the price.', 403, 'FORBIDDEN');
    }
    if (commission.status !== 'price_proposed' || !commission.proposedPrice) {
      throw new DomainError('There is no price proposal awaiting a response.');
    }

    const entry = {
      id: crypto.randomUUID(),
      commissionId,
      authorId: commissioner.id,
      action: accept ? ('accepted' as const) : ('rejected' as const),
      amount: commission.proposedPrice,
      createdAt: now(),
    };
    this.store.negotiations.push(note?.trim() ? { ...entry, note: note.trim() } : entry);

    if (accept) {
      commission.agreedTotal = commission.proposedPrice;
      commission.depositAmount = Math.round(commission.proposedPrice * 50) / 100;
      commission.status = 'accepted';
    } else {
      commission.status = 'negotiating';
    }
    commission.updatedAt = now();
    this.notify(
      commission.makerId,
      accept ? 'price_accepted' : 'price_rejected',
      accept ? 'Price accepted' : 'Price rejected',
      commission.title,
    );
    return commission;
  }

  payDeposit(commissioner: User, commissionId: string): Commission {
    const commission = this.get(commissionId);
    if (commissioner.id !== commission.commissionerId) {
      throw new DomainError('Only the commissioner can pay the deposit.', 403, 'FORBIDDEN');
    }
    if (
      commission.status !== 'accepted' ||
      !commission.agreedTotal ||
      commission.depositAmount === undefined
    ) {
      throw new DomainError('The agreed price must be accepted before paying a deposit.');
    }

    commission.depositPaid = true;
    commission.status = 'active';
    commission.updatedAt = now();
    const milestones = this.store.milestones.get(commission.id) ?? [];
    splitMilestonePayments(milestones, commission.agreedTotal - commission.depositAmount);
    this.notify(commission.makerId, 'deposit_paid', 'Deposit paid', commission.title);
    return commission;
  }

  postMilestoneUpdate(
    maker: User,
    commissionId: string,
    milestoneId: string,
    notes: string,
    attachments: MediaAttachment[] = [],
  ): Milestone {
    const commission = this.get(commissionId);
    if (maker.id !== commission.makerId || commission.status !== 'active') {
      throw new DomainError('Only the maker can update an active commission.', 403, 'FORBIDDEN');
    }
    const milestone = this.getMilestone(commissionId, milestoneId);
    if (milestone.status !== 'active' || (!notes.trim() && attachments.length === 0)) {
      throw new DomainError('The active milestone needs notes or an attachment.');
    }
    milestone.updates.push({
      id: crypto.randomUUID(),
      authorId: maker.id,
      notes: notes.trim(),
      attachments,
      createdAt: now(),
    });
    milestone.status = 'posted';
    commission.updatedAt = now();
    this.notify(commission.commissionerId, 'milestone_posted', 'Progress update posted', milestone.title);
    return milestone;
  }

  approveMilestone(commissioner: User, commissionId: string, milestoneId: string): Milestone {
    const commission = this.get(commissionId);
    if (commissioner.id !== commission.commissionerId || commission.status !== 'active') {
      throw new DomainError('Only the commissioner can approve this milestone.', 403, 'FORBIDDEN');
    }
    const milestones = this.store.milestones.get(commissionId) ?? [];
    const milestone = this.getMilestone(commissionId, milestoneId);
    if (milestone.status !== 'posted') {
      throw new DomainError('This milestone is not awaiting approval.');
    }
    milestone.status = 'complete';
    const next = milestones.find((candidate) => candidate.position === milestone.position + 1);
    if (next) {
      next.status = 'active';
    }
    commission.updatedAt = now();
    this.notify(commission.makerId, 'milestone_approved', 'Milestone approved', milestone.title);
    return milestone;
  }

  ship(maker: User, commissionId: string, trackingNumber?: string): Commission {
    const commission = this.get(commissionId);
    const milestones = this.store.milestones.get(commissionId) ?? [];
    if (maker.id !== commission.makerId || commission.status !== 'active') {
      throw new DomainError('Only the maker can ship an active commission.', 403, 'FORBIDDEN');
    }
    if (milestones.some((milestone) => milestone.status !== 'complete')) {
      throw new DomainError('Every milestone must be approved before shipping.');
    }
    commission.status = 'shipping';
    if (trackingNumber?.trim()) {
      commission.trackingNumber = trackingNumber.trim();
    } else {
      delete commission.trackingNumber;
    }
    commission.updatedAt = now();
    this.notify(commission.commissionerId, 'commission_shipped', 'Commission shipped', commission.title);
    return commission;
  }

  confirmReceipt(commissioner: User, commissionId: string): Commission {
    const commission = this.get(commissionId);
    if (commissioner.id !== commission.commissionerId || commission.status !== 'shipping') {
      throw new DomainError('Only the commissioner can confirm receipt after shipping.', 403, 'FORBIDDEN');
    }
    commission.status = 'complete';
    commission.updatedAt = now();
    this.notify(commission.makerId, 'receipt_confirmed', 'Delivery confirmed', commission.title);
    return commission;
  }

  cancel(user: User, commissionId: string): Commission {
    const commission = this.get(commissionId);
    assertParty(commission, user.id);
    if (
      !['pending', 'negotiating', 'price_proposed', 'accepted'].includes(
        commission.status,
      )
    ) {
      throw new DomainError(
        'After a deposit is recorded, cancellation requires a dispute and human review.',
      );
    }
    commission.status = 'cancelled';
    commission.updatedAt = now();
    return commission;
  }

  addReview(
    reviewer: User,
    commissionId: string,
    input: Omit<Review, 'id' | 'commissionId' | 'reviewerId' | 'revieweeId' | 'createdAt'>,
  ): Review {
    const commission = this.get(commissionId);
    assertParty(commission, reviewer.id);
    if (commission.status !== 'complete') {
      throw new DomainError('Reviews unlock after the commission is complete.');
    }
    if (
      this.store.reviews.some(
        (review) => review.commissionId === commissionId && review.reviewerId === reviewer.id,
      )
    ) {
      throw new DomainError('You have already reviewed this commission.', 409, 'DUPLICATE_REVIEW');
    }
    const ratings = [
      input.quality,
      input.communication,
      input.accuracy,
      input.packaging,
      input.timeline,
    ];
    if (ratings.some((rating) => !Number.isInteger(rating) || rating < 1 || rating > 5)) {
      throw new DomainError('Every rating must be a whole number from 1 to 5.');
    }
    const review: Review = {
      ...input,
      id: crypto.randomUUID(),
      commissionId,
      reviewerId: reviewer.id,
      revieweeId:
        reviewer.id === commission.makerId ? commission.commissionerId : commission.makerId,
      comment: input.comment.trim(),
      createdAt: now(),
    };
    this.store.reviews.push(review);
    this.notify(review.revieweeId, 'review_received', 'New review received', review.comment);
    return review;
  }

  raiseDispute(
    user: User,
    commissionId: string,
    explanation: string,
    attachments: MediaAttachment[] = [],
  ): Dispute {
    const commission = this.get(commissionId);
    assertParty(commission, user.id);
    if (
      commission.status === 'complete' ||
      commission.status === 'cancelled' ||
      commission.status === 'disputed' ||
      !explanation.trim()
    ) {
      throw new DomainError('This commission cannot be disputed.');
    }
    const timestamp = now();
    const dispute: Dispute = {
      id: crypto.randomUUID(),
      commissionId,
      raisedById: user.id,
      status: 'open',
      explanation: explanation.trim(),
      evidence: [
        {
          id: crypto.randomUUID(),
          authorId: user.id,
          message: explanation.trim(),
          attachments,
          createdAt: timestamp,
        },
      ],
      createdAt: timestamp,
    };
    this.store.disputes.set(dispute.id, dispute);
    commission.statusBeforeDispute = commission.status;
    commission.status = 'disputed';
    commission.updatedAt = timestamp;
    this.createDisputeConversation(commission, dispute);
    const otherParty =
      user.id === commission.makerId ? commission.commissionerId : commission.makerId;
    this.notify(otherParty, 'dispute_raised', 'A dispute was raised', commission.title);
    return dispute;
  }

  addEvidence(
    user: User,
    disputeId: string,
    message: string,
    attachments: MediaAttachment[] = [],
  ): Dispute {
    const dispute = requireValue(this.store.disputes.get(disputeId), 'Dispute not found.');
    const commission = this.get(dispute.commissionId);
    assertParty(commission, user.id);
    if (['resolved', 'closed'].includes(dispute.status) || (!message.trim() && !attachments.length)) {
      throw new DomainError('Evidence can only be added before resolution.');
    }
    dispute.evidence.push({
      id: crypto.randomUUID(),
      authorId: user.id,
      message: message.trim(),
      attachments,
      createdAt: now(),
    });
    return dispute;
  }

  assignDispute(admin: User, disputeId: string): Dispute {
    this.assertAdmin(admin);
    const dispute = requireValue(this.store.disputes.get(disputeId), 'Dispute not found.');
    if (dispute.status !== 'open') {
      throw new DomainError('Only an open dispute can be assigned.');
    }
    dispute.status = 'under_review';
    dispute.assignedAdminId = admin.id;
    return dispute;
  }

  resolveDispute(
    admin: User,
    disputeId: string,
    outcome: DisputeOutcome,
    resolution: string,
  ): Dispute {
    this.assertAdmin(admin);
    const dispute = requireValue(this.store.disputes.get(disputeId), 'Dispute not found.');
    if (dispute.status !== 'under_review' || !resolution.trim()) {
      throw new DomainError('An assigned dispute requires a written resolution.');
    }
    dispute.status = 'resolved';
    dispute.outcome = outcome;
    dispute.resolution = resolution.trim();
    dispute.resolvedAt = now();
    const commission = this.get(dispute.commissionId);
    if (outcome === 'commission_cancelled') {
      commission.status = 'cancelled';
    } else {
      commission.status = commission.statusBeforeDispute ?? 'active';
    }
    delete commission.statusBeforeDispute;
    commission.updatedAt = now();
    this.notify(commission.makerId, 'dispute_resolved', 'Dispute resolved', resolution);
    this.notify(commission.commissionerId, 'dispute_resolved', 'Dispute resolved', resolution);
    return dispute;
  }

  closeDispute(admin: User, disputeId: string): Dispute {
    this.assertAdmin(admin);
    const dispute = requireValue(this.store.disputes.get(disputeId), 'Dispute not found.');
    if (dispute.status !== 'resolved') {
      throw new DomainError('Resolve the dispute before closing it.');
    }
    dispute.status = 'closed';
    return dispute;
  }

  private get(commissionId: string): Commission {
    return requireValue(this.store.commissions.get(commissionId), 'Commission not found.');
  }

  private getMilestone(commissionId: string, milestoneId: string): Milestone {
    return requireValue(
      (this.store.milestones.get(commissionId) ?? []).find(
        (milestone) => milestone.id === milestoneId,
      ),
      'Milestone not found.',
    );
  }

  private assertAdmin(user: User): void {
    if (user.role !== 'admin') {
      throw new DomainError('Admin access required.', 403, 'FORBIDDEN');
    }
  }

  private notify(userId: string, type: string, title: string, body: string): void {
    this.store.notifications.push({
      id: crypto.randomUUID(),
      userId,
      type,
      title,
      body,
      read: false,
      createdAt: now(),
    });
  }

  private createCommissionConversation(commission: Commission): void {
    const id = crypto.randomUUID();
    this.store.conversations.set(id, {
      id,
      kind: 'commission',
      participantIds: [commission.makerId, commission.commissionerId],
      commissionId: commission.id,
      createdAt: now(),
    });
  }

  private createDisputeConversation(commission: Commission, dispute: Dispute): void {
    const id = crypto.randomUUID();
    this.store.conversations.set(id, {
      id,
      kind: 'dispute',
      participantIds: [commission.makerId, commission.commissionerId],
      commissionId: commission.id,
      disputeId: dispute.id,
      createdAt: now(),
    });
  }
}
