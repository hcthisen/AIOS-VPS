// Thin S3 client factory + typed wrappers around the handful of operations
// the Files tab uses. Centralizes error -> user-facing message translation so
// the route layer stays slim.

import { Readable } from "stream";
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  _Object,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { StorageConfig } from "./storageConfig";

export function s3ClientFor(cfg: StorageConfig): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

export interface FriendlyError {
  code: string;
  message: string;
  hint?: string;
}

export function translateError(err: unknown): FriendlyError {
  const e = err as any;
  const name = e?.name || e?.Code || e?.code || "Error";
  const rawMessage = e?.message || String(err);

  switch (name) {
    case "NoSuchBucket":
      return {
        code: "NoSuchBucket",
        message: "Bucket does not exist at this endpoint.",
        hint: "Check the bucket name and endpoint.",
      };
    case "PermanentRedirect":
    case "AuthorizationHeaderMalformed":
      return {
        code: "PermanentRedirect",
        message: "Bucket region mismatch.",
        hint: "Update the region to match where the bucket lives.",
      };
    case "InvalidAccessKeyId":
      return {
        code: "InvalidAccessKeyId",
        message: "Access key ID is not recognized by this endpoint.",
        hint: "Double-check the access key.",
      };
    case "SignatureDoesNotMatch":
      return {
        code: "SignatureDoesNotMatch",
        message: "Secret access key did not produce a valid signature.",
        hint: "Re-paste the secret access key; check for trailing whitespace.",
      };
    case "AccessDenied":
    case "AllAccessDisabled":
      return {
        code: "AccessDenied",
        message: "The credentials do not have permission for this operation.",
        hint: "Ensure the key policy grants s3:ListBucket, PutObject, GetObject, DeleteObject.",
      };
    case "NotFound":
    case "NoSuchKey":
      return {
        code: "NotFound",
        message: "Resource not found.",
        hint: rawMessage,
      };
    case "NetworkingError":
    case "ENOTFOUND":
    case "ECONNREFUSED":
    case "ETIMEDOUT":
      return {
        code: "NetworkError",
        message: "Could not reach the storage endpoint.",
        hint: "Confirm the endpoint URL and that it is reachable from this server.",
      };
    default:
      return { code: String(name), message: rawMessage };
  }
}

export async function headBucket(cfg: StorageConfig): Promise<void> {
  const client = s3ClientFor(cfg);
  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
  } finally {
    client.destroy();
  }
}

export interface ListResult {
  prefixes: string[];
  objects: Array<{
    key: string;
    size: number;
    lastModified?: Date;
    etag?: string;
  }>;
  nextToken?: string;
  keyCount: number;
}

export async function listObjects(
  cfg: StorageConfig,
  prefix: string,
  opts: { delimiter?: string; maxKeys?: number; continuationToken?: string } = {},
): Promise<ListResult> {
  const client = s3ClientFor(cfg);
  try {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: prefix,
        Delimiter: opts.delimiter,
        MaxKeys: opts.maxKeys ?? 1000,
        ContinuationToken: opts.continuationToken,
      }),
    );
    const objects = (out.Contents || []).map((o: _Object) => ({
      key: o.Key || "",
      size: Number(o.Size || 0),
      lastModified: o.LastModified,
      etag: o.ETag,
    }));
    const prefixes = (out.CommonPrefixes || []).map((p) => p.Prefix || "").filter(Boolean);
    return {
      prefixes,
      objects,
      nextToken: out.NextContinuationToken,
      keyCount: Number(out.KeyCount || objects.length),
    };
  } finally {
    client.destroy();
  }
}

export async function putObjectBuffer(
  cfg: StorageConfig,
  key: string,
  body: Buffer | string,
  contentType?: string,
): Promise<void> {
  const client = s3ClientFor(cfg);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  } finally {
    client.destroy();
  }
}

export async function streamingUpload(
  cfg: StorageConfig,
  key: string,
  body: Readable,
  contentType?: string,
): Promise<void> {
  const client = s3ClientFor(cfg);
  try {
    const upload = new Upload({
      client,
      params: {
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
      partSize: 8 * 1024 * 1024,
      queueSize: 4,
    });
    await upload.done();
  } finally {
    client.destroy();
  }
}

export async function getObjectString(cfg: StorageConfig, key: string): Promise<string> {
  const client = s3ClientFor(cfg);
  try {
    const out = await client.send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
    );
    const body = out.Body as Readable | undefined;
    if (!body) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  } finally {
    client.destroy();
  }
}

export async function deleteObject(cfg: StorageConfig, key: string): Promise<void> {
  const client = s3ClientFor(cfg);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } finally {
    client.destroy();
  }
}

export async function presignGet(
  cfg: StorageConfig,
  key: string,
  expiresSec = 600,
): Promise<string> {
  const client = s3ClientFor(cfg);
  try {
    return await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
      { expiresIn: expiresSec },
    );
  } finally {
    client.destroy();
  }
}
