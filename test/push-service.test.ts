import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { Notification, PushDelivery, User } from '../src/domain/types.js';
import {
  PushDeliveryWorker,
  type PushGateway,
  type PushReceiptResult,
  type PushSendResult,
} from '../src/services/push-service.js';
import { InMemoryStore } from '../src/store/in-memory-store.js';

class FakePushGateway implements PushGateway {
  sent: { token: string; notification: Notification }[] = [];
  sendResult: PushSendResult = {
    status: 'accepted',
    receiptId: 'receipt-1',
  };
  receiptResult: PushReceiptResult = { status: 'delivered' };

  async send(
    token: string,
    notification: Notification,
  ): Promise<PushSendResult> {
    this.sent.push({ token, notification });
    return this.sendResult;
  }

  async receipts(
    receiptIds: string[],
  ): Promise<Map<string, PushReceiptResult>> {
    return new Map(receiptIds.map((id) => [id, this.receiptResult]));
  }
}

function seededPushStore(): {
  store: InMemoryStore;
  user: User;
  notification: Notification;
  delivery: PushDelivery;
} {
  const store = new InMemoryStore();
  const createdAt = new Date().toISOString();
  const user: User = {
    id: crypto.randomUUID(),
    email: 'push@example.com',
    passwordHash: 'not-used',
    displayName: 'Push User',
    role: 'commissioner',
    status: 'active',
    pushToken: 'ExponentPushToken[test-token]',
    emailVerifiedAt: createdAt,
    createdAt,
  };
  const notification: Notification = {
    id: crypto.randomUUID(),
    userId: user.id,
    type: 'message_received',
    title: 'New message',
    body: 'A maker sent you a message.',
    read: false,
    createdAt,
  };
  const delivery: PushDelivery = {
    id: crypto.randomUUID(),
    notificationId: notification.id,
    userId: user.id,
    pushToken: user.pushToken!,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: createdAt,
    createdAt,
  };
  store.users.set(user.id, user);
  store.notifications.push(notification);
  store.pushDeliveries.set(delivery.id, delivery);
  return { store, user, notification, delivery };
}

describe('push delivery worker', () => {
  it('stores an Expo ticket and later records its delivery receipt', async () => {
    const { store, delivery } = seededPushStore();
    const gateway = new FakePushGateway();
    const worker = new PushDeliveryWorker(store, gateway);

    await worker.runNow();
    expect(store.pushDeliveries.get(delivery.id)).toMatchObject({
      status: 'sent',
      receiptId: 'receipt-1',
    });

    const sent = store.pushDeliveries.get(delivery.id);
    if (!sent) throw new Error('Delivery disappeared during the test.');
    sent.nextAttemptAt = new Date(0).toISOString();
    await worker.runNow();

    expect(store.pushDeliveries.get(delivery.id)).toMatchObject({
      status: 'delivered',
      receiptId: 'receipt-1',
    });
  });

  it('stops using a token rejected as DeviceNotRegistered', async () => {
    const { store, user, delivery } = seededPushStore();
    const gateway = new FakePushGateway();
    gateway.sendResult = {
      status: 'failed',
      error: 'DeviceNotRegistered',
      deviceNotRegistered: true,
    };
    const worker = new PushDeliveryWorker(store, gateway);

    await worker.runNow();

    expect(store.pushDeliveries.get(delivery.id)).toMatchObject({
      status: 'failed',
      lastError: 'DeviceNotRegistered',
    });
    expect(store.users.get(user.id)?.pushToken).toBeUndefined();
  });
});

describe('push delivery integration', () => {
  it('queues and sends a push when a message creates a notification', async () => {
    const store = new InMemoryStore();
    const gateway = new FakePushGateway();
    const app = await buildApp({
      store,
      seedDemoData: true,
      jwtSecret: 'test-secret',
      pushGateway: gateway,
    });

    try {
      const commissionerToken = (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            email: 'commissioner@demo.ruffl',
            password: 'RufflDemo1!',
          },
        })
      ).json().token as string;
      const makerToken = (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            email: 'maker@demo.ruffl',
            password: 'RufflDemo1!',
          },
        })
      ).json().token as string;

      const profileResponse = await app.inject({
        method: 'PATCH',
        url: '/me',
        headers: { authorization: `Bearer ${makerToken}` },
        payload: { pushToken: 'ExponentPushToken[maker-device]' },
      });
      expect(profileResponse.statusCode).toBe(200);

      const conversationResponse = await app.inject({
        method: 'POST',
        url: '/conversations/direct',
        headers: { authorization: `Bearer ${commissionerToken}` },
        payload: { participantId: 'demo-maker' },
      });
      const conversationId = conversationResponse.json().conversation.id as string;

      const messageResponse = await app.inject({
        method: 'POST',
        url: `/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${commissionerToken}` },
        payload: { text: 'Your commission has a new update.' },
      });
      expect(messageResponse.statusCode).toBe(201);

      await vi.waitFor(() => {
        expect(gateway.sent).toHaveLength(1);
      });
      expect(gateway.sent[0]).toMatchObject({
        token: 'ExponentPushToken[maker-device]',
        notification: {
          userId: 'demo-maker',
          type: 'message_received',
          body: 'Your commission has a new update.',
        },
      });
      expect([...store.pushDeliveries.values()]).toHaveLength(1);
      expect([...store.pushDeliveries.values()][0]).toMatchObject({
        userId: 'demo-maker',
        status: 'sent',
        receiptId: 'receipt-1',
      });
    } finally {
      await app.close();
    }
  });
});
