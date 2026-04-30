import { db, kvGet, kvSet } from "../db";
import { getCurrentCompanyId, withCompanyContext } from "../company-context";
import { log } from "../log";
import { getClaim } from "./claims";
import { Provider, ProviderConversationResult, killRun, startRun } from "./executor";
import { getNotificationConfig, getTelegramPairingState, pickTelegramMessage, sendTelegramMessage, TelegramUpdate } from "./notifications";
import { displayProvider, getProviderAvailability, isProviderAuthorized } from "./providerAvailability";
import { getRun, runEvents, Run } from "./runs";
import { listCompanies } from "./companies";

type TelegramAgentMessageStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

interface TelegramAgentConfig {
  enabled: boolean;
  provider: Provider;
  sessionId: string | null;
  offset: number | null;
  resetGeneration: number;
  updatedAt: number;
}

export interface TelegramAgentMessage {
  id: number;
  update_id: number;
  chat_id: string;
  text: string;
  status: TelegramAgentMessageStatus;
  run_id: string | null;
  provider: Provider | null;
  session_id: string | null;
  received_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

const CONFIG_KEY = "telegram.rootAgent.config";
const DEFAULT_CONFIG: TelegramAgentConfig = {
  enabled: false,
  provider: "claude-code",
  sessionId: null,
  offset: null,
  resetGeneration: 0,
  updatedAt: 0,
};

let pollTimer: NodeJS.Timeout | null = null;
let dispatching = false;

function scopedKey(key: string): string {
  return `company.${getCurrentCompanyId()}.${key}`;
}

export function getTelegramAgentConfig(): TelegramAgentConfig {
  const raw = kvGet(scopedKey(CONFIG_KEY)) || (getCurrentCompanyId() === 1 ? kvGet(CONFIG_KEY) : null);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw);
    const provider = parsed?.provider === "codex" ? "codex" : "claude-code";
    return {
      enabled: !!parsed?.enabled,
      provider,
      sessionId: typeof parsed?.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId : null,
      offset: Number.isFinite(parsed?.offset) ? Number(parsed.offset) : null,
      resetGeneration: Number.isFinite(parsed?.resetGeneration) ? Number(parsed.resetGeneration) : 0,
      updatedAt: Number.isFinite(parsed?.updatedAt) ? Number(parsed.updatedAt) : 0,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function setTelegramAgentConfig(config: TelegramAgentConfig) {
  kvSet(scopedKey(CONFIG_KEY), JSON.stringify({ ...config, updatedAt: Date.now() }));
}

export async function saveTelegramAgentConfig(input: { enabled?: boolean; provider?: Provider }) {
  const current = await normalizeTelegramAgentProvider(getTelegramAgentConfig());
  const nextProvider = input.provider || current.provider;
  if (input.provider && !(await isProviderAuthorized(input.provider))) {
    throw new Error(`${displayProvider(input.provider)} is not authorized`);
  }
  if (input.enabled === true && !(await isProviderAuthorized(nextProvider))) {
    throw new Error(`${displayProvider(nextProvider)} is not authorized`);
  }
  const providerChanged = nextProvider !== current.provider;
  const next: TelegramAgentConfig = {
    ...current,
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    provider: nextProvider,
    sessionId: providerChanged ? null : current.sessionId,
    resetGeneration: providerChanged ? current.resetGeneration + 1 : current.resetGeneration,
  };
  setTelegramAgentConfig(next);
  return getTelegramAgentStatus();
}

export async function getTelegramAgentStatus() {
  const config = await normalizeTelegramAgentProvider(getTelegramAgentConfig());
  const notification = getNotificationConfig();
  const pairing = getTelegramPairingState();
  const chatId = notification.channel === "telegram" ? notification.chatId || null : null;
  const queued = countMessages("queued");
  const running = countMessages("running");
  const active = getActiveTelegramRun();
  const providers = await getProviderAvailability();
  return {
    enabled: config.enabled,
    provider: config.provider,
    providerAuthorized: providers[config.provider],
    providers: {
      claudeCode: { authorized: providers["claude-code"] },
      codex: { authorized: providers.codex },
    },
    sessionId: config.sessionId,
    paired: !!chatId,
    chatId,
    botUsername: pairing?.botUsername || null,
    queued,
    running,
    activeRunId: active?.id || null,
    resetGeneration: config.resetGeneration,
  };
}

export function resetTelegramAgentSession(): { killed: number; canceled: number; sessionId: null } {
  const current = getTelegramAgentConfig();
  const runIds = activeTelegramRunIds();
  let killed = 0;
  for (const runId of runIds) {
    if (killRun(runId)) killed += 1;
  }
  const canceled = db.prepare(`
    UPDATE telegram_agent_messages
    SET status = 'canceled', finished_at = ?, error = 'session reset from dashboard'
    WHERE company_id = ? AND status IN ('queued', 'running')
  `).run(Date.now(), getCurrentCompanyId()).changes;
  setTelegramAgentConfig({
    ...current,
    sessionId: null,
    resetGeneration: current.resetGeneration + 1,
  });
  return { killed, canceled: Number(canceled), sessionId: null };
}

export function enqueueTelegramAgentMessage(input: { updateId: number; chatId: string; text: string }): boolean {
  const text = input.text.trim();
  if (!text) return false;
  const result = db.prepare(`
    INSERT OR IGNORE INTO telegram_agent_messages(company_id, update_id, chat_id, text, status, received_at)
    VALUES(?, ?, ?, ?, 'queued', ?)
  `).run(getCurrentCompanyId(), input.updateId, input.chatId, text, Date.now());
  return result.changes > 0;
}

export function buildTelegramRootPrompt(messages: TelegramAgentMessage[]): string {
  const body = messages
    .map((message, index) => `Message ${index + 1} (${new Date(message.received_at).toISOString()}):\n${message.text}`)
    .join("\n\n");
  return [
    "You were woken up because the owner sent a Telegram chat message to the AIOS Root agent.",
    "You are running from the AIOS repository root and should inspect root files and department folders directly when needed.",
    "For cross-department questions, read the relevant department folders such as */goals/, */cron/, and aios.yaml before answering.",
    "Do not claim you lack workspace or department access unless an actual tool/file operation fails; if it fails, include the exact error briefly.",
    "Reply directly to the owner in a Telegram-friendly chat style: concise, useful, and conversational.",
    "Do not dump raw logs unless the owner explicitly asks for them. If you changed files or started work, summarize the outcome and any next step.",
    "",
    "Message from owner via Telegram:",
    body,
    "",
  ].join("\n");
}

export function startTelegramAgent() {
  if (pollTimer) return;
  for (const company of listCompanies().filter((entry) => entry.setupPhase === "complete")) {
    withCompanyContext(company, () => recoverInterruptedMessages());
  }
  scheduleDispatch(500);
}

export function stopTelegramAgent() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function scheduleDispatch(delayMs: number) {
  pollTimer = setTimeout(() => {
    void dispatchLoop();
  }, delayMs);
  pollTimer.unref?.();
}

async function dispatchLoop() {
  try {
    for (const company of listCompanies().filter((entry) => entry.setupPhase === "complete")) {
      await withCompanyContext(company, async () => {
        await dispatchTelegramAgentQueue();
      });
    }
    scheduleDispatch(2_000);
  } catch (e: any) {
    log.warn("telegram root agent dispatch failed", e?.message || e);
    scheduleDispatch(5_000);
  }
}

export async function processTelegramAgentUpdates(updates: TelegramUpdate[]) {
  const agentConfig = getTelegramAgentConfig();
  const notification = getNotificationConfig();
  if (!agentConfig.enabled || notification.channel !== "telegram" || !notification.chatId) return;
  for (const update of updates) {
    const message = pickTelegramMessage(update);
    const chatId = message?.chat?.id ? String(message.chat.id) : "";
    if (chatId !== String(notification.chatId)) continue;
    const text = typeof message?.text === "string"
      ? message.text
      : typeof message?.caption === "string"
        ? message.caption
        : "";
    enqueueTelegramAgentMessage({ updateId: update.update_id, chatId, text });
  }
}

export async function dispatchTelegramAgentQueue() {
  if (dispatching) return;
  dispatching = true;
  try {
    while (true) {
      const config = getTelegramAgentConfig();
      const notification = getNotificationConfig();
      if (!config.enabled || notification.channel !== "telegram" || !notification.chatId) return;
      if (getClaim("_root")) return;

      const messages = queuedMessages();
      if (!messages.length) return;

      const generation = config.resetGeneration;
      if (!(await isProviderAuthorized(config.provider))) {
        markMessagesFinished(messages, "failed", config.sessionId, `${displayProvider(config.provider)} is not authorized`);
        await sendTelegramReply(notification.chatId, `${displayProvider(config.provider)} is not authorized in AIOS. Open Settings and connect or select an authorized operator.`);
        return;
      }
      const prompt = buildTelegramRootPrompt(messages);
      const result = await startRun({
        departments: ["_root"],
        trigger: "telegram:root",
        prompt,
        provider: config.provider,
        queueIfBusy: false,
        conversation: {
          source: "telegram",
          sessionId: config.sessionId,
        },
      });

      if (!result.accepted) return;

      markMessagesRunning(messages, result.run.id, config.provider, config.sessionId);
      const finished = await waitForRunFinished(result.run.id);
      const latest = getTelegramAgentConfig();
      if (latest.resetGeneration !== generation) return;

      const run = finished.run;
      const conversation = finished.conversation;
      if (run.status === "succeeded" && conversation?.sessionId) {
        setTelegramAgentConfig({ ...latest, sessionId: conversation.sessionId });
      }

      if (run.status === "succeeded") {
        markMessagesFinished(messages, "succeeded", conversation?.sessionId || latest.sessionId, null);
        await sendTelegramReply(notification.chatId, conversation?.finalMessage || "Done.");
      } else {
        const error = run.error || `run ${run.status}`;
        markMessagesFinished(messages, "failed", latest.sessionId, error);
        await sendTelegramReply(notification.chatId, `The Root agent did not finish successfully: ${error}`);
      }
    }
  } finally {
    dispatching = false;
  }
}

async function normalizeTelegramAgentProvider(config: TelegramAgentConfig): Promise<TelegramAgentConfig> {
  const providers = await getProviderAvailability();
  if (providers[config.provider]) return config;
  const fallback: Provider | null = providers.codex ? "codex" : providers["claude-code"] ? "claude-code" : null;
  if (!fallback) return config;
  const next = {
    ...config,
    provider: fallback,
    sessionId: null,
    resetGeneration: config.resetGeneration + 1,
  };
  setTelegramAgentConfig(next);
  return next;
}

function queuedMessages(): TelegramAgentMessage[] {
  return db.prepare(`
    SELECT * FROM telegram_agent_messages
    WHERE company_id = ? AND status = 'queued'
    ORDER BY id ASC
  `).all(getCurrentCompanyId()) as TelegramAgentMessage[];
}

function markMessagesRunning(messages: TelegramAgentMessage[], runId: string, provider: Provider, sessionId: string | null) {
  const ids = messages.map((message) => message.id);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`
    UPDATE telegram_agent_messages
    SET status = 'running', run_id = ?, provider = ?, session_id = ?, started_at = ?
    WHERE company_id = ? AND id IN (${placeholders})
  `).run(runId, provider, sessionId, Date.now(), getCurrentCompanyId(), ...ids);
}

function markMessagesFinished(messages: TelegramAgentMessage[], status: "succeeded" | "failed", sessionId: string | null, error: string | null) {
  const ids = messages.map((message) => message.id);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`
    UPDATE telegram_agent_messages
    SET status = ?, session_id = ?, finished_at = ?, error = ?
    WHERE company_id = ? AND id IN (${placeholders})
  `).run(status, sessionId, Date.now(), error, getCurrentCompanyId(), ...ids);
}

function countMessages(status: TelegramAgentMessageStatus): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM telegram_agent_messages WHERE company_id = ? AND status = ?").get(getCurrentCompanyId(), status) as { count: number };
  return Number(row.count || 0);
}

function activeTelegramRunIds(): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT run_id AS runId FROM telegram_agent_messages
    WHERE company_id = ? AND status = 'running' AND run_id IS NOT NULL
  `).all(getCurrentCompanyId()) as Array<{ runId: string }>;
  return rows.map((row) => row.runId).filter(Boolean);
}

function getActiveTelegramRun(): Run | null {
  for (const runId of activeTelegramRunIds()) {
    const run = getRun(runId);
    if (run && (run.status === "running" || run.status === "queued")) return run;
  }
  return null;
}

function recoverInterruptedMessages() {
  db.prepare(`
    UPDATE telegram_agent_messages
    SET status = 'queued', run_id = NULL, started_at = NULL, error = 'recovered after server restart'
    WHERE company_id = ? AND status = 'running'
  `).run(getCurrentCompanyId());
}

function waitForRunFinished(runId: string): Promise<{ run: Run; conversation: ProviderConversationResult | null }> {
  const existing = getRun(runId);
  if (existing && !["queued", "running"].includes(existing.status)) {
    return Promise.resolve({ run: existing, conversation: null });
  }
  return new Promise((resolve) => {
    const onFinished = (payload: any) => {
      if (payload?.runId !== runId) return;
      runEvents.off("run.finished", onFinished);
      resolve({
        run: getRun(runId)!,
        conversation: payload.conversation || null,
      });
    };
    runEvents.on("run.finished", onFinished);
  });
}

async function sendTelegramReply(chatId: string, text: string) {
  const chunks = splitTelegramMessage(text);
  for (const chunk of chunks) {
    const sent = await sendTelegramMessage(chatId, chunk);
    if (!sent.ok) {
      log.warn("telegram root agent reply failed", sent.error || "unknown error");
      return;
    }
  }
}

function splitTelegramMessage(text: string): string[] {
  const clean = text.trim() || "Done.";
  const max = 3900;
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += max) {
    chunks.push(clean.slice(i, i + max));
  }
  return chunks;
}
