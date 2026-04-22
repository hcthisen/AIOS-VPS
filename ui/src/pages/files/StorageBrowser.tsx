import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, getCsrf } from "../../api";
import { Banner } from "../../components/Banner";
import { Drawer } from "../../components/Drawer";
import { IconButton } from "../../components/IconButton";
import { FileEntry, ListResponse, StoragePublic, Visibility } from "./types";
import { StorageSetup, defaultFormState } from "./StorageSetup";

interface Props {
  deptName: string;
  existing: StoragePublic;
  visibility: Visibility;
  subPrefix: string;
  highlight?: string;
  onVisibility: (v: Visibility) => void;
  onNavigate: (subPrefix: string) => void;
  onChanged: () => void;
  onDisconnect: () => void;
}

type SortKey = "name" | "size" | "date";

export function StorageBrowser(props: Props) {
  const { deptName, existing, visibility, subPrefix, highlight, onVisibility, onNavigate, onChanged, onDisconnect } = props;
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);

  const root = visibility === "public" ? existing.publicPrefix : existing.privatePrefix;
  const uploadRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("visibility", visibility);
      if (subPrefix) params.set("prefix", subPrefix);
      params.set("sort", sort);
      params.set("order", order);
      const r = await api<ListResponse>(
        `/api/departments/${encodeURIComponent(deptName)}/storage/objects?${params.toString()}`,
      );
      setData(r);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, [deptName, visibility, subPrefix, sort, order]);

  const filtered = useMemo(() => {
    if (!data) return [] as FileEntry[];
    if (!search.trim()) return data.files;
    const q = search.toLowerCase();
    return data.files.filter((f) => f.name.toLowerCase().includes(q));
  }, [data, search]);

  const breadcrumb = useMemo(() => buildBreadcrumb(root, subPrefix), [root, subPrefix]);

  const handleDelete = async (f: FileEntry) => {
    if (!window.confirm(`Delete ${f.name}? This removes the object from the bucket.`)) return;
    try {
      await api(
        `/api/departments/${encodeURIComponent(deptName)}/storage/objects?key=${encodeURIComponent(f.key)}`,
        { method: "DELETE" },
      );
      setNotice(`Deleted ${f.name}.`);
      await refresh();
      onChanged();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const handleCopyUrl = async (f: FileEntry) => {
    try {
      const wantsPublicUrl = visibility === "public" && !!existing.publicBaseUrl;
      const mode = wantsPublicUrl ? "public" : "signed";
      const ttl = mode === "signed" ? 3600 : undefined;
      const params = new URLSearchParams({ key: f.key, mode });
      if (ttl) params.set("ttl", String(ttl));
      const r = await api<{ url: string; mode: string; expiresIn?: number }>(
        `/api/departments/${encodeURIComponent(deptName)}/storage/objects/url?${params.toString()}`,
      );
      await navigator.clipboard.writeText(r.url);
      setNotice(
        r.mode === "signed"
          ? `Signed URL copied (expires in ${Math.round((r.expiresIn || 0) / 60)} min).`
          : "Public URL copied.",
      );
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm("Disconnect storage? Bucket contents are not affected.")) return;
    try {
      await api(
        `/api/departments/${encodeURIComponent(deptName)}/storage/config`,
        { method: "DELETE" },
      );
      onDisconnect();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const handleReset = async () => {
    if (!window.confirm("Reset the CLAUDE.md File storage section to defaults? Your customizations will be overwritten.")) return;
    try {
      await api(
        `/api/departments/${encodeURIComponent(deptName)}/storage/instructions/reset`,
        { method: "POST" },
      );
      setNotice("Storage instructions reset to defaults.");
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const handleUpload = async (file: File) => {
    setError(null);
    setUploadPct(0);
    try {
      const params = new URLSearchParams();
      params.set("visibility", visibility);
      if (subPrefix) params.set("prefix", subPrefix);
      params.set("filename", file.name);
      await xhrUpload(
        `/api/departments/${encodeURIComponent(deptName)}/storage/objects/upload?${params.toString()}`,
        file,
        setUploadPct,
      );
      setNotice(`Uploaded ${file.name}.`);
      await refresh();
      onChanged();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setUploadPct(null);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner kind="ok" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="small muted">View:</span>
          <button
            className={visibility === "public" ? "primary" : "ghost"}
            onClick={() => onVisibility("public")}
            type="button"
          >
            Public
          </button>
          <button
            className={visibility === "private" ? "primary" : "ghost"}
            onClick={() => onVisibility("private")}
            type="button"
          >
            Private
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost" onClick={() => setSettingsOpen(true)} type="button">Settings</button>
          <button className="ghost" onClick={handleReset} type="button">Reset instructions</button>
          <button className="ghost danger" onClick={handleDisconnect} type="button">Disconnect</button>
        </div>
      </div>

      <div className="row" style={{ gap: 6, alignItems: "baseline" }}>
        {breadcrumb.map((seg, i) => (
          <React.Fragment key={seg.prefix}>
            {i > 0 && <span className="muted small">/</span>}
            <a onClick={() => onNavigate(seg.sub)}>{seg.label}</a>
          </React.Fragment>
        ))}
      </div>

      <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
        <input
          type="text"
          placeholder="Filter files in this folder..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <div className="row" style={{ gap: 8 }}>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="name">Sort: Name</option>
            <option value="size">Sort: Size</option>
            <option value="date">Sort: Date</option>
          </select>
          <select value={order} onChange={(e) => setOrder(e.target.value as "asc" | "desc")}>
            <option value="asc">Asc</option>
            <option value="desc">Desc</option>
          </select>
          <button
            className="primary"
            onClick={() => uploadRef.current?.click()}
            disabled={uploadPct !== null}
            type="button"
          >
            {uploadPct !== null ? `Uploading ${uploadPct}%` : "Upload"}
          </button>
          <input
            ref={uploadRef}
            type="file"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {loading && !data && <div className="muted">Loading...</div>}

      {data && (
        <>
          {data.folders.length > 0 && (
            <div>
              <div className="small muted" style={{ marginBottom: 6 }}>Folders</div>
              <div className="files-grid">
                {data.folders.map((f) => (
                  <div
                    key={f.key}
                    className="file-card folder"
                    onClick={() => onNavigate(f.key.slice(root.length))}
                  >
                    <div className="file-thumb folder-thumb">{"📁"}</div>
                    <div className="file-name" title={f.name}>{f.name}/</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="small muted" style={{ marginBottom: 6 }}>
              {filtered.length} file{filtered.length === 1 ? "" : "s"}
            </div>
            {filtered.length === 0 ? (
              <div className="muted small">Empty.</div>
            ) : (
              <div className="files-grid">
                {filtered.map((f) => (
                  <FileCard
                    key={f.key}
                    file={f}
                    highlight={highlight === f.name}
                    visibility={visibility}
                    allowSignedPreview={visibility === "private" || !existing.publicBaseUrl}
                    deptName={deptName}
                    onCopy={handleCopyUrl}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <Drawer
        open={settingsOpen}
        title="Storage settings"
        onClose={() => setSettingsOpen(false)}
      >
        {settingsOpen && (
          <StorageSetup
            deptName={deptName}
            existing={existing}
            initial={defaultFormState(existing)}
            onSaved={() => {
              setSettingsOpen(false);
              setNotice("Storage credentials updated.");
              onChanged();
            }}
            onCancel={() => setSettingsOpen(false)}
          />
        )}
      </Drawer>
    </div>
  );
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "avif"]);

function iconFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (IMAGE_EXTS.has(ext)) return "🖼️"; // image
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "🎬"; // clapper
  if (["mp3", "wav", "flac", "ogg"].includes(ext)) return "🎵"; // musical note
  if (["pdf"].includes(ext)) return "📄"; // document
  if (["md", "markdown", "txt"].includes(ext)) return "📝"; // memo
  if (["json", "yaml", "yml"].includes(ext)) return "⚙️"; // gear
  return "📄";
}

function FileCard({
  file,
  highlight,
  visibility,
  allowSignedPreview,
  deptName,
  onCopy,
  onDelete,
}: {
  file: FileEntry;
  highlight: boolean;
  visibility: Visibility;
  allowSignedPreview: boolean;
  deptName: string;
  onCopy: (f: FileEntry) => void;
  onDelete: (f: FileEntry) => void;
}) {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const isImage = IMAGE_EXTS.has(ext);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    if (visibility === "public" && !allowSignedPreview) {
      setSignedUrl(file.publicUrl || null);
      return;
    }
    let cancelled = false;
    api<{ url: string }>(
      `/api/departments/${encodeURIComponent(deptName)}/storage/objects/url?key=${encodeURIComponent(file.key)}&mode=signed&ttl=600`,
    )
      .then((r) => { if (!cancelled) setSignedUrl(r.url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [allowSignedPreview, deptName, file.key, file.publicUrl, isImage, visibility]);

  return (
    <div className={`file-card${highlight ? " highlight" : ""}`}>
      <div className="file-thumb">
        {isImage && signedUrl ? (
          <img src={signedUrl} alt={file.name} loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <span style={{ fontSize: 28 }}>{iconFor(file.name)}</span>
        )}
      </div>
      <div className="file-name" title={file.name}>{file.name}</div>
      <div className="file-meta small muted">
        {formatBytes(file.size)} · {file.lastModified ? new Date(file.lastModified).toLocaleDateString() : "—"}
      </div>
      <div className="row" style={{ gap: 4, justifyContent: "flex-end", marginTop: 6 }}>
        <IconButton onClick={() => onCopy(file)}>Copy URL</IconButton>
        <IconButton onClick={() => onDelete(file)} danger>Delete</IconButton>
      </div>
    </div>
  );
}

function buildBreadcrumb(root: string, subPrefix: string): Array<{ label: string; sub: string; prefix: string }> {
  const out = [{ label: root.replace(/\/$/, "") || "(root)", sub: "", prefix: root }];
  if (!subPrefix) return out;
  const parts = subPrefix.replace(/\/$/, "").split("/").filter(Boolean);
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}${p}/` : `${p}/`;
    out.push({ label: p, sub: acc, prefix: `${root}${acc}` });
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function xhrUpload(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.withCredentials = true;
    const csrf = getCsrf();
    if (csrf) xhr.setRequestHeader("x-csrf", csrf);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `upload failed (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(file);
  });
}
