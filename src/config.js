import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const srcDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectDirectory = path.resolve(srcDirectory, "..");

// Keep configuration local without adding a dependency. Existing environment
// variables win over .env values, and credentials are deliberately unsupported.
try {
  const environmentFile = fs.readFileSync(path.join(projectDirectory, ".env"), "utf8");
  for (const line of environmentFile.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

export const dataDirectory = path.join(projectDirectory, "data");
export const browserProfileDirectory = path.join(dataDirectory, "browser-profile");
export const jobsFile = path.join(dataDirectory, "jobs.json");
export const schedulerLockFile = path.join(dataDirectory, "scheduler.lock");
export const outputDirectory = path.join(projectDirectory, "output", "playwright");

export const baseUrl = (
  process.env.REBOKS_BASE_URL ||
  "https://reboks.nus.edu.sg/nus_public_web/public/index.php"
).replace(/\/$/, "");

export const facilitiesUrl = `${baseUrl}/facilities`;
export const authUrl = `${baseUrl}/auth`;

export const defaultReleaseDays = Number.parseInt(
  process.env.REBOKS_RELEASE_DAYS || "13",
  10,
);
export const defaultReleaseTime = process.env.REBOKS_RELEASE_TIME || "12:00";
export const defaultHeadless = process.env.REBOKS_HEADLESS !== "false";
export const maxAttempts = Number.parseInt(process.env.REBOKS_MAX_ATTEMPTS || "3", 10);
export const retryMilliseconds = Number.parseInt(
  process.env.REBOKS_RETRY_MS || "5000",
  10,
);

export const singaporeTimeZone = "Asia/Singapore";
