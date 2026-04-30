// System-managed sync layer.
//
// - Mirror CLAUDE.md <-> AGENTS.md inside every department folder.
// - Copy root org.md into every department.
// - Regenerate _org.md (list of departments + one-line summaries) per folder.
// - Sync skills/ into provider-specific destinations (v1: copies into .claude/skills
//   and .codex/skills under each department, so both providers discover them).
//
// Commits as "aios: sync" so system-generated churn is separable from operator edits.

import { readFile, writeFile, stat, mkdir, copyFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

import { config } from "../config";
import { db } from "../db";
import { getCurrentCompanyId } from "../company-context";
import { ensureRootDepartmentName, getRootDepartment, listDepartments, pruneMissingDepartmentsFromAiosYaml } from "./departments";
import { buildDefaultReadmeMd, ensureAutomationWorkspace, gitRun, rootDisplayNameFromYaml, readAiosYaml, syncRepoWithRemote } from "./repo";
import { log } from "../log";
import { sendNotification } from "./notifications";
import { applyOutboxInstructions } from "./outboxInstructions";

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  try {
    const prev = await readFile(path, "utf-8");
    if (prev === content) return false;
  } catch {}
  await mkdir(require("path").dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return true;
}

async function readFirstLineDescription(contextPath: string): Promise<string> {
  try {
    const raw = await readFile(contextPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (const ln of lines) {
      const cleaned = ln.replace(/^#+\s*/, "").trim();
      if (cleaned) return cleaned.slice(0, 200);
    }
  } catch {}
  return "(no CLAUDE.md)";
}

async function ensureRootReadme(rootName: string): Promise<boolean> {
  const path = join(config.repoDir, "README.md");
  const next = buildDefaultReadmeMd(rootName);
  if (!existsSync(path)) {
    await writeFile(path, next, "utf-8");
    return true;
  }
  const current = await readFile(path, "utf-8").catch(() => "");
  const isOldScaffold = /^# .+\r?\n\r?\nManaged by AIOS\. See `aios\.yaml` for the department list\.\r?\n?$/.test(current);
  const isOldGeneratedReadme = current.includes("Active goals are evaluated once per heartbeat");
  if (!isOldScaffold && !isOldGeneratedReadme) return false;
  if (current === next) return false;
  await writeFile(path, next, "utf-8");
  return true;
}

async function copyTree(src: string, dst: string): Promise<void> {
  if (!existsSync(src)) return;
  const srcStat = await stat(src);
  if (srcStat.isDirectory()) {
    await mkdir(dst, { recursive: true });
    const entries = await readdir(src);
    for (const entry of entries) await copyTree(join(src, entry), join(dst, entry));
  } else {
    await mkdir(require("path").dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

export interface SyncResult {
  changed: string[];
  conflicts: Array<{ path: string; message: string }>;
  removedDepartments: string[];
}

export async function runSyncLayer(opts: { commit?: boolean } = { commit: true }): Promise<SyncResult> {
  const out: SyncResult = { changed: [], conflicts: [], removedDepartments: [] };
  const removedDepartments = await pruneMissingDepartmentsFromAiosYaml();
  if (removedDepartments.length) {
    out.removedDepartments.push(...removedDepartments);
    out.changed.push(join(config.repoDir, "aios.yaml"));
    clearRemovedDepartmentState(removedDepartments);
  }
  const root = await getRootDepartment();
  const depts = await listDepartments();
  const scopes = [root, ...depts];
  const yaml = await readAiosYaml();
  const rootNamePath = await ensureRootDepartmentName();
  if (rootNamePath) out.changed.push(rootNamePath);

  // 1. CLAUDE.md <-> AGENTS.md per department (and at repo root).
  await mirrorClaudeAgents(config.repoDir, out);
  for (const dept of depts) await mirrorClaudeAgents(dept.path, out);

  // 1b. Ensure root/departments have the standard automation folders,
  // default non-destructive skills, and owner-notification instructions.
  for (const scope of scopes) {
    const changed = await ensureAutomationWorkspace(scope.path);
    out.changed.push(...changed);
    if (await applyOutboxInstructions(scope.name)) {
      out.changed.push(join(scope.path, "CLAUDE.md"), join(scope.path, "AGENTS.md"));
    }
  }
  if (await ensureRootReadme(rootDisplayNameFromYaml(yaml))) {
    out.changed.push(join(config.repoDir, "README.md"));
  }

  // 2. org.md propagation.
  const rootOrg = join(config.repoDir, "org.md");
  if (existsSync(rootOrg)) {
    const orgBody = await readFile(rootOrg, "utf-8");
    for (const dept of depts) {
      const dst = join(dept.path, "org.md");
      if (await writeIfChanged(dst, orgBody)) out.changed.push(dst);
    }
  }

  // 3. _org.md per department.
  const summaries: Array<{ name: string; line: string }> = [];
  for (const dept of depts) {
    summaries.push({ name: dept.name, line: await readFirstLineDescription(dept.contextPath) });
  }
  const orgMap = [
    "# Organization map (auto-generated by AIOS; do not edit by hand)",
    "",
    ...summaries.map((summary) => `- **${summary.name}**: ${summary.line}`),
    "",
  ].join("\n");
  for (const dept of scopes) {
    const dst = join(dept.path, "_org.md");
    if (await writeIfChanged(dst, orgMap)) out.changed.push(dst);
  }

  // 4. Skills sync. Canonical location: <dept>/skills/. Mirror into
  //    <dept>/.claude/skills/ and <dept>/.codex/skills/ so both providers see them.
  for (const dept of scopes) {
    const canonical = join(dept.path, "skills");
    if (!existsSync(canonical)) continue;
    for (const target of [join(dept.path, ".claude", "skills"), join(dept.path, ".codex", "skills")]) {
      try {
        await mkdir(target, { recursive: true });
        await copyTree(canonical, target);
        out.changed.push(target);
      } catch (e: any) {
        out.conflicts.push({ path: target, message: String(e?.message || e) });
      }
    }
  }

  if (out.changed.length && opts.commit !== false) {
    try {
      await gitRun(["add", "-A"]);
      const { stdout: status } = await gitRun(["status", "--porcelain"]);
      if (status.trim()) {
        await gitRun(["commit", "-m", "aios: sync"]);
        await syncRepoWithRemote({ notifyOnRemoteWins: true });
      }
    } catch (e: any) {
      log.warn("sync: commit/push failed", e?.message || e);
    }
  }

  if (out.conflicts.length) {
    const lines = out.conflicts.map((conflict) => `- ${conflict.path}: ${conflict.message}`).join("\n");
    await sendNotification(`AIOS sync detected conflicts and left files unchanged.\n${lines}`, "AIOS sync conflict")
      .catch(() => {});
  }

  return out;
}

function clearRemovedDepartmentState(departments: string[]) {
  for (const department of departments) {
    const abs = join(config.repoDir, department);
    db.prepare("DELETE FROM backlog WHERE company_id = ? AND department = ?").run(getCurrentCompanyId(), department);
    db.prepare("DELETE FROM claims WHERE company_id = ? AND department = ?").run(getCurrentCompanyId(), department);
    db.prepare("DELETE FROM cron_state WHERE company_id = ? AND (path = ? OR path LIKE ?)").run(getCurrentCompanyId(), abs, `${abs}%`);
    db.prepare("DELETE FROM goal_state WHERE company_id = ? AND (path = ? OR path LIKE ?)").run(getCurrentCompanyId(), abs, `${abs}%`);
  }
}

async function mirrorClaudeAgents(dir: string, out: SyncResult) {
  const claude = join(dir, "CLAUDE.md");
  const agents = join(dir, "AGENTS.md");
  const hasClaude = existsSync(claude);
  const hasAgents = existsSync(agents);

  if (!hasClaude && !hasAgents) return;
  if (hasClaude && hasAgents) {
    const [claudeBody, agentsBody] = await Promise.all([
      readFile(claude, "utf-8"),
      readFile(agents, "utf-8"),
    ]);
    if (claudeBody === agentsBody) return;

    const [claudeStat, agentsStat] = await Promise.all([stat(claude), stat(agents)]);
    if (claudeStat.mtimeMs === agentsStat.mtimeMs) {
      out.conflicts.push({ path: dir, message: "divergent CLAUDE.md and AGENTS.md with identical timestamps; resolve manually" });
      return;
    }

    if (claudeStat.mtimeMs > agentsStat.mtimeMs) {
      await copyFile(claude, agents);
      out.changed.push(agents);
    } else {
      await copyFile(agents, claude);
      out.changed.push(claude);
    }
    return;
  }

  if (hasClaude) {
    await copyFile(claude, agents);
    out.changed.push(agents);
  } else {
    await copyFile(agents, claude);
    out.changed.push(claude);
  }
}
