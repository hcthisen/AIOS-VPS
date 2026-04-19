import { Router, badRequest, conflict, unauthorized } from "../http";
import {
  clearSessionCookie, createSession, createUser, findUserByEmail,
  hasAnyUser, setSessionCookie, verifyPassword, destroySession, getUser,
} from "../auth";
import { getSetupPhase, setSetupPhase } from "../setup-phase";
import { config } from "../config";

function isSecure() {
  return !!config.auth.publicBaseUrl?.startsWith("https://");
}

function validEmail(e: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function registerAuthRoutes(router: Router) {
  router.post("/api/auth/signup", async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    if (!validEmail(email) || password.length < 8) {
      throw badRequest("valid email and 8+ char password required");
    }
    // First-admin bootstrap: only unauthenticated when there are no users yet.
    if (hasAnyUser()) {
      if (!req.actor?.isAdmin) throw unauthorized("signup disabled after first admin");
    }
    if (findUserByEmail(email)) throw conflict("email already registered");
    const user = createUser(email, password, true);
    const sess = createSession(user.id);
    setSessionCookie(res, sess.id, sess.expiresAt, isSecure());
    if (getSetupPhase() === "admin_setup") setSetupPhase("domain_setup");
    res.json({
      user: { id: user.id, email: user.email, isAdmin: user.isAdmin },
      csrf: sess.csrf,
      setupPhase: getSetupPhase(),
    });
  });

  router.post("/api/auth/login", async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const row = findUserByEmail(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw unauthorized("invalid credentials");
    }
    const sess = createSession(row.id);
    setSessionCookie(res, sess.id, sess.expiresAt, isSecure());
    res.json({
      user: { id: row.id, email: row.email, isAdmin: !!row.is_admin },
      csrf: sess.csrf,
      setupPhase: getSetupPhase(),
    });
  });

  router.post("/api/auth/logout", async (req, res) => {
    if (req.session) destroySession(req.session.id);
    clearSessionCookie(res, isSecure());
    res.json({ ok: true });
  });

  router.get("/api/auth/me", async (req, res) => {
    if (!req.actor) { res.json({ user: null, setupPhase: getSetupPhase() }); return; }
    const user = getUser(req.actor.userId);
    res.json({
      user,
      csrf: req.session?.csrf,
      setupPhase: getSetupPhase(),
      firstRun: !hasAnyUser(),
    });
  });
}
