import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { cliArgs, parseProviderConversationResult } from "./executor";

describe("executor provider conversation parsing", () => {
  it("extracts Claude session id and final response from JSON output", () => {
    const parsed = parseProviderConversationResult("claude-code", JSON.stringify({
      type: "result",
      result: "Hello from Claude.",
      session_id: "5f1ceac2-4089-46e6-a711-7b171f0fdc6a",
    }));

    assert.equal(parsed.sessionId, "5f1ceac2-4089-46e6-a711-7b171f0fdc6a");
    assert.equal(parsed.finalMessage, "Hello from Claude.");
  });

  it("extracts Codex thread id and latest agent response from JSONL output", () => {
    const parsed = parseProviderConversationResult("codex", [
      JSON.stringify({ type: "thread.started", thread_id: "019dc3cc-096f-7091-b3c2-03d03639b9d2" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer." } }),
    ].join("\n"));

    assert.equal(parsed.sessionId, "019dc3cc-096f-7091-b3c2-03d03639b9d2");
    assert.equal(parsed.finalMessage, "Final answer.");
  });

  it("resumes Codex Telegram sessions with full workspace access by default", () => {
    const invocation = cliArgs("codex", "hello", {
      source: "telegram",
      sessionId: "019dc3cc-096f-7091-b3c2-03d03639b9d2",
    });

    assert.equal(invocation.bin, "codex");
    assert.deepEqual(invocation.args.slice(0, 3), ["exec", "resume", "--json"]);
    assert.ok(invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(invocation.args.includes("019dc3cc-096f-7091-b3c2-03d03639b9d2"));
  });
});
