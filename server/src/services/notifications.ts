// Notifications: Telegram or SMTP. Config stored in kv; tested via POST /test.

import { createTransport, Transporter } from "nodemailer";
import { kvGet, kvSet } from "../db";
import { log } from "../log";

export type NotificationConfig =
  | { channel: "telegram"; botToken: string; chatId: string }
  | { channel: "email";    from: string; to: string; smtpHost: string; smtpPort: number; smtpUser?: string; smtpPass?: string; secure?: boolean }
  | { channel: "none" };

const KEY = "notifications.config";

export function setNotificationConfig(c: NotificationConfig) { kvSet(KEY, JSON.stringify(c)); }
export function getNotificationConfig(): NotificationConfig {
  const raw = kvGet(KEY);
  if (!raw) return { channel: "none" };
  try { return JSON.parse(raw); } catch { return { channel: "none" }; }
}

export async function sendNotification(message: string, subject = "AIOS"): Promise<{ ok: boolean; error?: string }> {
  const c = getNotificationConfig();
  if (c.channel === "none") return { ok: true };
  if (c.channel === "telegram") return sendTelegram(c, message);
  if (c.channel === "email") return sendEmail(c, subject, message);
  return { ok: false, error: "unknown notification channel" };
}

async function sendTelegram(c: Extract<NotificationConfig, { channel: "telegram" }>, text: string) {
  try {
    const url = `https://api.telegram.org/bot${c.botToken}/sendMessage`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: c.chatId, text, disable_web_page_preview: true }),
    });
    if (!r.ok) return { ok: false, error: `telegram ${r.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function sendEmail(c: Extract<NotificationConfig, { channel: "email" }>, subject: string, text: string) {
  try {
    const transport: Transporter = createTransport({
      host: c.smtpHost,
      port: c.smtpPort,
      secure: c.secure ?? c.smtpPort === 465,
      auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass || "" } : undefined,
    } as any);
    await transport.sendMail({ from: c.from, to: c.to, subject, text });
    return { ok: true };
  } catch (e: any) {
    log.warn("email send failed:", e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
