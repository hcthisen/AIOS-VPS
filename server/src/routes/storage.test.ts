import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { collectObjectListing, encodeObjectPath, publicUrlFor } from "./storage";
import type { StorageConfig } from "../services/storageConfig";

const baseConfig: StorageConfig = {
  endpoint: "https://s3.example.test",
  region: "us-east-1",
  bucket: "assets-bucket",
  accessKeyId: "key",
  secretAccessKey: "secret",
  publicBaseUrl: "https://cdn.example.test/assets",
  publicPrefix: "public-files/",
  privatePrefix: "private-files/",
};

describe("storage route helpers", () => {
  it("collectObjectListing follows continuation tokens and merges pages", async () => {
    const calls: Array<string | undefined> = [];
    const listed = await collectObjectListing(async (token) => {
      calls.push(token);
      if (!token) {
        return {
          prefixes: ["public-files/images/"],
          objects: [{ key: "public-files/images/hero one.png", size: 1 }],
          nextToken: "page-2",
          keyCount: 1,
        };
      }
      return {
        prefixes: ["public-files/videos/"],
        objects: [{ key: "public-files/videos/demo.mp4", size: 2 }],
        nextToken: undefined,
        keyCount: 1,
      };
    });

    assert.deepEqual(calls, [undefined, "page-2"]);
    assert.deepEqual(listed.prefixes, ["public-files/images/", "public-files/videos/"]);
    assert.equal(listed.objects.length, 2);
    assert.equal(listed.nextToken, undefined);
  });

  it("encodes public object paths segment by segment", () => {
    assert.equal(encodeObjectPath("images/hero one#.png"), "images/hero%20one%23.png");
    assert.equal(
      publicUrlFor(baseConfig, "public-files/images/hero one#.png"),
      "https://cdn.example.test/assets/images/hero%20one%23.png",
    );
  });
});
