import React, { useEffect, useState } from "react";
import { api, setActiveCompanySlug } from "../api";
import { Section } from "../components/Section";
import { Banner } from "../components/Banner";
import { ContextSetup } from "./ContextSetup";
import { NotificationsSetup } from "./NotificationsSetup";

interface RepoOption {
  fullName: string;
  private: boolean;
}

export function AddCompanyPage({
  navigate,
  onChanged,
}: {
  navigate: (to: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [step, setStep] = useState<"repo" | "context" | "notifications">("repo");
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [fullName, setFullName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [companySlug, setCompanySlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ repos: RepoOption[] }>("/api/companies/github/repos")
      .then((r) => setRepos(r.repos || []))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!fullName || displayName) return;
    setDisplayName(fullName.split("/")[1] || fullName);
  }, [fullName]);

  const attach = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ company: { slug: string; displayName: string } }>("/api/companies", {
        method: "POST",
        body: JSON.stringify({ fullName, displayName }),
      });
      setCompanySlug(result.company.slug);
      setActiveCompanySlug(result.company.slug);
      await onChanged();
      setStep("context");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (step === "context" && companySlug) {
    return (
      <div className="col narrow">
        <h2>Add company</h2>
        <ContextSetup
          basePath={`/api/companies/${encodeURIComponent(companySlug)}/context`}
          savePath={`/api/companies/${encodeURIComponent(companySlug)}/context`}
          onAdvance={async () => setStep("notifications")}
        />
      </div>
    );
  }

  if (step === "notifications" && companySlug) {
    return (
      <div className="col narrow">
        <h2>Add company</h2>
        <NotificationsSetup
          mode="onboarding"
          basePath={`/api/companies/${encodeURIComponent(companySlug)}/notifications`}
          onAdvance={async () => {
            await api(`/api/companies/${encodeURIComponent(companySlug)}/complete`, { method: "POST" });
            await onChanged();
            navigate("/");
          }}
        />
      </div>
    );
  }

  return (
    <div className="col narrow">
      <h2>Add company</h2>
      <Section title="Choose repo" description="Select an AIOS repo from the connected GitHub account. Already connected repos are hidden.">
        <label className="col">
          <span className="small muted">Repository</span>
          <select value={fullName} onChange={(e) => setFullName(e.target.value)}>
            <option value="">-- pick a repo --</option>
            {repos.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}{repo.private ? " (private)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="col">
          <span className="small muted">Company name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Company name" />
        </label>
        <div className="row">
          <button className="primary" onClick={attach} disabled={busy || !fullName || !displayName.trim()}>
            {busy ? "Attaching..." : "Attach repo"}
          </button>
          <button className="ghost" onClick={() => navigate("/")}>Cancel</button>
        </div>
        {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
      </Section>
    </div>
  );
}
