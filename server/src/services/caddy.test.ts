import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { renderManagedCaddyfile } from "./caddy";

describe("caddy", () => {
  it("renders the placeholder config when no hosts are managed", () => {
    const body = renderManagedCaddyfile([], 3100);
    assert.match(body, /AIOS domain setup pending/);
    assert.match(body, /:80/);
  });

  it("renders sorted, deduped host blocks", () => {
    const body = renderManagedCaddyfile(
      ["files.example.test", "dashboard.example.test", "files.example.test"],
      3200,
    );
    assert.match(body, /dashboard\.example\.test \{\s+reverse_proxy localhost:3200/s);
    assert.match(body, /files\.example\.test \{\s+reverse_proxy localhost:3200/s);
    const fileHostMatches = body.match(/files\.example\.test \{/g) || [];
    assert.equal(fileHostMatches.length, 1);
  });
});
