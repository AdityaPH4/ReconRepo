/**
 * S3-backed object store — same interface as `localObjectStore.ts`.
 *
 * `exists()` uses `HeadObjectCommand` — there is no separate `s3:HeadObject`
 * IAM action; that call is authorized under `s3:GetObject`.
 *
 * Credentials: if `accessKeyId`/`secretAccessKey` are set, they're used
 * explicitly (local development, outside AWS). Left blank, the AWS SDK's
 * default credential chain applies — the intended path in production, where
 * the Lambda execution role is granted S3 permissions directly instead of
 * static keys.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStore, PutObjectInput } from './types.js';

export interface S3ObjectStoreConfig {
  region: string;
  bucket: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createS3ObjectStore(cfg: S3ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
      : {}),
  });

  return {
    driver: 's3',

    async put({ key, body, contentType }: PutObjectInput) {
      await client.send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }),
      );
      return { key };
    },

    async get(key: string) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return streamToBuffer(res.Body);
    },

    async exists(key: string) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
