import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { Banner } from "../components/Banner";

type Channel = "telegram" | "email" | "none";

interface TelegramPairingCandidate {
  chatId: string;
  chatType: string;
  displayName: string;
  username?: string;
  senderName?: string;
  lastMessage?: string;
  seenAt: number;
}

interface TelegramPairingResponse {
  ok: boolean;
  botName?: string;
  botUsername?: string;
  candidates: TelegramPairingCandidate[];
  pairedChatId: string | null;
}

type NotificationConfig =
  | { channel: "telegram"; chatId: string | null; paired: boolean; botName?: string; botUsername?: string }
  | { channel: "email"; from: string; to: string; smtpHost: string; smtpPort: number; smtpUser?: string; secure?: boolean }
  | { channel: "none" };

export function NotificationsSetup({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [channel, setChannel] = useState<Channel>("telegram");
  const [tg, setTg] = useState({ botToken: "" });
  const [mail, setMail] = useState({ from: "", to: "", smtpHost: "", smtpPort: 587, smtpUser: "", smtpPass: "" });
  const [telegramReady, setTelegramReady] = useState(false);
  const [pairing, setPairing] = useState<TelegramPairingResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [approvingChatId, setApprovingChatId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  const pairedCandidate = useMemo(
    () => pairing?.candidates.find((candidate) => candidate.chatId === pairing.pairedChatId) || null,
    [pairing],
  );

  async function loadConfig() {
    const config = await api<NotificationConfig>("/api/onboarding/notifications/config").catch(() => ({ channel: "telegram", chatId: null, paired: false } as NotificationConfig));
    if (config.channel === "telegram") {
      setChannel("telegram");
      setTelegramReady(true);
      setPairing((previous) => ({
        ok: true,
        botName: config.botName,
        botUsername: config.botUsername,
        candidates: previous?.candidates || [],
        pairedChatId: config.chatId,
      }));
    } else if (config.channel === "email") {
      setChannel("email");
      setMail({
        from: config.from || "",
        to: config.to || "",
        smtpHost: config.smtpHost || "",
        smtpPort: Number(config.smtpPort) || 587,
        smtpUser: config.smtpUser || "",
        smtpPass: "",
      });
      setTelegramReady(false);
      setPairing(null);
    } else {
      setChannel("telegram");
      setTelegramReady(false);
      setPairing(null);
    }
  }

  useEffect(() => {
    loadConfig().catch(() => {});
  }, []);

  useEffect(() => {
    if (channel !== "telegram" || !telegramReady) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await api<TelegramPairingResponse>("/api/onboarding/notifications/telegram/pairing");
        if (!cancelled) {
          setPairing(next);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message);
        }
      }
    };

    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [channel, telegramReady]);

  const saveTelegramBotToken = async () => {
    setSaving(true);
    setError(null);
    setTested(null);
    try {
      const response = await api<{ ok: boolean; botName?: string; botUsername?: string }>("/api/onboarding/notifications/save", {
        method: "POST",
        body: JSON.stringify({ channel: "telegram", botToken: tg.botToken }),
      });
      setTelegramReady(true);
      setPairing({
        ok: true,
        botName: response.botName,
        botUsername: response.botUsername,
        candidates: [],
        pairedChatId: null,
      });
      setTg({ botToken: "" });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveEmail = async () => {
    await api("/api/onboarding/notifications/save", {
      method: "POST",
      body: JSON.stringify({ channel: "email", ...mail }),
    });
  };

  const saveNone = async () => {
    await api("/api/onboarding/notifications/save", {
      method: "POST",
      body: JSON.stringify({ channel: "none" }),
    });
  };

  const approveCandidate = async (chatId: string) => {
    setApprovingChatId(chatId);
    setError(null);
    setTested(null);
    try {
      await api("/api/onboarding/notifications/telegram/approve", {
        method: "POST",
        body: JSON.stringify({ chatId }),
      });
      const next = await api<TelegramPairingResponse>("/api/onboarding/notifications/telegram/pairing");
      setPairing(next);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setApprovingChatId(null);
    }
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    setTested(null);
    try {
      if (channel === "telegram" && !pairing?.pairedChatId) {
        throw new Error("Approve a Telegram chat first.");
      }
      if (channel === "email") {
        await saveEmail();
      } else if (channel === "none") {
        await saveNone();
      }
      const response = await api<{ ok: boolean; error?: string }>("/api/onboarding/notifications/test", { method: "POST" });
      setTested(response.ok ? "delivered" : response.error || "delivery failed");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTesting(false);
    }
  };

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      if (channel === "telegram") {
        if (!telegramReady) {
          throw new Error("Save the Telegram bot token first.");
        }
        if (!pairing?.pairedChatId) {
          throw new Error("Approve a Telegram chat before finishing setup.");
        }
      } else if (channel === "email") {
        await saveEmail();
      } else {
        await saveNone();
      }
      await onAdvance();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setFinishing(false);
    }
  };

  return (
    <Section title="Notifications">
      <div className="row">
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={channel === "telegram"} onChange={() => setChannel("telegram")} style={{ width: "auto", minHeight: 0 }} /> Telegram
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={channel === "email"} onChange={() => setChannel("email")} style={{ width: "auto", minHeight: 0 }} /> Email
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={channel === "none"} onChange={() => setChannel("none")} style={{ width: "auto", minHeight: 0 }} /> None
        </label>
      </div>

      {channel === "telegram" && (
        <div className="col">
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <input
                placeholder="Bot token"
                type="password"
                value={tg.botToken}
                onChange={(e) => setTg({ botToken: e.target.value })}
              />
            </div>
            <button onClick={saveTelegramBotToken} disabled={saving || !tg.botToken.trim()}>
              {saving ? "Saving..." : "Save bot token"}
            </button>
          </div>

          {telegramReady && (
            <div className="col" style={{ gap: 10 }}>
              <div className="small muted">
                {pairing?.botUsername
                  ? <>Send a message to <code>@{pairing.botUsername}</code> in Telegram. This page will list chats that contact the bot.</>
                  : <>Send a message to the bot in Telegram. This page will list chats that contact the bot.</>}
              </div>

              {pairing?.pairedChatId && (
                <div className="badge ok">
                  Paired with {pairedCandidate?.displayName || pairing.pairedChatId}
                </div>
              )}

              <div className="col" style={{ gap: 8 }}>
                {(pairing?.candidates || []).length === 0 && (
                  <div className="small muted">Waiting for a Telegram message...</div>
                )}
                {(pairing?.candidates || []).map((candidate) => {
                  const approved = candidate.chatId === pairing?.pairedChatId;
                  return (
                    <div key={candidate.chatId} className="candidate-card">
                      <div className="col" style={{ gap: 4 }}>
                        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                          <strong>{candidate.displayName}</strong>
                          <span className="badge">{candidate.chatType}</span>
                          {candidate.username && <span className="small muted">@{candidate.username}</span>}
                        </div>
                        {candidate.senderName && <div className="small muted">Sender: {candidate.senderName}</div>}
                        {candidate.lastMessage && <div className="small muted">Latest: {candidate.lastMessage}</div>}
                      </div>
                      <button
                        className={approved ? "primary" : ""}
                        disabled={approved || approvingChatId === candidate.chatId}
                        onClick={() => approveCandidate(candidate.chatId)}
                      >
                        {approved ? "Approved" : approvingChatId === candidate.chatId ? "Approving..." : "Approve"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {channel === "email" && (
        <div className="col">
          <input placeholder="From" value={mail.from} onChange={(e) => setMail({ ...mail, from: e.target.value })} />
          <input placeholder="To" value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} />
          <input placeholder="SMTP host" value={mail.smtpHost} onChange={(e) => setMail({ ...mail, smtpHost: e.target.value })} />
          <input placeholder="SMTP port" value={mail.smtpPort} type="number" onChange={(e) => setMail({ ...mail, smtpPort: Number(e.target.value) })} />
          <input placeholder="SMTP user (optional)" value={mail.smtpUser} onChange={(e) => setMail({ ...mail, smtpUser: e.target.value })} />
          <input placeholder="SMTP pass (optional)" type="password" value={mail.smtpPass} onChange={(e) => setMail({ ...mail, smtpPass: e.target.value })} />
        </div>
      )}

      {channel === "none" && (
        <div className="small muted">Notifications are disabled. You can configure them later in onboarding.</div>
      )}

      <div className="row">
        <button onClick={test} disabled={testing || (channel === "telegram" && !pairing?.pairedChatId)}>
          {testing ? "Sending..." : "Send test"}
        </button>
        <button className="primary" onClick={finish} disabled={finishing}>
          {finishing ? "Finishing..." : "Finish setup"}
        </button>
      </div>

      {tested && <Banner kind="ok" onDismiss={() => setTested(null)}>{tested}</Banner>}
      {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
    </Section>
  );
}
