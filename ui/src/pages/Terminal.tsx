import React, { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

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
    const ws = new WebSocket(`${proto}//${window.location.host}/api/terminal`);
    ws.onmessage = (e) => { try { const p = JSON.parse(e.data); if (p.t === "data") term.write(p.d); } catch {} };
    term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "data", d })));
    term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "resize", cols, rows })));
    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); ws.close(); term.dispose(); };
  }, []);
  return (
    <div className="col" style={{ height: "calc(100vh - 48px)" }}>
      <h2 style={{ margin: 0 }}>Terminal</h2>
      <div ref={ref} style={{ flex: 1, background: "#000", borderRadius: 6 }} />
    </div>
  );
}
