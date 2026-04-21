// Read / write the AIOS_STORAGE_* keys in a department's .env. This is the
// only serializer for storage credentials; GET paths must use the masked
// variant to avoid leaking the secret key.

import { join } from "path";

import { listDepartments } from "./departments";
import { mergeEnv, readEnvFile, toMap } from "./envFile";

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  publicPrefix: string;
  privatePrefix: string;
}

export interface StorageConfigPublic {
  configured: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdMasked: string;
  publicBaseUrl: string;
  publicPrefix: string;
  privatePrefix: string;
}

export const STORAGE_KEYS = [
  "AIOS_STORAGE_ENDPOINT",
  "AIOS_STORAGE_REGION",
  "AIOS_STORAGE_BUCKET",
  "AIOS_STORAGE_ACCESS_KEY_ID",
  "AIOS_STORAGE_SECRET_ACCESS_KEY",
  "AIOS_STORAGE_PUBLIC_BASE_URL",
  "AIOS_STORAGE_PUBLIC_PREFIX",
  "AIOS_STORAGE_PRIVATE_PREFIX",
] as const;

export const DEFAULT_PUBLIC_PREFIX = "public/";
export const DEFAULT_PRIVATE_PREFIX = "private/";

export async function deptEnvPath(deptName: string): Promise<string> {
  const depts = await listDepartments();
  const d = depts.find((x) => x.name === deptName);
  if (!d) throw new Error(`department not found: ${deptName}`);
  return join(d.path, ".env");
}

function normalizePrefix(p: string, fallback: string): string {
  const v = (p || "").trim();
  if (!v) return fallback;
  return v.endsWith("/") ? v : `${v}/`;
}

export function maskAccessKey(id: string): string {
  if (!id) return "";
  if (id.length <= 4) return "*".repeat(id.length);
  return `****${id.slice(-4)}`;
}

export function fromEnvMap(map: Record<string, string>): StorageConfig | null {
  const endpoint = (map.AIOS_STORAGE_ENDPOINT || "").trim();
  const bucket = (map.AIOS_STORAGE_BUCKET || "").trim();
  const accessKeyId = (map.AIOS_STORAGE_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (map.AIOS_STORAGE_SECRET_ACCESS_KEY || "").trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    region: (map.AIOS_STORAGE_REGION || "us-east-1").trim(),
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: (map.AIOS_STORAGE_PUBLIC_BASE_URL || "").trim(),
    publicPrefix: normalizePrefix(map.AIOS_STORAGE_PUBLIC_PREFIX, DEFAULT_PUBLIC_PREFIX),
    privatePrefix: normalizePrefix(map.AIOS_STORAGE_PRIVATE_PREFIX, DEFAULT_PRIVATE_PREFIX),
  };
}

export async function readStorageConfig(deptName: string): Promise<StorageConfig | null> {
  const abs = await deptEnvPath(deptName);
  const entries = await readEnvFile(abs);
  return fromEnvMap(toMap(entries));
}

export async function readStorageConfigPublic(deptName: string): Promise<StorageConfigPublic> {
  const cfg = await readStorageConfig(deptName);
  if (!cfg) {
    return {
      configured: false,
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyIdMasked: "",
      publicBaseUrl: "",
      publicPrefix: DEFAULT_PUBLIC_PREFIX,
      privatePrefix: DEFAULT_PRIVATE_PREFIX,
    };
  }
  return {
    configured: true,
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKeyIdMasked: maskAccessKey(cfg.accessKeyId),
    publicBaseUrl: cfg.publicBaseUrl,
    publicPrefix: cfg.publicPrefix,
    privatePrefix: cfg.privatePrefix,
  };
}

export function validateConfig(input: Partial<StorageConfig>): StorageConfig {
  const endpoint = (input.endpoint || "").trim();
  const bucket = (input.bucket || "").trim();
  const accessKeyId = (input.accessKeyId || "").trim();
  const secretAccessKey = (input.secretAccessKey || "").trim();
  if (!endpoint) throw new Error("endpoint is required");
  if (!/^https?:\/\//i.test(endpoint)) throw new Error("endpoint must start with http(s)://");
  if (!bucket) throw new Error("bucket is required");
  if (!/^[a-z0-9][a-z0-9.\-]{1,62}$/.test(bucket)) throw new Error("bucket name is invalid");
  if (!accessKeyId) throw new Error("accessKeyId is required");
  if (!secretAccessKey) throw new Error("secretAccessKey is required");
  const publicBaseUrl = (input.publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (publicBaseUrl && !/^https?:\/\//i.test(publicBaseUrl)) {
    throw new Error("publicBaseUrl must start with http(s)://");
  }
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    region: (input.region || "us-east-1").trim() || "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl,
    publicPrefix: normalizePrefix(input.publicPrefix || "", DEFAULT_PUBLIC_PREFIX),
    privatePrefix: normalizePrefix(input.privatePrefix || "", DEFAULT_PRIVATE_PREFIX),
  };
}

export async function writeStorageConfig(deptName: string, cfg: StorageConfig): Promise<void> {
  const abs = await deptEnvPath(deptName);
  await mergeEnv(abs, {
    AIOS_STORAGE_ENDPOINT: cfg.endpoint,
    AIOS_STORAGE_REGION: cfg.region,
    AIOS_STORAGE_BUCKET: cfg.bucket,
    AIOS_STORAGE_ACCESS_KEY_ID: cfg.accessKeyId,
    AIOS_STORAGE_SECRET_ACCESS_KEY: cfg.secretAccessKey,
    AIOS_STORAGE_PUBLIC_BASE_URL: cfg.publicBaseUrl,
    AIOS_STORAGE_PUBLIC_PREFIX: cfg.publicPrefix,
    AIOS_STORAGE_PRIVATE_PREFIX: cfg.privatePrefix,
  });
}

export async function clearStorageConfig(deptName: string): Promise<void> {
  const abs = await deptEnvPath(deptName);
  await mergeEnv(abs, {}, [...STORAGE_KEYS]);
}

// When the operator re-tests with the secret omitted (Settings drawer),
// merge the stored secret back in so they don't have to re-type it.
export async function mergeStoredSecret(
  deptName: string,
  input: Partial<StorageConfig>,
): Promise<Partial<StorageConfig>> {
  if (input.secretAccessKey && input.secretAccessKey.trim()) return input;
  const stored = await readStorageConfig(deptName);
  if (!stored) return input;
  return { ...input, secretAccessKey: stored.secretAccessKey };
}

