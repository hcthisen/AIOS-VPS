import React, { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { Banner } from "../components/Banner";

type Verify = { domain: string; resolved: boolean; resolvedIps: string[]; expectedIp: string; matches: boolean };

export function VpsDomainSetup({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [net, setNet] = useState<{ ip: string; port: number } | null>(null);
  const [domain, setDomain] = useState("");
  const [verify, setVerify] = useState<Verify | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [ready, setReady] = useState<{ ready: boolean; url?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => { api("/api/vps/network-info").then(setNet).catch(() => {}); return () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
  }; }, []);

  const doVerify = async () => {
    setError(null);
    try { setVerify(await api<Verify>("/api/vps/verify-dns", { method: "POST", body: JSON.stringify({ domain }) })); }
    catch (e: any) { setError(e.message); }
  };

  const doConfigure = async () => {
    setConfiguring(true); setError(null);
    try {
      const r = await api<{ ok: boolean; url: string; nextUrl: string }>(
        "/api/vps/configure-domain",
        { method: "POST", body: JSON.stringify({ domain }) },
      );
      // Poll readiness every 3s.
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await api<{ ready: boolean; url: string }>(`/api/vps/domain-readiness?domain=${encodeURIComponent(domain)}`);
          setReady(s);
          if (s.ready) {
            window.clearInterval(pollRef.current!);
            pollRef.current = null;
            window.location.href = r.nextUrl;
          }
        } catch {}
      }, 3000);
    } catch (e: any) { setError(e.message); setConfiguring(false); }
  };

  const doSkip = async () => {
    await api("/api/vps/skip-domain", { method: "POST" });
    await onAdvance();
  };

  return (
    <Section
      title="Attach a domain (HTTPS via Caddy)"
      description={<>Point an A record at <b className="mono">{net?.ip || "\u2026"}</b>, then configure the domain. Until you do, the dashboard is reachable on <code>{`http://${net?.ip}:${net?.port}`}</code>.</>}
    >
      <div className="row">
        <input placeholder="dashboard.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <button onClick={doVerify} disabled={!domain}>Verify DNS</button>
      </div>
      {verify && (
        <div className="small">
          Resolved: <code>{verify.resolvedIps.join(", ") || "(none)"}</code> \u00b7 Expected: <code>{verify.expectedIp}</code> \u00b7{" "}
          {verify.matches
            ? <span className="badge ok">matches</span>
            : <span className="badge warn">does not match</span>}
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={doConfigure} disabled={!domain || configuring}>
          {configuring ? "Configuring\u2026" : "Configure HTTPS"}
        </button>
        <a className="small muted" onClick={doSkip}>skip (stay on raw IP)</a>
      </div>
      {ready && !ready.ready && <div className="small muted">Waiting for HTTPS to come up at {ready.url}\u2026</div>}
      {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
    </Section>
  );
}
