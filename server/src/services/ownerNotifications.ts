import { createHash } from "crypto";
import { existsSync } from "fs";
import { readdir, readFile, rm, stat } from "fs/promises";
import { basename, join, relative } from "path";
import matter from "gray-matter";

import { config } from "../config";
import { db } from "../db";
import { getCurrentCompanyId } from "../company-context";
import { getRootDepartment, listDepartments } from "./departments";
import { getNotificationConfig, sendNotification } from "./notifications";

export type OwnerNotificationStatus = "pending" | "delivered" | "failed" | "no_channel";
export type OwnerNotificationPriority = "info" | "warning" | "critical";

export interface OwnerNotification {
  id: number;
  company_id?: number;
  source_scope: string;
  source_path: string;
  content_hash: string;
  run_id: string | null;
  title: string;
  body: string;
  priority: OwnerNotificationPriority;
  tags: string;
  status: OwnerNotificationStatus;
  delivery_channel: string;
  delivery_attempts: number;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
  raw_frontmatter: string | null;
}

export interface NotificationListOptions {
  limit?: number;
  offset?: number;
  query?: string;
  scope?: string;
  priority?: string;
  status?: string;
}

export interface ProcessOutboxResult {
  inserted: number;
  delivered: number;
  failed: number;
  noChannel: number;
  deletedPaths: string[];
}

const PRIORITIES = new Set<OwnerNotificationPriority>(["info", "warning", "critical"]);

function normalizePriority(input: unknown): OwnerNotificationPriority {
  const value = String(input || "info").trim().toLowerCase();
  return PRIORITIES.has(value as OwnerNotificationPriority) ? value as OwnerNotificationPriority : "info";
}

function filenameTitle(file: string): string {
  return basename(file, ".md")
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    || "Owner notification";
}

function normalizeTags(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 12);
  }
  if (typeof input === "string") {
    return input.split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, 12);
  }
  return [];
}

function contentHash(scope: string, relPath: string, raw: string): string {
  return createHash("sha256").update(scope).update("\0").update(relPath).update("\0").update(raw).digest("hex");
}

function deliveryChannel(): string {
  const notificationConfig = getNotificationConfig();
  return notificationConfig.channel;
}

function clampLimit(value: unknown): number {
  const n = Number(value) || 50;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function clampOffset(value: unknown): number {
  const n = Number(value) || 0;
  return Math.max(0, Math.floor(n));
}

function insertNotification(input: {
  sourceScope: string;
  sourcePath: string;
  contentHash: string;
  runId?: string | null;
  title: string;
  body: string;
  priority: OwnerNotificationPriority;
  tags: string[];
  status?: OwnerNotificationStatus;
  lastError?: string | null;
  rawFrontmatter?: unknown;
}): OwnerNotification | null {
  const status = input.status || "pending";
  try {
    const info = db.prepare(`
      INSERT INTO owner_notifications(
        company_id, source_scope, source_path, content_hash, run_id, title, body, priority, tags,
        status, delivery_channel, delivery_attempts, last_error, created_at, raw_frontmatter
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      getCurrentCompanyId(),
      input.sourceScope,
      input.sourcePath,
      input.contentHash,
      input.runId || null,
      input.title.slice(0, 200),
      input.body.slice(0, 8000),
      input.priority,
      JSON.stringify(input.tags),
      status,
      deliveryChannel(),
      input.lastError || null,
      Date.now(),
      input.rawFrontmatter ? JSON.stringify(input.rawFrontmatter).slice(0, 4000) : null,
    );
    return getNotification(Number(info.lastInsertRowid));
  } catch (e: any) {
    if (String(e?.message || e).includes("UNIQUE")) return null;
    throw e;
  }
}

async function sourceScopes(): Promise<Array<{ name: string; path: string; outbox: string }>> {
  const root = await getRootDepartment();
  const departments = await listDepartments();
  return [root, ...departments].map((scope) => ({
    name: scope.name,
    path: scope.path,
    outbox: join(scope.path, "outbox"),
  }));
}

export async function processOwnerNotificationOutbox(opts: { runId?: string | null } = {}): Promise<ProcessOutboxResult> {
  const result: ProcessOutboxResult = { inserted: 0, delivered: 0, failed: 0, noChannel: 0, deletedPaths: [] };
  for (const scope of await sourceScopes()) {
    if (!existsSync(scope.outbox)) continue;
    const files = (await readdir(scope.outbox).catch(() => []))
      .filter((file) => file.toLowerCase().endsWith(".md"))
      .sort();
    for (const file of files) {
      const abs = join(scope.outbox, file);
      const s = await stat(abs).catch(() => null);
      if (!s?.isFile()) continue;
      const raw = await readFile(abs, "utf-8").catch(() => "");
      const relPath = relative(config.repoDir, abs).replace(/\\/g, "/");
      const hash = contentHash(scope.name, relPath, raw);
      let inserted: OwnerNotification | null = null;
      try {
        const parsed = matter(raw);
        const body = parsed.content.trim();
        if (!body) throw new Error("notification body is empty");
        inserted = insertNotification({
          sourceScope: scope.name,
          sourcePath: relPath,
          contentHash: hash,
          runId: opts.runId || null,
          title: String(parsed.data.title || filenameTitle(file)).trim() || filenameTitle(file),
          body,
          priority: normalizePriority(parsed.data.priority),
          tags: normalizeTags(parsed.data.tags),
          rawFrontmatter: parsed.data,
        });
      } catch (e: any) {
        inserted = insertNotification({
          sourceScope: scope.name,
          sourcePath: relPath,
          contentHash: hash,
          runId: opts.runId || null,
          title: `Invalid outbox notification: ${file}`,
          body: raw.trim() || "(empty file)",
          priority: "warning",
          tags: ["outbox", "invalid"],
          status: "failed",
          lastError: `invalid outbox notification: ${String(e?.message || e)}`,
        });
      } finally {
        await rm(abs, { force: true }).catch(() => {});
        result.deletedPaths.push(abs);
      }

      if (!inserted) continue;
      result.inserted += 1;
      const delivered = await deliverOwnerNotification(inserted.id);
      if (delivered?.status === "delivered") result.delivered += 1;
      else if (delivered?.status === "no_channel") result.noChannel += 1;
      else if (delivered?.status === "failed") result.failed += 1;
    }
  }
  return result;
}

export function getNotification(id: number): OwnerNotification | null {
  return db.prepare("SELECT * FROM owner_notifications WHERE id = ? AND company_id = ?")
    .get(id, getCurrentCompanyId()) as OwnerNotification | undefined || null;
}

export function listOwnerNotifications(opts: NotificationListOptions = {}): { notifications: OwnerNotification[]; total: number } {
  const where: string[] = [];
  const args: any[] = [];
  const query = String(opts.query || "").trim();
  if (query) {
    where.push("(title LIKE ? OR body LIKE ? OR tags LIKE ? OR source_path LIKE ?)");
    const like = `%${query}%`;
    args.push(like, like, like, like);
  }
  if (opts.scope) {
    where.push("source_scope = ?");
    args.push(String(opts.scope));
  }
  if (opts.priority && PRIORITIES.has(opts.priority as OwnerNotificationPriority)) {
    where.push("priority = ?");
    args.push(opts.priority);
  }
  if (opts.status && ["pending", "delivered", "failed", "no_channel"].includes(opts.status)) {
    where.push("status = ?");
    args.push(opts.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  where.unshift("company_id = ?");
  args.unshift(getCurrentCompanyId());
  const scopedWhereSql = `WHERE ${where.join(" AND ")}`;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM owner_notifications ${scopedWhereSql}`).get(...args) as { count: number };
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const notifications = db.prepare(`
    SELECT * FROM owner_notifications
    ${scopedWhereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset) as OwnerNotification[];
  return { notifications, total: total.count };
}

export function markOwnerNotificationRead(id: number, read: boolean): OwnerNotification | null {
  db.prepare("UPDATE owner_notifications SET read_at = ? WHERE id = ? AND company_id = ?").run(read ? Date.now() : null, id, getCurrentCompanyId());
  return getNotification(id);
}

export async function deliverOwnerNotification(id: number): Promise<OwnerNotification | null> {
  const notification = getNotification(id);
  if (!notification) return null;
  if (notification.status === "delivered") return notification;
  if (notification.status === "failed" && notification.last_error?.startsWith("invalid outbox notification")) {
    return notification;
  }

  const notificationConfig = getNotificationConfig();
  if (notificationConfig.channel === "none") {
    db.prepare(`
      UPDATE owner_notifications
      SET status = 'no_channel', delivery_channel = 'none', last_error = NULL
      WHERE id = ? AND company_id = ?
    `).run(id, getCurrentCompanyId());
    return getNotification(id);
  }

  const message = formatDeliveryMessage(notification);
  const sent = await sendNotification(message, notification.title);
  const attempts = notification.delivery_attempts + 1;
  if (sent.ok) {
    db.prepare(`
      UPDATE owner_notifications
      SET status = 'delivered', delivery_channel = ?, delivery_attempts = ?, last_error = NULL, delivered_at = ?
      WHERE id = ? AND company_id = ?
    `).run(notificationConfig.channel, attempts, Date.now(), id, getCurrentCompanyId());
  } else {
    db.prepare(`
      UPDATE owner_notifications
      SET status = 'failed', delivery_channel = ?, delivery_attempts = ?, last_error = ?
      WHERE id = ? AND company_id = ?
    `).run(notificationConfig.channel, attempts, sent.error || "delivery failed", id, getCurrentCompanyId());
  }
  return getNotification(id);
}

export async function retryPendingOwnerNotifications(limit = 20): Promise<number> {
  const rows = db.prepare(`
    SELECT id FROM owner_notifications
    WHERE company_id = ? AND status IN ('pending', 'failed', 'no_channel')
    ORDER BY created_at ASC
    LIMIT ?
  `).all(getCurrentCompanyId(), limit) as Array<{ id: number }>;
  let attempted = 0;
  for (const row of rows) {
    const before = getNotification(row.id);
    if (!before || before.status === "failed" && before.last_error?.startsWith("invalid outbox notification")) continue;
    await deliverOwnerNotification(row.id);
    attempted += 1;
  }
  return attempted;
}

function formatDeliveryMessage(notification: OwnerNotification): string {
  const scope = notification.source_scope === "_root" ? "Root" : notification.source_scope;
  const priority = notification.priority.toUpperCase();
  return [
    `${notification.title}`,
    "",
    `Scope: ${scope}`,
    `Priority: ${priority}`,
    "",
    notification.body,
  ].join("\n").trim();
}
