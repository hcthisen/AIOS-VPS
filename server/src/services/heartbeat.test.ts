import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildGoalWakePrompt,
  isGoalScheduleAllowed,
  MIN_GOAL_INTERVAL_MS,
} from "./heartbeat";

describe("heartbeat goal scheduling", () => {
  it("rejects goal wake schedules below the minimum interval", () => {
    assert.equal(isGoalScheduleAllowed("* * * * *"), false);
    assert.equal(isGoalScheduleAllowed("*/5 * * * *"), false);
    assert.equal(isGoalScheduleAllowed("*/10 * * * *"), true);
    assert.equal(isGoalScheduleAllowed("0 9 * * *"), true);
  });

  it("allows callers to tune the minimum interval", () => {
    assert.equal(isGoalScheduleAllowed("*/5 * * * *", 5 * 60_000), true);
    assert.equal(isGoalScheduleAllowed("*/5 * * * *", MIN_GOAL_INTERVAL_MS), false);
  });

  it("adds wake schedule and self-tuning instructions to goal prompts", () => {
    const prompt = buildGoalWakePrompt({
      relPath: "trading1/goals/strategy.md",
      schedule: "0 9 * * *",
      prompt: "Build the strategy.",
    });

    assert.match(prompt, /Goal file: trading1\/goals\/strategy\.md/);
    assert.match(prompt, /Current wake schedule: 0 9 \* \* \*/);
    assert.match(prompt, /Minimum wake interval: 10 minutes/);
    assert.match(prompt, /Never delete this goal/);
    assert.match(prompt, /Build the strategy/);
  });
});
