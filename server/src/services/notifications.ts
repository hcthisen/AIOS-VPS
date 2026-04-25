import { createTransport, Transporter } from "nodemailer";
import { kvGet, kvSet } from "../db";
import { log } from "../log";

export type NotificationConfig =
  | { channel: "telegram"; botToken: string; chatId?: string | null }
  | { channel: "email"; from: string; to: string; smtpHost: string; smtpPort: number; smtpUser?: string; smtpPass?: string; secure?: boolean }
  | { channel: "none" };

export interface TelegramPairingCandidate {
  chatId: string;
  chatType: string;
  displayName: string;
  username?: string;
  senderName?: string;
  lastMessage?: string;
  seenAt: number;
}

export interface TelegramPairingState {
  botToken: string;
  botName?: string;
  botUsername?: string;
  candidates: TelegramPairingCandidate[];
  offset: number;
  updatedAt: number;
}

const KEY = "notifications.config";
const TELEGRAM_PAIRING_KEY = "notifications.telegram.pairing";

export function setNotificationConfig(c: NotificationConfig) {
  kvSet(KEY, JSON.stringify(c));
}

export function getNotificationConfig(): NotificationConfig {
  const raw = kvGet(KEY);
  if (!raw) return { channel: "none" };
  try {
    return JSON.parse(raw);
  } catch {
    return { channel: "none" };
  }
}

export function setTelegramPairingState(state: TelegramPairingState) {
  kvSet(TELEGRAM_PAIRING_KEY, JSON.stringify(state));
}

export function getTelegramPairingState(): TelegramPairingState | null {
  const raw = kvGet(TELEGRAM_PAIRING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface TelegramBotProfile {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: any;
  edited_message?: any;
  channel_post?: any;
  edited_channel_post?: any;
}

export async function telegramApi<T>(botToken: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {}

  if (!response.ok || payload?.ok !== true) {
    const detail = payload?.description || `${method} failed`;
    throw new Error(detail);
  }

  return payload.result as T;
}

export function pickTelegramMessage(update: TelegramUpdate): any | null {
  return update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
}

function trimPreview(value: string | undefined, max = 80): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

function joinName(parts: Array<string | undefined>): string | undefined {
  const value = parts.filter(Boolean).join(" ").trim();
  return value || undefined;
}

function describeTelegramCandidate(update: TelegramUpdate): TelegramPairingCandidate | null {
  const message = pickTelegramMessage(update);
  const chat = message?.chat;
  if (!chat?.id) return null;

  const chatType = String(chat.type || "unknown");
  const username = typeof chat.username === "string" && chat.username.trim()
    ? chat.username.trim()
    : typeof message?.from?.username === "string" && message.from.username.trim()
      ? message.from.username.trim()
      : undefined;

  const displayName = chatType === "private"
    ? joinName([message?.from?.first_name, message?.from?.last_name])
      || joinName([chat.first_name, chat.last_name])
      || username
      || `Chat ${chat.id}`
    : String(chat.title || username || `Chat ${chat.id}`);

  const senderName = chatType === "private"
    ? undefined
    : joinName([message?.from?.first_name, message?.from?.last_name])
      || (typeof message?.from?.username === "string" ? message.from.username : undefined);

  const lastMessage = trimPreview(
    typeof message?.text === "string"
      ? message.text
      : typeof message?.caption === "string"
        ? message.caption
        : undefined,
  );

  return {
    chatId: String(chat.id),
    chatType,
    displayName,
    username,
    senderName,
    lastMessage,
    seenAt: Date.now(),
  };
}

function mergeTelegramCandidates(
  existing: TelegramPairingCandidate[],
  incoming: TelegramPairingCandidate[],
): TelegramPairingCandidate[] {
  const merged = new Map<string, TelegramPairingCandidate>();
  for (const candidate of existing) {
    merged.set(candidate.chatId, candidate);
  }
  for (const candidate of incoming) {
    const previous = merged.get(candidate.chatId);
    merged.set(candidate.chatId, {
      ...previous,
      ...candidate,
      seenAt: Math.max(previous?.seenAt || 0, candidate.seenAt),
    });
  }
  return [...merged.values()].sort((a, b) => b.seenAt - a.seenAt);
}

export async function primeTelegramPairing(botToken: string): Promise<{ botName?: string; botUsername?: string }> {
  const profile = await telegramApi<TelegramBotProfile>(botToken, "getMe");
  const existing = getTelegramPairingState();
  setTelegramPairingState({
    botToken,
    botName: profile.first_name,
    botUsername: profile.username,
    candidates: existing?.botToken === botToken ? existing.candidates : [],
    offset: existing?.botToken === botToken ? existing.offset : 0,
    updatedAt: Date.now(),
  });
  return { botName: profile.first_name, botUsername: profile.username };
}

export function recordTelegramPairingUpdates(botToken: string, updates: TelegramUpdate[]): TelegramPairingState | null {
  const state = getTelegramPairingState();
  if (!state || state.botToken !== botToken) return state;
  const candidates = updates
    .map(describeTelegramCandidate)
    .filter((candidate): candidate is TelegramPairingCandidate => !!candidate);
  const nextOffset = updates.reduce((max, update) => Math.max(max, update.update_id + 1), state.offset);
  const next = {
    ...state,
    candidates: mergeTelegramCandidates(state.candidates, candidates),
    offset: nextOffset,
    updatedAt: Date.now(),
  };
  setTelegramPairingState(next);
  return next;
}

export function getTelegramPairingSnapshot(): {
  botName?: string;
  botUsername?: string;
  candidates: TelegramPairingCandidate[];
  pairedChatId: string | null;
} {
  const config = getNotificationConfig();
  if (config.channel !== "telegram" || !config.botToken) {
    throw new Error("save a Telegram bot token first");
  }

  const state = getTelegramPairingState();
  if (!state) {
    throw new Error("Telegram pairing is not initialized");
  }

  return {
    botName: state.botName,
    botUsername: state.botUsername,
    candidates: state.candidates,
    pairedChatId: config.chatId || null,
  };
}

export async function syncTelegramPairing(): Promise<{
  botName?: string;
  botUsername?: string;
  candidates: TelegramPairingCandidate[];
  pairedChatId: string | null;
}> {
  const config = getNotificationConfig();
  if (config.channel !== "telegram" || !config.botToken) {
    throw new Error("save a Telegram bot token first");
  }
  let state = getTelegramPairingState();
  if (!state || state.botToken !== config.botToken) {
    await primeTelegramPairing(config.botToken);
  }
  return getTelegramPairingSnapshot();
}

export function approveTelegramPairing(chatId: string): TelegramPairingCandidate {
  const config = getNotificationConfig();
  if (config.channel !== "telegram" || !config.botToken) {
    throw new Error("save a Telegram bot token first");
  }

  const state = getTelegramPairingState();
  const candidate = state?.candidates.find((entry) => entry.chatId === chatId);
  if (!candidate) {
    throw new Error("chat not found; send a fresh message to the bot and try again");
  }

  setNotificationConfig({ channel: "telegram", botToken: config.botToken, chatId });
  return candidate;
}

export async function sendNotification(message: string, subject = "AIOS"): Promise<{ ok: boolean; error?: string }> {
  const config = getNotificationConfig();
  if (config.channel === "none") return { ok: true };
  if (config.channel === "telegram") return sendTelegram(config, message);
  if (config.channel === "email") return sendEmail(config, subject, message);
  return { ok: false, error: "unknown notification channel" };
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const config = getNotificationConfig();
  if (config.channel !== "telegram" || !config.botToken) {
    return { ok: false, error: "Telegram notifications are not configured" };
  }
  return sendTelegram({ ...config, chatId }, text);
}

async function sendTelegram(
  config: Extract<NotificationConfig, { channel: "telegram" }>,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!config.chatId) {
    return { ok: false, error: "approve a Telegram chat first" };
  }
  try {
    await telegramApi(config.botToken, "sendMessage", {
      chat_id: config.chatId,
      text,
      disable_web_page_preview: true,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function sendEmail(
  config: Extract<NotificationConfig, { channel: "email" }>,
  subject: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const transport: Transporter = createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.secure ?? config.smtpPort === 465,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass || "" } : undefined,
    } as any);
    await transport.sendMail({ from: config.from, to: config.to, subject, text });
    return { ok: true };
  } catch (e: any) {
    log.warn("email send failed:", e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
