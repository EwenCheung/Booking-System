import { defaultReleaseDays, defaultReleaseTime } from "./config.js";
import { addJob } from "./store.js";
import {
  clockToMinutes,
  parseClock,
  parseDateOnly,
  parseRunAt,
  releaseAtForDate,
} from "./time.js";

function requiredText(value, label, maximumLength = 160) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximumLength) {
    throw new Error(`${label} must be ${maximumLength} characters or fewer.`);
  }
  return normalized;
}

function optionalText(value, maximumLength = 160) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (normalized.length > maximumLength) {
    throw new Error(`Resource must be ${maximumLength} characters or fewer.`);
  }
  return normalized || null;
}

function finiteNumber(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`);
  return number;
}

export function prepareBookingJob(input) {
  const activity = requiredText(input.activity, "Activity");
  const venue = requiredText(input.venue, "Venue");
  const date = requiredText(input.date, "Date", 10);
  const start = requiredText(input.start, "Start time", 5);
  const end = input.end ? requiredText(input.end, "End time", 5) : null;
  parseDateOnly(date);
  parseClock(start);
  if (end) {
    parseClock(end);
    if (clockToMinutes(end) <= clockToMinutes(start)) {
      throw new Error("End time must be later than start time.");
    }
  }

  const releaseDays = finiteNumber(
    input.releaseDays,
    defaultReleaseDays,
    "Release days",
  );
  if (!Number.isInteger(releaseDays) || releaseDays < 0 || releaseDays > 90) {
    throw new Error("Release days must be a whole number from 0 to 90.");
  }
  const releaseTime = input.releaseTime || defaultReleaseTime;
  parseClock(releaseTime);

  const explicitRunAt = parseRunAt(input.runAt);
  const runAt =
    explicitRunAt ||
    releaseAtForDate(date, {
      advanceDays: releaseDays,
      releaseTime,
    });
  const maxPrice = finiteNumber(input.maxPrice, 0, "Maximum price");
  if (maxPrice < 0 || maxPrice > 10_000) {
    throw new Error("Maximum price must be between 0 and 10,000 SGD.");
  }

  return {
    activity,
    venue,
    date,
    start,
    end,
    resource: optionalText(input.resource),
    maxPrice,
    runAt: runAt.toISOString(),
    releaseRule: explicitRunAt
      ? { type: "explicit" }
      : { type: "calculated", releaseDays, releaseTime },
    automationAuthorisedAt: new Date().toISOString(),
  };
}

export async function createBookingJob(input) {
  return addJob(prepareBookingJob(input));
}
