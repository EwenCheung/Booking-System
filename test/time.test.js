import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReboksDate,
  parseClock,
  parseDateOnly,
  parseRunAt,
  releaseAtForDate,
  textContainsTime,
} from "../src/time.js";

test("formats dates the way the REBOKS date field expects", () => {
  assert.equal(formatReboksDate("2027-01-14"), "Thu, 14 Jan 2027");
});

test("uses the current NUS inclusive-day release example", () => {
  assert.equal(
    releaseAtForDate("2027-01-14", {
      advanceDays: 13,
      releaseTime: "12:00",
    }).toISOString(),
    "2027-01-01T04:00:00.000Z",
  );
});

test("parses a local run-at value as Singapore time", () => {
  assert.equal(parseRunAt("2027-01-01T12:00").toISOString(), "2027-01-01T04:00:00.000Z");
});

test("validates impossible dates and clocks", () => {
  assert.throws(() => parseDateOnly("2027-02-29"), /Invalid calendar date/);
  assert.throws(() => parseClock("25:00"), /Invalid time/);
});

test("matches both 24-hour and 12-hour REBOKS labels", () => {
  assert.equal(textContainsTime("18:00 - 19:00 Available", "18:00"), true);
  assert.equal(textContainsTime("6:00 PM to 7:00 PM", "18:00"), true);
  assert.equal(textContainsTime("Court 01;15;128450;18:00:00;19:00:00", "18:00"), true);
  assert.equal(textContainsTime("7:00 PM to 8:00 PM", "18:00"), false);
});
