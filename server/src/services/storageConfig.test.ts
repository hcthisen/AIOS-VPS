import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  fromEnvMap,
  maskAccessKey,
  normalizeOptionalUrl,
  normalizeUrl,
  validateConfig,
} from "./storageConfig";

describe("storageConfig", () => {
  it("maskAccessKey redacts all but last 4", () => {
    assert.equal(maskAccessKey("AKIAIOSFODNN7EXAMPLE"), "****MPLE");
    assert.equal(maskAccessKey("abcd"), "****");
    assert.equal(maskAccessKey(""), "");
  });

  it("fromEnvMap requires endpoint + bucket + access + secret", () => {
    assert.equal(fromEnvMap({}), null);
    assert.equal(
      fromEnvMap({
        AIOS_STORAGE_ENDPOINT: "https://x.test",
        AIOS_STORAGE_BUCKET: "b",
        AIOS_STORAGE_ACCESS_KEY_ID: "k",
      }),
      null,
      "missing secret should be null",
    );
  });

  it("fromEnvMap fills in defaults for prefixes", () => {
    const cfg = fromEnvMap({
      AIOS_STORAGE_ENDPOINT: "https://x.test",
      AIOS_STORAGE_BUCKET: "b",
      AIOS_STORAGE_ACCESS_KEY_ID: "k",
      AIOS_STORAGE_SECRET_ACCESS_KEY: "s",
    });
    assert.ok(cfg);
    assert.equal(cfg!.publicPrefix, "public/");
    assert.equal(cfg!.privatePrefix, "private/");
    assert.equal(cfg!.region, "us-east-1");
  });

  it("validateConfig trims endpoint trailing slash and normalizes prefixes", () => {
    const cfg = validateConfig({
      endpoint: "https://x.test/",
      region: "eu-central-1",
      bucket: "my-bucket",
      accessKeyId: "k",
      secretAccessKey: "s",
      publicBaseUrl: "https://cdn.example/",
      publicPrefix: "media",
      privatePrefix: "secret",
    });
    assert.equal(cfg.endpoint, "https://x.test");
    assert.equal(cfg.publicBaseUrl, "https://cdn.example");
    assert.equal(cfg.publicPrefix, "media/");
    assert.equal(cfg.privatePrefix, "secret/");
  });

  it("normalizes scheme-less URLs to https", () => {
    assert.equal(normalizeUrl("s3.example.test", "endpoint"), "https://s3.example.test");
    assert.equal(normalizeOptionalUrl("cdn.example.test/path/", "publicBaseUrl"), "https://cdn.example.test/path");
  });

  it("keeps explicit http URLs intact", () => {
    assert.equal(normalizeUrl("http://minio.internal:9000/", "endpoint"), "http://minio.internal:9000");
  });

  it("validateConfig rejects bad inputs", () => {
    assert.throws(() => validateConfig({ endpoint: "", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }));
    assert.throws(() => validateConfig({ endpoint: "not-a-url", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }));
    assert.throws(() => validateConfig({ endpoint: "https://x", bucket: "Bad_Name", accessKeyId: "k", secretAccessKey: "s" }));
    assert.throws(() => validateConfig({ endpoint: "https://x", bucket: "b", accessKeyId: "", secretAccessKey: "s" }));
    assert.throws(() => validateConfig({ endpoint: "https://x", bucket: "b", accessKeyId: "k", secretAccessKey: "" }));
  });

  it("fromEnvMap normalizes stored URLs", () => {
    const cfg = fromEnvMap({
      AIOS_STORAGE_ENDPOINT: "s3.example.test",
      AIOS_STORAGE_BUCKET: "bucket-name",
      AIOS_STORAGE_ACCESS_KEY_ID: "k",
      AIOS_STORAGE_SECRET_ACCESS_KEY: "s",
      AIOS_STORAGE_PUBLIC_BASE_URL: "cdn.example.test/assets/",
    });
    assert.ok(cfg);
    assert.equal(cfg!.endpoint, "https://s3.example.test");
    assert.equal(cfg!.publicBaseUrl, "https://cdn.example.test/assets");
  });
});
