export type Visibility = "public" | "private";

export interface StoragePublic {
  configured: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyIdMasked: string;
  publicBaseUrl: string;
  publicPrefix: string;
  privatePrefix: string;
}

export interface PublicUrlRepairResult {
  ok: boolean;
  status: "ok" | "repairing" | "failed" | "external" | "not_applicable";
  publicBaseUrl: string;
  host: string;
  detail: string;
  hint?: string;
  repaired?: boolean;
}

export interface StorageFormState {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  publicPrefix: string;
  privatePrefix: string;
}

export interface ProbeError {
  code: string;
  message: string;
  hint?: string;
}

export interface ProbeResult {
  ok: boolean;
  readOk: boolean;
  writeOk: boolean;
  deleteOk: boolean;
  objectCount: number;
  error?: ProbeError;
  warnings?: string[];
  publicUrl?: {
    ok: boolean;
    mode: "aios" | "external";
    url: string;
    detail: string;
  };
}

export interface FolderEntry {
  key: string;
  name: string;
}

export interface FileEntry {
  key: string;
  name: string;
  size: number;
  lastModified?: string;
  publicUrl?: string;
}

export interface ListResponse {
  visibility: Visibility;
  prefix: string;
  folders: FolderEntry[];
  files: FileEntry[];
  nextCursor?: string;
}

export interface FilesQuery {
  visibility?: Visibility;
  prefix?: string;
  highlight?: string;
}
