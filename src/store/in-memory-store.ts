import type {
  Commission,
  Conversation,
  Dispute,
  MakerProfile,
  MaterialEntry,
  Message,
  Milestone,
  NegotiationEntry,
  Notification,
  Review,
  User,
  WaitlistEntry,
  Warning,
} from '../domain/types.js';

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
  readonly notifications: Notification[] = [];

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
    this.notifications.length = 0;
  }
}
