import type { Milestone, SuitType } from './types.js';

const templates: Record<SuitType, string[]> = {
  head: ['Design confirmed', 'Foam base', 'Furring', 'Eyes and details', 'Final photography', 'Packaging'],
  partial: [
    'Design confirmed',
    'Head base',
    'Furring and eyes',
    'Paws and tail',
    'Final photography',
    'Packaging',
  ],
  full: [
    'Design confirmed',
    'Head base',
    'Furring and eyes',
    'Body pattern',
    'Body and legs',
    'Detailing',
    'Final photography',
    'Packaging',
  ],
  custom: ['Design confirmed', 'Build', 'Detailing', 'Final photography', 'Packaging'],
};

// Creates locked placeholder milestones; payment is assigned after the deposit.
export function createMilestones(commissionId: string, suitType: SuitType): Milestone[] {
  return templates[suitType].map((title, position) => ({
    id: crypto.randomUUID(),
    commissionId,
    position,
    title,
    status: position === 0 ? 'active' : 'locked',
    paymentAmount: 0,
    updates: [],
  }));
}

// Splits pence exactly so the final milestone absorbs any remainder.
export function splitMilestonePayments(milestones: Milestone[], remainingAmount: number): void {
  const totalPence = Math.round(remainingAmount * 100);
  const ordinaryShare = Math.floor(totalPence / milestones.length);

  milestones.forEach((milestone, index) => {
    const pence =
      index === milestones.length - 1
        ? totalPence - ordinaryShare * (milestones.length - 1)
        : ordinaryShare;
    milestone.paymentAmount = pence / 100;
  });
}
