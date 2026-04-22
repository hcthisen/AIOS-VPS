import React, { useState } from "react";
import { api } from "../../api";
import { Banner } from "../../components/Banner";
import { FeedbackButton, useActionRunner } from "../../components/FeedbackButton";
import { ProbeResult, StorageFormState, StoragePublic } from "./types";

interface Props {
  deptName: string;
  initial?: StorageFormState;
  existing?: StoragePublic;
  onSaved: () => void;
  onCancel?: () => void;
}

export function defaultFormState(existing?: StoragePublic): StorageFormState {
  return {
    endpoint: existing?.endpoint || "",
    region: existing?.region || "",
    bucket: existing?.bucket || "",
    accessKeyId: "",
    secretAccessKey: "",
    publicBaseUrl: existing?.publicBaseUrl || "",
    publicPrefix: existing?.publicPrefix || "public/",
    privatePrefix: existing?.privatePrefix || "private/",
  };
}

export function StorageSetup({ deptName, initial, existing, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<StorageFormState>(initial || defaultFormState(existing));
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { actions, run } = useActionRunner();

  const update = <K extends keyof StorageFormState>(k: K, v: StorageFormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setProbe(null);
  };

  const hasAccessKey = form.accessKeyId.trim() || !!existing?.configured;
  const hasSecret = form.secretAccessKey.trim() || !!existing?.configured;
  const canTest = form.endpoint.trim() && form.bucket.trim() && hasAccessKey && hasSecret;

  const handleTest = () =>
    run(
      "probe",
      async () => {
        setError(null);
        const payload: Partial<StorageFormState> = { ...form };
        if (!payload.accessKeyId?.trim()) delete payload.accessKeyId;
        if (!payload.secretAccessKey?.trim()) delete payload.secretAccessKey;
        const result = await api<ProbeResult>(
          `/api/departments/${encodeURIComponent(deptName)}/storage/test`,
          { method: "POST", body: JSON.stringify(payload) },
        );
        setProbe(result);
        if (!result.ok) throw new Error(result.error?.message || "connection test failed");
      },
      setError,
    );

  const handleSave = () =>
    run(
      "save",
      async () => {
        setError(null);
        const payload: Partial<StorageFormState> = { ...form };
        if (!payload.accessKeyId?.trim()) delete payload.accessKeyId;
        if (!payload.secretAccessKey?.trim()) delete payload.secretAccessKey;
        await api(
          `/api/departments/${encodeURIComponent(deptName)}/storage/config`,
          { method: "POST", body: JSON.stringify(payload) },
        );
        onSaved();
      },
      setError,
    );

  return (
    <div className="col" style={{ gap: 16 }}>
      {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}

      <div className="col" style={{ gap: 10 }}>
        <Field label="Storage endpoint" hint="Scheme is optional; AIOS defaults to https://. Examples: s3.eu-central-1.hetzner.com, <id>.r2.cloudflarestorage.com">
          <input
            placeholder="s3.example.com"
            value={form.endpoint}
            onChange={(e) => update("endpoint", e.target.value)}
          />
        </Field>
        <Field label="Region" hint='e.g. "eu-central-1" or "auto" for R2'>
          <input value={form.region} onChange={(e) => update("region", e.target.value)} />
        </Field>
        <Field label="Bucket name">
          <input value={form.bucket} onChange={(e) => update("bucket", e.target.value)} />
        </Field>
        <Field
          label="Access key ID"
          hint={existing?.configured ? "Leave blank to keep the stored access key." : ""}
        >
          <input
            value={form.accessKeyId}
            onChange={(e) => update("accessKeyId", e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={existing?.configured ? existing.accessKeyIdMasked : ""}
          />
        </Field>
        <Field
          label="Secret access key"
          hint={existing?.configured ? "Leave blank to keep the stored secret." : ""}
        >
          <input
            type="password"
            value={form.secretAccessKey}
            onChange={(e) => update("secretAccessKey", e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={existing?.configured ? "(unchanged)" : ""}
          />
        </Field>
        <Field label="Public base URL" hint="Scheme is optional; AIOS defaults to https://. Bucket CORS is usually unnecessary because uploads go through AIOS and private previews use signed URLs.">
          <input
            value={form.publicBaseUrl}
            onChange={(e) => update("publicBaseUrl", e.target.value)}
            placeholder="cdn.example.com"
          />
        </Field>
        <div className="row" style={{ gap: 12 }}>
          <Field label="Public prefix" className="flex-1">
            <input value={form.publicPrefix} onChange={(e) => update("publicPrefix", e.target.value)} />
          </Field>
          <Field label="Private prefix" className="flex-1">
            <input value={form.privatePrefix} onChange={(e) => update("privatePrefix", e.target.value)} />
          </Field>
        </div>
      </div>

      {probe && probe.ok && (
        <Banner kind="ok">
          Connection OK. Bucket has {probe.objectCount} object{probe.objectCount === 1 ? "" : "s"}.
          Read, write, and delete permissions confirmed
          {probe.deleteOk ? "" : " (delete failed — see warnings)"}.
          {probe.warnings?.length ? (
            <div className="small" style={{ marginTop: 4 }}>
              {probe.warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          ) : null}
        </Banner>
      )}
      {probe && !probe.ok && probe.error && (
        <Banner kind="err">
          {probe.error.message}
          {probe.error.hint ? <div className="small muted" style={{ marginTop: 4 }}>{probe.error.hint}</div> : null}
        </Banner>
      )}

      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        {onCancel && <button className="ghost" type="button" onClick={onCancel}>Cancel</button>}
        <FeedbackButton
          className="ghost"
          state={actions.probe || "idle"}
          idleLabel="Test connection"
          workingLabel="Testing..."
          okLabel="Connected"
          onClick={handleTest}
          disabled={!canTest}
        />
        <FeedbackButton
          className="primary"
          state={actions.save || "idle"}
          idleLabel={existing?.configured ? "Save changes" : "Save and connect"}
          workingLabel="Saving..."
          okLabel="Saved"
          onClick={handleSave}
          disabled={!probe?.ok}
        />
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={["col", className].filter(Boolean).join(" ")} style={{ gap: 4 }}>
      <span className="small">{label}</span>
      {children}
      {hint ? <span className="small muted">{hint}</span> : null}
    </label>
  );
}
