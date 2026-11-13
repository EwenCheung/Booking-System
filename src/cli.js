#!/usr/bin/env node

import process from "node:process";

import { parseArguments, numberFlag, requireFlags } from "./args.js";
import { loginInteractively } from "./browser.js";
import { defaultReleaseDays, defaultReleaseTime } from "./config.js";
import { discoverFacilitiesDirect } from "./fast-reboks.js";
import { getAvailability } from "./reboks.js";
import { createBookingJob } from "./jobs.js";
import { runDueJobs, runJob, watchDueJobs } from "./scheduler.js";
import { installService, serviceStatus, uninstallService } from "./service.js";
import { readStore, removeJob } from "./store.js";
import {
  formatSingaporeTimestamp,
  parseDateOnly,
} from "./time.js";

const HELP = `NUS REBOKS booking helper

Usage:
  npm run login -- [--role student|staff|guest]
  npm run booking -- discover [--activity Badminton]
  npm run availability -- --activity Badminton --venue "..." --date YYYY-MM-DD [--headed]
  npm run booking -- queue add --activity Badminton --venue "..." --date YYYY-MM-DD --start HH:mm [options]
  npm run booking -- queue list
  npm run booking -- queue remove JOB_ID
  npm run booking -- run JOB_ID [--dry-run] [--headed]
  npm run booking -- watch
  npm run scheduler
  npm run service:install

Queue options:
  --end HH:mm                End time, when needed to disambiguate
  --resource TEXT            Court/resource text when search returns several results
  --run-at TIMESTAMP         Override calculated release time; local form uses Singapore time
  --release-days N           Default: ${defaultReleaseDays}
  --release-time HH:mm       Default: ${defaultReleaseTime}
  --max-price N              Maximum authorised charge in SGD; default 0

The login command saves browser cookies in data/browser-profile. It never stores a password.
`;

function printAvailability(result) {
  if (result.details?.length) {
    for (const detail of result.details) {
      console.log(`\n${detail.resource.text || detail.resource.href}`);
      if (detail.slots.length) {
        console.table(
          detail.slots.map((slot) => ({
            available: !slot.disabled,
            time: slot.label,
          })),
        );
      } else {
        console.log(detail.message || "No timeslots found.");
      }
    }
    return;
  }

  if (result.slots.length) {
    console.table(
      result.slots.map((slot) => ({ available: !slot.disabled, time: slot.label })),
    );
  } else if (result.resources.length) {
    console.table(result.resources.map((resource) => ({ resource: resource.text, url: resource.href })));
  } else {
    console.log(result.message || "No matching facilities or timeslots found.");
  }
}

async function commandDiscover(flags) {
  const result = await discoverFacilitiesDirect(flags.activity);
  console.table(result.activities);
  if (flags.activity) console.table(result.venues);
}

async function commandAvailability(flags) {
  requireFlags(flags, ["activity", "venue", "date"]);
  parseDateOnly(flags.date);
  const result = await getAvailability(flags, { headed: Boolean(flags.headed) });
  printAvailability(result);
}

async function commandQueue(positional, flags) {
  const action = positional[1];
  if (action === "add") {
    requireFlags(flags, ["activity", "venue", "date", "start"]);
    const job = await createBookingJob({
      activity: flags.activity,
      venue: flags.venue,
      date: flags.date,
      start: flags.start,
      end: flags.end,
      resource: flags.resource,
      maxPrice: numberFlag(flags, "max-price", 0),
      runAt: flags["run-at"],
      releaseDays: numberFlag(flags, "release-days", defaultReleaseDays),
      releaseTime: flags["release-time"] || defaultReleaseTime,
    });
    console.log(`Queued job ${job.id}.`);
    console.log(`Execution time: ${formatSingaporeTimestamp(job.runAt)} (Singapore)`);
    console.log(
      "Run `npm run service:install` once so macOS checks the queue after login and reboot.",
    );
    return;
  }

  if (action === "list") {
    const store = await readStore();
    console.table(
      store.jobs.map((job) => ({
        id: job.id,
        status: job.status,
        facility: `${job.activity} — ${job.venue}`,
        slot: `${job.date} ${job.start}${job.end ? `-${job.end}` : ""}`,
        runAt: formatSingaporeTimestamp(job.nextAttemptAt || job.runAt),
        attempts: job.attempts,
        error: job.lastError || "",
      })),
    );
    return;
  }

  if (action === "remove") {
    const id = positional[2];
    if (!id) throw new Error("Provide the job ID to remove.");
    await removeJob(id);
    console.log(`Removed job ${id}.`);
    return;
  }

  throw new Error("Use `queue add`, `queue list`, or `queue remove JOB_ID`.");
}

async function commandService(positional) {
  const action = positional[1];
  if (action === "install") {
    const file = await installService();
    console.log(`Installed and started macOS scheduler: ${file}`);
    return;
  }
  if (action === "uninstall") {
    const file = await uninstallService();
    console.log(`Stopped and removed macOS scheduler: ${file}`);
    return;
  }
  if (action === "status") {
    console.log(await serviceStatus());
    return;
  }
  throw new Error("Use `service install`, `service uninstall`, or `service status`.");
}

async function main() {
  const { positional, flags } = parseArguments(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === "help" || flags.help) {
    console.log(HELP);
    return;
  }

  if (command === "login") {
    await loginInteractively({ role: flags.role || "student" });
  } else if (command === "discover") {
    await commandDiscover(flags);
  } else if (command === "availability") {
    await commandAvailability(flags);
  } else if (command === "queue") {
    await commandQueue(positional, flags);
  } else if (command === "run") {
    const id = positional[1];
    if (!id) throw new Error("Provide the job ID to run.");
    console.log(
      await runJob(id, {
        headed: Boolean(flags.headed),
        dryRun: Boolean(flags["dry-run"]),
      }),
    );
  } else if (command === "run-due") {
    const result = await runDueJobs({ headed: Boolean(flags.headed) });
    if (result.skipped) console.log("Another scheduler process is already running.");
    for (const item of result.results || []) console.log(item);
  } else if (command === "watch") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log("Watching the local REBOKS queue (checks twice per second). Press Ctrl+C to stop.");
    await watchDueJobs({ signal: controller.signal });
  } else if (command === "service") {
    await commandService(positional);
  } else {
    throw new Error(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main().catch((error) => {
  console.error(`${error.name || "Error"}: ${error.message}`);
  if (process.env.DEBUG && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
