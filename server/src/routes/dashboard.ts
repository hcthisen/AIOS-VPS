// Dashboard API: departments, runs, backlog, webhooks, usage, manual prompt,
// kill switches, pause/resume, live stream (SSE), sync trigger.

import { readFile, writeFile, mkdir, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

import { Router, badRequest, notFound } from "../http";
import { adminOnly, requireAuth } from "../auth";
import { config } from "../config";
import { listDepartments, listCronTasks, listGoals } from "../services/departments";
import { listRuns, getRun, activeRuns, listBacklog, runEvents, Run } from "../services/runs";
import { listClaims } from "../services/claims";
import { startRun, killRun, setGlobalPause, isGlobalPaused, activeProcessCount } from "../services/executor";
import { runSyncLayer } from "../services/sync";
import { db } from "../db";
import { heartbeatStatus, runHeartbeatTick } from "../services/heartbeat";

export function registerDashboardRoutes(router: Router) {
  const guard = adminOnly();

  // ---------- Departments ----------
  router.get("/api/departments", async (req, res) => {
    await guard(req, res);
    const depts = await listDepartments();
    const claims = new Map(listClaims().map((c) => [c.department, c]));
    res.json({
      departments: depts.map((d) => ({
        name: d.name,
        path: d.path,
        claim: claims.get(d.name) || null,
      })),
    });
  });

  router.get("/api/departments/:name", async (req, res) => {
    await guard(req, res);
    const name = req.params.name;
    const depts = await listDepartments();
    const d = depts.find((x) => x.name === name);
    if (!d) throw notFound("department not found");
    const [tasks, goals] = await Promise.all([
      listCronTasks().then((all) => all.filter((t) => t.department === name)),
      listGoals().then((all) => all.filter((g) => g.department === name)),
    ]);
    res.json({
      name: d.name,
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
    const provider = req.body?.provider;
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
    const depts = await listDepartments();
    if (!depts.some((d) => d.name === dept)) {
      recordDelivery({ department: dept, endpoint, payload, outcome: "rejected:unknown-dept" });
      res.error(404, "unknown department");
      return;
    }
    // Find a matching prompt file: <dept>/webhooks/<name>.md
    const promptPath = join(config.repoDir, dept, "webhooks", `${name}.md`);
    if (!existsSync(promptPath)) {
      recordDelivery({ department: dept, endpoint, payload, outcome: "rejected:no-handler" });
      res.error(404, "no handler");
      return;
    }
    const prompt = `${await readFile(promptPath, "utf-8")}\n\n---\nPayload:\n${JSON.stringify(payload, null, 2)}`;
    const r = await startRun({ departments: [dept], trigger: `webhook:${endpoint}`, prompt });
    recordDelivery({ department: dept, endpoint, payload, outcome: r.accepted ? `run:${r.run.id}` : "queued" });
    res.json({ ok: true, runId: r.run.id, accepted: r.accepted });
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
  router.get("/api/controls/status", async (req, res) => {
    await guard(req, res);
    res.json({
      paused: isGlobalPaused(),
      activeProcesses: activeProcessCount(),
      heartbeat: heartbeatStatus(),
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
    const rel = req.path.replace(/^\/api\/files\//, "");
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
    const rel = req.path.replace(/^\/api\/files\//, "");
    const abs = join(config.repoDir, rel);
    if (!abs.startsWith(config.repoDir)) throw badRequest("path escape");
    const content = typeof req.body === "string" ? req.body
      : req.rawBody ? req.rawBody.toString("utf-8")
      : JSON.stringify(req.body);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
    res.json({ ok: true });
  });
}

function recordDelivery(d: { department: string; endpoint: string; payload: unknown; outcome: string }) {
  db.prepare(`INSERT INTO webhook_deliveries(department, endpoint, source, payload, outcome, received_at)
              VALUES(?, ?, ?, ?, ?, ?)`)
    .run(d.department, d.endpoint, null, JSON.stringify(d.payload).slice(0, 8000), d.outcome, Date.now());
}
