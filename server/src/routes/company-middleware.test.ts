import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { companyMiddleware } from "../company-middleware";
import { HttpError } from "../http";

function req(path: string, slug: string) {
  return {
    path,
    query: {},
    headers: { "x-aios-company-slug": slug },
  } as any;
}

const res = {} as any;

describe("company middleware", () => {
  it("ignores stale company selectors on global auth endpoints", () => {
    assert.doesNotThrow(() => companyMiddleware(req("/api/auth/login", "missing-company"), res));
  });

  it("still rejects unknown company selectors on company-scoped endpoints", () => {
    assert.throws(
      () => companyMiddleware(req("/api/departments", "missing-company"), res),
      (error) => error instanceof HttpError
        && error.status === 400
        && error.message === "unknown company",
    );
  });
});
