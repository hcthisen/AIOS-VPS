// Heartbeat scanner: pull repo → run sync → scan cron/goals → enqueue triggers.

import cronParser from "cron-parser";
import { db } from "../db";
import { log } from "../log";
import { pullRepo } from "./repo";
import { listCronTasks, listGoals } from "./departments";
import { startRun, isGlobalPaused } from "./executor";
import { runSyncLayer } from "./sync";
import { getSetupPhase } from "../setup-phase";
import { isSystemUpdateBlocking } from "./systemUpdate";

const DEFAULT_INTERVAL_MS = 60_000;
let heartbeatTimer: NodeJS.Timeout | null = null;
let running = false;
let lastTickAt = 0;
let lastTickError: string | null = null;

export function startHeartbeat(intervalMs = DEFAULT_INTERVAL_MS) {
  if (heartbeatTimer) return;
  log.info(`heartbeat: starting at ${intervalMs}ms`);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runHeartbeatTick();
      lastTickError = null;
    } catch (e: any) {
      lastTickError = String(e?.message || e);
      log.error("heartbeat tick failed", lastTickError);
    } finally {
      lastTickAt = Date.now();
      running = false;
    }
  };
  heartbeatTimer = setInterval(tick, intervalMs);
  // Run one immediately but don't block startup.
  setTimeout(tick, 500);
}

export function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

export function heartbeatStatus() {
  return { running: !!heartbeatTimer, lastTickAt, lastTickError };
}

export async function runHeartbeatTick() {
  if (getSetupPhase() !== "complete") return; // nothing to do until onboarding is finished
  if (isGlobalPaused()) return;
  if (await isSystemUpdateBlocking()) return;

  const pull = await pullRepo();
  if (!pull.ok) {
    log.warn("heartbeat: pull failed:", pull.error);
    return;
  }
  await runSyncLayer().catch((e) => log.warn("sync after pull failed", e?.message || e));

  const now = Date.now();

  // Cron tasks
  const tasks = await listCronTasks();
  for (const t of tasks) {
    if (t.paused) continue;
    const state = db.prepare("SELECT * FROM cron_state WHERE path = ?").get(t.path) as { last_fired: number; paused: number } | undefined;
    const lastFired = state?.last_fired ?? 0;
    let next: number;
    try {
      const it = cronParser.parseExpression(t.schedule, { currentDate: new Date(lastFired || now - 60_000) });
      next = it.next().getTime();
    } catch (e: any) {
      log.warn(`invalid cron '${t.schedule}' in ${t.relPath}`);
      continue;
    }
    if (next <= now) {
      db.prepare(`INSERT INTO cron_state(path, last_fired, paused) VALUES(?, ?, 0)
                  ON CONFLICT(path) DO UPDATE SET last_fired=excluded.last_fired`).run(t.path, now);
      await startRun({
        departments: [t.department],
        trigger: `cron:${t.relPath}`,
        prompt: t.prompt,
        provider: (t.provider as any) || undefined,
      });
    }
  }

  // Goals — evaluated once per heartbeat per active goal.
  const goals = await listGoals();
  for (const g of goals) {
    if (g.status !== "active") continue;
    await startRun({
      departments: [g.department],
      trigger: `goal:${g.relPath}`,
      prompt: `You are evaluating a goal. If it deserves action this cycle, do the next smallest useful step and update the goal file's state frontmatter. Otherwise, reply "skip" and do nothing.\n\n${g.prompt}`,
      provider: (g.provider as any) || undefined,
    });
  }
}
