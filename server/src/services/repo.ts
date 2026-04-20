// Repo management: clone/pull, scaffold new repo, validate aios.yaml.

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";

import { config } from "../config";
import { buildCommonAuthEnv } from "./provider-auth";
import { cloneUrlWithPat, getGithubCreds, GithubCreds } from "./github";

const execFileAsync = promisify(execFile);

export interface AiosYaml {
  version?: string | number;
  departments?: string[];
  ignored?: string[];
  mirrors?: Array<{ source: string; target: string }>;
  notifications?: { default?: string };
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export async function gitRun(args: string[], cwd = config.repoDir, env: NodeJS.ProcessEnv = buildGitEnv()) {
  return execFileAsync("git", args, { cwd, env });
}

function buildGitEnv(): NodeJS.ProcessEnv {
  const creds = getGithubCreds();
  const env = buildCommonAuthEnv();
  if (creds?.mode === "deploy_key" && creds.privateKeyPath) {
    return {
      ...env,
      GIT_SSH_COMMAND: `ssh -i "${creds.privateKeyPath}" -o StrictHostKeyChecking=accept-new`,
    };
  }
  return env;
}

export async function cloneRepo(input: {
  cloneUrl: string; creds: GithubCreds;
}): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  try {
    await mkdir(dirname(config.repoDir), { recursive: true });
    const useDeployKey = input.creds.mode === "deploy_key" && !!input.creds.privateKeyPath;
    const url = input.creds.mode === "pat" && input.creds.username && input.creds.token
      ? cloneUrlWithPat(input.cloneUrl, input.creds.username, input.creds.token)
      : useDeployKey && input.cloneUrl.startsWith("https://github.com/")
        ? input.cloneUrl.replace(/^https:\/\/github\.com\//, "git@github.com:")
        : input.cloneUrl;
    const env = useDeployKey
      ? {
          ...buildCommonAuthEnv(),
          GIT_SSH_COMMAND: `ssh -i "${input.creds.privateKeyPath}" -o StrictHostKeyChecking=accept-new`,
        }
      : buildGitEnv();
    if (existsSync(join(config.repoDir, ".git"))) {
      await gitRun(["pull", "--ff-only"], config.repoDir, env);
    } else {
      await execFileAsync("git", ["clone", url, config.repoDir], { env });
    }
    const { stdout } = await gitRun(["rev-parse", "HEAD"], config.repoDir, env);
    return { ok: true, commit: stdout.trim() };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

export async function pullRepo(): Promise<{ ok: true; changed: boolean; commit: string } | { ok: false; error: string }> {
  try {
    if (!existsSync(join(config.repoDir, ".git"))) {
      return { ok: false, error: "repo not cloned" };
    }
    const before = (await gitRun(["rev-parse", "HEAD"])).stdout.trim();
    await gitRun(["pull", "--ff-only"]).catch(() => {});
    const after = (await gitRun(["rev-parse", "HEAD"])).stdout.trim();
    return { ok: true, changed: before !== after, commit: after };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

export async function readAiosYaml(): Promise<AiosYaml | null> {
  const path = join(config.repoDir, "aios.yaml");
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  return parseSimpleYaml(raw);
}

// --- intentionally tiny YAML parser, scoped to aios.yaml shape ---
// aios.yaml is shallow: keys, lists, and simple scalars. Keeps us off a dep.
function parseSimpleYaml(text: string): AiosYaml {
  const out: any = {};
  const lines = text.split(/\r?\n/);
  let currentList: any[] | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentList) {
      currentList.push(stripQuotes(listMatch[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === "" || value === null) {
      currentList = [];
      out[key] = currentList;
    } else if (/^\[.*\]$/.test(value.trim())) {
      out[key] = value.trim().slice(1, -1).split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
      currentList = null;
    } else {
      out[key] = coerce(stripQuotes(value));
      currentList = null;
    }
  }
  return out;
}

function stripQuotes(s: string) {
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerce(s: string): any {
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

export async function scaffoldRepo(dir: string, opts: { name: string }): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "aios.yaml"),
    `version: 1
departments:
  - sample
ignored:
  - node_modules
  - .git
  - dashboard
`);
  await writeFile(join(dir, "CLAUDE.md"),
    `# ${opts.name} - root context\n\nThis is the AIOS-managed monorepo for ${opts.name}. Top-level folders listed in \`aios.yaml\` are departments.\n`);
  await writeFile(join(dir, "AGENTS.md"),
    `# ${opts.name} - root context\n\nThis is the AIOS-managed monorepo for ${opts.name}. Top-level folders listed in \`aios.yaml\` are departments.\n`);
  await writeFile(join(dir, "org.md"),
    "# Organization\n\nReplace this with a description of your business, priorities, and shared conventions.\n");
  await writeFile(join(dir, "README.md"),
    `# ${opts.name}\n\nManaged by AIOS. See \`aios.yaml\` for the department list.\n`);
  await writeFile(join(dir, ".gitignore"),
    "node_modules/\n.env\n.env.local\nlogs/\n*.log\n");

  const dept = join(dir, "sample");
  await mkdir(join(dept, "cron"), { recursive: true });
  await mkdir(join(dept, "goals"), { recursive: true });
  await mkdir(join(dept, "skills"), { recursive: true });
  await mkdir(join(dept, "logs"), { recursive: true });
  await writeFile(join(dept, "CLAUDE.md"),
    "# sample department\n\nOne-line summary: sample department used to demonstrate the AIOS execution model.\n");
  await writeFile(join(dept, "AGENTS.md"),
    "# sample department\n\nOne-line summary: sample department used to demonstrate the AIOS execution model.\n");
  await writeFile(join(dept, "cron", "hello.md"),
    `---
schedule: "0 * * * *"
provider: claude-code
---

Print "hello from AIOS" to stdout and exit.
`);
}

export async function validateAiosRepo(dir: string): Promise<{ ok: boolean; error?: string; yaml?: AiosYaml }> {
  if (!existsSync(join(dir, "aios.yaml"))) {
    return { ok: false, error: "aios.yaml missing at repo root" };
  }
  const y = parseSimpleYaml(await readFile(join(dir, "aios.yaml"), "utf-8"));
  if (!Array.isArray(y.departments)) {
    return { ok: false, error: "aios.yaml: `departments` must be a list" };
  }
  return { ok: true, yaml: y };
}

export async function discoverDepartments(): Promise<string[]> {
  const y = await readAiosYaml();
  if (!y?.departments) return [];
  const out: string[] = [];
  for (const d of y.departments) {
    if (await pathExists(join(config.repoDir, d))) out.push(d);
  }
  return out;
}

export async function repoHead(): Promise<string | null> {
  try {
    const { stdout } = await gitRun(["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}
