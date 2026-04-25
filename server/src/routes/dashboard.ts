// Dashboard API: departments, runs, backlog, webhooks, usage, manual prompt,
// kill switches, pause/resume, live stream (SSE), sync trigger.

import { readFile, writeFile, mkdir, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { timingSafeEqual } from "crypto";
import matter from "gray-matter";

import { Router, badRequest, conflict, notFound, AiosRequest } from "../http";
import { adminOnly } from "../auth";
import { config } from "../config";
import {
  createDepartment,
  DepartmentCreateError,
  getRootDepartment,
  listDepartments,
  listCronTasks,
  listGoals,
  ROOT_DEPARTMENT_NAME,
  updateRootDepartmentName,
} from "../services/departments";
import { listRuns, getRun, activeRuns, listBacklog, runEvents, Run } from "../services/runs";
import { listClaims } from "../services/claims";
import { startRun, killRun, killAllRuns, setGlobalPause, isGlobalPaused, activeProcessCount } from "../services/executor";
import { runSyncLayer } from "../services/sync";
import { db } from "../db";
import { heartbeatStatus, runHeartbeatTick } from "../services/heartbeat";
import { displayProvider, getProviderAvailability, isProviderAuthorized, parseProvider } from "../services/providerAvailability";
import {
  deliverOwnerNotification,
  listOwnerNotifications,
  markOwnerNotificationRead,
} from "../services/ownerNotifications";

export function registerDashboardRoutes(router: Router) {
  const guard = adminOnly();

  // ---------- Departments ----------
  router.get("/api/departments", async (req, res) => {
    await guard(req, res);
    const [root, depts] = await Promise.all([getRootDepartment(), listDepartments()]);
    const claims = new Map(listClaims().map((c) => [c.department, c]));
    res.json({
      root: {
        name: root.name,
        displayName: root.displayName,
        path: root.path,
        claim: claims.get(root.name) || null,
      },
      departments: depts.map((d) => ({
        name: d.name,
        path: d.path,
        claim: claims.get(d.name) || null,
      })),
    });
  });

  router.post("/api/departments", async (req, res) => {
    await guard(req, res);
    try {
      const department = await createDepartment({ name: String(req.body?.name || "") });
      const sync = await runSyncLayer({ commit: false });
      res.json({
        ok: true,
        department: {
          name: department.name,
          path: department.path,
          claim: null,
        },
        sync,
      }, 201);
    } catch (e: any) {
      if (e instanceof DepartmentCreateError) {
        throw e.code === "conflict" ? conflict(e.message) : badRequest(e.message);
      }
      throw e;
    }
  });

  router.put("/api/root", async (req, res) => {
    await guard(req, res);
    try {
      const root = await updateRootDepartmentName(String(req.body?.displayName || req.body?.name || ""));
      const sync = await runSyncLayer({ commit: false });
      res.json({
        ok: true,
        root: {
          name: root.name,
          displayName: root.displayName,
          path: root.path,
          claim: listClaims().find((c) => c.department === root.name) || null,
        },
        sync,
      });
    } catch (e: any) {
      if (e instanceof DepartmentCreateError) {
        throw e.code === "conflict" ? conflict(e.message) : badRequest(e.message);
      }
      throw e;
    }
  });

  router.get("/api/departments/:name", async (req, res) => {
    await guard(req, res);
    const name = req.params.name;
    const d = name === ROOT_DEPARTMENT_NAME
      ? await getRootDepartment()
      : (await listDepartments()).find((x) => x.name === name);
    if (!d) throw notFound("department not found");
    const [tasks, goals] = await Promise.all([
      listCronTasks().then((all) => all.filter((t) => t.department === name)),
      listGoals().then((all) => all.filter((g) => g.department === name)),
    ]);
    res.json({
      name: d.name,
      displayName: d.displayName,
      isRoot: !!d.isRoot,
      path: d.path,
      claim: listClaims().find((c) => c.department === name) || null,
      cron: tasks,
      goals,
      runs: listRuns({ department: name, limit: 25 }),
      backlog: listBacklog().filter((b) => b.department === name),
    });
  });

  // ---------- Runs ----------
  router.get("/api/runs", async (req, res) => {
    await guard(req, res);
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const dept = req.query.department;
    res.json({ runs: listRuns({ department: dept, limit, offset }) });
  });

  router.get("/api/runs/active", async (req, res) => {
    await guard(req, res);
    res.json({ runs: activeRuns(), claims: listClaims() });
  });

  router.get("/api/runs/:id", async (req, res) => {
    await guard(req, res);
    const run = getRun(req.params.id);
    if (!run) throw notFound("run not found");
    res.json({ run });
  });

  router.get("/api/runs/:id/log", async (req, res) => {
    await guard(req, res);
    const run = getRun(req.params.id);
    if (!run || !run.log_path) throw notFound("no log");
    try {
      const text = await readFile(run.log_path, "utf-8");
      res.text(text);
    } catch { throw notFound("log not found"); }
  });

  router.post("/api/runs/:id/kill", async (req, res) => {
    await guard(req, res);
    const ok = killRun(req.params.id);
    res.json({ ok });
  });

  // Live streaming via SSE
  router.get("/api/runs/:id/stream", async (req, res) => {
    await guard(req, res);
    const runId = req.params.id;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const write = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onOutput = (p: { runId: string; chunk: string }) => {
      if (p.runId === runId) write("output", { chunk: p.chunk });
    };
    const onFinished = (p: { runId: string }) => {
      if (p.runId === runId) { write("finished", {}); cleanup(); res.end(); }
    };
    const onUpdate = (p: { id: string; patch: Partial<Run> }) => {
      if (p.id === runId) write("update", p.patch);
    };
    runEvents.on("run.output", onOutput);
    runEvents.on("run.finished", onFinished);
    runEvents.on("run.updated", onUpdate);
    const cleanup = () => {
      runEvents.off("run.output", onOutput);
      runEvents.off("run.finished", onFinished);
      runEvents.off("run.updated", onUpdate);
    };
    req.on("close", cleanup);
  });

  // Master stream of run-created events
  router.get("/api/events", async (req, res) => {
    await guard(req, res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const write = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const handlers: Array<[string, (p: any) => void]> = [
      ["run.created",  (p) => write("run.created", p)],
      ["run.updated",  (p) => write("run.updated", p)],
      ["run.finished", (p) => write("run.finished", p)],
    ];
    for (const [ev, fn] of handlers) runEvents.on(ev, fn);
    req.on("close", () => { for (const [ev, fn] of handlers) runEvents.off(ev, fn); });
  });

  // ---------- Manual prompt ----------
  router.post("/api/manual-run", async (req, res) => {
    await guard(req, res);
    const dept = String(req.body?.department || "").trim();
    const prompt = String(req.body?.prompt || "").trim();
    const providerRaw = req.body?.provider;
    const provider = parseProvider(providerRaw);
    if (providerRaw && !provider) throw badRequest("provider must be claude-code or codex");
    if (provider && !(await isProviderAuthorized(provider))) {
      throw badRequest(`${displayProvider(provider)} is not authorized`);
    }
    if (!dept || !prompt) throw badRequest("department and prompt required");
    const r = await startRun({
      departments: [dept],
      trigger: "manual",
      prompt,
      provider,
    });
    res.json(r);
  });

  // ---------- Backlog ----------
  router.get("/api/backlog", async (req, res) => {
    await guard(req, res);
    res.json({ backlog: listBacklog() });
  });

  // ---------- Cron task controls ----------
  router.post("/api/cron/:path/pause", async (req, res) => {
    await guard(req, res);
    const tasks = await listCronTasks();
    const t = tasks.find((x) => x.relPath === decodeURIComponent(req.params.path));
    if (!t) throw notFound("task not found");
    const raw = await readFile(t.path, "utf-8");
    const updated = raw.replace(/^(paused:\s*).*$/m, `$1true`);
    const next = updated === raw ? raw.replace(/^---\n/, `---\npaused: true\n`) : updated;
    await writeFile(t.path, next);
    res.json({ ok: true });
  });

  router.post("/api/cron/:path/resume", async (req, res) => {
    await guard(req, res);
    const tasks = await listCronTasks();
    const t = tasks.find((x) => x.relPath === decodeURIComponent(req.params.path));
    if (!t) throw notFound("task not found");
    const raw = await readFile(t.path, "utf-8");
    const updated = raw.replace(/^paused:\s*true\s*$/m, "paused: false");
    await writeFile(t.path, updated);
    res.json({ ok: true });
  });

  // ---------- Webhooks ----------
  router.get("/api/webhooks/handlers", async (req, res) => {
    await guard(req, res);
    res.json({ handlers: await listWebhookHandlers() });
  });

  // Admin view of deliveries.
  router.get("/api/webhooks/deliveries", async (req, res) => {
    await guard(req, res);
    const rows = db.prepare("SELECT * FROM webhook_deliveries ORDER BY received_at DESC LIMIT 200").all();
    res.json({ deliveries: rows });
  });

  // Public intake: /webhooks/:department/:name (no auth — validated by a per-dept secret).
  router.post("/webhooks/:department/:name", async (req, res) => {
    const dept = req.params.department;
    const name = req.params.name;
    const endpoint = `${dept}/${name}`;
    const payload = req.body || {};
    const source = describeWebhookSource(req);
    const depts = await listDepartments();
    if (!depts.some((d) => d.name === dept)) {
      recordDelivery({ department: dept, endpoint, source, payload, outcome: "rejected:unknown-dept" });
      res.error(404, "unknown department");
      return;
    }
    // Find a matching prompt file: <dept>/webhooks/<name>.md
    const promptPath = join(config.repoDir, dept, "webhooks", `${name}.md`);
    if (!existsSync(promptPath)) {
      recordDelivery({ department: dept, endpoint, source, payload, outcome: "rejected:no-handler" });
      res.error(404, "no handler");
      return;
    }
    const parsed = matter(await readFile(promptPath, "utf-8"));
    const requiredKey = String(
      parsed.data.webhookKey
      || parsed.data.webhookSecret
      || parsed.data.key
      || parsed.data.secret
      || "",
    ).trim();
    const suppliedKey = String(
      req.headers["x-webhook-key"]
      || req.headers["x-webhook-secret"]
      || req.query.key
      || req.query.secret
      || "",
    ).trim();
    if (requiredKey && !matchesSecret(requiredKey, suppliedKey)) {
      recordDelivery({ department: dept, endpoint, source, payload, outcome: "rejected:bad-key" });
      res.error(401, "invalid webhook key");
      return;
    }
    const prompt = `${parsed.content.trim()}\n\n---\nPayload:\n${JSON.stringify(payload, null, 2)}`;
    const r = await startRun({ departments: [dept], trigger: `webhook:${endpoint}`, prompt });
    recordDelivery({ department: dept, endpoint, source, payload, outcome: r.accepted ? `run:${r.run.id}` : "queued" });
    res.json({ ok: true, runId: r.run.id, accepted: r.accepted });
  });

  // ---------- Owner notifications ----------
  router.get("/api/notifications", async (req, res) => {
    await guard(req, res);
    res.json(listOwnerNotifications({
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
      query: req.query.query || "",
      scope: req.query.scope || "",
      priority: req.query.priority || "",
      status: req.query.status || "",
    }));
  });

  router.post("/api/notifications/:id/read", async (req, res) => {
    await guard(req, res);
    const notification = markOwnerNotificationRead(Number(req.params.id), true);
    if (!notification) throw notFound("notification not found");
    res.json({ ok: true, notification });
  });

  router.post("/api/notifications/:id/unread", async (req, res) => {
    await guard(req, res);
    const notification = markOwnerNotificationRead(Number(req.params.id), false);
    if (!notification) throw notFound("notification not found");
    res.json({ ok: true, notification });
  });

  router.post("/api/notifications/:id/retry", async (req, res) => {
    await guard(req, res);
    const notification = await deliverOwnerNotification(Number(req.params.id));
    if (!notification) throw notFound("notification not found");
    res.json({ ok: true, notification });
  });

  // ---------- Controls ----------
  router.post("/api/controls/pause", async (req, res) => {
    await guard(req, res);
    setGlobalPause(true);
    res.json({ ok: true, paused: true });
  });
  router.post("/api/controls/resume", async (req, res) => {
    await guard(req, res);
    setGlobalPause(false);
    res.json({ ok: true, paused: false });
  });
  router.post("/api/controls/kill-all", async (req, res) => {
    await guard(req, res);
    setGlobalPause(true);
    const killed = killAllRuns();
    res.json({ ok: true, killed, paused: true });
  });
  router.get("/api/controls/status", async (req, res) => {
    await guard(req, res);
    const providers = await getProviderAvailability();
    res.json({
      paused: isGlobalPaused(),
      activeProcesses: activeProcessCount(),
      heartbeat: heartbeatStatus(),
      providers: {
        claudeCode: { authorized: providers["claude-code"] },
        codex: { authorized: providers.codex },
      },
    });
  });
  router.post("/api/controls/sync", async (req, res) => {
    await guard(req, res);
    const r = await runSyncLayer({ commit: true });
    res.json(r);
  });
  router.post("/api/controls/heartbeat", async (req, res) => {
    await guard(req, res);
    await runHeartbeatTick();
    res.json({ ok: true });
  });

  // ---------- Usage ----------
  router.get("/api/usage", async (req, res) => {
    await guard(req, res);
    const byDept = db.prepare(`
      SELECT department,
             COALESCE(SUM(tokens_in), 0)  as tokens_in,
             COALESCE(SUM(tokens_out), 0) as tokens_out,
             COALESCE(SUM(cost_usd), 0)   as cost_usd,
             COUNT(*) as runs
      FROM usage GROUP BY department
    `).all();
    const byDay = db.prepare(`
      SELECT DATE(recorded_at/1000, 'unixepoch') as day,
             COALESCE(SUM(tokens_in), 0)  as tokens_in,
             COALESCE(SUM(tokens_out), 0) as tokens_out,
             COALESCE(SUM(cost_usd), 0)   as cost_usd
      FROM usage
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `).all();
    res.json({ byDept, byDay });
  });

  // ---------- File editors ----------
  router.get("/api/files/*", async (req, res) => {
    await guard(req, res);
    const rel = decodeURIComponent(req.path.replace(/^\/api\/files\//, ""));
    const abs = join(config.repoDir, rel);
    if (!abs.startsWith(config.repoDir)) throw badRequest("path escape");
    if (!existsSync(abs)) throw notFound("file not found");
    const s = await stat(abs);
    if (s.isDirectory()) {
      const entries = await readdir(abs);
      res.json({ dir: rel, entries });
    } else {
      res.text(await readFile(abs, "utf-8"));
    }
  });

  router.put("/api/files/*", async (req, res) => {
    await guard(req, res);
    const rel = decodeURIComponent(req.path.replace(/^\/api\/files\//, ""));
    const abs = join(config.repoDir, rel);
    if (!abs.startsWith(config.repoDir)) throw badRequest("path escape");
    const content = typeof req.body === "string" ? req.body
      : req.rawBody ? req.rawBody.toString("utf-8")
      : JSON.stringify(req.body);
    await validateProviderFrontmatter(rel, content);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    await runSyncLayer({ commit: false }).catch(() => {});
    res.json({ ok: true });
  });
}

async function validateProviderFrontmatter(relPath: string, content: string) {
  if (!/(^|\/)(cron|goals)\/[^/]+\.md$/i.test(relPath.replace(/\\/g, "/"))) return;
  let provider: string | undefined;
  try {
    provider = matter(content).data?.provider;
  } catch {
    return;
  }
  if (!provider) return;
  const parsed = parseProvider(provider);
  if (!parsed) throw badRequest("provider must be claude-code or codex");
  if (!(await isProviderAuthorized(parsed))) {
    throw badRequest(`${displayProvider(parsed)} is not authorized`);
  }
}

function recordDelivery(d: { department: string; endpoint: string; source?: string | null; payload: unknown; outcome: string }) {
  db.prepare(`INSERT INTO webhook_deliveries(department, endpoint, source, payload, outcome, received_at)
              VALUES(?, ?, ?, ?, ?, ?)`)
    .run(d.department, d.endpoint, d.source || null, JSON.stringify(d.payload).slice(0, 8000), d.outcome, Date.now());
}

function matchesSecret(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(actual, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function describeWebhookSource(req: AiosRequest): string | null {
  const forwarded = String(req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || "").split(",")[0]?.trim();
  const remote = req.socket?.remoteAddress?.trim() || "";
  const userAgent = String(req.headers["user-agent"] || "").trim();
  const address = forwarded || remote;
  if (!address && !userAgent) return null;
  if (!address) return userAgent.slice(0, 180);
  if (!userAgent) return address;
  return `${address} | ${userAgent.slice(0, 180)}`;
}

function firstPromptLine(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => !!entry);
  return line || "(empty handler)";
}

async function listWebhookHandlers() {
  const depts = await listDepartments();
  const recent = db.prepare("SELECT endpoint, outcome, received_at FROM webhook_deliveries ORDER BY received_at DESC LIMIT 1000").all() as Array<{
    endpoint: string;
    outcome: string;
    received_at: number;
  }>;
  const recentByEndpoint = new Map<string, { lastOutcome: string; lastReceivedAt: number; deliveries: number }>();
  for (const row of recent) {
    const existing = recentByEndpoint.get(row.endpoint);
    if (existing) {
      existing.deliveries += 1;
      continue;
    }
    recentByEndpoint.set(row.endpoint, {
      lastOutcome: row.outcome,
      lastReceivedAt: row.received_at,
      deliveries: 1,
    });
  }

  const handlers: Array<{
    department: string;
    name: string;
    endpoint: string;
    relPath: string;
    hasSecret: boolean;
    promptPreview: string;
    deliveries: number;
    lastOutcome: string | null;
    lastReceivedAt: number | null;
  }> = [];

  for (const dept of depts) {
    const webhooksDir = join(dept.path, "webhooks");
    if (!existsSync(webhooksDir)) continue;
    const files = await readdir(webhooksDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const raw = await readFile(join(webhooksDir, file), "utf-8").catch(() => "");
      if (!raw) continue;
      const parsed = matter(raw);
      const name = file.replace(/\.md$/, "");
      const endpoint = `${dept.name}/${name}`;
      const requiredKey = String(
        parsed.data.webhookKey
        || parsed.data.webhookSecret
        || parsed.data.key
        || parsed.data.secret
        || "",
      ).trim();
      const stats = recentByEndpoint.get(endpoint);
      handlers.push({
        department: dept.name,
        name,
        endpoint,
        relPath: `${dept.name}/webhooks/${file}`,
        hasSecret: !!requiredKey,
        promptPreview: firstPromptLine(parsed.content.trim()),
        deliveries: stats?.deliveries || 0,
        lastOutcome: stats?.lastOutcome || null,
        lastReceivedAt: stats?.lastReceivedAt || null,
      });
    }
  }

  handlers.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  return handlers;
}
