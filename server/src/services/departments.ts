// Department + cron + goal parsers. Files are the source of truth.

import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import matter from "gray-matter";

import { config } from "../config";
import { buildDepartmentContextMd, readAiosYaml } from "./repo";

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

export class DepartmentCreateError extends Error {
  constructor(public code: "bad_request" | "conflict", message: string) {
    super(message);
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try { return await readdir(p); } catch { return []; }
}

export function normalizeDepartmentName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}

export async function createDepartment(input: { name: string }): Promise<Department> {
  const name = normalizeDepartmentName(String(input.name || ""));
  if (!name) throw new DepartmentCreateError("bad_request", "department name required");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) {
    throw new DepartmentCreateError("bad_request", "department name must use letters, numbers, dots, dashes, or underscores");
  }

  const y = await readAiosYaml();
  const departments = Array.isArray(y?.departments) ? y.departments : [];
  const ignored = Array.isArray(y?.ignored) ? y.ignored : [];
  if (ignored.includes(name)) throw new DepartmentCreateError("conflict", `${name} is listed as ignored in aios.yaml`);

  const deptPath = join(config.repoDir, name);
  if (departments.includes(name) && existsSync(deptPath)) {
    throw new DepartmentCreateError("conflict", "department already exists");
  }
  if (!departments.includes(name) && existsSync(deptPath)) {
    throw new DepartmentCreateError("conflict", `folder already exists: ${name}`);
  }

  await writeDepartmentToAiosYaml(name);
  await mkdir(join(deptPath, "cron"), { recursive: true });
  await mkdir(join(deptPath, "goals"), { recursive: true });
  await mkdir(join(deptPath, "skills"), { recursive: true });
  await mkdir(join(deptPath, "webhooks"), { recursive: true });
  await mkdir(join(deptPath, "logs"), { recursive: true });

  const context = buildDepartmentContextMd(name);
  await writeFile(join(deptPath, "CLAUDE.md"), context, "utf-8");
  await writeFile(join(deptPath, "AGENTS.md"), context, "utf-8");
  await writeFile(join(deptPath, "README.md"), `# ${name}\n\nDepartment managed by AIOS.\n`, "utf-8");
  await writeFile(join(deptPath, "cron", ".gitkeep"), "", "utf-8");
  await writeFile(join(deptPath, "goals", ".gitkeep"), "", "utf-8");
  await writeFile(join(deptPath, "skills", ".gitkeep"), "", "utf-8");
  await writeFile(join(deptPath, "webhooks", ".gitkeep"), "", "utf-8");

  return {
    name,
    path: deptPath,
    contextPath: join(deptPath, "CLAUDE.md"),
  };
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

async function writeDepartmentToAiosYaml(name: string): Promise<void> {
  const path = join(config.repoDir, "aios.yaml");
  const raw = existsSync(path)
    ? await readFile(path, "utf-8")
    : "version: 1\ndepartments:\n";
  const y = await readAiosYaml();
  const departments = Array.isArray(y?.departments) ? y.departments : [];
  const nextDepartments = departments.includes(name) ? departments : [...departments, name];
  await writeFile(path, rewriteDepartmentsSection(raw, nextDepartments), "utf-8");
}

function rewriteDepartmentsSection(raw: string, departments: string[]): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const section = [
    "departments:",
    ...departments.map((department) => `  - ${quoteYamlScalar(department)}`),
  ];
  const start = lines.findIndex((line) => /^departments:\s*/.test(line));
  if (start === -1) {
    return [...lines, ...(lines.length ? [""] : []), ...section, ""].join("\n");
  }

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && /^[A-Za-z_][\w-]*:\s*/.test(line)) break;
    end += 1;
  }
  return [...lines.slice(0, start), ...section, ...lines.slice(end), ""].join("\n");
}

function quoteYamlScalar(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
