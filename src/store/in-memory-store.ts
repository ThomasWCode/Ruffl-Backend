import type {
  AdminAuditEvent,
  Commission,
  Conversation,
  Dispute,
  MakerProfile,
  MaterialEntry,
  Message,
  Milestone,
  NegotiationEntry,
  Notification,
  PushDelivery,
  Review,
  User,
  WaitlistEntry,
  Warning,
} from '../domain/types.js';

export interface StoreSnapshot {
  users: User[];
  makerProfiles: MakerProfile[];
  commissions: Commission[];
  milestones: [string, Milestone[]][];
  negotiations: NegotiationEntry[];
  conversations: Conversation[];
  messages: Message[];
  reviews: Review[];
  materials: MaterialEntry[];
  waitlist: WaitlistEntry[];
  disputes: Dispute[];
  warnings: Warning[];
  adminAuditEvents: AdminAuditEvent[];
  notifications: Notification[];
  pushDeliveries: PushDelivery[];
}

export interface StoreMutation {
  commit: () => Promise<void>;
  rollback: () => void;
}

export class InMemoryStore {
  readonly users = new Map<string, User>();
  readonly makerProfiles = new Map<string, MakerProfile>();
  readonly commissions = new Map<string, Commission>();
  readonly milestones = new Map<string, Milestone[]>();
  readonly negotiations: NegotiationEntry[] = [];
  readonly conversations = new Map<string, Conversation>();
  readonly messages: Message[] = [];
  readonly reviews: Review[] = [];
  readonly materials: MaterialEntry[] = [];
  readonly waitlist: WaitlistEntry[] = [];
  readonly disputes = new Map<string, Dispute>();
  readonly warnings: Warning[] = [];
  readonly adminAuditEvents: AdminAuditEvent[] = [];
  readonly notifications: Notification[] = [];
  readonly pushDeliveries = new Map<string, PushDelivery>();
  readonly persistent: boolean = false;
  private mutationQueue = Promise.resolve();

  clear(): void {
    this.users.clear();
    this.makerProfiles.clear();
    this.commissions.clear();
    this.milestones.clear();
    this.negotiations.length = 0;
    this.conversations.clear();
    this.messages.length = 0;
    this.reviews.length = 0;
    this.materials.length = 0;
    this.waitlist.length = 0;
    this.disputes.clear();
    this.warnings.length = 0;
    this.adminAuditEvents.length = 0;
    this.notifications.length = 0;
    this.pushDeliveries.clear();
  }

  snapshot(): StoreSnapshot {
    return structuredClone({
      users: [...this.users.values()],
      makerProfiles: [...this.makerProfiles.values()],
      commissions: [...this.commissions.values()],
      milestones: [...this.milestones.entries()],
      negotiations: this.negotiations,
      conversations: [...this.conversations.values()],
      messages: this.messages,
      reviews: this.reviews,
      materials: this.materials,
      waitlist: this.waitlist,
      disputes: [...this.disputes.values()],
      warnings: this.warnings,
      adminAuditEvents: this.adminAuditEvents,
      notifications: this.notifications,
      pushDeliveries: [...this.pushDeliveries.values()],
    });
  }

  restore(snapshot: StoreSnapshot): void {
    this.clear();
    snapshot.users.forEach((item) => this.users.set(item.id, structuredClone(item)));
    snapshot.makerProfiles.forEach((item) =>
      this.makerProfiles.set(item.userId, structuredClone(item)),
    );
    snapshot.commissions.forEach((item) =>
      this.commissions.set(item.id, structuredClone(item)),
    );
    snapshot.milestones.forEach(([commissionId, items]) =>
      this.milestones.set(commissionId, structuredClone(items)),
    );
    this.negotiations.push(...structuredClone(snapshot.negotiations));
    snapshot.conversations.forEach((item) =>
      this.conversations.set(item.id, structuredClone(item)),
    );
    this.messages.push(...structuredClone(snapshot.messages));
    this.reviews.push(...structuredClone(snapshot.reviews));
    this.materials.push(...structuredClone(snapshot.materials));
    this.waitlist.push(...structuredClone(snapshot.waitlist));
    snapshot.disputes.forEach((item) => this.disputes.set(item.id, structuredClone(item)));
    this.warnings.push(...structuredClone(snapshot.warnings));
    this.adminAuditEvents.push(...structuredClone(snapshot.adminAuditEvents));
    this.notifications.push(...structuredClone(snapshot.notifications));
    snapshot.pushDeliveries.forEach((item) =>
      this.pushDeliveries.set(item.id, structuredClone(item)),
    );
  }

  async beginMutation(): Promise<StoreMutation> {
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.mutationQueue;
    this.mutationQueue = previous.then(() => current);
    await previous;

    const before = this.snapshot();
    let finished = false;
    return {
      commit: async () => {
        if (finished) return;
        finished = true;
        const after = this.snapshot();
        try {
          await this.persistChanges(before, after);
        } catch (error) {
          this.restore(before);
          throw error;
        } finally {
          release();
        }
      },
      rollback: () => {
        if (finished) return;
        finished = true;
        this.restore(before);
        release();
      },
    };
  }

  async readinessCheck(): Promise<void> {}

  async close(): Promise<void> {}

  protected async persistChanges(
    _before: StoreSnapshot,
    _after: StoreSnapshot,
  ): Promise<void> {}
}
