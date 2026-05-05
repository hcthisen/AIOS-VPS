import { enterCompanyContext } from "./company-context";
import { Handler, badRequest } from "./http";
import { getCompanyBySlug, getDefaultCompany } from "./services/companies";

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

function isGlobalApiPath(path: string): boolean {
  return GLOBAL_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export const companyMiddleware: Handler = (req) => {
  const headerSlug = String(req.headers["x-aios-company-slug"] || "").trim();
  const querySlug = String(req.query.company || "").trim();
  const slug = isGlobalApiPath(req.path) ? "" : headerSlug || querySlug;
  const company = slug ? getCompanyBySlug(slug) : getDefaultCompany();
  if (!company) throw badRequest("unknown company");
  enterCompanyContext(company);
};
