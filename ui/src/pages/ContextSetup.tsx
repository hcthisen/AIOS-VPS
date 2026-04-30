import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { Banner } from "../components/Banner";

interface ContextForm {
  organizationName: string;
  deploymentScope: string;
  parentScope: string;
  scopeSummary: string;
  outsideRepoContext: string;
  sharedConventions: string;
}

const emptyForm: ContextForm = {
  organizationName: "",
  deploymentScope: "",
  parentScope: "",
  scopeSummary: "",
  outsideRepoContext: "",
  sharedConventions: "",
};

export function ContextSetup({
  onAdvance,
  basePath = "/api/onboarding/context",
  savePath = "/api/onboarding/context/save",
}: {
  onAdvance: () => Promise<void>;
  basePath?: string;
  savePath?: string;
}) {
  const [form, setForm] = useState<ContextForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ContextForm>(basePath)
      .then(setForm)
      .catch((e) => setError(e.message));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(savePath, {
        method: "POST",
        body: JSON.stringify(form),
      });
      await onAdvance();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Shared context"
      description={<>This step defines the organization and deployment scope for the whole repository. AIOS writes the root <code>org.md</code> plus the root <code>CLAUDE.md</code> and <code>AGENTS.md</code>, then syncs shared context into each department.</>}
    >
      <input
        value={form.organizationName}
        onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
        placeholder="Organization name"
      />
      <input
        value={form.deploymentScope}
        onChange={(e) => setForm({ ...form, deploymentScope: e.target.value })}
        placeholder="AIOS deployment scope, e.g. Marketing"
      />
      <input
        value={form.parentScope}
        onChange={(e) => setForm({ ...form, parentScope: e.target.value })}
        placeholder="Parent company or department, optional"
      />
      <textarea
        value={form.scopeSummary}
        onChange={(e) => setForm({ ...form, scopeSummary: e.target.value })}
        placeholder="Describe what this AIOS deployment owns and why it exists."
      />
      <textarea
        value={form.outsideRepoContext}
        onChange={(e) => setForm({ ...form, outsideRepoContext: e.target.value })}
        placeholder="Describe teams, systems, or responsibilities that exist outside this repository."
      />
      <textarea
        value={form.sharedConventions}
        onChange={(e) => setForm({ ...form, sharedConventions: e.target.value })}
        placeholder="Describe shared conventions, approval rules, tone, or compliance constraints."
      />

      <div className="row">
        <button className="primary" onClick={save} disabled={busy || !form.organizationName.trim() || !form.deploymentScope.trim()}>
          {busy ? "Saving..." : "Save context"}
        </button>
      </div>

      {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
    </Section>
  );
}
