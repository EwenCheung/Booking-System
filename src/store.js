import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { dataDirectory, jobsFile, schedulerLockFile } from "./config.js";

const EMPTY_STORE = { version: 1, jobs: [] };

async function ensureDataDirectory() {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
}

export async function readStore() {
  await ensureDataDirectory();
  try {
    const contents = await fs.readFile(jobsFile, "utf8");
    const parsed = JSON.parse(contents);
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      throw new Error("Unsupported jobs.json format.");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(EMPTY_STORE);
    throw error;
  }
}

export async function writeStore(store) {
  await ensureDataDirectory();
  const temporaryFile = `${jobsFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryFile, jobsFile);
}

export async function addJob(job) {
  const store = await readStore();
  const record = {
    id: crypto.randomUUID().split("-")[0],
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...job,
  };
  store.jobs.push(record);
  await writeStore(store);
  return record;
}

export async function updateJob(id, update) {
  const store = await readStore();
  const index = store.jobs.findIndex((job) => job.id === id);
  if (index < 0) throw new Error(`Unknown job "${id}".`);
  const nextUpdate =
    typeof update === "function" ? update(store.jobs[index]) : update;
  store.jobs[index] = {
    ...store.jobs[index],
    ...nextUpdate,
    updatedAt: new Date().toISOString(),
  };
  await writeStore(store);
  return store.jobs[index];
}

export async function removeJob(id) {
  const store = await readStore();
  const originalLength = store.jobs.length;
  store.jobs = store.jobs.filter((job) => job.id !== id);
  if (store.jobs.length === originalLength) {
    throw new Error(`Unknown job "${id}".`);
  }
  await writeStore(store);
}

export async function getJob(id) {
  const store = await readStore();
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Unknown job "${id}".`);
  return job;
}

export async function dueJobs(now = new Date()) {
  const store = await readStore();
  return store.jobs.filter((job) => {
    if (!["pending", "retry"].includes(job.status)) return false;
    const scheduled = new Date(job.nextAttemptAt || job.runAt);
    return !Number.isNaN(scheduled.getTime()) && scheduled <= now;
  });
}

export async function withSchedulerLock(callback) {
  await ensureDataDirectory();
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fs.open(schedulerLockFile, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let lock;
      try {
        lock = JSON.parse(await fs.readFile(schedulerLockFile, "utf8")).pid;
      } catch {
        await fs.unlink(schedulerLockFile);
        continue;
      }
      if (!Number.isInteger(lock) || lock < 1) {
        await fs.unlink(schedulerLockFile);
        continue;
      }
      let active = true;
      try {
        process.kill(lock, 0);
      } catch (processError) {
        if (processError.code === "ESRCH") active = false;
        else throw processError;
      }
      if (active) return { skipped: true };
      await fs.unlink(schedulerLockFile);
    }
  }

  if (!handle) return { skipped: true };

  try {
    return await callback();
  } finally {
    await handle.close();
    await fs.unlink(schedulerLockFile).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function ensureOutputDirectory() {
  await fs.mkdir(path.resolve(dataDirectory, "..", "output", "playwright"), {
    recursive: true,
  });
}
