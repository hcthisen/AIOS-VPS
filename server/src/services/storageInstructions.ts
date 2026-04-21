// Manage the "## File storage" section in a department's CLAUDE.md. Uses the
// generic managedSection utility so we can later add other auto-managed
// sections without stomping operator edits.

import { join } from "path";

import { listDepartments } from "./departments";
import {
  removeManagedSection,
  upsertManagedSection,
} from "./managedSection";
import { runSyncLayer } from "./sync";
import { log } from "../log";

const SECTION_ID = "storage";

export function defaultInstructionsBody(): string {
  return `## File storage

This department has an S3-compatible bucket configured for file outputs.
Credentials are in .env as AIOS_STORAGE_* variables.

**When to use storage:**
- Any generated image, video, document, or binary artifact.
- Any file that needs a public URL (social media, external APIs, email embeds).
- Any file that would be inappropriate to commit to the repo (size, sensitivity, binary format).

**Where to save:**
- Public files (world-readable via URL): \`\${AIOS_STORAGE_PUBLIC_PREFIX}<category>/YYYY-MM-DD/<slug>.<ext>\`
- Private files (internal only): \`\${AIOS_STORAGE_PRIVATE_PREFIX}<category>/YYYY-MM-DD/<slug>.<ext>\`

**File naming:**
- Use slugified descriptive names, not UUIDs or timestamps alone.
- Always include a file extension matching the content type.
- Organize by date folder so listings are chronologically scannable.

**Reporting:**
- At the end of any run that produced files, print a "Files produced:" section listing each full public URL (for public files) or S3 path (for private files).
- AIOS captures this and surfaces it in the run log.

**Upload method:**
- Use \`aws s3 cp\` or the department's preferred S3 client with credentials from .env.
- Do not embed credentials in prompts or commit them to the repo.`;
}

async function contextPath(deptName: string): Promise<string> {
  const depts = await listDepartments();
  const d = depts.find((x) => x.name === deptName);
  if (!d) throw new Error(`department not found: ${deptName}`);
  return join(d.path, "CLAUDE.md");
}

function triggerSync(): void {
  runSyncLayer({ commit: true }).catch((e: unknown) => {
    log.warn("storage instructions: sync failed", (e as Error)?.message || e);
  });
}

export async function applyInstructions(deptName: string): Promise<boolean> {
  const abs = await contextPath(deptName);
  const changed = await upsertManagedSection(abs, SECTION_ID, defaultInstructionsBody());
  if (changed) triggerSync();
  return changed;
}

export async function clearInstructions(deptName: string): Promise<boolean> {
  const abs = await contextPath(deptName);
  const changed = await removeManagedSection(abs, SECTION_ID);
  if (changed) triggerSync();
  return changed;
}

export async function resetInstructionsToDefaults(deptName: string): Promise<boolean> {
  const abs = await contextPath(deptName);
  const changed = await upsertManagedSection(abs, SECTION_ID, defaultInstructionsBody());
  if (changed) triggerSync();
  return changed;
}
