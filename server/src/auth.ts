import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import * as cookie from "cookie";
import { db } from "./db";
import { AiosRequest, AiosResponse, forbidden, unauthorized, Handler } from "./http";

const SESSION_COOKIE = "aios_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7d

export interface User { id: number; email: string; isAdmin: boolean; }

export function hashPassword(p: string) { return bcrypt.hashSync(p, 10); }
export function verifyPassword(p: string, h: string) { return bcrypt.compareSync(p, h); }

export function hasAnyUser(): boolean {
  const row = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  return row.c > 0;
}

export function createUser(email: string, password: string, isAdmin = true): User {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO users(email, password_hash, is_admin, created_at) VALUES(?, ?, ?, ?)`,
  );
  const r = stmt.run(email.toLowerCase(), hashPassword(password), isAdmin ? 1 : 0, now);
  return { id: Number(r.lastInsertRowid), email, isAdmin };
}

export function findUserByEmail(email: string): { id: number; email: string; password_hash: string; is_admin: number } | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as any;
}

export function getUser(id: number): User | null {
  const row = db.prepare("SELECT id, email, is_admin FROM users WHERE id = ?").get(id) as any;
  return row ? { id: row.id, email: row.email, isAdmin: !!row.is_admin } : null;
}

export function createSession(userId: number): { id: string; csrf: string; expiresAt: number } {
  const id = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare("INSERT INTO sessions(id, user_id, csrf, created_at, expires_at) VALUES(?, ?, ?, ?, ?)")
    .run(id, userId, csrf, now, expiresAt);
  return { id, csrf, expiresAt };
}

export function destroySession(id: string) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function getSession(id: string) {
  const row = db.prepare("SELECT id, user_id, csrf, expires_at FROM sessions WHERE id = ?")
    .get(id) as any;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(id);
    return null;
  }
  return { id: row.id as string, userId: row.user_id as number, csrf: row.csrf as string };
}

export function setSessionCookie(res: AiosResponse, id: string, expiresAt: number, secure: boolean) {
  const c = cookie.serialize(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    expires: new Date(expiresAt),
  });
  res.setHeader("Set-Cookie", c);
}

export function clearSessionCookie(res: AiosResponse, secure: boolean) {
  res.setHeader("Set-Cookie", cookie.serialize(SESSION_COOKIE, "", {
    httpOnly: true, sameSite: "lax", path: "/", secure, expires: new Date(0),
  }));
}

export function parseSessionCookie(req: AiosRequest): string | null {
  const hdr = req.headers.cookie;
  if (!hdr) return null;
  const parsed = cookie.parse(hdr);
  return parsed[SESSION_COOKIE] || null;
}

/**
 * Middleware: attach session + actor if cookie is valid.
 */
export const sessionMiddleware: Handler = async (req, res) => {
  const sid = parseSessionCookie(req);
  req.session = null;
  req.actor = null;
  if (!sid) return;
  const sess = getSession(sid);
  if (!sess) return;
  const user = getUser(sess.userId);
  if (!user) return;
  req.session = sess;
  req.actor = { userId: user.id, email: user.email, isAdmin: user.isAdmin };
};

/**
 * Guard: require authenticated admin for an endpoint. Also enforces CSRF for
 * unsafe methods via an `x-csrf` header.
 */
export function adminOnly(): Handler {
  return async (req, res) => {
    if (!req.actor) throw unauthorized("login required");
    if (!req.actor.isAdmin) throw forbidden("admin required");
    const unsafe = req.method && !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (unsafe) {
      const sent = (req.headers["x-csrf"] || "") as string;
      if (!sent || sent !== req.session?.csrf) throw forbidden("csrf check failed");
    }
  };
}

export function requireAuth(): Handler {
  return async (req) => {
    if (!req.actor) throw unauthorized("login required");
  };
}
