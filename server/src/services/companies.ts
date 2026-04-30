import { join } from "path";
import { randomBytes } from "crypto";

import { config } from "../config";
import { db } from "../db";
import {
  CompanyContext,
  setFallbackCompany,
  withCompanyContext,
} from "../company-context";

export type CompanySetupPhase = "repo_setup" | "context_setup" | "notifications" | "complete";

export interface Company extends CompanyContext {
  repoFullName: string | null;
  setupPhase: CompanySetupPhase;
  isDefault: boolean;
  webhookSecret: string;
  createdAt: number;
  updatedAt: number;
}

export function normalizeCompanySlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
}

function rowToCompany(row: any): Company {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    repoFullName: row.repo_full_name ? String(row.repo_full_name) : null,
    repoDir: String(row.repo_dir),
    setupPhase: (row.setup_phase || "complete") as CompanySetupPhase,
    isDefault: !!row.is_default,
    webhookSecret: row.webhook_secret || ensureCompanyWebhookSecret(Number(row.id)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function initCompanyContextFallback(): Company {
  const company = getDefaultCompany();
  setFallbackCompany(company);
  return company;
}

export function getDefaultCompany(): Company {
  const row = db.prepare("SELECT * FROM companies WHERE is_default = 1 ORDER BY id LIMIT 1").get()
    || db.prepare("SELECT * FROM companies ORDER BY id LIMIT 1").get();
  if (!row) throw new Error("default company is missing");
  return rowToCompany(row);
}

export function getCompanyBySlug(slug: string): Company | null {
  const normalized = normalizeCompanySlug(slug);
  if (!normalized) return null;
  const row = db.prepare("SELECT * FROM companies WHERE slug = ?").get(normalized);
  return row ? rowToCompany(row) : null;
}

export function getCompanyById(id: number): Company | null {
  const row = db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
  return row ? rowToCompany(row) : null;
}

export function listCompanies(): Company[] {
  return db.prepare("SELECT * FROM companies ORDER BY is_default DESC, display_name COLLATE NOCASE")
    .all()
    .map(rowToCompany);
}

export function listConnectedRepoFullNames(): string[] {
  return db.prepare("SELECT repo_full_name FROM companies WHERE repo_full_name IS NOT NULL")
    .all()
    .map((row: any) => String(row.repo_full_name).toLowerCase());
}

export function createCompany(input: {
  displayName: string;
  slug?: string;
  repoFullName: string;
}): Company {
  const displayName = String(input.displayName || "").trim();
  if (!displayName) throw new Error("company name required");
  const baseSlug = normalizeCompanySlug(input.slug || displayName);
  if (!baseSlug) throw new Error("company slug required");
  const repoFullName = String(input.repoFullName || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) throw new Error("invalid repo full name");

  const existingRepo = db.prepare("SELECT slug FROM companies WHERE lower(repo_full_name) = lower(?)").get(repoFullName) as any;
  if (existingRepo) throw new Error(`repo already connected to ${existingRepo.slug}`);

  const slug = uniqueSlug(baseSlug);
  const repoDir = join(config.dataDir, "repos", slug);
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO companies(slug, display_name, repo_full_name, repo_dir, setup_phase, is_default, webhook_secret, created_at, updated_at)
    VALUES(?, ?, ?, ?, 'context_setup', 0, ?, ?, ?)
  `).run(slug, displayName, repoFullName, repoDir, randomBytes(32).toString("hex"), now, now);
  return getCompanyById(Number(result.lastInsertRowid))!;
}

export function updateDefaultCompanyRepo(fullName: string | null) {
  const company = getDefaultCompany();
  db.prepare("UPDATE companies SET repo_full_name = ?, updated_at = ? WHERE id = ?")
    .run(fullName, Date.now(), company.id);
}

export function setCompanySetupPhase(companyId: number, phase: CompanySetupPhase) {
  db.prepare("UPDATE companies SET setup_phase = ?, updated_at = ? WHERE id = ?")
    .run(phase, Date.now(), companyId);
}

export function ensureCompanyWebhookSecret(companyId: number): string {
  const row = db.prepare("SELECT webhook_secret FROM companies WHERE id = ?").get(companyId) as { webhook_secret?: string } | undefined;
  if (row?.webhook_secret) return row.webhook_secret;
  const secret = randomBytes(32).toString("hex");
  db.prepare("UPDATE companies SET webhook_secret = ?, updated_at = ? WHERE id = ?")
    .run(secret, Date.now(), companyId);
  return secret;
}

export function runForCompany<T>(company: CompanyContext, fn: () => T): T {
  return withCompanyContext(company, fn);
}

function uniqueSlug(base: string): string {
  let slug = base;
  let i = 2;
  while (db.prepare("SELECT 1 FROM companies WHERE slug = ?").get(slug)) {
    slug = `${base}-${i}`;
    i += 1;
  }
  return slug;
}
