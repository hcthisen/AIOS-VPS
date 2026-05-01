import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import { db } from "../db";
import { buildPublicObjectUrl, findPublicMatch, matchPublicBaseUrlRequest } from "./publicBaseUrl";

describe("publicBaseUrl", () => {
  let tempRoot = "";
  let previousRepoDir = "";
  let previousDefaultRepoDir = "";
  let companySlug = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-public-base-url-"));
    previousRepoDir = config.repoDir;
    const defaultRow = db.prepare("SELECT repo_dir FROM companies WHERE is_default = 1 ORDER BY id LIMIT 1").get() as { repo_dir?: string } | undefined;
    previousDefaultRepoDir = defaultRow?.repo_dir || previousRepoDir;
    companySlug = `public-url-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });

  afterEach(async () => {
    if (companySlug) db.prepare("DELETE FROM companies WHERE slug = ?").run(companySlug);
    if (previousDefaultRepoDir) {
      db.prepare("UPDATE companies SET repo_dir = ? WHERE is_default = 1").run(previousDefaultRepoDir);
    }
    config.repoDir = previousRepoDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("builds encoded public object URLs from the configured base", () => {
    const url = buildPublicObjectUrl(
      "https://files.example.test/assets",
      "public/report #1.txt",
      "public/",
    );
    assert.equal(url, "https://files.example.test/assets/report%20%231.txt");
  });

  it("matches only requests under the configured base path", () => {
    assert.deepEqual(
      matchPublicBaseUrlRequest(
        "https://files.example.test/assets",
        "files.example.test",
        "/assets/report%20%231.txt",
      ),
      { tail: "report%20%231.txt", specificity: "/assets".length },
    );
    assert.equal(
      matchPublicBaseUrlRequest(
        "https://files.example.test/assets",
        "files.example.test",
        "/assets",
      ),
      null,
    );
    assert.equal(
      matchPublicBaseUrlRequest(
        "https://files.example.test/assets",
        "other.example.test",
        "/assets/report%20%231.txt",
      ),
      null,
    );
  });

  it("matches raw IP hosts with explicit ports", () => {
    assert.deepEqual(
      matchPublicBaseUrlRequest(
        "http://204.168.231.255:3100/public-files",
        "204.168.231.255:3100",
        "/public-files/image.png",
      ),
      { tail: "image.png", specificity: "/public-files".length },
    );
  });

  it("resolves public object requests from non-default company storage configs", async () => {
    const defaultRepo = join(tempRoot, "default-repo");
    const companyRepo = join(tempRoot, "company-repo");
    const department = "marketing";
    const publicBaseUrl = `https://${companySlug}.example.test/files`;

    await mkdir(join(defaultRepo, "other"), { recursive: true });
    await mkdir(join(companyRepo, department), { recursive: true });
    await writeFile(join(defaultRepo, "aios.yaml"), "version: 1\ndepartments:\n  - other\n", "utf-8");
    await writeFile(join(companyRepo, "aios.yaml"), `version: 1\ndepartments:\n  - ${department}\n`, "utf-8");
    await writeFile(join(companyRepo, department, ".env"), [
      "AIOS_STORAGE_ENDPOINT=https://storage.example.test",
      "AIOS_STORAGE_REGION=auto",
      "AIOS_STORAGE_BUCKET=aios-test",
      "AIOS_STORAGE_ACCESS_KEY_ID=test-key",
      "AIOS_STORAGE_SECRET_ACCESS_KEY=test-secret",
      `AIOS_STORAGE_PUBLIC_BASE_URL=${publicBaseUrl}`,
      "AIOS_STORAGE_PUBLIC_PREFIX=public/",
      "AIOS_STORAGE_PRIVATE_PREFIX=private/",
      "",
    ].join("\n"), "utf-8");

    config.repoDir = defaultRepo;
    db.prepare("UPDATE companies SET repo_dir = ? WHERE is_default = 1").run(defaultRepo);
    db.prepare(`
      INSERT INTO companies(slug, display_name, repo_full_name, repo_dir, setup_phase, is_default, webhook_secret, created_at, updated_at)
      VALUES(?, ?, NULL, ?, 'complete', 0, ?, ?, ?)
    `).run(companySlug, "Public URL Test", companyRepo, "secret", Date.now(), Date.now());

    const match = await findPublicMatch(`${companySlug}.example.test`, "/files/report.txt");

    assert.equal(match?.company?.slug, companySlug);
    assert.equal(match?.deptName, department);
    assert.equal(match?.key, "public/report.txt");
  });
});
