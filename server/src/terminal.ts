// Embedded terminal: WebSocket attaches to a bash shell running as the app user.
// Admin-only via session cookie.

import { Server as HttpServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as cookie from "cookie";
import { getSession, getUser } from "./auth";
import { buildCommonAuthEnv } from "./services/provider-auth";
import { config } from "./config";
import { log } from "./log";
import { getCompanyBySlug, getDefaultCompany } from "./services/companies";
import { withCompanyContext } from "./company-context";

type PtyModule = typeof import("node-pty") | null;
let ptyMod: PtyModule = null;
try { ptyMod = require("node-pty"); } catch (e) {
  log.warn("node-pty not available; embedded terminal disabled");
}

export function attachTerminal(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== "/api/terminal") return;
      const auth = authenticate(req);
      if (!auth) { socket.destroy(); return; }
      if (!ptyMod) { socket.destroy(); return; }
      const company = url.searchParams.get("company")
        ? getCompanyBySlug(url.searchParams.get("company") || "")
        : getDefaultCompany();
      if (!company) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        withCompanyContext(company, () => spawnShell(ws, auth));
      });
    } catch {
      socket.destroy();
    }
  });
}

function authenticate(req: IncomingMessage): { userId: number } | null {
  const c = req.headers.cookie;
  if (!c) return null;
  const parsed = cookie.parse(c);
  const sid = parsed["aios_session"];
  if (!sid) return null;
  const sess = getSession(sid);
  if (!sess) return null;
  const user = getUser(sess.userId);
  if (!user?.isAdmin) return null;
  return { userId: user.id };
}

function spawnShell(ws: WebSocket, _auth: { userId: number }) {
  if (!ptyMod) { ws.close(); return; }
  const term = ptyMod.spawn("bash", ["-l"], {
    name: "xterm-color",
    cols: 120,
    rows: 30,
    cwd: config.repoDir,
    env: buildCommonAuthEnv() as any,
  });
  term.onData((data: string) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "data", d: data })));
  ws.on("message", (msg) => {
    try {
      const payload = JSON.parse(msg.toString());
      if (payload.t === "data") term.write(payload.d);
      else if (payload.t === "resize") term.resize(payload.cols || 80, payload.rows || 24);
    } catch {}
  });
  ws.on("close", () => { try { term.kill(); } catch {} });
  term.onExit(() => { try { ws.close(); } catch {} });
}
