import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import { mergeStoredCredentials, readStorageConfig, writeStorageConfig } from "./storageConfig";

describe("mergeStoredCredentials", () => {
  let tempRoot = "";
  const prevRepoDir = config.repoDir;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-storage-config-"));
    config.repoDir = tempRoot;
    await mkdir(join(tempRoot, "sample"), { recursive: true });
    await writeFile(join(tempRoot, "aios.yaml"), "departments:\n  - sample\n", "utf-8");
    await writeFile(
      join(tempRoot, "sample", ".env"),
      [
        "AIOS_STORAGE_ENDPOINT=https://s3.example.test",
        "AIOS_STORAGE_REGION=auto",
        "AIOS_STORAGE_BUCKET=assets-bucket",
        "AIOS_STORAGE_ACCESS_KEY_ID=stored-access",
        "AIOS_STORAGE_SECRET_ACCESS_KEY=stored-secret",
      ].join("\n") + "\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    config.repoDir = prevRepoDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("reuses stored credentials when fields are omitted", async () => {
    const merged = await mergeStoredCredentials("sample", {
      endpoint: "https://s3.example.test",
      bucket: "assets-bucket",
      region: "auto",
    });
    assert.equal(merged.accessKeyId, "stored-access");
    assert.equal(merged.secretAccessKey, "stored-secret");
  });

  it("preserves explicitly provided credentials", async () => {
    const merged = await mergeStoredCredentials("sample", {
      accessKeyId: "fresh-access",
      secretAccessKey: "fresh-secret",
    });
    assert.equal(merged.accessKeyId, "fresh-access");
    assert.equal(merged.secretAccessKey, "fresh-secret");
  });

  it("creates a missing .env when saving storage config", async () => {
    await rm(join(tempRoot, "sample", ".env"), { force: true });

    await writeStorageConfig("sample", {
      endpoint: "https://s3.example.test",
      region: "auto",
      bucket: "assets-bucket",
      accessKeyId: "fresh-access",
      secretAccessKey: "fresh-secret",
      publicBaseUrl: "https://files.example.test/public",
      publicPrefix: "public/",
      privatePrefix: "private/",
    });

    const stored = await readStorageConfig("sample");
    assert.equal(stored?.endpoint, "https://s3.example.test");
    assert.equal(stored?.bucket, "assets-bucket");
    assert.equal(stored?.accessKeyId, "fresh-access");
    assert.equal(stored?.secretAccessKey, "fresh-secret");
    assert.equal(stored?.publicBaseUrl, "https://files.example.test/public");
  });
});
