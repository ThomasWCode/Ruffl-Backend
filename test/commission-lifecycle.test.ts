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

  it('moves a request through negotiation and allocates the remaining balance exactly', async () => {
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
