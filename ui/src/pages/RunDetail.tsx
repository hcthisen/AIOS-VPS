import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, apiStream } from "../api";
import type { StoragePublic } from "./files/types";

export function RunDetail({ id, navigate }: { id: string; navigate: (t: string) => void }) {
  const [run, setRun] = useState<any>(null);
  const [text, setText] = useState("");
  const [storage, setStorage] = useState<StoragePublic | null>(null);
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

  useEffect(() => {
    if (!run?.department) return;
    api<StoragePublic>(`/api/departments/${encodeURIComponent(run.department)}/storage/config`)
      .then(setStorage)
      .catch(() => setStorage(null));
  }, [run?.department]);

  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);

  const kill = async () => { await api(`/api/runs/${id}/kill`, { method: "POST" }); refresh(); };

  const rendered = useMemo(
    () => renderLog(text, run?.department, storage, navigate),
    [text, run?.department, storage],
  );

  return (
    <div className="col">
      <a onClick={() => navigate("/runs")} className="small">{"←"} Runs</a>
      <div className="page-header">
        <div>
          <h2>Run <span className="mono">{id}</span></h2>
          {run && (
            <div className="small muted">
              {run.department} · {run.trigger} · {run.provider || "—"} · <span className="badge">{run.status}</span>
              {run.commit_sha && <> · commit <code>{run.commit_sha.slice(0, 7)}</code></>}
            </div>
          )}
        </div>
        <div className="page-header-actions">
          {run?.status === "running" && <button className="danger" onClick={kill}>Kill</button>}
        </div>
      </div>
      <pre ref={ref} className="log">{rendered}</pre>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>()"']+)/g;
const FILES_HEADING_RE = /^(\s*)(Files produced:)\s*$/im;

function renderLog(
  text: string,
  department: string | undefined,
  storage: StoragePublic | null,
  navigate: (t: string) => void,
): React.ReactNode {
  if (!text) return "(no output yet)";
  const match = FILES_HEADING_RE.exec(text);
  if (!match) return text;
  const headIdx = match.index;
  const before = text.slice(0, headIdx);
  const rest = text.slice(headIdx);
  const lines = rest.split("\n");
  return (
    <>
      {before}
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {renderLine(line, department, storage, navigate)}
          {i < lines.length - 1 ? "\n" : ""}
        </React.Fragment>
      ))}
    </>
  );
}

function renderLine(
  line: string,
  department: string | undefined,
  storage: StoragePublic | null,
  navigate: (t: string) => void,
): React.ReactNode {
  URL_RE.lastIndex = 0;
  const segments: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(line))) {
    if (m.index > lastIdx) segments.push(line.slice(lastIdx, m.index));
    const url = m[0];
    segments.push(<FileLink key={m.index} url={url} department={department} storage={storage} navigate={navigate} />);
    lastIdx = m.index + url.length;
  }
  if (lastIdx < line.length) segments.push(line.slice(lastIdx));
  if (!segments.length) return line;
  return <>{segments}</>;
}

function FileLink({
  url,
  department,
  storage,
  navigate,
}: {
  url: string;
  department: string | undefined;
  storage: StoragePublic | null;
  navigate: (t: string) => void;
}) {
  const ref = toFilesHref(url, department, storage);
  if (!ref) {
    return <a href={url} target="_blank" rel="noreferrer" className="log-files-link">{url}</a>;
  }
  return (
    <span
      className="log-files-link"
      onClick={(e) => {
        e.preventDefault();
        navigate(ref);
      }}
    >
      {url}
    </span>
  );
}

function toFilesHref(url: string, department: string | undefined, storage: StoragePublic | null): string | null {
  if (!department || !storage?.configured) return null;
  const base = storage.publicBaseUrl?.replace(/\/+$/, "");
  if (!base || !url.startsWith(base + "/")) return null;
  const keyTail = url.slice(base.length + 1);
  const slash = keyTail.lastIndexOf("/");
  const prefix = slash >= 0 ? keyTail.slice(0, slash + 1) : "";
  const basename = slash >= 0 ? keyTail.slice(slash + 1) : keyTail;
  const params = new URLSearchParams({ tab: "files", visibility: "public" });
  if (prefix) params.set("prefix", prefix);
  if (basename) params.set("highlight", basename);
  return `/departments/${encodeURIComponent(department)}?${params.toString()}`;
}
