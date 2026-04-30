import { AsyncLocalStorage } from "async_hooks";

export interface CompanyContext {
  id: number;
  slug: string;
  displayName: string;
  repoDir: string;
}

const storage = new AsyncLocalStorage<CompanyContext>();
let fallbackCompany: CompanyContext | null = null;

export function withCompanyContext<T>(company: CompanyContext, fn: () => T): T {
  return storage.run(company, fn);
}

export function enterCompanyContext(company: CompanyContext) {
  storage.enterWith(company);
}

export function getCurrentCompanyContext(): CompanyContext | null {
  return storage.getStore() || fallbackCompany;
}

export function getCurrentCompanyId(): number {
  return getCurrentCompanyContext()?.id || 1;
}

export function getCurrentCompanySlug(): string {
  return getCurrentCompanyContext()?.slug || "default";
}

export function setFallbackCompany(company: CompanyContext) {
  fallbackCompany = company;
}
