// Connection probe: head + list + put + get + delete. Returns a structured
// result so the UI can surface per-step success/failure.

import { randomBytes } from "crypto";

import {
  deleteObject,
  FriendlyError,
  getObjectString,
  headBucket,
  listObjects,
  putObjectBuffer,
  translateError,
} from "./storageClient";
import { StorageConfig } from "./storageConfig";

export interface ProbeResult {
  ok: boolean;
  readOk: boolean;
  writeOk: boolean;
  deleteOk: boolean;
  objectCount: number;
  error?: FriendlyError;
  warnings?: string[];
}

export async function probe(cfg: StorageConfig): Promise<ProbeResult> {
  const warnings: string[] = [];

  try {
    await headBucket(cfg);
  } catch (e) {
    return {
      ok: false,
      readOk: false,
      writeOk: false,
      deleteOk: false,
      objectCount: 0,
      error: translateError(e),
    };
  }

  let objectCount = 0;
  try {
    const listed = await listObjects(cfg, "", { maxKeys: 1000 });
    objectCount = listed.keyCount;
  } catch (e) {
    return {
      ok: false,
      readOk: false,
      writeOk: false,
      deleteOk: false,
      objectCount: 0,
      error: translateError(e),
    };
  }

  const probeKey = `${cfg.publicPrefix}.aios-probe-${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
  const probeBody = "probe";

  try {
    await putObjectBuffer(cfg, probeKey, probeBody, "text/plain");
  } catch (e) {
    return {
      ok: false,
      readOk: true,
      writeOk: false,
      deleteOk: false,
      objectCount,
      error: translateError(e),
    };
  }

  let readBack = "";
  try {
    readBack = await getObjectString(cfg, probeKey);
  } catch (e) {
    // best-effort cleanup
    await deleteObject(cfg, probeKey).catch(() => {});
    return {
      ok: false,
      readOk: true,
      writeOk: true,
      deleteOk: false,
      objectCount,
      error: translateError(e),
    };
  }
  if (readBack !== probeBody) {
    await deleteObject(cfg, probeKey).catch(() => {});
    return {
      ok: false,
      readOk: true,
      writeOk: true,
      deleteOk: false,
      objectCount,
      error: {
        code: "ReadBackMismatch",
        message: "Wrote an object but read back different content.",
        hint: "Bucket may be behind a cache or have object-lock rules.",
      },
    };
  }

  let deleteOk = true;
  let deleteError: FriendlyError | undefined;
  try {
    await deleteObject(cfg, probeKey);
  } catch (e) {
    deleteOk = false;
    const friendly = translateError(e);
    deleteError = {
      code: "DeleteFailed",
      message: "Delete permission is required for the Files tab.",
      hint: friendly.hint || friendly.message,
    };
    warnings.push(
      `Delete step failed (${friendly.code}): object ${probeKey} left behind. ` +
        (friendly.hint || friendly.message),
    );
  }

  return {
    ok: deleteOk,
    readOk: true,
    writeOk: true,
    deleteOk,
    objectCount,
    error: deleteError,
    warnings: warnings.length ? warnings : undefined,
  };
}
