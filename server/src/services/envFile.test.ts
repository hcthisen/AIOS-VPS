import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  applyUpdates,
  parseEnv,
  serializeEnv,
  toMap,
} from "./envFile";

describe("envFile", () => {
  it("parses simple key=value", () => {
    const entries = parseEnv("FOO=bar\nBAZ=qux\n");
    const map = toMap(entries);
    assert.equal(map.FOO, "bar");
    assert.equal(map.BAZ, "qux");
  });

  it("parses quoted values with spaces and equals", () => {
    const entries = parseEnv('NAME="hello world"\nURL="https://x.test/?a=1"\n');
    const map = toMap(entries);
    assert.equal(map.NAME, "hello world");
    assert.equal(map.URL, "https://x.test/?a=1");
  });

  it("preserves comments and blank lines on write", () => {
    const text = "# header comment\nFOO=bar\n\n# trailing\nBAZ=qux\n";
    const entries = parseEnv(text);
    const out = serializeEnv(entries);
    assert.match(out, /# header comment/);
    assert.match(out, /FOO=bar/);
    assert.match(out, /# trailing/);
    assert.match(out, /BAZ=qux/);
  });

  it("applyUpdates updates in place and appends unknown keys", () => {
    const entries = parseEnv("# comment\nFOO=old\nBAR=stable\n");
    const next = applyUpdates(entries, { FOO: "new", NEW: "value" });
    const map = toMap(next);
    assert.equal(map.FOO, "new");
    assert.equal(map.BAR, "stable");
    assert.equal(map.NEW, "value");
    const out = serializeEnv(next);
    assert.match(out, /^# comment/);
  });

  it("applyUpdates removes keys listed in removeKeys", () => {
    const entries = parseEnv("A=1\nB=2\nC=3\n");
    const next = applyUpdates(entries, {}, ["B"]);
    const map = toMap(next);
    assert.equal(map.A, "1");
    assert.equal(map.B, undefined);
    assert.equal(map.C, "3");
  });

  it("quotes values that need quoting on write", () => {
    const entries = parseEnv("FOO=bar\n");
    const next = applyUpdates(entries, { FOO: "value with spaces" });
    const out = serializeEnv(next);
    assert.match(out, /FOO="value with spaces"/);
  });

  it("does not interpolate $ in values", () => {
    const entries = parseEnv("SECRET=before\n");
    const next = applyUpdates(entries, { SECRET: "literal$VALUE" });
    const map = toMap(parseEnv(serializeEnv(next)));
    assert.equal(map.SECRET, "literal$VALUE");
  });

  it("handles CRLF input", () => {
    const entries = parseEnv("FOO=1\r\nBAR=2\r\n");
    const map = toMap(entries);
    assert.equal(map.FOO, "1");
    assert.equal(map.BAR, "2");
  });
});
