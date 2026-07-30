export type UserRole = 'commissioner' | 'maker' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'deleted';
export type SuitType = 'head' | 'partial' | 'full' | 'custom';
export type CommissionStatus =
  | 'pending'
  | 'negotiating'
  | 'price_proposed'
  | 'accepted'
  | 'active'
  | 'shipping'
  | 'complete'
  | 'cancelled'
  | 'disputed';
export type MilestoneStatus = 'locked' | 'active' | 'posted' | 'complete';
export type ConversationKind = 'commission' | 'direct' | 'dispute' | 'admin';
export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'closed';
export type DisputeOutcome =
  | 'maker_favoured'
  | 'commissioner_favoured'
  | 'split_decision'
  | 'commission_cancelled'
  | 'no_resolution';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  avatarUrl?: string;
  bio?: string;
  pushToken?: string;
  suspendedUntil?: string;
  suspensionReason?: string;
  emailVerifiedAt?: string;
  createdAt: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  avatarUrl?: string;
  bio?: string;
  suspendedUntil?: string;
  suspensionReason?: string;
  emailVerifiedAt?: string;
  createdAt: string;
}

export interface MakerProfile {
  userId: string;
  bio: string;
  location: string;
  specialisms: string[];
  basePrices: Record<'head' | 'partial' | 'full', number>;
  addOnPrices: Record<'movingJaw' | 'followMeEyes' | 'coolingFan', number>;
  turnaroundWeeks: number;
  queueOpen: boolean;
  verified: boolean;
  trusted: boolean;
  bannerUrl?: string;
}

export interface NegotiationEntry {
  id: string;
  commissionId: string;
  authorId: string;
  action: 'proposal' | 'accepted' | 'rejected';
  amount?: number;
  note?: string;
  createdAt: string;
}

export interface MediaAttachment {
  url: string;
  name: string;
  contentType: string;
}

export interface MilestoneUpdate {
  id: string;
  authorId: string;
  notes: string;
  attachments: MediaAttachment[];
  createdAt: string;
}

export interface Milestone {
  id: string;
  commissionId: string;
  position: number;
  title: string;
  status: MilestoneStatus;
  paymentAmount: number;
  updates: MilestoneUpdate[];
}

export interface Commission {
  id: string;
  commissionerId: string;
  makerId: string;
  title: string;
  suitType: SuitType;
  species: string;
  description: string;
  referenceNotes: string;
  budget: number;
  proposedPrice?: number;
  agreedTotal?: number;
  depositAmount?: number;
  depositPaid: boolean;
  status: CommissionStatus;
  statusBeforeDispute?: Exclude<CommissionStatus, 'disputed'>;
  trackingNumber?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  participantIds: string[];
  commissionId?: string;
  disputeId?: string;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  attachments: MediaAttachment[];
  createdAt: string;
}

export interface Review {
  id: string;
  commissionId: string;
  reviewerId: string;
  revieweeId: string;
  quality: number;
  communication: number;
  accuracy: number;
  packaging: number;
  timeline: number;
  comment: string;
  createdAt: string;
}

export interface MaterialEntry {
  id: string;
  commissionId: string;
  makerId: string;
  item: string;
  quantity: number;
  unit: string;
  costPerUnit: number;
  createdAt: string;
}

export interface WaitlistEntry {
  id: string;
  makerId: string;
  commissionerId: string;
  message: string;
  createdAt: string;
}

export interface DisputeEvidence {
  id: string;
  authorId: string;
  message: string;
  attachments: MediaAttachment[];
  createdAt: string;
}

export interface Dispute {
  id: string;
  commissionId: string;
  raisedById: string;
  status: DisputeStatus;
  assignedAdminId?: string;
  explanation: string;
  evidence: DisputeEvidence[];
  outcome?: DisputeOutcome;
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface Warning {
  id: string;
  userId: string;
  adminId: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface AdminAuditEvent {
  id: string;
  adminId: string;
  targetUserId?: string;
  action: string;
  details: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export type PushDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface PushDelivery {
  id: string;
  notificationId: string;
  userId: string;
  pushToken: string;
  status: PushDeliveryStatus;
  receiptId?: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
}

export interface UploadSlot {
  uploadUrl: string;
  publicUrl: string;
  expiresInSeconds: number;
  method: 'PUT';
  headers: Record<string, string>;
}
