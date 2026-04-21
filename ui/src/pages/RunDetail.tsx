import React, { useEffect, useRef, useState } from "react";
import { api, apiStream } from "../api";

export function RunDetail({ id, navigate }: { id: string; navigate: (t: string) => void }) {
  const [run, setRun] = useState<any>(null);
  const [text, setText] = useState("");
  const ref = useRef<HTMLPreElement>(null);

  const refresh = async () => {
    const r = await api<{ run: any }>(`/api/runs/${id}`); setRun(r.run);
  };

  useEffect(() => {
    refresh();
    api<string>(`/api/runs/${id}/log`).then(setText).catch(() => {});
    const es = apiStream(`/api/runs/${id}/stream`, {
      onEvent: (event, data) => {
        if (event === "output") setText((t) => t + (data.chunk || ""));
        if (event === "finished" || event === "update") refresh();
      },
    });
    return () => es.close();
  }, [id]);

  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);

  const kill = async () => { await api(`/api/runs/${id}/kill`, { method: "POST" }); refresh(); };

  return (
    <div className="col">
      <a onClick={() => navigate("/runs")} className="small">{"\u2190"} Runs</a>
      <div className="page-header">
        <div>
          <h2>Run <span className="mono">{id}</span></h2>
          {run && (
            <div className="small muted">
              {run.department} \u00b7 {run.trigger} \u00b7 {run.provider || "\u2014"} \u00b7 <span className="badge">{run.status}</span>
              {run.commit_sha && <> \u00b7 commit <code>{run.commit_sha.slice(0, 7)}</code></>}
            </div>
          )}
        </div>
        <div className="page-header-actions">
          {run?.status === "running" && <button className="danger" onClick={kill}>Kill</button>}
        </div>
      </div>
      <pre ref={ref} className="log">{text || "(no output yet)"}</pre>
    </div>
  );
}
