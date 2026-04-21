import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  hasManagedSection,
  stripManagedSection,
  upsertManagedBlock,
} from "./managedSection";

describe("managedSection", () => {
  it("inserts a section into an empty file", () => {
    const out = upsertManagedBlock("", "storage", "## File storage\nhello");
    assert.match(out, /aios:managed:storage start/);
    assert.match(out, /aios:managed:storage end/);
    assert.match(out, /## File storage/);
  });

  it("appends to an existing file without stomping operator content", () => {
    const prev = "# Department context\n\nOperator notes here.\n";
    const out = upsertManagedBlock(prev, "storage", "## File storage\nbody");
    assert.match(out, /Operator notes here\./);
    assert.match(out, /## File storage/);
  });

  it("is idempotent — re-upsert replaces the block, does not duplicate", () => {
    let content = upsertManagedBlock("base", "storage", "## File storage\nv1");
    content = upsertManagedBlock(content, "storage", "## File storage\nv2");
    const matches = content.match(/aios:managed:storage start/g) || [];
    assert.equal(matches.length, 1);
    assert.match(content, /v2/);
    assert.doesNotMatch(content, /v1/);
  });

  it("strips the section cleanly", () => {
    const withSection = upsertManagedBlock("hello\n", "storage", "## File storage\nbody");
    assert.ok(hasManagedSection(withSection, "storage"));
    const stripped = stripManagedSection(withSection, "storage");
    assert.ok(!hasManagedSection(stripped, "storage"));
    assert.match(stripped, /hello/);
  });

  it("removal is no-op when marker absent", () => {
    const content = "just text\n";
    const stripped = stripManagedSection(content, "storage");
    assert.equal(stripped, content);
  });

  it("leaves sibling managed sections alone", () => {
    let content = upsertManagedBlock("", "storage", "## File storage\ns");
    content = upsertManagedBlock(content, "notes", "## Notes\nn");
    content = stripManagedSection(content, "storage");
    assert.ok(!hasManagedSection(content, "storage"));
    assert.ok(hasManagedSection(content, "notes"));
  });
});
