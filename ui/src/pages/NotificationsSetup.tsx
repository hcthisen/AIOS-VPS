import React, { useState } from "react";
import { api } from "../api";

export function NotificationsSetup({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [channel, setChannel] = useState<"telegram" | "email" | "none">("telegram");
  const [tg, setTg] = useState({ botToken: "", chatId: "" });
  const [mail, setMail] = useState({ from: "", to: "", smtpHost: "", smtpPort: 587, smtpUser: "", smtpPass: "" });
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const body: any = channel === "telegram" ? { channel, ...tg }
      : channel === "email" ? { channel, ...mail }
      : { channel: "none" };
    try { await api("/api/onboarding/notifications/save", { method: "POST", body: JSON.stringify(body) }); }
    catch (e: any) { setError(e.message); }
  };

  const test = async () => {
    setError(null); setTested(null);
    await save();
    try {
      const r = await api<{ ok: boolean; error?: string }>("/api/onboarding/notifications/test", { method: "POST" });
      setTested(r.ok ? "✓ delivered" : `✗ ${r.error}`);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="card col">
      <h2 style={{ marginTop: 0 }}>Notifications</h2>
      <div className="row">
        <label><input type="radio" checked={channel === "telegram"} onChange={() => setChannel("telegram")} /> Telegram</label>
        <label><input type="radio" checked={channel === "email"} onChange={() => setChannel("email")} /> Email</label>
        <label><input type="radio" checked={channel === "none"} onChange={() => setChannel("none")} /> None</label>
      </div>
      {channel === "telegram" && (
        <div className="col">
          <input placeholder="Bot token" value={tg.botToken} onChange={(e) => setTg({ ...tg, botToken: e.target.value })} />
          <input placeholder="Chat ID" value={tg.chatId} onChange={(e) => setTg({ ...tg, chatId: e.target.value })} />
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
      <div className="row">
        <button onClick={test}>Save & send test</button>
        <button className="primary" onClick={async () => { await save(); await onAdvance(); }}>Finish setup</button>
      </div>
      {tested && <div className={tested.startsWith("✓") ? "badge ok" : "badge err"}>{tested}</div>}
      {error && <div className="badge err">{error}</div>}
    </div>
  );
}
