import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { UploadSlot } from '../domain/types.js';

interface MediaConfiguration {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
}

export class MediaService {
  private readonly client: S3Client;

  constructor(private readonly configuration: MediaConfiguration) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${configuration.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    });
  }

  static fromEnvironment(): MediaService | null {
    const values = {
      accountId: process.env.R2_ACCOUNT_ID?.trim(),
      accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim(),
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim(),
      bucket: process.env.R2_BUCKET?.trim(),
      publicUrl: process.env.R2_PUBLIC_URL?.trim(),
    };
    if (Object.values(values).every((value) => !value)) return null;
    if (Object.values(values).some((value) => !value)) {
      throw new Error(
        'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and R2_PUBLIC_URL must be set together.',
      );
    }
    const publicUrl = new URL(values.publicUrl!);
    if (publicUrl.protocol !== 'https:') {
      throw new Error('R2_PUBLIC_URL must use HTTPS.');
    }
    return new MediaService(values as MediaConfiguration);
  }

  async createUploadSlot(
    objectKey: string,
    contentType: string,
  ): Promise<UploadSlot> {
    const expiresInSeconds = 300;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.configuration.bucket,
        Key: objectKey,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
    return {
      uploadUrl,
      publicUrl: `${this.configuration.publicUrl.replace(/\/+$/, '')}/${objectKey}`,
      expiresInSeconds,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
    };
  }
}
