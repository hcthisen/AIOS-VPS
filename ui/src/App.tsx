import React, { useEffect, useState } from "react";
import { api, getActiveCompanySlug, setActiveCompanySlug, setCsrf } from "./api";
import { useRoute } from "./router";
import { AuthPage } from "./pages/Auth";
import { VpsDomainSetup } from "./pages/VpsDomainSetup";
import { ProviderAuth } from "./pages/ProviderAuth";
import { GithubSetup } from "./pages/GithubSetup";
import { RepoSetup } from "./pages/RepoSetup";
import { ContextSetup } from "./pages/ContextSetup";
import { NotificationsSetup } from "./pages/NotificationsSetup";
import { Overview } from "./pages/Overview";
import { RunsPage } from "./pages/Runs";
import { DepartmentsPage } from "./pages/Departments";
import { DepartmentDetail } from "./pages/DepartmentDetail";
import { BacklogPage } from "./pages/Backlog";
import { WebhooksPage } from "./pages/Webhooks";
import { UsagePage } from "./pages/Usage";
import { TerminalPage } from "./pages/Terminal";
import { ManualRunPage } from "./pages/ManualRun";
import { RunDetail } from "./pages/RunDetail";
import { SettingsPage } from "./pages/Settings";
import { ServerClock } from "./components/ServerClock";
import { AddCompanyPage } from "./pages/AddCompany";

export interface Me {
  user: { id: number; email: string; isAdmin: boolean } | null;
  csrf?: string;
  setupPhase: string;
  firstRun?: boolean;
}

interface Company {
  id: number;
  slug: string;
  displayName: string;
  repoFullName: string | null;
  setupPhase: string;
  isDefault: boolean;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [path, navigate] = useRoute();
  const [systemUpdate, setSystemUpdate] = useState<any>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [activeCompany, setActiveCompany] = useState<Company | null>(null);

  const refresh = async () => {
    const m = await api<Me>("/api/auth/me");
    if (m.csrf) setCsrf(m.csrf);
    setMe(m);
    return m;
  };

  useEffect(() => { refresh().catch(() => setMe({ user: null, setupPhase: "admin_setup" })); }, []);

  const refreshCompanies = async () => {
    const result = await api<{ companies: Company[] }>("/api/companies");
    const rows = result.companies || [];
    setCompanies(rows);
    const stored = getActiveCompanySlug();
    const next = rows.find((company) => company.slug === stored)
      || rows.find((company) => company.isDefault)
      || rows[0]
      || null;
    setActiveCompany(next);
    setActiveCompanySlug(next?.slug || null);
  };

  useEffect(() => {
    if (!me?.user || me.setupPhase !== "complete") return;
    refreshCompanies().catch(() => {});
  }, [me?.user?.id, me?.setupPhase]);

  useEffect(() => {
    if (!me) return;
    if (!me.user) {
      if (path !== "/auth") navigate("/auth");
      return;
    }
    if (me.setupPhase !== "complete") {
      const target = setupPhaseToRoute(me.setupPhase);
      if (path !== target) navigate(target);
      return;
    }
    if (path === "/auth" || path.startsWith("/setup/")) {
      navigate("/");
    }
  }, [me, path]);

  useEffect(() => {
    if (!me?.user?.isAdmin || me.setupPhase !== "complete") {
      setSystemUpdate(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api("/api/settings/system-update/status");
        if (!cancelled) setSystemUpdate(next);
      } catch {
        if (!cancelled) setSystemUpdate(null);
      }
    };
    load();
    const timer = window.setInterval(load, 5 * 60_000);
    const onStatus = (event: Event) => {
      const custom = event as CustomEvent<any>;
      setSystemUpdate(custom.detail || null);
    };
    window.addEventListener("aios-system-update-status", onStatus as EventListener);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("aios-system-update-status", onStatus as EventListener);
    };
  }, [me?.user?.isAdmin, me?.setupPhase]);

  if (!me) return <div className="auth-wrap"><div>Loading…</div></div>;

  if (!me.user) {
    return <AuthPage onAuthed={refresh} firstRun={!!me.firstRun} setupPhase={me.setupPhase} />;
  }

  // Setup flow uses a minimal layout without the main sidebar.
  if (me.setupPhase !== "complete" && path.startsWith("/setup/")) {
    return <SetupLayout me={me} onAdvance={refresh} navigate={navigate} path={path} />;
  }

  if (me.setupPhase === "complete" && !activeCompany) {
    return <div className="auth-wrap"><div>Loading...</div></div>;
  }

  const close = () => document.body.classList.remove("nav-open");
  const go = (t: string) => { close(); navigate(t); };
  const title = titleFor(path);
  const selectCompany = (slug: string) => {
    const next = companies.find((company) => company.slug === slug) || null;
    setActiveCompany(next);
    setActiveCompanySlug(next?.slug || null);
    close();
    navigate("/");
  };

  return (
    <div className="layout">
      <header className="topbar">
        <button
          className="hamburger"
          aria-label="Open navigation"
          onClick={() => document.body.classList.toggle("nav-open")}
        >
          {"\u2630"}
        </button>
        <span className="brand">{activeCompany?.displayName || "AIOS"}</span>
        <ServerClock />
        <span className="spacer" />
        <span className="small muted">{title}</span>
      </header>
      <div className="drawer-scrim" onClick={close} />
      <nav className="sidebar">
        <div className="sidebar-brand">
          <h1>{activeCompany?.displayName || "AIOS"}</h1>
          <ServerClock />
        </div>
        {companies.length > 0 && (
          <div className="company-switcher">
            <select value={activeCompany?.slug || ""} onChange={(e) => selectCompany(e.target.value)}>
              {companies.map((company) => (
                <option key={company.slug} value={company.slug}>{company.displayName}</option>
              ))}
            </select>
            <a className={path === "/companies/new" ? "active" : ""} onClick={() => go("/companies/new")}>Add company</a>
          </div>
        )}
        <a className={path === "/" ? "active" : ""} onClick={() => go("/")}>Overview</a>
        <a className={path.startsWith("/runs") ? "active" : ""} onClick={() => go("/runs")}>Runs</a>
        <a className={path.startsWith("/departments") ? "active" : ""} onClick={() => go("/departments")}>Departments</a>
        <a className={path === "/manual" ? "active" : ""} onClick={() => go("/manual")}>Manual run</a>
        <a className={path === "/backlog" ? "active" : ""} onClick={() => go("/backlog")}>Backlog</a>
        <a className={path === "/webhooks" ? "active" : ""} onClick={() => go("/webhooks")}>Webhooks</a>
        <a className={path === "/usage" ? "active" : ""} onClick={() => go("/usage")}>Usage</a>
        <a className={path === "/terminal" ? "active" : ""} onClick={() => go("/terminal")}>Terminal</a>
        <a className={path === "/settings" ? "active" : ""} onClick={() => go("/settings")}>
          <span>Settings</span>
          {systemUpdate?.state?.updateAvailable ? <span className="badge warn">update</span> : null}
        </a>
        <hr />
        <div className="small muted">{me.user.email}</div>
        <a onClick={async () => { close(); await api("/api/auth/logout", { method: "POST" }); refresh(); navigate("/auth"); }}>Log out</a>
      </nav>
      <main className="main">
        <Page key={activeCompany?.slug || "default"} path={path} navigate={navigate} me={me} refresh={refresh} refreshCompanies={refreshCompanies} />
      </main>
    </div>
  );
}

function titleFor(path: string): string {
  if (path === "/") return "Overview";
  if (path === "/companies/new") return "Add company";
  if (path.startsWith("/runs")) return "Runs";
  if (path.startsWith("/departments")) return "Departments";
  if (path === "/manual") return "Manual run";
  if (path === "/backlog") return "Backlog";
  if (path === "/webhooks") return "Webhooks";
  if (path === "/usage") return "Usage";
  if (path === "/terminal") return "Terminal";
  if (path === "/settings") return "Settings";
  return "";
}

function setupPhaseToRoute(phase: string) {
  switch (phase) {
    case "domain_setup": return "/setup/domain";
    case "provider_setup": return "/setup/providers";
    case "github_setup": return "/setup/github";
    case "repo_setup": return "/setup/repo";
    case "context_setup": return "/setup/context";
    case "notifications": return "/setup/notifications";
    default: return "/";
  }
}

function SetupLayout({ me, onAdvance, navigate, path }: { me: Me; onAdvance: () => Promise<Me>; navigate: (t: string) => void; path: string }) {
  const steps = [
    ["admin_setup", "Admin"],
    ["domain_setup", "Domain"],
    ["provider_setup", "Providers"],
    ["github_setup", "GitHub"],
    ["repo_setup", "Repo"],
    ["context_setup", "Context"],
    ["notifications", "Notifications"],
    ["complete", "Done"],
  ] as const;
  const activeIdx = steps.findIndex((s) => s[0] === me.setupPhase);
  const page = path.replace(/^\/setup\//, "");
  return (
    <div style={{ maxWidth: 760, margin: "40px auto", padding: 16 }}>
      <h1 style={{ marginTop: 0 }}>AIOS setup</h1>
      <div className="stepper">
        {steps.map((s, i) => (
          <div key={s[0]} className={`step ${i < activeIdx ? "done" : ""} ${i === activeIdx ? "active" : ""}`}>{s[1]}</div>
        ))}
      </div>
      {page === "domain" && <VpsDomainSetup onAdvance={async () => { const m = await onAdvance(); if (m.setupPhase !== "domain_setup") navigate("/setup/providers"); }} />}
      {page === "providers" && <ProviderAuth onAdvance={async () => { const m = await onAdvance(); if (m.setupPhase !== "provider_setup") navigate("/setup/github"); }} />}
      {page === "github" && <GithubSetup onAdvance={async () => { const m = await onAdvance(); if (m.setupPhase !== "github_setup") navigate("/setup/repo"); }} />}
      {page === "repo" && <RepoSetup onAdvance={async () => { const m = await onAdvance(); if (m.setupPhase !== "repo_setup") navigate("/setup/context"); }} />}
      {page === "context" && <ContextSetup onAdvance={async () => { const m = await onAdvance(); if (m.setupPhase !== "context_setup") navigate("/setup/notifications"); }} />}
      {page === "notifications" && <NotificationsSetup onAdvance={async () => { await api("/api/onboarding/complete", { method: "POST" }); await onAdvance(); navigate("/"); }} />}
    </div>
  );
}

function Page({ path, navigate, me, refresh, refreshCompanies }: { path: string; navigate: (t: string) => void; me: Me; refresh: () => Promise<Me>; refreshCompanies: () => Promise<void> }) {
  if (path === "/") return <Overview navigate={navigate} />;
  if (path === "/companies/new") return <AddCompanyPage navigate={navigate} onChanged={refreshCompanies} />;
  if (path === "/runs") return <RunsPage navigate={navigate} />;
  if (path.startsWith("/runs/")) return <RunDetail id={path.split("/")[2]} navigate={navigate} />;
  if (path === "/departments") return <DepartmentsPage navigate={navigate} />;
  if (path.startsWith("/departments/")) return <DepartmentDetail name={decodeURIComponent(path.split("/")[2])} navigate={navigate} />;
  if (path === "/manual") return <ManualRunPage />;
  if (path === "/backlog") return <BacklogPage />;
  if (path === "/webhooks") return <WebhooksPage navigate={navigate} />;
  if (path === "/usage") return <UsagePage />;
  if (path === "/terminal") return <TerminalPage />;
  if (path === "/settings") return <SettingsPage />;
  return <div><h2>Not found</h2><a onClick={() => navigate("/")}>Back</a></div>;
}
