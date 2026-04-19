// Claims: lightweight per-department lock. Serializes within a department;
// parallelizes across departments. Multi-dept triggers claim everything or wait.

import { db } from "../db";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours, per PRD

export interface Claim {
  department: string;
  run_id: string;
  claimed_at: number;
  expires_at: number;
}

export function getClaim(department: string): Claim | null {
  return (db.prepare("SELECT * FROM claims WHERE department = ?").get(department) as Claim | undefined) || null;
}

export function listClaims(): Claim[] {
  return db.prepare("SELECT * FROM claims ORDER BY claimed_at DESC").all() as Claim[];
}

/**
 * Attempt to claim departments atomically. Returns true on success.
 * Expired claims are released before the attempt so a dead run doesn't block forever.
 */
export function claimDepartments(departments: string[], runId: string, ttlMs = DEFAULT_TTL_MS): boolean {
  if (departments.length === 0) return false;
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM claims WHERE expires_at < ?").run(now);
    for (const d of departments) {
      const held = db.prepare("SELECT 1 FROM claims WHERE department = ?").get(d);
      if (held) throw new Error("department busy");
    }
    const insert = db.prepare("INSERT INTO claims(department, run_id, claimed_at, expires_at) VALUES(?, ?, ?, ?)");
    for (const d of departments) insert.run(d, runId, now, now + ttlMs);
  });
  try { tx(); return true; } catch { return false; }
}

export function releaseClaim(department: string, runId: string) {
  db.prepare("DELETE FROM claims WHERE department = ? AND run_id = ?").run(department, runId);
}

export function releaseClaimsForRun(runId: string) {
  db.prepare("DELETE FROM claims WHERE run_id = ?").run(runId);
}

export function expireStaleClaims(): number {
  const r = db.prepare("DELETE FROM claims WHERE expires_at < ?").run(Date.now());
  return Number(r.changes);
}
