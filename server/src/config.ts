import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface AiosConfig {
  port: number;
  host: string;
  dataDir: string;
  repoDir: string;
  logsDir: string;
  uiDir: string;
  agentHome: string;
  appUser: string;
  publicIp?: string;
  auth: {
    publicBaseUrl: string | null;
    baseUrlMode: "auto" | "explicit";
    domain: string | null;
  };
}

const defaultHome = process.env.AIOS_HOME || process.env.HOME || "/home/aios";

function loadOrInitConfig(path: string): AiosConfig {
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      return normalize(parsed);
    } catch {
      // fall through and rewrite
    }
  }
  const seed = normalize({});
  mkdirSync(require("path").dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(seed, null, 2));
  return seed;
}

function normalize(input: Partial<AiosConfig>): AiosConfig {
  const dataDir = input.dataDir
    || process.env.AIOS_DATA_DIR
    || join(process.cwd(), "data");
  const logsDir = input.logsDir
    || process.env.AIOS_LOGS_DIR
    || join(dataDir, "..", "logs");
  return {
    port: input.port ?? Number(process.env.PORT) ?? 3100,
    host: input.host ?? (process.env.HOST || "0.0.0.0"),
    dataDir,
    repoDir: input.repoDir
      || process.env.AIOS_REPO_DIR
      || join(defaultHome, "repo"),
    logsDir,
    uiDir: input.uiDir
      || process.env.AIOS_UI_DIR
      || join(__dirname, "..", "..", "ui", "dist"),
    agentHome: input.agentHome
      || process.env.AIOS_HOME
      || process.env.HOME
      || defaultHome,
    appUser: input.appUser || process.env.AIOS_USER || "aios",
    auth: {
      publicBaseUrl: input.auth?.publicBaseUrl ?? null,
      baseUrlMode: input.auth?.baseUrlMode ?? "auto",
      domain: input.auth?.domain ?? null,
    },
  };
}

const configPath = process.env.AIOS_CONFIG
  || join(process.env.AIOS_DATA_DIR || join(process.cwd(), "data"), "config.json");

export const config = loadOrInitConfig(configPath);

export function saveConfig(next: AiosConfig) {
  mkdirSync(require("path").dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(next, null, 2));
  Object.assign(config, next);
}

export function getConfigPath() {
  return configPath;
}

// Ensure data + logs dirs exist on boot.
for (const dir of [config.dataDir, config.logsDir]) {
  try { mkdirSync(dir, { recursive: true }); } catch {}
}
