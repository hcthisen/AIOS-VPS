// Per-department S3 storage routes. Setup, probe, browser, upload, delete,
// signed URLs. All routes admin-guarded. Secrets never leave the server via GET.

import { Router, badRequest, notFound } from "../http";
import { adminOnly } from "../auth";
import { log } from "../log";

import {
  applyInstructions,
  clearInstructions,
  resetInstructionsToDefaults,
  storageInstructionPaths,
} from "../services/storageInstructions";
import {
  StorageConfig,
  clearStorageConfig,
  mergeStoredCredentials,
  readStorageConfig,
  readStorageConfigPublic,
  validateConfig,
  writeStorageConfig,
} from "../services/storageConfig";
import {
  deleteObject,
  ListResult,
  listObjects,
  presignGet,
  streamingUpload,
  translateError,
} from "../services/storageClient";
import { probe } from "../services/storageProbe";
import { buildPublicObjectUrl, encodePublicPath, probePublicBaseUrl } from "../services/publicBaseUrl";
import { syncManagedCaddy } from "../services/caddy";
import { commitRepoPaths, isGitWorktreeBlocked, syncRepoWithRemote } from "../services/repo";

// Serialize concurrent writes per department so a second POST /config can't
// race ahead of an in-flight probe+write.
const deptLocks = new Map<string, Promise<void>>();

function withDeptLock<T>(dept: string, fn: () => Promise<T>): Promise<T> {
  const prev = deptLocks.get(dept) || Promise.resolve();
  const next = prev.then(fn, fn);
  deptLocks.set(
    dept,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function assertUnderPrefix(key: string, publicPrefix: string, privatePrefix: string) {
  if (!key) throw badRequest("key required");
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) {
    throw badRequest("invalid key");
  }
  if (!key.startsWith(publicPrefix) && !key.startsWith(privatePrefix)) {
    throw badRequest("key must be under a configured prefix");
  }
}

function resolvePrefix(visibility: string, cfg: StorageConfig, sub: string): string {
  const root = visibility === "private" ? cfg.privatePrefix : cfg.publicPrefix;
  if (!sub) return root;
  const cleanSub = sub.replace(/^\/+/, "").replace(/\\+/g, "/");
  if (cleanSub.includes("..")) throw badRequest("invalid prefix");
  if (cleanSub.startsWith(root)) return cleanSub.endsWith("/") ? cleanSub : `${cleanSub}/`;
  const joined = `${root}${cleanSub}`;
  return joined.endsWith("/") ? joined : `${joined}/`;
}

export function encodeObjectPath(path: string): string {
  return encodePublicPath(path);
}

export async function collectObjectListing(
  fetchPage: (continuationToken?: string) => Promise<ListResult>,
): Promise<ListResult> {
  const prefixes = new Set<string>();
  const objects: ListResult["objects"] = [];
  let nextToken: string | undefined;
  let keyCount = 0;
  do {
    const page = await fetchPage(nextToken);
    for (const prefix of page.prefixes) prefixes.add(prefix);
    objects.push(...page.objects);
    keyCount += page.keyCount;
    nextToken = page.nextToken;
  } while (nextToken);
  return {
    prefixes: [...prefixes],
    objects,
    nextToken: undefined,
    keyCount,
  };
}

export function publicUrlFor(cfg: StorageConfig, key: string): string | undefined {
  return buildPublicObjectUrl(cfg.publicBaseUrl, key, cfg.publicPrefix);
}

async function commitStorageInstructionChanges(
  dept: string,
  message: string,
): Promise<string | null> {
  const paths = await storageInstructionPaths(dept);
  return commitRepoPaths(paths, message);
}

async function ensureRepoWritable() {
  if (isGitWorktreeBlocked()) throw badRequest("repo is busy with active agent work");
  const git = await syncRepoWithRemote({ notifyOnRemoteWins: true });
  if (!git.ok || git.blocked) throw badRequest(git.error || "repo is busy with active agent work");
}

export function registerStorageRoutes(router: Router) {
  const guard = adminOnly();

  router.get("/api/departments/:dept/storage/config", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    const cfg = await readStorageConfigPublic(dept);
    res.json(cfg);
  });

  router.post("/api/departments/:dept/storage/test", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    const body = (req.body || {}) as Partial<StorageConfig>;
    const merged = await mergeStoredCredentials(dept, body);
    let cfg: StorageConfig;
    try {
      cfg = validateConfig(merged);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const result = await probe(cfg);
    if (result.ok && cfg.publicBaseUrl) {
      const publicCheck = await probePublicBaseUrl(dept, cfg);
      if (publicCheck?.info) result.publicUrl = publicCheck.info;
      if (publicCheck && !publicCheck.ok) {
        result.ok = false;
        result.error = publicCheck.error;
      }
    }
    log.info("storage probe", {
      dept,
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      ok: result.ok,
      errorCode: result.error?.code,
    });
    res.json(result);
  });

  router.post("/api/departments/:dept/storage/config", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    const body = (req.body || {}) as Partial<StorageConfig>;
    const merged = await mergeStoredCredentials(dept, body);
    let cfg: StorageConfig;
    try {
      cfg = validateConfig(merged);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    await withDeptLock(dept, async () => {
      await ensureRepoWritable();
      const result = await probe(cfg);
      if (!result.ok) {
        throw badRequest(result.error?.message || "probe failed", {
          code: "ProbeFailed",
          error: result.error,
          result,
        });
      }
      const publicCheck = await probePublicBaseUrl(dept, cfg);
      if (publicCheck?.info) result.publicUrl = publicCheck.info;
      if (publicCheck && !publicCheck.ok) {
        throw badRequest(publicCheck.error?.message || "public URL probe failed", {
          code: publicCheck.error?.code || "PublicBaseUrlFailed",
          hint: publicCheck.error?.hint,
          error: publicCheck.error,
          publicUrl: publicCheck.info,
        });
      }
      await writeStorageConfig(dept, cfg);
      await applyInstructions(dept);
      await syncManagedCaddy();
      await commitStorageInstructionChanges(dept, `aios: storage instructions for ${dept}`).catch((e) => {
        log.warn("storage prompt commit failed", {
          dept,
          error: String((e as any)?.message || e),
        });
        return null;
      });
      log.info("storage configured", {
        dept,
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
      });
    });
    res.json({ ok: true });
  });

  router.delete("/api/departments/:dept/storage/config", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    await withDeptLock(dept, async () => {
      await ensureRepoWritable();
      await clearStorageConfig(dept);
      await clearInstructions(dept);
      await syncManagedCaddy();
      await commitStorageInstructionChanges(dept, `aios: remove storage instructions for ${dept}`).catch((e) => {
        log.warn("storage prompt commit failed", {
          dept,
          error: String((e as any)?.message || e),
        });
        return null;
      });
      log.info("storage disconnected", { dept });
    });
    res.json({ ok: true });
  });

  router.post("/api/departments/:dept/storage/instructions/reset", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    await ensureRepoWritable();
    const changed = await resetInstructionsToDefaults(dept);
    if (changed) {
      await commitStorageInstructionChanges(dept, `aios: reset storage instructions for ${dept}`).catch((e) => {
        log.warn("storage prompt commit failed", {
          dept,
          error: String((e as any)?.message || e),
        });
        return null;
      });
    }
    res.json({ ok: true, changed });
  });

  router.get("/api/departments/:dept/storage/objects", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    const cfg = await readStorageConfig(dept);
    if (!cfg) throw notFound("storage not configured");
    const visibility = req.query.visibility === "private" ? "private" : "public";
    const sub = req.query.prefix || "";
    const prefix = resolvePrefix(visibility, cfg, sub);
    const search = (req.query.search || "").toLowerCase();
    const sort = req.query.sort || "name";
    const order = req.query.order === "desc" ? "desc" : "asc";

    let listed;
    try {
      listed = await collectObjectListing((continuationToken) =>
        listObjects(cfg, prefix, {
          delimiter: "/",
          maxKeys: 1000,
          continuationToken,
        }),
      );
    } catch (e) {
      const friendly = translateError(e);
      throw badRequest(friendly.message, { code: friendly.code, hint: friendly.hint });
    }

    const folders = listed.prefixes.map((p) => ({
      key: p,
      name: p.slice(prefix.length).replace(/\/$/, ""),
    }));
    let files = listed.objects
      .filter((o) => o.key !== prefix)
      .map((o) => {
        const name = o.key.slice(prefix.length);
        return {
          key: o.key,
          name,
          size: o.size,
          lastModified: o.lastModified,
          publicUrl: publicUrlFor(cfg, o.key),
        };
      })
      .filter((f) => !f.name.includes("/"));

    if (search) files = files.filter((f) => f.name.toLowerCase().includes(search));
    files.sort((a, b) => {
      let cmp = 0;
      if (sort === "size") cmp = a.size - b.size;
      else if (sort === "date") {
        const at = a.lastModified ? a.lastModified.getTime() : 0;
        const bt = b.lastModified ? b.lastModified.getTime() : 0;
        cmp = at - bt;
      } else cmp = a.name.localeCompare(b.name);
      return order === "desc" ? -cmp : cmp;
    });

    res.json({
      visibility,
      prefix,
      folders,
      files,
      nextCursor: undefined,
    });
  });

  router.post("/api/departments/:dept/storage/objects/upload", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    const cfg = await readStorageConfig(dept);
    if (!cfg) throw notFound("storage not configured");
    const visibility = req.query.visibility === "private" ? "private" : "public";
    const sub = req.query.prefix || "";
    const filename = (req.query.filename || "").trim();
    if (!filename) throw badRequest("filename required");
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      throw badRequest("invalid filename");
    }
    const prefix = resolvePrefix(visibility, cfg, sub);
    const key = `${prefix}${filename}`;
    const contentType = (req.headers["content-type"] as string) || "application/octet-stream";
    try {
      await streamingUpload(cfg, key, req, contentType);
    } catch (e) {
      const friendly = translateError(e);
      throw badRequest(friendly.message, { code: friendly.code, hint: friendly.hint });
    }
    res.json({
      ok: true,
      key,
      publicUrl: publicUrlFor(cfg, key),
      contentType,
    });
  });

  router.delete("/api/departments/:dept/storage/objects", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    const cfg = await readStorageConfig(dept);
    if (!cfg) throw notFound("storage not configured");
    const key = req.query.key || "";
    assertUnderPrefix(key, cfg.publicPrefix, cfg.privatePrefix);
    try {
      await deleteObject(cfg, key);
    } catch (e) {
      const friendly = translateError(e);
      throw badRequest(friendly.message, { code: friendly.code, hint: friendly.hint });
    }
    res.json({ ok: true });
  });

  router.get("/api/departments/:dept/storage/objects/url", async (req, res) => {
    await guard(req, res);
    const dept = req.params.dept;
    const cfg = await readStorageConfig(dept);
    if (!cfg) throw notFound("storage not configured");
    const key = req.query.key || "";
    assertUnderPrefix(key, cfg.publicPrefix, cfg.privatePrefix);
    const mode = req.query.mode === "signed" ? "signed" : "public";
    const ttl = Math.max(30, Math.min(3600 * 24, Number(req.query.ttl || 600)));
    if (mode === "public") {
      const url = publicUrlFor(cfg, key);
      if (!url) {
        throw badRequest("no public URL for this key", { code: "NoPublicUrl" });
      }
      res.json({ url, mode: "public" });
      return;
    }
    try {
      const url = await presignGet(cfg, key, ttl);
      res.json({ url, mode: "signed", expiresIn: ttl });
    } catch (e) {
      const friendly = translateError(e);
      throw badRequest(friendly.message, { code: friendly.code, hint: friendly.hint });
    }
  });
}
