import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { Commission, Milestone } from '../src/domain/types.js';
import { InMemoryStore } from '../src/store/in-memory-store.js';

describe('commission lifecycle', () => {
  const store = new InMemoryStore();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let commissionerToken: string;
  let makerToken: string;

  beforeEach(async () => {
    store.clear();
    app = await buildApp({ store, seedDemoData: true, jwtSecret: 'test-secret' });
    commissionerToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'commissioner@demo.ruffl', password: 'RufflDemo1!' },
      })
    ).json().token;
    makerToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'maker@demo.ruffl', password: 'RufflDemo1!' },
      })
    ).json().token;
  });

  afterEach(async () => {
    await app.close();
  });

  it('moves a request through negotiation, milestones, shipping, receipt, and review', async () => {
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/commissions',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        makerId: 'demo-maker',
        title: 'Aurora fox partial',
        suitType: 'partial',
        species: 'Fox',
        description: 'Bright northern-lights palette.',
        budget: 2500,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json().commission as Commission;

    await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/respond`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: { accept: true },
    });
    await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/price`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: { amount: 2345.67, note: 'Includes follow-me eyes.' },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/price-response`,
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { accept: true },
    });
    expect((accepted.json().commission as Commission).depositAmount).toBe(1172.84);

    const deposit = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/deposit`,
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect((deposit.json().commission as Commission).status).toBe('active');

    const unsafeCancellation = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/cancel`,
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {},
    });
    expect(unsafeCancellation.statusCode).toBe(400);
    expect(unsafeCancellation.json().message).toContain('requires a dispute');

    const detail = await app.inject({
      method: 'GET',
      url: `/commissions/${created.id}`,
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    const milestones = detail.json().milestones as Milestone[];
    const milestoneTotal = milestones.reduce((sum, milestone) => sum + milestone.paymentAmount, 0);
    expect(milestoneTotal).toBeCloseTo(1172.83, 2);
    expect(milestones[0]?.status).toBe('active');
    expect(milestones[1]?.status).toBe('locked');

    const material = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/materials`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: {
        item: 'Luxury faux fur',
        quantity: 3,
        unit: 'metres',
        costPerUnit: 28.5,
      },
    });
    expect(material.statusCode).toBe(201);

    for (const milestone of milestones) {
      const update = await app.inject({
        method: 'POST',
        url: `/commissions/${created.id}/milestones/${milestone.id}/updates`,
        headers: { authorization: `Bearer ${makerToken}` },
        payload: { notes: `${milestone.title} is ready for review.` },
      });
      expect(update.statusCode).toBe(200);
      expect((update.json().milestone as Milestone).status).toBe('posted');

      const approval = await app.inject({
        method: 'POST',
        url: `/commissions/${created.id}/milestones/${milestone.id}/approve`,
        headers: { authorization: `Bearer ${commissionerToken}` },
      });
      expect(approval.statusCode).toBe(200);
      expect((approval.json().milestone as Milestone).status).toBe('complete');
    }

    const shipped = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/ship`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: { trackingNumber: 'RUFFL-TRACK-001' },
    });
    expect(shipped.json().commission).toMatchObject({
      status: 'shipping',
      trackingNumber: 'RUFFL-TRACK-001',
    });

    const receipt = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/receipt`,
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(receipt.json().commission.status).toBe('complete');

    const review = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/reviews`,
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        quality: 5,
        communication: 4,
        accuracy: 5,
        packaging: 5,
        timeline: 4,
        comment: 'Clear updates and excellent finished work.',
      },
    });
    expect(review.statusCode).toBe(201);
    expect(review.json().review).toMatchObject({
      reviewerId: 'demo-commissioner',
      revieweeId: 'demo-maker',
    });

    const makerReview = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/reviews`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: {
        quality: 4,
        communication: 5,
        accuracy: 5,
        packaging: 4,
        timeline: 5,
        comment: 'Clear brief and prompt approvals.',
      },
    });
    expect(makerReview.statusCode).toBe(201);
    expect(makerReview.json().review).toMatchObject({
      reviewerId: 'demo-maker',
      revieweeId: 'demo-commissioner',
    });

    const completedDetail = await app.inject({
      method: 'GET',
      url: `/commissions/${created.id}`,
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(completedDetail.json().reviews).toHaveLength(2);

    const duplicateReview = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/reviews`,
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        quality: 5,
        communication: 5,
        accuracy: 5,
        packaging: 5,
        timeline: 5,
        comment: 'A second review must not be accepted.',
      },
    });
    expect(duplicateReview.statusCode).toBe(409);
    expect(duplicateReview.json().code).toBe('DUPLICATE_REVIEW');

    const makerProfile = await app.inject({
      method: 'GET',
      url: '/makers/demo-maker',
    });
    expect(makerProfile.json()).toMatchObject({
      completedCount: 1,
      rating: 4.6,
    });
  });

  it('prevents the commissioner from posting a maker milestone update', async () => {
    const commission = {
      id: 'commission-one',
      commissionerId: 'demo-commissioner',
      makerId: 'demo-maker',
      title: 'Test',
      suitType: 'head' as const,
      species: 'Wolf',
      description: 'Test build',
      referenceNotes: '',
      budget: 1000,
      agreedTotal: 1000,
      depositAmount: 500,
      depositPaid: true,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.commissions.set(commission.id, commission);
    store.milestones.set(commission.id, [
      {
        id: 'milestone-one',
        commissionId: commission.id,
        position: 0,
        title: 'Design',
        status: 'active',
        paymentAmount: 500,
        updates: [],
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/commissions/commission-one/milestones/milestone-one/updates',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { notes: 'Trying to bypass role checks.' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('supports a closed maker waitlist and reopening the commission queue', async () => {
    const makerTwoToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'maker2@demo.ruffl',
          password: 'RufflDemo1!',
        },
      })
    ).json().token as string;

    const closedRequest = await app.inject({
      method: 'POST',
      url: '/commissions',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        makerId: 'demo-maker-2',
        title: 'Realistic wolf',
        suitType: 'head',
        species: 'Wolf',
        description: 'A realistic grey wolf head.',
        budget: 1500,
      },
    });
    expect(closedRequest.statusCode).toBe(400);

    const joined = await app.inject({
      method: 'POST',
      url: '/makers/demo-maker-2/waitlist',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { message: 'Please contact me when the queue reopens.' },
    });
    expect(joined.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/makers/demo-maker-2/waitlist',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { message: 'Duplicate request.' },
    });
    expect(duplicate.statusCode).toBe(409);

    const waitlist = await app.inject({
      method: 'GET',
      url: '/maker-profile/waitlist',
      headers: { authorization: `Bearer ${makerTwoToken}` },
    });
    expect(waitlist.json()).toEqual([
      expect.objectContaining({
        makerId: 'demo-maker-2',
        commissionerId: 'demo-commissioner',
      }),
    ]);

    const reopened = await app.inject({
      method: 'PATCH',
      url: '/maker-profile',
      headers: { authorization: `Bearer ${makerTwoToken}` },
      payload: {
        queueOpen: true,
        turnaroundWeeks: 20,
        specialisms: ['Realistic', 'Canine'],
      },
    });
    expect(reopened.json().profile).toMatchObject({
      queueOpen: true,
      turnaroundWeeks: 20,
      specialisms: ['Realistic', 'Canine'],
    });

    const openRequest = await app.inject({
      method: 'POST',
      url: '/commissions',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        makerId: 'demo-maker-2',
        title: 'Realistic wolf',
        suitType: 'head',
        species: 'Wolf',
        description: 'A realistic grey wolf head.',
        budget: 1500,
      },
    });
    expect(openRequest.statusCode).toBe(201);

    const search = await app.inject({
      method: 'GET',
      url: '/makers?search=realistic&openOnly=true',
    });
    expect(search.json()).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: 'demo-maker-2' }),
      }),
    ]);
  });

  it('runs a dispute through evidence, admin adjudication, closure, and resumed work', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/commissions',
        headers: { authorization: `Bearer ${commissionerToken}` },
        payload: {
          makerId: 'demo-maker',
          title: 'Disputed fox head',
          suitType: 'head',
          species: 'Fox',
          description: 'A commission used to verify the dispute workflow.',
          budget: 1200,
        },
      })
    ).json().commission as Commission;
    const raised = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/disputes`,
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        explanation: 'We need an administrator to clarify the agreed scope.',
      },
    });
    expect(raised.statusCode).toBe(201);
    const disputeId = raised.json().dispute.id as string;
    expect(store.commissions.get(created.id)).toMatchObject({
      status: 'disputed',
      statusBeforeDispute: 'pending',
    });

    const evidence = await app.inject({
      method: 'POST',
      url: `/disputes/${disputeId}/evidence`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: {
        message: 'The original brief and conversation show the intended scope.',
      },
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().dispute.evidence).toHaveLength(2);

    const makerTwoToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'maker2@demo.ruffl',
          password: 'RufflDemo1!',
        },
      })
    ).json().token as string;
    const unrelatedEvidence = await app.inject({
      method: 'POST',
      url: `/disputes/${disputeId}/evidence`,
      headers: { authorization: `Bearer ${makerTwoToken}` },
      payload: { message: 'I should not be able to access this dispute.' },
    });
    expect(unrelatedEvidence.statusCode).toBe(403);

    const adminToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'admin@demo.ruffl',
          password: 'RufflDemo1!',
        },
      })
    ).json().token as string;
    const csrfToken = (
      await app.inject({
        method: 'GET',
        url: '/admin/csrf',
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json().csrfToken as string;
    const disputeQueue = await app.inject({
      method: 'GET',
      url: '/admin/disputes',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(disputeQueue.json().disputes).toEqual([
      expect.objectContaining({
        id: disputeId,
        status: 'open',
        commission: expect.objectContaining({ id: created.id }),
      }),
    ]);

    const assigned = await app.inject({
      method: 'POST',
      url: `/admin/disputes/${disputeId}/assign`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    expect(assigned.json().dispute).toMatchObject({
      status: 'under_review',
      assignedAdminId: 'demo-admin',
    });

    const resolved = await app.inject({
      method: 'POST',
      url: `/admin/disputes/${disputeId}/resolve`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
      payload: {
        outcome: 'split_decision',
        resolution: 'Continue using the written brief and confirm changes in chat.',
      },
    });
    expect(resolved.json().dispute.status).toBe('resolved');
    expect(store.commissions.get(created.id)).toMatchObject({
      status: 'pending',
    });
    expect(store.commissions.get(created.id)?.statusBeforeDispute).toBeUndefined();

    const closed = await app.inject({
      method: 'POST',
      url: `/admin/disputes/${disputeId}/close`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    expect(closed.json().dispute.status).toBe('closed');
    expect(store.adminAuditEvents.map((event) => event.action)).toEqual([
      'dispute_assigned',
      'dispute_resolved',
      'dispute_closed',
    ]);

    const resumed = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/respond`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: { accept: true },
    });
    expect(resumed.json().commission.status).toBe('negotiating');

    const repeated = await app.inject({
      method: 'POST',
      url: `/commissions/${created.id}/disputes`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: {
        explanation: 'A separate issue arose after work resumed.',
      },
    });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.json().dispute.id).not.toBe(disputeId);

    const latestDetail = await app.inject({
      method: 'GET',
      url: `/commissions/${created.id}`,
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(latestDetail.json().dispute).toMatchObject({
      id: repeated.json().dispute.id,
      status: 'open',
    });
  });

  it('supports private direct and support conversations across accounts', async () => {
    const direct = await app.inject({
      method: 'POST',
      url: '/conversations/direct',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { participantId: 'demo-maker' },
    });
    expect(direct.statusCode).toBe(201);
    const directConversationId = direct.json().conversation.id as string;

    const sent = await app.inject({
      method: 'POST',
      url: `/conversations/${directConversationId}/messages`,
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { text: 'Could we discuss a future fox build?' },
    });
    expect(sent.statusCode).toBe(201);

    const received = await app.inject({
      method: 'GET',
      url: `/conversations/${directConversationId}/messages`,
      headers: { authorization: `Bearer ${makerToken}` },
    });
    expect(received.json().messages).toEqual([
      expect.objectContaining({
        text: 'Could we discuss a future fox build?',
        senderId: 'demo-commissioner',
      }),
    ]);
    const notificationResponse = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { authorization: `Bearer ${makerToken}` },
    });
    const messageNotification = notificationResponse
      .json()
      .notifications.find(
        (notification: { type: string }) =>
          notification.type === 'message_received',
      );
    const readNotification = await app.inject({
      method: 'POST',
      url: `/notifications/${messageNotification.id}/read`,
      headers: { authorization: `Bearer ${makerToken}` },
      payload: {},
    });
    expect(readNotification.json().notification.read).toBe(true);

    const support = await app.inject({
      method: 'POST',
      url: '/support/conversation',
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(support.statusCode).toBe(201);
    const supportConversationId = support.json().conversation.id as string;

    await app.inject({
      method: 'POST',
      url: `/conversations/${supportConversationId}/messages`,
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { text: 'I need help understanding a warning.' },
    });

    const adminToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'admin@demo.ruffl',
          password: 'RufflDemo1!',
        },
      })
    ).json().token as string;
    const csrfToken = (
      await app.inject({
        method: 'GET',
        url: '/admin/csrf',
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json().csrfToken as string;
    const adminInbox = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminInbox.json().conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: supportConversationId, kind: 'admin' }),
      ]),
    );
    const supportMessages = await app.inject({
      method: 'GET',
      url: `/conversations/${supportConversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(supportMessages.json().messages).toEqual([
      expect.objectContaining({
        senderId: 'demo-commissioner',
        text: 'I need help understanding a warning.',
      }),
    ]);

    const adminReply = await app.inject({
      method: 'POST',
      url: `/conversations/${supportConversationId}/messages`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
      payload: {
        text: 'I can help. The warning is also available from your account screen.',
      },
    });
    expect(adminReply.statusCode).toBe(201);

    const commissionerMessages = await app.inject({
      method: 'GET',
      url: `/conversations/${supportConversationId}/messages`,
      headers: { authorization: `Bearer ${commissionerToken}` },
    });
    expect(commissionerMessages.json().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          senderId: 'demo-admin',
          text: 'I can help. The warning is also available from your account screen.',
        }),
      ]),
    );

    const makerInbox = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${makerToken}` },
    });
    expect(makerInbox.json().conversations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: supportConversationId })]),
    );
  });
});
