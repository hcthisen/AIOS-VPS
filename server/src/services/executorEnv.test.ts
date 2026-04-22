import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { buildRunEnv } from "./executor";

describe("buildRunEnv", () => {
  it("merges department .env while preserving reserved runtime keys", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aios-run-env-"));
    try {
      await writeFile(
        join(cwd, ".env"),
        [
          "HOME=/tmp/override-home",
          "PATH=/tmp/override-path",
          "OPENAI_API_KEY=test-openai-key",
          "AIOS_STORAGE_ACCESS_KEY_ID=dept-access",
          "AIOS_STORAGE_SECRET_ACCESS_KEY=dept-secret",
          "AIOS_STORAGE_REGION=eu-central-1",
        ].join("\n") + "\n",
        "utf-8",
      );

      const env = await buildRunEnv("codex", cwd);
      assert.notEqual(env.HOME, "/tmp/override-home");
      assert.notEqual(env.PATH, "/tmp/override-path");
      assert.equal(env.OPENAI_API_KEY, "test-openai-key");
      assert.equal(env.AWS_ACCESS_KEY_ID, "dept-access");
      assert.equal(env.AWS_SECRET_ACCESS_KEY, "dept-secret");
      assert.equal(env.AWS_REGION, "eu-central-1");
      assert.equal(env.AWS_DEFAULT_REGION, "eu-central-1");
      assert.ok(env.CODEX_HOME, "CODEX_HOME should stay defined for codex runs");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
