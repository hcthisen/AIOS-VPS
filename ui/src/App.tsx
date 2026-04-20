import React, { useEffect, useState } from "react";
import { api, setCsrf } from "./api";
import { useRoute } from "./router";
import { AuthPage } from "./pages/Auth";
import { VpsDomainSetup } from "./pages/VpsDomainSetup";
import { ProviderAuth } from "./pages/ProviderAuth";
import { GithubSetup } from "./pages/GithubSetup";
import { RepoSetup } from "./pages/RepoSetup";
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

export interface Me {
  user: { id: number; email: string; isAdmin: boolean } | null;
  csrf?: string;
  setupPhase: string;
  firstRun?: boolean;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [path, navigate] = useRoute();

  const refresh = async () => {
    const m = await api<Me>("/api/auth/me");
    if (m.csrf) setCsrf(m.csrf);
    setMe(m);
    return m;
  };

  useEffect(() => { refresh().catch(() => setMe({ user: null, setupPhase: "admin_setup" })); }, []);

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

  if (!me) return <div className="auth-wrap"><div>Loading…</div></div>;

  if (!me.user) {
    return <AuthPage onAuthed={refresh} firstRun={!!me.firstRun} setupPhase={me.setupPhase} />;
  }

  // Setup flow uses a minimal layout without the main sidebar.
  if (me.setupPhase !== "complete" && path.startsWith("/setup/")) {
    return <SetupLayout me={me} onAdvance={refresh} navigate={navigate} path={path} />;
  }

  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>AIOS</h1>
        <a className={path === "/" ? "active" : ""} onClick={() => navigate("/")}>Overview</a>
        <a className={path.startsWith("/runs") ? "active" : ""} onClick={() => navigate("/runs")}>Runs</a>
        <a className={path.startsWith("/departments") ? "active" : ""} onClick={() => navigate("/departments")}>Departments</a>
        <a className={path === "/manual" ? "active" : ""} onClick={() => navigate("/manual")}>Manual run</a>
        <a className={path === "/backlog" ? "active" : ""} onClick={() => navigate("/backlog")}>Backlog</a>
        <a className={path === "/webhooks" ? "active" : ""} onClick={() => navigate("/webhooks")}>Webhooks</a>
        <a className={path === "/usage" ? "active" : ""} onClick={() => navigate("/usage")}>Usage</a>
        <a className={path === "/terminal" ? "active" : ""} onClick={() => navigate("/terminal")}>Terminal</a>
        <a className={path === "/settings" ? "active" : ""} onClick={() => navigate("/settings")}>Settings</a>
        <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />
        <div className="small muted">{me.user.email}</div>
        <a onClick={async () => { await api("/api/auth/logout", { method: "POST" }); refresh(); navigate("/auth"); }}>Log out</a>
      </nav>
      <main className="main">
        <Page path={path} navigate={navigate} me={me} refresh={refresh} />
      </main>
    </div>
  );
}

function setupPhaseToRoute(phase: string) {
  switch (phase) {
    case "domain_setup": return "/setup/domain";
    case "provider_setup": return "/setup/providers";
    case "github_setup": return "/setup/github";
    case "repo_setup": return "/setup/repo";
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
      {page === "repo" && <RepoSetup onAdvance={async () => { const m = await onAdvance(); if (m.setupPhase !== "repo_setup") navigate("/setup/notifications"); }} />}
      {page === "notifications" && <NotificationsSetup onAdvance={async () => { await api("/api/onboarding/complete", { method: "POST" }); await onAdvance(); navigate("/"); }} />}
    </div>
  );
}

function Page({ path, navigate, me, refresh }: { path: string; navigate: (t: string) => void; me: Me; refresh: () => Promise<Me> }) {
  if (path === "/") return <Overview navigate={navigate} />;
  if (path === "/runs") return <RunsPage navigate={navigate} />;
  if (path.startsWith("/runs/")) return <RunDetail id={path.split("/")[2]} navigate={navigate} />;
  if (path === "/departments") return <DepartmentsPage navigate={navigate} />;
  if (path.startsWith("/departments/")) return <DepartmentDetail name={decodeURIComponent(path.split("/")[2])} navigate={navigate} />;
  if (path === "/manual") return <ManualRunPage />;
  if (path === "/backlog") return <BacklogPage />;
  if (path === "/webhooks") return <WebhooksPage />;
  if (path === "/usage") return <UsagePage />;
  if (path === "/terminal") return <TerminalPage />;
  if (path === "/settings") return <SettingsPage />;
  return <div><h2>Not found</h2><a onClick={() => navigate("/")}>Back</a></div>;
}
