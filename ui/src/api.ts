// Thin fetch wrapper. Talks to /api/*; attaches CSRF header for unsafe methods.

let csrfToken: string | null = null;
let activeCompanySlug: string | null = localStorage.getItem("aios.activeCompanySlug");

const GLOBAL_API_PREFIXES = [
  "/api/auth",
  "/api/companies",
  "/api/health",
  "/api/onboarding",
  "/api/provider-auth",
  "/api/vps",
  "/api/settings/github",
  "/api/settings/system-update",
  "/api/settings/time",
];

function apiPathname(path: string): string {
  try {
    return new URL(path, window.location.origin).pathname;
  } catch {
    return path.split("?")[0] || path;
  }
}

function shouldAttachCompanySlug(path: string): boolean {
  const pathname = apiPathname(path);
  if (!pathname.startsWith("/api/")) return false;
  return !GLOBAL_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function setCsrf(t: string | null) { csrfToken = t; }
export function getCsrf() { return csrfToken; }
export function setActiveCompanySlug(slug: string | null) {
  activeCompanySlug = slug;
  if (slug) localStorage.setItem("aios.activeCompanySlug", slug);
  else localStorage.removeItem("aios.activeCompanySlug");
}
export function getActiveCompanySlug() { return activeCompanySlug; }

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD" && csrfToken) {
    headers.set("x-csrf", csrfToken);
  }
  if (activeCompanySlug && shouldAttachCompanySlug(path) && !headers.has("x-aios-company-slug")) {
    headers.set("x-aios-company-slug", activeCompanySlug);
  }
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch {}
    throw new Error(body.error || `${method} ${path} → ${res.status}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return (await res.text()) as any;
}

export function apiStream(path: string, handlers: { onEvent: (event: string, data: any) => void; onError?: (e: any) => void; }) {
  const url = new URL(path, window.location.origin);
  if (activeCompanySlug && shouldAttachCompanySlug(path)) url.searchParams.set("company", activeCompanySlug);
  const es = new EventSource(url.toString(), { withCredentials: true } as any);
  const raw = es as any;
  // EventSource gives us .addEventListener for named events.
  const names = ["output", "update", "finished", "run.created", "run.updated", "run.finished"];
  for (const n of names) {
    es.addEventListener(n, (e) => {
      try { handlers.onEvent(n, JSON.parse((e as MessageEvent).data)); } catch {}
    });
  }
  es.onerror = (e) => handlers.onError?.(e);
  return es;
}
