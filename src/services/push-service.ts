import type { Notification, PushDelivery } from '../domain/types.js';
import type { InMemoryStore } from '../store/in-memory-store.js';

export type PushSendResult =
  | { status: 'accepted'; receiptId: string }
  | { status: 'retry'; error: string }
  | { status: 'failed'; error: string; deviceNotRegistered?: boolean };

export type PushReceiptResult =
  | { status: 'delivered' }
  | { status: 'retry'; error: string }
  | { status: 'failed'; error: string; deviceNotRegistered?: boolean };

export interface PushGateway {
  send(
    token: string,
    notification: Notification,
  ): Promise<PushSendResult>;
  receipts(receiptIds: string[]): Promise<Map<string, PushReceiptResult>>;
}

interface ExpoResult {
  status?: string;
  id?: string;
  details?: { error?: string };
}

const pushTokenPattern = /^(Expo(nent)?PushToken)\[[A-Za-z0-9_-]+\]$/;

export function isExpoPushToken(value: string): boolean {
  return pushTokenPattern.test(value);
}

function pushError(error: string | undefined): PushSendResult | PushReceiptResult {
  if (error === 'DeviceNotRegistered') {
    return {
      status: 'failed',
      error: 'DeviceNotRegistered',
      deviceNotRegistered: true,
    };
  }
  if (error === 'MessageRateExceeded') {
    return { status: 'retry', error: 'MessageRateExceeded' };
  }
  return { status: 'failed', error: error ?? 'PushRejected' };
}

export class ExpoPushGateway implements PushGateway {
  private constructor(private readonly accessToken: string) {}

  static fromEnvironment(): ExpoPushGateway | null {
    const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
    return accessToken ? new ExpoPushGateway(accessToken) : null;
  }

  async send(
    token: string,
    notification: Notification,
  ): Promise<PushSendResult> {
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: token,
          sound: 'default',
          title: notification.title.slice(0, 120),
          body: notification.body.slice(0, 1_000),
          data: {
            notificationId: notification.id,
            type: notification.type,
          },
          ttl: 86_400,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 429 || response.status >= 500) {
        return { status: 'retry', error: `ExpoHttp${response.status}` };
      }
      if (!response.ok) {
        return { status: 'failed', error: `ExpoHttp${response.status}` };
      }
      const payload = (await response.json()) as {
        data?: ExpoResult | ExpoResult[];
      };
      const ticket = Array.isArray(payload.data)
        ? payload.data[0]
        : payload.data;
      if (ticket?.status === 'ok' && ticket.id) {
        return { status: 'accepted', receiptId: ticket.id };
      }
      return pushError(ticket?.details?.error) as PushSendResult;
    } catch {
      return { status: 'retry', error: 'ExpoUnavailable' };
    }
  }

  async receipts(
    receiptIds: string[],
  ): Promise<Map<string, PushReceiptResult>> {
    const response = await fetch(
      'https://exp.host/--/api/v2/push/getReceipts',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: receiptIds }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Expo receipt request failed with status ${response.status}.`);
    }
    const payload = (await response.json()) as {
      data?: Record<string, ExpoResult>;
    };
    return new Map(
      Object.entries(payload.data ?? {}).map(([id, receipt]) => [
        id,
        receipt.status === 'ok'
          ? { status: 'delivered' as const }
          : (pushError(receipt.details?.error) as PushReceiptResult),
      ]),
    );
  }
}

function nextRetry(attempts: number): string {
  const seconds = Math.min(60 * 2 ** Math.max(attempts - 1, 0), 3_600);
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

export class PushDeliveryWorker {
  private interval: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: InMemoryStore,
    private readonly gateway: PushGateway,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  start(): void {
    this.interval = setInterval(() => this.wake(), 60_000);
    this.interval.unref();
    this.wake();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  wake(): void {
    void this.runNow().catch(this.onError);
  }

  async runNow(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.removeOldCompletedDeliveries();
      await this.sendQueuedDeliveries();
      await this.checkDueReceipts();
    } finally {
      this.running = false;
    }
  }

  private async sendQueuedDeliveries(): Promise<void> {
    const now = Date.now();
    const queued = [...this.store.pushDeliveries.values()]
      .filter(
        (delivery) =>
          delivery.status === 'queued' &&
          new Date(delivery.nextAttemptAt).getTime() <= now,
      )
      .slice(0, 100);

    for (const delivery of queued) {
      const notification = this.store.notifications.find(
        (item) => item.id === delivery.notificationId,
      );
      if (!notification) {
        await this.updateDelivery(delivery.id, (current) => {
          current.status = 'failed';
          current.lastError = 'NotificationMissing';
        });
        continue;
      }

      const result = await this.gateway.send(delivery.pushToken, notification);
      await this.updateDelivery(delivery.id, (current) => {
        if (result.status === 'accepted') {
          current.status = 'sent';
          current.receiptId = result.receiptId;
          current.nextAttemptAt = new Date(
            Date.now() + 15 * 60_000,
          ).toISOString();
          delete current.lastError;
          return;
        }
        current.attempts += 1;
        current.lastError = result.error;
        if (result.status === 'retry' && current.attempts < 5) {
          current.nextAttemptAt = nextRetry(current.attempts);
          return;
        }
        current.status = 'failed';
        if (result.status === 'failed' && result.deviceNotRegistered) {
          this.clearPushToken(current);
        }
      });
    }
  }

  private async checkDueReceipts(): Promise<void> {
    const now = Date.now();
    const sent = [...this.store.pushDeliveries.values()]
      .filter(
        (delivery) =>
          delivery.status === 'sent' &&
          Boolean(delivery.receiptId) &&
          new Date(delivery.nextAttemptAt).getTime() <= now,
      )
      .slice(0, 1_000);
    if (!sent.length) return;

    let receipts: Map<string, PushReceiptResult>;
    try {
      receipts = await this.gateway.receipts(
        sent.flatMap((delivery) =>
          delivery.receiptId ? [delivery.receiptId] : [],
        ),
      );
    } catch {
      for (const delivery of sent) {
        await this.updateDelivery(delivery.id, (current) => {
          current.nextAttemptAt = new Date(
            Date.now() + 5 * 60_000,
          ).toISOString();
          current.lastError = 'ReceiptUnavailable';
        });
      }
      return;
    }

    for (const delivery of sent) {
      const result = delivery.receiptId
        ? receipts.get(delivery.receiptId)
        : undefined;
      await this.updateDelivery(delivery.id, (current) => {
        if (!result) {
          const expired =
            Date.now() - new Date(current.createdAt).getTime() >= 24 * 3_600_000;
          current.status = expired ? 'failed' : 'sent';
          current.nextAttemptAt = new Date(
            Date.now() + 5 * 60_000,
          ).toISOString();
          current.lastError = expired ? 'ReceiptExpired' : 'ReceiptPending';
          return;
        }
        if (result.status === 'delivered') {
          current.status = 'delivered';
          delete current.lastError;
          return;
        }
        current.lastError = result.error;
        if (result.status === 'retry' && current.attempts < 5) {
          current.status = 'queued';
          current.attempts += 1;
          delete current.receiptId;
          current.nextAttemptAt = nextRetry(current.attempts);
          return;
        }
        current.status = 'failed';
        if (result.status === 'failed' && result.deviceNotRegistered) {
          this.clearPushToken(current);
        }
      });
    }
  }

  private clearPushToken(delivery: PushDelivery): void {
    const user = this.store.users.get(delivery.userId);
    if (user?.pushToken === delivery.pushToken) {
      delete user.pushToken;
    }
  }

  private async updateDelivery(
    deliveryId: string,
    update: (delivery: PushDelivery) => void,
  ): Promise<void> {
    const mutation = await this.store.beginMutation();
    try {
      const current = this.store.pushDeliveries.get(deliveryId);
      if (current) update(current);
      await mutation.commit();
    } catch (error) {
      mutation.rollback();
      throw error;
    }
  }

  private async removeOldCompletedDeliveries(): Promise<void> {
    const cutoff = Date.now() - 30 * 24 * 3_600_000;
    const oldIds = [...this.store.pushDeliveries.values()]
      .filter(
        (delivery) =>
          ['delivered', 'failed'].includes(delivery.status) &&
          new Date(delivery.createdAt).getTime() < cutoff,
      )
      .map((delivery) => delivery.id);
    if (!oldIds.length) return;

    const mutation = await this.store.beginMutation();
    try {
      oldIds.forEach((id) => this.store.pushDeliveries.delete(id));
      await mutation.commit();
    } catch (error) {
      mutation.rollback();
      throw error;
    }
  }
}
