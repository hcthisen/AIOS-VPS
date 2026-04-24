// Manage the "## File storage" section in a department's CLAUDE.md and
// AGENTS.md. Uses the generic managedSection utility so we can later add other
// auto-managed sections without stomping operator edits.

import { join } from "path";

import { ROOT_DEPARTMENT_NAME, getRootDepartment, listDepartments } from "./departments";
import {
  removeManagedSection,
  upsertManagedSection,
} from "./managedSection";

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

**CLI environment:**
- AIOS injects this department's \`.env\` into every run.
- AIOS also maps \`AIOS_STORAGE_ACCESS_KEY_ID\` and \`AIOS_STORAGE_SECRET_ACCESS_KEY\` to \`AWS_ACCESS_KEY_ID\` and \`AWS_SECRET_ACCESS_KEY\`, and maps the region to \`AWS_REGION\` / \`AWS_DEFAULT_REGION\`.

**Upload method:**
- Use \`aws s3 cp <local-file> "s3://$AIOS_STORAGE_BUCKET/<key>" --endpoint-url "$AIOS_STORAGE_ENDPOINT"\`.
- Example public key: \`$AIOS_STORAGE_PUBLIC_PREFIXimages/2026-04-22/launch-hero.png\`
- Example private key: \`$AIOS_STORAGE_PRIVATE_PREFIXreports/2026-04-22/qbr-draft.pdf\`

**Reporting:**
- At the end of any run that produced files, print a "Files produced:" section.
- For public files, print the full public URL only when \`AIOS_STORAGE_PUBLIC_BASE_URL\` is configured; otherwise print the full \`s3://bucket/key\` path.
- For private files, always print the full \`s3://bucket/key\` path.
- AIOS captures this and surfaces it in the run log.
- When a public base URL is configured, AIOS verifies that uploaded public links are actually reachable before accepting the setting.
- Bucket CORS is usually unnecessary for current AIOS flows because uploads go through AIOS and private previews use signed URLs.
- Do not embed credentials in prompts or commit them to the repo.`;
}

async function contextPaths(deptName: string): Promise<string[]> {
  if (deptName === ROOT_DEPARTMENT_NAME) {
    const root = await getRootDepartment();
    return [join(root.path, "CLAUDE.md"), join(root.path, "AGENTS.md")];
  }
  const depts = await listDepartments();
  const d = depts.find((x) => x.name === deptName);
  if (!d) throw new Error(`department not found: ${deptName}`);
  return [join(d.path, "CLAUDE.md"), join(d.path, "AGENTS.md")];
}

export async function storageInstructionPaths(deptName: string): Promise<string[]> {
  return contextPaths(deptName);
}

export async function applyInstructions(deptName: string): Promise<boolean> {
  const paths = await contextPaths(deptName);
  const changed = await Promise.all(
    paths.map((abs) => upsertManagedSection(abs, SECTION_ID, defaultInstructionsBody())),
  );
  return changed.some(Boolean);
}

export async function clearInstructions(deptName: string): Promise<boolean> {
  const paths = await contextPaths(deptName);
  const changed = await Promise.all(paths.map((abs) => removeManagedSection(abs, SECTION_ID)));
  return changed.some(Boolean);
}

export async function resetInstructionsToDefaults(deptName: string): Promise<boolean> {
  const paths = await contextPaths(deptName);
  const changed = await Promise.all(
    paths.map((abs) => upsertManagedSection(abs, SECTION_ID, defaultInstructionsBody())),
  );
  return changed.some(Boolean);
}
