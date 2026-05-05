import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { PeerCertificate } from "tls";

import {
  shouldManageHttpsPublicBaseUrl,
  validateCertificateForHost,
} from "./storagePublicUrlRepair";

describe("storagePublicUrlRepair", () => {
  it("manages only standard HTTPS hostnames", () => {
    assert.equal(shouldManageHttpsPublicBaseUrl("").manage, false);
    assert.equal(shouldManageHttpsPublicBaseUrl("http://files.example.test").manage, false);
    assert.equal(shouldManageHttpsPublicBaseUrl("https://203.0.113.10/files").manage, false);
    assert.equal(shouldManageHttpsPublicBaseUrl("https://files.example.test:8443/files").manage, false);
    assert.equal(shouldManageHttpsPublicBaseUrl("https://files.example.test/files").manage, true);
  });

  it("accepts a live certificate that matches the hostname", () => {
    const cert = {
      valid_from: new Date(Date.now() - 60_000).toUTCString(),
      valid_to: new Date(Date.now() + 60_000).toUTCString(),
      subjectaltname: "DNS:files.example.test",
    } as PeerCertificate;

    const result = validateCertificateForHost("files.example.test", cert);
    assert.equal(result.ok, true);
  });

  it("rejects expired and mismatched certificates", () => {
    const expired = {
      valid_from: new Date(Date.now() - 120_000).toUTCString(),
      valid_to: new Date(Date.now() - 60_000).toUTCString(),
      subjectaltname: "DNS:files.example.test",
    } as PeerCertificate;
    const mismatched = {
      valid_from: new Date(Date.now() - 60_000).toUTCString(),
      valid_to: new Date(Date.now() + 60_000).toUTCString(),
      subjectaltname: "DNS:other.example.test",
    } as PeerCertificate;

    assert.equal(validateCertificateForHost("files.example.test", expired).ok, false);
    assert.equal(validateCertificateForHost("files.example.test", mismatched).ok, false);
  });
});
