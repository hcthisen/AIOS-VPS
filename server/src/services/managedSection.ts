// Append/update/remove a named section inside a markdown file using HTML
// comment markers. Lets other code treat the section as auto-managed without
// stomping operator edits elsewhere in the file.

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";

function markers(id: string) {
  return {
    start: `<!-- aios:managed:${id} start -->`,
    end: `<!-- aios:managed:${id} end -->`,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasManagedSection(content: string, id: string): boolean {
  const { start, end } = markers(id);
  return content.includes(start) && content.includes(end);
}

export function stripManagedSection(content: string, id: string): string {
  const { start, end } = markers(id);
  const re = new RegExp(
    `\\n*${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`,
    "g",
  );
  return content.replace(re, "");
}

export function upsertManagedBlock(content: string, id: string, body: string): string {
  const stripped = stripManagedSection(content, id);
  const trimmed = stripped.replace(/\s+$/, "");
  const { start, end } = markers(id);
  const block = `${start}\n${body.trimEnd()}\n${end}`;
  if (!trimmed) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

export async function upsertManagedSection(
  abs: string,
  id: string,
  body: string,
): Promise<boolean> {
  const prev = existsSync(abs) ? await readFile(abs, "utf-8") : "";
  const next = upsertManagedBlock(prev, id, body);
  if (next === prev) return false;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, next);
  return true;
}

export async function removeManagedSection(abs: string, id: string): Promise<boolean> {
  if (!existsSync(abs)) return false;
  const prev = await readFile(abs, "utf-8");
  const next = stripManagedSection(prev, id);
  if (next === prev) return false;
  await writeFile(abs, next);
  return true;
}
