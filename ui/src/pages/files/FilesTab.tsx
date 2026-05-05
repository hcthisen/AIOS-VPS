import React, { useEffect, useState } from "react";
import { api } from "../../api";
import { Banner } from "../../components/Banner";
import { Section } from "../../components/Section";
import { StorageBrowser } from "./StorageBrowser";
import { StorageSetup } from "./StorageSetup";
import { FilesQuery, PublicUrlRepairResult, StoragePublic, Visibility } from "./types";

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
  const [publicUrlRepair, setPublicUrlRepair] = useState<PublicUrlRepairResult | null>(null);
  const [repairingPublicUrl, setRepairingPublicUrl] = useState(false);
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
      if (!r.configured || !r.publicBaseUrl) setPublicUrlRepair(null);
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

  useEffect(() => {
    if (!cfg?.configured || !cfg.publicBaseUrl) return;
    let cancelled = false;
    setRepairingPublicUrl(true);
    api<PublicUrlRepairResult>(
      `/api/departments/${encodeURIComponent(deptName)}/storage/public-url/repair`,
      { method: "POST" },
    )
      .then((result) => {
        if (!cancelled) setPublicUrlRepair(result);
      })
      .catch((e: any) => {
        if (!cancelled) {
          setPublicUrlRepair({
            ok: false,
            status: "failed",
            publicBaseUrl: cfg.publicBaseUrl,
            host: "",
            detail: e?.message || String(e),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setRepairingPublicUrl(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cfg?.configured, cfg?.publicBaseUrl, deptName]);

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
        description="Point this department at an S3-compatible bucket. Credentials save to .env; a ‘File storage’ section is appended to both CLAUDE.md and AGENTS.md so the agent knows how to use it. AIOS verifies configured public URLs before saving them and can self-host them on this VPS when the hostname points here. Bucket CORS is usually unnecessary for current AIOS flows."
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
        publicUrlRepair={publicUrlRepair}
        repairingPublicUrl={repairingPublicUrl}
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
