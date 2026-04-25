import { join } from "path";

import { ROOT_DEPARTMENT_NAME, getRootDepartment, listDepartments } from "./departments";
import { upsertManagedSection } from "./managedSection";
import { outboxInstructionsBody } from "./outboxInstructionsBody";

const SECTION_ID = "owner-notifications";

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

export async function applyOutboxInstructions(deptName: string): Promise<boolean> {
  const paths = await contextPaths(deptName);
  const changed = await Promise.all(
    paths.map((abs) => upsertManagedSection(abs, SECTION_ID, outboxInstructionsBody())),
  );
  return changed.some(Boolean);
}
