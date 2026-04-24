// Repo management: clone/pull, scaffold new repo, validate aios.yaml.

import { randomBytes } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, stat, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, relative, resolve, sep } from "path";
import matter from "gray-matter";

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

export interface AiosContextInput {
  organizationName: string;
  deploymentScope: string;
  parentScope?: string;
  scopeSummary: string;
  outsideRepoContext: string;
  sharedConventions: string;
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export async function gitRun(args: string[], cwd = config.repoDir, env: NodeJS.ProcessEnv = buildGitEnv()) {
  return execFileAsync("git", args, { cwd, env });
}

function repoPathspecs(paths: string[]): string[] {
  const repoRoot = resolve(config.repoDir);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const abs = resolve(repoRoot, raw);
    const rel = relative(repoRoot, abs);
    if (!rel || rel === "" || rel.startsWith("..") || resolve(repoRoot, rel) !== abs) continue;
    const spec = rel.split(sep).join("/");
    if (seen.has(spec)) continue;
    seen.add(spec);
    out.push(spec);
  }
  return out;
}

export async function commitRepoPaths(paths: string[], message: string): Promise<string | null> {
  const pathspecs = repoPathspecs(paths);
  if (!pathspecs.length) return null;

  const { stdout: status } = await gitRun(["status", "--porcelain", "--", ...pathspecs]);
  if (!status.trim()) return null;

  const tmpDir = join(config.dataDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpIndex = join(tmpDir, `git-index-${Date.now()}-${randomBytes(4).toString("hex")}`);
  const tempEnv = {
    ...buildGitEnv(),
    GIT_INDEX_FILE: tmpIndex,
  };

  try {
    try {
      await gitRun(["rev-parse", "--verify", "HEAD"], config.repoDir, tempEnv);
      await gitRun(["read-tree", "HEAD"], config.repoDir, tempEnv);
    } catch {
      // Empty repository; commit from an empty temporary index.
    }

    await gitRun(["add", "--", ...pathspecs], config.repoDir, tempEnv);
    const { stdout: staged } = await gitRun(["diff", "--cached", "--name-only", "--", ...pathspecs], config.repoDir, tempEnv);
    if (!staged.trim()) return null;

    await gitRun(["commit", "-m", message], config.repoDir, tempEnv);
    await gitRun(["add", "--", ...pathspecs]).catch(() => {});
    await gitRun(["push", "origin", "HEAD"]).catch(() => {});
    const { stdout: head } = await gitRun(["rev-parse", "HEAD"]);
    return head.trim();
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

function buildGitEnv(): NodeJS.ProcessEnv {
  const creds = getGithubCreds();
  const env = buildCommonAuthEnv();
  const gitName = process.env.GIT_AUTHOR_NAME
    || process.env.GIT_COMMITTER_NAME
    || creds?.username
    || "AIOS";
  const gitEmail = process.env.GIT_AUTHOR_EMAIL
    || process.env.GIT_COMMITTER_EMAIL
    || (creds?.username ? `${creds.username}@users.noreply.github.com` : "aios@local.invalid");
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_AUTHOR_NAME: gitName,
    GIT_AUTHOR_EMAIL: gitEmail,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || gitName,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || gitEmail,
  };
  if (creds?.mode === "deploy_key" && creds.privateKeyPath) {
    return {
      ...gitEnv,
      GIT_SSH_COMMAND: `ssh -i "${creds.privateKeyPath}" -o StrictHostKeyChecking=accept-new`,
    };
  }
  return gitEnv;
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

function yamlQuote(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function trimParagraph(value: string, fallback: string) {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

function buildDefaultContext(name: string): AiosContextInput {
  return {
    organizationName: name,
    deploymentScope: name,
    parentScope: "",
    scopeSummary: `This AIOS deployment manages ${name}. Use it as the source of truth for the teams and automations that live in this repository.`,
    outsideRepoContext: "Describe the broader organization, adjacent teams, systems, or responsibilities that exist outside this repository.",
    sharedConventions: "Document shared conventions, approval rules, tone, compliance requirements, and other guidance every department should inherit.",
  };
}

function buildRootOrgMd(input: AiosContextInput): string {
  const parentScope = String(input.parentScope || "").trim();
  return `---
organization_name: ${yamlQuote(input.organizationName)}
deployment_scope: ${yamlQuote(input.deploymentScope)}
parent_scope: ${yamlQuote(parentScope)}
---
# Organization context

## Organization
${trimParagraph(input.organizationName, "Describe the organization this AIOS belongs to.")}

## AIOS deployment scope
${trimParagraph(input.scopeSummary, "Describe the part of the organization this AIOS is responsible for.")}

## Parent organization or department
${trimParagraph(parentScope, "This AIOS is deployed at the organization root.")}

## Outside this repository
${trimParagraph(input.outsideRepoContext, "List the teams, systems, or responsibilities that sit outside this repository but may matter to the work here.")}

## Shared conventions
${trimParagraph(input.sharedConventions, "List the conventions, constraints, and expectations every department in this AIOS should follow.")}
`;
}

function buildRootContextMd(input: AiosContextInput): string {
  const parentScope = String(input.parentScope || "").trim();
  const parentLine = parentScope
    ? `- This AIOS sits inside ${parentScope}.`
    : "- This AIOS is the root operating scope for this repository.";
  return `# Root context - ${input.deploymentScope}

One-line summary: AIOS workspace for ${input.deploymentScope} in ${input.organizationName}.

## Scope of this repository
- This repository serves ${input.deploymentScope}.
${parentLine}
- Root-level folders listed in \`aios.yaml\` are departments within this AIOS deployment.

## Shared context files
- \`org.md\` is the authored organization and deployment context for the whole AIOS.
- Every department receives a synced copy of \`org.md\` so shared context is available from inside the folder.
- Every department also receives an auto-generated \`_org.md\` listing sibling departments and their one-line summaries.

## Department conventions
- Keep department-specific instructions in each department's \`CLAUDE.md\` and \`AGENTS.md\`.
- Put scheduled prompts in \`cron/*.md\` with a \`schedule\` frontmatter field.
- Put long-running objectives and recurring work in \`goals/\`.
- Put reusable local skills in \`skills/\`.

## Cross-department work
- Start from the local department folder and only leave it when the task clearly requires cross-department context or collaboration.
- Use \`org.md\` to understand the larger business context.
- Use \`_org.md\` to discover which sibling departments exist before reading outside the current folder.
`;
}

export function buildDepartmentContextMd(name: string): string {
  return `# ${name} department - Department responsible for ${name} work in this AIOS deployment

One-line summary: ${name} is a department inside this AIOS deployment and owns the work routed into this folder.

## Role in this deployment
- This folder is one department inside a larger AIOS deployment, which may itself be only one part of a larger company or parent department.
- Keep the information this department always needs inside this folder.
- Use shared context files when work needs organizational awareness outside this folder.

## Local structure
- \`cron/\`: scheduled prompts for recurring work. Each markdown file is a task with frontmatter such as \`schedule: "0 * * * *"\`.
- \`goals/\`: long-running goals, standing objectives, or recurring work definitions.
- \`skills/\`: reusable local skills and operating procedures for this department.
- \`logs/\`: optional local logs or generated artifacts when the department needs them.

## Shared context
- \`org.md\`: authored organization and deployment-scope context copied from the repo root.
- \`_org.md\`: auto-generated map of sibling departments and their one-line summaries.
- Read both before coordinating outside this folder.

## Cross-department work
- Start from this folder's files and solve the task locally when possible.
- If the task depends on another department, use \`_org.md\` to discover the right folder and then inspect that folder directly.
- Do not assume shared knowledge that is not written in this folder, \`org.md\`, or the target department's files.
`;
}

function extractSection(content: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`## ${escaped}\\r?\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1]?.trim() || undefined;
}

export async function readRepoContext(dir: string, fallbackName = "AIOS deployment"): Promise<AiosContextInput> {
  const defaults = buildDefaultContext(fallbackName);
  const orgPath = join(dir, "org.md");
  if (!existsSync(orgPath)) return defaults;
  const raw = await readFile(orgPath, "utf-8");
  const parsed = matter(raw);
  const frontmatter = parsed.data as Record<string, unknown>;
  return {
    organizationName: String(frontmatter.organization_name || defaults.organizationName).trim(),
    deploymentScope: String(frontmatter.deployment_scope || defaults.deploymentScope).trim(),
    parentScope: String(frontmatter.parent_scope || "").trim(),
    scopeSummary: extractSection(parsed.content, "AIOS deployment scope") || defaults.scopeSummary,
    outsideRepoContext: extractSection(parsed.content, "Outside this repository") || defaults.outsideRepoContext,
    sharedConventions: extractSection(parsed.content, "Shared conventions") || defaults.sharedConventions,
  };
}

export async function writeRepoContext(dir: string, input: AiosContextInput): Promise<void> {
  const normalized: AiosContextInput = {
    organizationName: trimParagraph(input.organizationName, "AIOS deployment"),
    deploymentScope: trimParagraph(input.deploymentScope, trimParagraph(input.organizationName, "AIOS deployment")),
    parentScope: String(input.parentScope || "").trim(),
    scopeSummary: trimParagraph(input.scopeSummary, "Describe what this AIOS deployment is responsible for."),
    outsideRepoContext: trimParagraph(input.outsideRepoContext, "Describe the broader organization outside this repository."),
    sharedConventions: trimParagraph(input.sharedConventions, "Describe the conventions every department should follow."),
  };
  await writeFile(join(dir, "org.md"), buildRootOrgMd(normalized));
  const rootContext = buildRootContextMd(normalized);
  await writeFile(join(dir, "CLAUDE.md"), rootContext);
  await writeFile(join(dir, "AGENTS.md"), rootContext);
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
  await writeRepoContext(dir, buildDefaultContext(opts.name));
  await writeFile(join(dir, "README.md"),
    `# ${opts.name}\n\nManaged by AIOS. See \`aios.yaml\` for the department list.\n`);
  await writeFile(join(dir, ".gitignore"),
    "node_modules/\n.env\n.env.local\nlogs/\n*.log\n");

  const dept = join(dir, "sample");
  await mkdir(join(dept, "cron"), { recursive: true });
  await mkdir(join(dept, "goals"), { recursive: true });
  await mkdir(join(dept, "skills"), { recursive: true });
  await mkdir(join(dept, "logs"), { recursive: true });
  const sampleContext = buildDepartmentContextMd("sample");
  await writeFile(join(dept, "CLAUDE.md"), sampleContext);
  await writeFile(join(dept, "AGENTS.md"), sampleContext);
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
