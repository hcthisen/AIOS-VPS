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
  const [mode, setMode] = useState<"create" | "attach">("create");
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [fullName, setFullName] = useState("");
  const [repoName, setRepoName] = useState("aios-company");
  const [isPrivate, setIsPrivate] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [displayNameTouched, setDisplayNameTouched] = useState(false);
  const [companySlug, setCompanySlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "attach" || repos.length > 0) return;
    api<{ repos: RepoOption[] }>("/api/companies/github/repos")
      .then((r) => setRepos(r.repos || []))
      .catch((e) => setError(e.message));
  }, [mode, repos.length]);

  useEffect(() => {
    if (displayNameTouched) return;
    if (mode === "create") {
      setDisplayName(repoName);
      return;
    }
    if (fullName) setDisplayName(fullName.split("/")[1] || fullName);
  }, [mode, repoName, fullName, displayNameTouched]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ company: { slug: string; displayName: string } }>("/api/companies", {
        method: "POST",
        body: JSON.stringify(
          mode === "create"
            ? { mode, name: repoName, private: isPrivate, displayName }
            : { mode, fullName, displayName },
        ),
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
      <Section title="Create new company" description="Create a fresh AIOS repo in the connected GitHub account, or attach an existing AIOS repo.">
        <div className="row">
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" checked={mode === "create"} onChange={() => setMode("create")} style={{ width: "auto", minHeight: 0 }} /> Create new company
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="radio" checked={mode === "attach"} onChange={() => setMode("attach")} style={{ width: "auto", minHeight: 0 }} /> Attach existing repo
          </label>
        </div>
        {mode === "create" && (
          <div className="col">
            <label className="col">
              <span className="small muted">Repository name</span>
              <input value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="repo name" />
            </label>
            <label className="small"><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> private</label>
            <p className="small muted">AIOS will create the repo on GitHub, clone it locally, and scaffold the company workspace.</p>
          </div>
        )}
        {mode === "attach" && (
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
        )}
        <label className="col">
          <span className="small muted">Company name</span>
          <input
            value={displayName}
            onChange={(e) => {
              setDisplayNameTouched(true);
              setDisplayName(e.target.value);
            }}
            placeholder="Company name"
          />
        </label>
        <div className="row">
          <button className="primary" onClick={save} disabled={busy || !displayName.trim() || (mode === "create" ? !repoName.trim() : !fullName)}>
            {busy ? "Working..." : mode === "create" ? "Create company" : "Attach repo"}
          </button>
          <button className="ghost" onClick={() => navigate("/")}>Cancel</button>
        </div>
        {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
      </Section>
    </div>
  );
}
