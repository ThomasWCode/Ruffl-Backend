import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { UploadSlot } from '../src/domain/types.js';
import {
  MediaService,
  type MediaGateway,
} from '../src/services/media-service.js';
import { InMemoryStore } from '../src/store/in-memory-store.js';

class FakeMediaGateway implements MediaGateway {
  async createUploadSlot(
    objectKey: string,
    contentType: string,
    _size: number,
  ): Promise<UploadSlot> {
    return {
      uploadUrl: `https://upload.example.test/${objectKey}`,
      publicUrl: `https://media.example.test/${objectKey}`,
      expiresInSeconds: 300,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
    };
  }

  ownsPublicUrl(
    url: string,
    userId: string,
    folder: 'uploads' | 'avatars' | 'banners',
  ): boolean {
    return url.startsWith(
      `https://media.example.test/${folder}/${userId}/`,
    );
  }
}

describe('media uploads', () => {
  const store = new InMemoryStore();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let commissionerToken: string;

  beforeEach(async () => {
    store.clear();
    app = await buildApp({
      store,
      seedDemoData: true,
      jwtSecret: 'test-secret',
      mediaGateway: new FakeMediaGateway(),
    });
    commissionerToken = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'commissioner@demo.ruffl',
          password: 'RufflDemo1!',
        },
      })
    ).json().token as string;
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates an owned upload slot and accepts its URL in a message', async () => {
    const slotResponse = await app.inject({
      method: 'POST',
      url: '/uploads/slot',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        fileName: 'reference.png',
        contentType: 'image/png',
        size: 1_024,
        category: 'image',
      },
    });
    expect(slotResponse.statusCode).toBe(200);
    const slot = slotResponse.json().slot as UploadSlot;
    expect(slot.publicUrl).toContain('/uploads/demo-commissioner/');

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
      payload: {
        text: '',
        attachments: [
          {
            url: slot.publicUrl,
            name: 'reference.png',
            contentType: 'image/png',
          },
        ],
      },
    });

    expect(messageResponse.statusCode).toBe(201);
    expect(messageResponse.json().message.attachments).toEqual([
      {
        url: slot.publicUrl,
        name: 'reference.png',
        contentType: 'image/png',
      },
    ]);
  });

  it('rejects media URLs that are not owned by the authenticated account', async () => {
    const conversationResponse = await app.inject({
      method: 'POST',
      url: '/conversations/direct',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { participantId: 'demo-maker' },
    });
    const conversationId = conversationResponse.json().conversation.id as string;
    const response = await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        text: 'This URL belongs to another account.',
        attachments: [
          {
            url: 'https://media.example.test/uploads/demo-maker/private.png',
            name: 'private.png',
            contentType: 'image/png',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_MEDIA_URL' });
    expect(store.messages).toHaveLength(0);
  });

  it('only accepts an owned avatar URL on the user profile', async () => {
    const invalid = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: { avatarUrl: 'https://images.example.test/avatar.png' },
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { authorization: `Bearer ${commissionerToken}` },
      payload: {
        avatarUrl:
          'https://media.example.test/avatars/demo-commissioner/avatar.png',
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().user.avatarUrl).toBe(
      'https://media.example.test/avatars/demo-commissioner/avatar.png',
    );
  });
});

describe('media URL ownership', () => {
  function mediaService(): MediaService {
    return new MediaService({
      accountId: 'account-id',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      bucket: 'ruffl-media',
      publicUrl: 'https://media.example.test/assets',
    });
  }

  it('binds the declared byte length and content type into the upload signature', async () => {
    const slot = await mediaService().createUploadSlot(
      'uploads/user-one/reference.png',
      'image/png',
      1_024,
    );
    const signedHeaders = new URL(slot.uploadUrl).searchParams.get(
      'X-Amz-SignedHeaders',
    );

    expect(signedHeaders).toContain('content-length');
    expect(signedHeaders).toContain('content-type');
    expect(slot.headers).toEqual({ 'Content-Type': 'image/png' });
  });

  it('requires the exact read origin, folder, user, and path shape', () => {
    const media = mediaService();

    expect(
      media.ownsPublicUrl(
        'https://media.example.test/assets/uploads/user-one/reference.png',
        'user-one',
        'uploads',
      ),
    ).toBe(true);
    expect(
      media.ownsPublicUrl(
        'https://media.example.test.evil.test/assets/uploads/user-one/reference.png',
        'user-one',
        'uploads',
      ),
    ).toBe(false);
    expect(
      media.ownsPublicUrl(
        'https://media.example.test/assets/uploads/user-two/reference.png',
        'user-one',
        'uploads',
      ),
    ).toBe(false);
    expect(
      media.ownsPublicUrl(
        'https://media.example.test/assets/uploads/user-one/reference.png?redirect=1',
        'user-one',
        'uploads',
      ),
    ).toBe(false);
  });
});
