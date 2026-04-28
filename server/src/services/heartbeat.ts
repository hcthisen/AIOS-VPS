// Heartbeat scanner: pull repo → run sync → scan cron/goals → enqueue triggers.

import cronParser from "cron-parser";
import { db } from "../db";
import { log } from "../log";
import { checkRemoteForUpdates, gitRun, isGitWorktreeBlocked, reconcilePendingRepoSync, RepoSyncResult, syncRepoWithRemote } from "./repo";
import { listCronTasks, listGoals } from "./departments";
import { startRun, isGlobalPaused } from "./executor";
import { runSyncLayer } from "./sync";
import { getSetupPhase } from "../setup-phase";
import { isSystemUpdateBlocking } from "./systemUpdate";
import { processOwnerNotificationOutbox, retryPendingOwnerNotifications } from "./ownerNotifications";
import { schedulerCronOptions } from "./time";

const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_GOAL_INTERVAL_MS = 10 * 60_000;
let heartbeatTimer: NodeJS.Timeout | null = null;
let running = false;
let lastTickAt = 0;
let lastTickError: string | null = null;
let lastGitSync: RepoSyncResult | null = null;

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
  return { running: !!heartbeatTimer, lastTickAt, lastTickError, lastGitSync };
}

export async function runHeartbeatTick() {
  if (getSetupPhase() !== "complete") return; // nothing to do until onboarding is finished
  if (isGlobalPaused()) return;
  if (await isSystemUpdateBlocking()) return;

  const remote = await checkRemoteForUpdates().catch((e) => {
    log.warn("heartbeat: remote check failed:", e?.message || e);
    return null;
  });
  if (remote?.changed) {
    const git = await reconcilePendingRepoSync("heartbeat remote update");
    if (git) lastGitSync = git;
    if (git && !git.ok) {
      log.warn("heartbeat: git sync failed:", git.error);
      return;
    }
  }
  if (!isGitWorktreeBlocked()) {
    await runSyncLayer().catch((e) => log.warn("sync after pull failed", e?.message || e));
    const outbox = await processOwnerNotificationOutbox().catch((e) => {
      log.warn("owner notification outbox processing failed", e?.message || e);
      return null;
    });
    if (outbox?.deletedPaths.length) {
      await commitOutboxCleanup().catch((e) => log.warn("owner notification cleanup commit failed", e?.message || e));
    }
  }
  await retryPendingOwnerNotifications().catch((e) => log.warn("owner notification retry failed", e?.message || e));

  const now = Date.now();

  // Cron tasks
  const tasks = await listCronTasks();
  for (const t of tasks) {
    if (t.paused) continue;
    const state = db.prepare("SELECT * FROM cron_state WHERE path = ?").get(t.path) as { last_fired: number; paused: number } | undefined;
    const lastFired = state?.last_fired ?? 0;
    let next: number;
    try {
      const it = cronParser.parseExpression(t.schedule, schedulerCronOptions(new Date(lastFired || now - 60_000)));
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

  // Goals are scheduled wakeups. The heartbeat checks them every minute, but a
  // goal only runs when its own schedule is due.
  const goals = await listGoals();
  for (const g of goals) {
    if (g.status !== "active") continue;
    if (!isGoalScheduleAllowed(g.schedule)) {
      log.warn(`goal schedule '${g.schedule}' in ${g.relPath} is below the 10 minute minimum; skipping`);
      continue;
    }
    const state = db.prepare("SELECT * FROM goal_state WHERE path = ?").get(g.path) as { last_fired: number } | undefined;
    const lastFired = state?.last_fired ?? 0;
    let next: number;
    try {
      const it = cronParser.parseExpression(g.schedule, schedulerCronOptions(new Date(lastFired || now - 60_000)));
      next = it.next().getTime();
    } catch (e: any) {
      log.warn(`invalid goal schedule '${g.schedule}' in ${g.relPath}`);
      continue;
    }
    if (next > now) continue;

    db.prepare(`INSERT INTO goal_state(path, last_fired) VALUES(?, ?)
                ON CONFLICT(path) DO UPDATE SET last_fired=excluded.last_fired`).run(g.path, now);
    await startRun({
      departments: [g.department],
      trigger: `goal:${g.relPath}`,
      prompt: buildGoalWakePrompt(g),
      provider: (g.provider as any) || undefined,
    });
  }
}

async function commitOutboxCleanup() {
  await gitRun(["add", "-A"]);
  const { stdout } = await gitRun(["status", "--porcelain"]);
  if (!stdout.trim()) return;
  await gitRun(["commit", "-m", "aios: process owner notifications"]);
  lastGitSync = await syncRepoWithRemote({ notifyOnRemoteWins: true });
}

export function isGoalScheduleAllowed(schedule: string, minIntervalMs = MIN_GOAL_INTERVAL_MS): boolean {
  try {
    const it = cronParser.parseExpression(schedule, schedulerCronOptions(new Date()));
    const first = it.next().getTime();
    const second = it.next().getTime();
    return second - first >= minIntervalMs;
  } catch {
    return true;
  }
}

export function buildGoalWakePrompt(goal: { relPath: string; schedule: string; prompt: string }): string {
  return [
    "You have been woken up to work on a long-running AIOS goal.",
    "",
    `Goal file: ${goal.relPath}`,
    `Current wake schedule: ${goal.schedule}`,
    "Minimum wake interval: 10 minutes. Prefer hourly, daily, or weekly schedules unless this is lightweight monitoring work.",
    "",
    "You may update this goal file, including its schedule, status, and state, when a different wake cadence better fits the goal.",
    "Never delete this goal. If it should stop running, set status: paused. If it is done, set status: complete.",
    "Take the next smallest useful step. If no useful work is due, update state only if helpful and exit.",
    "",
    "Goal:",
    goal.prompt,
  ].join("\n");
}
