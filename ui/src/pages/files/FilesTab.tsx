import React, { useEffect, useState } from "react";
import { api } from "../../api";
import { Banner } from "../../components/Banner";
import { Section } from "../../components/Section";
import { StorageBrowser } from "./StorageBrowser";
import { StorageSetup } from "./StorageSetup";
import { FilesQuery, StoragePublic, Visibility } from "./types";

export function FilesTab({
  deptName,
  query,
  onQueryChange,
}: {
  deptName: string;
  query: FilesQuery;
  onQueryChange: (next: FilesQuery) => void;
}) {
  const [cfg, setCfg] = useState<StoragePublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const visibility: Visibility = query.visibility === "private" ? "private" : "public";
  const subPrefix = query.prefix || "";

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api<StoragePublic>(
        `/api/departments/${encodeURIComponent(deptName)}/storage/config`,
      );
      setCfg(r);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, [deptName]);

  if (loading && !cfg) {
    return <Section title="Files"><div className="muted">Loading...</div></Section>;
  }

  if (error) {
    return (
      <Section title="Files">
        <Banner kind="err">{error}</Banner>
      </Section>
    );
  }

  if (!cfg?.configured) {
    return (
      <Section
        title="Connect file storage"
        description="Point this department at an S3-compatible bucket. Credentials save to .env; a ‘File storage’ section is appended to both CLAUDE.md and AGENTS.md so the agent knows how to use it. Bucket CORS is usually unnecessary for current AIOS flows."
      >
        <StorageSetup
          deptName={deptName}
          existing={cfg || undefined}
          onSaved={() => {
            refresh().catch(() => {});
          }}
        />
      </Section>
    );
  }

  return (
    <Section
      title={<span>Files <span className="small muted">· {cfg.bucket}</span></span>}
      description={`${cfg.endpoint} · region ${cfg.region} · key ${cfg.accessKeyIdMasked}`}
    >
      <StorageBrowser
        deptName={deptName}
        existing={cfg}
        visibility={visibility}
        subPrefix={subPrefix}
        highlight={query.highlight}
        onVisibility={(v) => onQueryChange({ ...query, visibility: v, prefix: "", highlight: undefined })}
        onNavigate={(sub) => onQueryChange({ ...query, prefix: sub || undefined, highlight: undefined })}
        onChanged={() => {
          refresh().catch(() => {});
        }}
        onDisconnect={() => {
          onQueryChange({});
          refresh().catch(() => {});
        }}
      />
    </Section>
  );
}
