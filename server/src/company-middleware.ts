import { enterCompanyContext } from "./company-context";
import { Handler, badRequest } from "./http";
import { getCompanyBySlug, getDefaultCompany } from "./services/companies";

export const companyMiddleware: Handler = (req) => {
  const headerSlug = String(req.headers["x-aios-company-slug"] || "").trim();
  const querySlug = String(req.query.company || "").trim();
  const slug = headerSlug || querySlug;
  const company = slug ? getCompanyBySlug(slug) : getDefaultCompany();
  if (!company) throw badRequest("unknown company");
  enterCompanyContext(company);
};
