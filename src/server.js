#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseArguments } from "./args.js";
import { loginInteractively } from "./browser.js";
import {
  defaultReleaseDays,
  defaultReleaseTime,
  projectDirectory,
} from "./config.js";
import { AuthRequiredError, BookingFlowError } from "./errors.js";
import { discoverFacilitiesDirect } from "./fast-reboks.js";
import { getAvailability } from "./reboks.js";
import { createBookingJob } from "./jobs.js";
import { runDueJobs, runJob } from "./scheduler.js";
import { installService, serviceStatus, uninstallService } from "./service.js";
import { hasSavedSession } from "./session.js";
import { getJob, readStore, removeJob } from "./store.js";

const executeFile = promisify(execFile);
const currentFile = fileURLToPath(import.meta.url);
const publicDirectory = path.join(projectDirectory, "web");
const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/favicon.svg", { file: "favicon.svg", type: "image/svg+xml" }],
]);

const runtime = {
  schedulerActive: false,
  schedulerLastCheckedAt: null,
  schedulerLastResults: [],
  schedulerLastError: null,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function checkSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Invalid request origin.");
  }
  if (originHost !== request.headers.host) {
    throw new HttpError(403, "Cross-origin dashboard actions are not allowed.");
  }
}

async function readJson(request) {
  checkSameOrigin(request);
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new HttpError(415, "Dashboard actions require application/json.");
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new HttpError(413, "Request body is too large.");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    activity: job.activity,
    venue: job.venue,
    resource: job.resource,
    date: job.date,
    start: job.start,
    end: job.end,
    maxPrice: job.maxPrice,
    runAt: job.runAt,
    nextAttemptAt: job.nextAttemptAt,
    releaseRule: job.releaseRule,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    lastError: job.lastError,
    outcome: job.outcome,
  };
}

async function dashboardState() {
  const [store, service, sessionSaved] = await Promise.all([
    readStore(),
    serviceStatus(),
    hasSavedSession(),
  ]);
  return {
    now: new Date().toISOString(),
    jobs: [...store.jobs].reverse().map(publicJob),
    service: { installed: service.installed, platform: service.platform || process.platform },
    sessionSaved,
    scheduler: { ...runtime },
    defaults: {
      releaseDays: defaultReleaseDays,
      releaseTime: defaultReleaseTime,
      timeZone: "Asia/Singapore",
    },
  };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(response, 200, await dashboardState());
  }

  if (request.method === "GET" && url.pathname === "/api/catalog") {
    const activity = url.searchParams.get("activity") || undefined;
    const catalog = await discoverFacilitiesDirect(activity);
    return json(response, 200, catalog);
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(request);
    await loginInteractively({ role: body.role || "student", waitForEnter: false });
    return json(response, 200, { ok: true, message: "REBOKS login verified and saved." });
  }

  if (request.method === "POST" && url.pathname === "/api/availability") {
    const body = await readJson(request);
    const result = await getAvailability(body);
    return json(response, 200, result);
  }

  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readJson(request);
    const job = await createBookingJob(body);
    return json(response, 201, { job: publicJob(job) });
  }

  const jobRoute = /^\/api\/jobs\/([a-zA-Z0-9_-]+)(?:\/(run))?$/.exec(url.pathname);
  if (jobRoute && request.method === "DELETE" && !jobRoute[2]) {
    checkSameOrigin(request);
    const job = await getJob(jobRoute[1]);
    if (job.status === "running") throw new HttpError(409, "A running job cannot be removed.");
    await removeJob(jobRoute[1]);
    return json(response, 200, { ok: true });
  }

  if (jobRoute && request.method === "POST" && jobRoute[2] === "run") {
    const body = await readJson(request);
    const outcome = await runJob(jobRoute[1], {
      dryRun: Boolean(body.dryRun),
      headed: Boolean(body.headed),
    });
    return json(response, 200, { outcome });
  }

  if (request.method === "POST" && url.pathname === "/api/scheduler/run") {
    await readJson(request);
    const result = await checkDueJobs();
    return json(response, 200, result);
  }

  if (request.method === "POST" && url.pathname === "/api/service/install") {
    await readJson(request);
    const file = await installService();
    return json(response, 200, { ok: true, file });
  }

  if (request.method === "POST" && url.pathname === "/api/service/uninstall") {
    await readJson(request);
    const file = await uninstallService();
    return json(response, 200, { ok: true, file });
  }

  throw new HttpError(404, "API endpoint not found.");
}

async function serveStatic(response, pathname) {
  const asset = staticFiles.get(pathname);
  if (!asset) throw new HttpError(404, "Page not found.");
  const contents = await fs.readFile(path.join(publicDirectory, asset.file));
  response.writeHead(200, {
    "content-type": asset.type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  });
  response.end(contents);
}

function errorStatus(error) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof AuthRequiredError) return 401;
  if (error instanceof BookingFlowError) return 422;
  if (/already in use by process/i.test(error.message)) return 409;
  return 400;
}

export function createDashboardServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
      } else if (request.method === "GET" || request.method === "HEAD") {
        await serveStatic(response, url.pathname);
      } else {
        throw new HttpError(405, "Method not allowed.");
      }
    } catch (error) {
      if (!response.headersSent) {
        json(response, errorStatus(error), {
          error: error.message || "Unexpected dashboard error.",
          code: error.code || null,
        });
      } else {
        response.end();
      }
    }
  });
}

async function checkDueJobs() {
  try {
    const result = await runDueJobs();
    runtime.schedulerLastCheckedAt = new Date().toISOString();
    runtime.schedulerLastResults = result.results || [];
    runtime.schedulerLastError = null;
    return result;
  } catch (error) {
    runtime.schedulerLastCheckedAt = new Date().toISOString();
    runtime.schedulerLastError = error.message;
    throw error;
  }
}

async function openDashboard(url) {
  if (process.platform === "darwin") return executeFile("open", [url]);
  if (process.platform === "win32") return executeFile("cmd", ["/c", "start", "", url]);
  return executeFile("xdg-open", [url]);
}

export async function startDashboard({ port = 4173, open = false } = {}) {
  const server = createDashboardServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  runtime.schedulerActive = true;
  checkDueJobs().catch(() => {});
  const schedulerTimer = setInterval(() => checkDueJobs().catch(() => {}), 500);
  schedulerTimer.unref();

  server.once("close", () => {
    clearInterval(schedulerTimer);
    runtime.schedulerActive = false;
  });
  console.log(`REBOKS dashboard: ${url}`);
  if (open) await openDashboard(url).catch(() => {});
  return { server, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const { flags } = parseArguments(process.argv.slice(2));
  const port = flags.port ? Number(flags.port) : Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error("--port must be a whole number from 0 to 65535.");
    process.exitCode = 1;
  } else {
    const running = await startDashboard({ port, open: Boolean(flags.open) });
    const close = () => running.server.close(() => process.exit(0));
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }
}
