import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  normalizeTimezoneOffsetMinutes,
  timezoneLabel,
  timezoneOffsetToEtcGmt,
} from "./time";

describe("scheduler time helpers", () => {
  it("formats fixed UTC offsets for display", () => {
    assert.equal(timezoneLabel(0), "UTC");
    assert.equal(timezoneLabel(2 * 60), "UTC+02");
    assert.equal(timezoneLabel(-5 * 60), "UTC-05");
  });

  it("maps fixed offsets to IANA Etc/GMT names used by cron-parser", () => {
    assert.equal(timezoneOffsetToEtcGmt(0), "Etc/GMT");
    assert.equal(timezoneOffsetToEtcGmt(2 * 60), "Etc/GMT-2");
    assert.equal(timezoneOffsetToEtcGmt(-5 * 60), "Etc/GMT+5");
  });

  it("rounds and clamps simple UTC offset inputs", () => {
    assert.equal(normalizeTimezoneOffsetMinutes(125), 120);
    assert.equal(normalizeTimezoneOffsetMinutes(-9999), -12 * 60);
    assert.equal(normalizeTimezoneOffsetMinutes(9999), 14 * 60);
  });
});
