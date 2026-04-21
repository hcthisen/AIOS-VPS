// Minimal .env round-tripping. We preserve unknown keys, comments, and
// ordering because operators may have hand-edited the file.

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";

export interface EnvEntry {
  kind: "kv" | "raw";
  key?: string;
  value?: string;
  raw: string;
}

const NEEDS_QUOTES = /[\s="#]/;

function parseLine(line: string): EnvEntry {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return { kind: "raw", raw: line };
  const key = m[1];
  let rest = m[2];
  const hashIdx = rest.indexOf(" #");
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const q = rest[0];
    const end = rest.indexOf(q, 1);
    if (end > 0) rest = rest.slice(1, end).replace(/\\"/g, '"');
  } else if (hashIdx >= 0) {
    rest = rest.slice(0, hashIdx);
  }
  return { kind: "kv", key, value: rest.trim(), raw: line };
}

export function parseEnv(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  const src = text.replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      out.push({ kind: "raw", raw: line });
      continue;
    }
    out.push(parseLine(line));
  }
  if (lines[lines.length - 1] === "") out.pop();
  return out;
}

export function toMap(entries: EnvEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) if (e.kind === "kv" && e.key) map[e.key] = e.value || "";
  return map;
}

function formatValue(v: string): string {
  if (v === "") return "";
  if (NEEDS_QUOTES.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
  return v;
}

export function serializeEnv(entries: EnvEntry[]): string {
  const lines = entries.map((e) => {
    if (e.kind === "raw") return e.raw;
    return `${e.key}=${formatValue(e.value ?? "")}`;
  });
  return lines.join("\n") + "\n";
}

export async function readEnvFile(abs: string): Promise<EnvEntry[]> {
  if (!existsSync(abs)) return [];
  const text = await readFile(abs, "utf-8");
  return parseEnv(text);
}

export async function writeEnvFile(abs: string, entries: EnvEntry[]): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, serializeEnv(entries));
}

export function applyUpdates(
  entries: EnvEntry[],
  updates: Record<string, string>,
  removeKeys: string[] = [],
): EnvEntry[] {
  const next = entries.slice();
  const removeSet = new Set(removeKeys);
  const touched = new Set<string>();

  // Update in place; skip entries whose key is in removeSet.
  for (let i = 0; i < next.length; i++) {
    const e = next[i];
    if (e.kind !== "kv" || !e.key) continue;
    if (removeSet.has(e.key)) {
      next.splice(i, 1);
      i--;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(updates, e.key)) {
      next[i] = { kind: "kv", key: e.key, value: updates[e.key], raw: "" };
      touched.add(e.key);
    }
  }
  // Append new keys we didn't find.
  for (const [k, v] of Object.entries(updates)) {
    if (!touched.has(k)) next.push({ kind: "kv", key: k, value: v, raw: "" });
  }
  return next;
}

export async function mergeEnv(
  abs: string,
  updates: Record<string, string>,
  removeKeys: string[] = [],
): Promise<void> {
  const entries = await readEnvFile(abs);
  const next = applyUpdates(entries, updates, removeKeys);
  await writeEnvFile(abs, next);
}
