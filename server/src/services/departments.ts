// Department + cron + goal parsers. Files are the source of truth.

import { readdir, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import matter from "gray-matter";

import { config } from "../config";
import { readAiosYaml } from "./repo";

export interface CronTask {
  path: string;          // absolute file path
  relPath: string;       // repo-relative
  department: string;
  name: string;
  schedule: string;
  provider?: string;
  paused?: boolean;
  prompt: string;
}

export interface Goal {
  path: string;
  relPath: string;
  department: string;
  name: string;
  status?: "active" | "paused" | "complete";
  provider?: string;
  prompt: string;
  state?: Record<string, unknown>;
}

export interface Department {
  name: string;
  path: string;
  contextPath: string;
}

async function safeReaddir(p: string): Promise<string[]> {
  try { return await readdir(p); } catch { return []; }
}

export async function listDepartments(): Promise<Department[]> {
  const y = await readAiosYaml();
  if (!y?.departments) return [];
  const out: Department[] = [];
  for (const name of y.departments) {
    const path = join(config.repoDir, name);
    if (!existsSync(path)) continue;
    const s = await stat(path).catch(() => null);
    if (!s?.isDirectory()) continue;
    out.push({
      name,
      path,
      contextPath: join(path, "CLAUDE.md"),
    });
  }
  return out;
}

export async function listCronTasks(): Promise<CronTask[]> {
  const depts = await listDepartments();
  const tasks: CronTask[] = [];
  for (const d of depts) {
    const cronDir = join(d.path, "cron");
    const files = await safeReaddir(cronDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const abs = join(cronDir, f);
      try {
        const raw = await readFile(abs, "utf-8");
        const parsed = matter(raw);
        const fm = parsed.data as any;
        const schedule = String(fm.schedule || fm.cron || "").trim();
        if (!schedule) continue;
        tasks.push({
          path: abs,
          relPath: `${d.name}/cron/${f}`,
          department: d.name,
          name: f.replace(/\.md$/, ""),
          schedule,
          provider: fm.provider,
          paused: !!fm.paused,
          prompt: parsed.content.trim(),
        });
      } catch { /* skip */ }
    }
  }
  return tasks;
}

export async function listGoals(): Promise<Goal[]> {
  const depts = await listDepartments();
  const goals: Goal[] = [];
  for (const d of depts) {
    const dir = join(d.path, "goals");
    const files = await safeReaddir(dir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const abs = join(dir, f);
      try {
        const raw = await readFile(abs, "utf-8");
        const parsed = matter(raw);
        const fm = parsed.data as any;
        goals.push({
          path: abs,
          relPath: `${d.name}/goals/${f}`,
          department: d.name,
          name: f.replace(/\.md$/, ""),
          status: (fm.status as any) || "active",
          provider: fm.provider,
          prompt: parsed.content.trim(),
          state: fm.state || {},
        });
      } catch {}
    }
  }
  return goals;
}
