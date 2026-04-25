import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { startRun } from "./executor";

describe("executor provider auth", () => {
  let previousAiosHome: string | undefined;
  let tempHome = "";

  beforeEach(async () => {
    previousAiosHome = process.env.AIOS_HOME;
    tempHome = await mkdtemp(join(tmpdir(), "aios-executor-provider-auth-"));
    process.env.AIOS_HOME = tempHome;
  });

  afterEach(async () => {
    if (previousAiosHome === undefined) delete process.env.AIOS_HOME;
    else process.env.AIOS_HOME = previousAiosHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("cancels explicit runs for unauthorized providers before claiming", async () => {
    const result = await startRun({
      departments: ["_root"],
      trigger: "manual",
      prompt: "hello",
      provider: "codex",
    });

    assert.equal(result.accepted, false);
    assert.equal(result.run.status, "canceled");
    assert.match(result.reason || "", /Codex is not authorized/);
  });
});
