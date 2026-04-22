import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { buildPublicObjectUrl, matchPublicBaseUrlRequest } from "./publicBaseUrl";

describe("publicBaseUrl", () => {
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
});
