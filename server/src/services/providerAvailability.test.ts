import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { getProviderAvailability, parseProvider } from "./providerAvailability";

describe("providerAvailability", () => {
  let previousAiosHome: string | undefined;
  let tempHome = "";

  beforeEach(async () => {
    previousAiosHome = process.env.AIOS_HOME;
    tempHome = await mkdtemp(join(tmpdir(), "aios-provider-availability-"));
    process.env.AIOS_HOME = tempHome;
  });

  afterEach(async () => {
    if (previousAiosHome === undefined) delete process.env.AIOS_HOME;
    else process.env.AIOS_HOME = previousAiosHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("detects only authorized providers", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "auth.json"), "{}\n", "utf-8");

    const providers = await getProviderAvailability();

    assert.equal(providers.codex, true);
    assert.equal(providers["claude-code"], false);
  });

  it("parses only supported provider ids", () => {
    assert.equal(parseProvider("claude-code"), "claude-code");
    assert.equal(parseProvider("codex"), "codex");
    assert.equal(parseProvider("other"), undefined);
  });
});
