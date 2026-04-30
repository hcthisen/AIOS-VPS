import React, { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { getActiveCompanySlug } from "../api";

export function TerminalPage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({ convertEol: true, theme: { background: "#000" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const company = getActiveCompanySlug();
    const qs = company ? `?company=${encodeURIComponent(company)}` : "";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/terminal${qs}`);
    ws.onmessage = (e) => { try { const p = JSON.parse(e.data); if (p.t === "data") term.write(p.d); } catch {} };
    const sendData = (d: string) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "data", d }));
    term.onData(sendData);
    term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "resize", cols, rows })));
    const onResize = () => fit.fit();
    const pasteClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        sendData(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
      } catch {
        // Browser clipboard access can be blocked outside a user gesture or
        // insecure context. Native paste still has a chance to work.
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const isPaste = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
      if (!isPaste) return;
      event.preventDefault();
      pasteClipboard();
    };
    window.addEventListener("resize", onResize);
    term.element?.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", onResize);
      term.element?.removeEventListener("keydown", onKeyDown);
      ws.close();
      term.dispose();
    };
  }, []);
  return (
    <div className="col" style={{ height: "calc(100vh - var(--chrome-h) - 48px)" }}>
      <h2 style={{ margin: 0 }}>Terminal</h2>
      <div ref={ref} style={{ flex: 1, background: "#000", borderRadius: 6, minHeight: 0 }} />
    </div>
  );
}
