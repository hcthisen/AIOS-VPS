import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { db } from "../db";
import { createCompany } from "./companies";

describe("companies", () => {
  it("creates additional companies as runnable immediately", () => {
    const slug = `company-complete-${Date.now()}`;
    try {
      const company = createCompany({
        displayName: "Company Complete",
        slug,
        repoFullName: `acme/${slug}`,
      });

      assert.equal(company.setupPhase, "complete");
    } finally {
      db.prepare("DELETE FROM companies WHERE slug = ?").run(slug);
    }
  });
});
