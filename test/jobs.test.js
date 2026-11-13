import assert from "node:assert/strict";
import test from "node:test";

import { prepareBookingJob } from "../src/jobs.js";

test("normalizes a dashboard booking and calculates its release", () => {
  const job = prepareBookingJob({
    activity: " Badminton ",
    venue: "Kent Ridge - Multi-purpose Sports Hall 5",
    date: "2027-01-14",
    start: "18:00",
    end: "19:00",
    maxPrice: "0",
    releaseDays: 13,
    releaseTime: "12:00",
  });
  assert.equal(job.activity, "Badminton");
  assert.equal(job.runAt, "2027-01-01T04:00:00.000Z");
  assert.equal(job.maxPrice, 0);
});

test("rejects an end time that is not after the start", () => {
  assert.throws(
    () =>
      prepareBookingJob({
        activity: "Badminton",
        venue: "Venue",
        date: "2027-01-14",
        start: "19:00",
        end: "18:00",
      }),
    /End time must be later/,
  );
});
