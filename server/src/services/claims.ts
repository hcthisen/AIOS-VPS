// Claims: lightweight per-department lock. Serializes within a department;
// parallelizes across departments. Multi-dept triggers claim everything or wait.

import { db } from "../db";
import { getCurrentCompanyId } from "../company-context";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours, per PRD

export interface Claim {
  company_id?: number;
  department: string;
  run_id: string;
  claimed_at: number;
  expires_at: number;
}

export function getClaim(department: string): Claim | null {
  return (db.prepare("SELECT * FROM claims WHERE company_id = ? AND department = ?").get(getCurrentCompanyId(), department) as Claim | undefined) || null;
}

export function listClaims(): Claim[] {
  return db.prepare("SELECT * FROM claims WHERE company_id = ? ORDER BY claimed_at DESC").all(getCurrentCompanyId()) as Claim[];
}

/**
 * Attempt to claim departments atomically. Returns true on success.
 * Expired claims are released before the attempt so a dead run doesn't block forever.
 */
export function claimDepartments(departments: string[], runId: string, ttlMs = DEFAULT_TTL_MS): boolean {
  if (departments.length === 0) return false;
  const now = Date.now();
  const companyId = getCurrentCompanyId();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM claims WHERE company_id = ? AND expires_at < ?").run(companyId, now);
    for (const d of departments) {
      const held = db.prepare("SELECT 1 FROM claims WHERE company_id = ? AND department = ?").get(companyId, d);
      if (held) throw new Error("department busy");
    }
    const insert = db.prepare("INSERT INTO claims(company_id, department, run_id, claimed_at, expires_at) VALUES(?, ?, ?, ?, ?)");
    for (const d of departments) insert.run(companyId, d, runId, now, now + ttlMs);
  });
  try { tx(); return true; } catch { return false; }
}

export function releaseClaim(department: string, runId: string) {
  db.prepare("DELETE FROM claims WHERE company_id = ? AND department = ? AND run_id = ?").run(getCurrentCompanyId(), department, runId);
}

export function releaseClaimsForRun(runId: string) {
  db.prepare("DELETE FROM claims WHERE company_id = ? AND run_id = ?").run(getCurrentCompanyId(), runId);
}

export function expireStaleClaims(): number {
  const r = db.prepare("DELETE FROM claims WHERE company_id = ? AND expires_at < ?").run(getCurrentCompanyId(), Date.now());
  return Number(r.changes);
}
