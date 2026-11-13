import { maxAttempts, retryMilliseconds } from "./config.js";
import { AuthRequiredError } from "./errors.js";
import { executeBooking } from "./reboks.js";
import { dueJobs, getJob, updateJob, withSchedulerLock } from "./store.js";

function wait(milliseconds, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
      } else {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    }
  });
}

function serializableDetails(error) {
  try {
    return JSON.parse(JSON.stringify(error.details || {}));
  } catch {
    return {};
  }
}

export async function runJob(id, { headed = false, dryRun = false } = {}) {
  const job = await getJob(id);
  if (!dryRun && !["pending", "retry", "auth_required", "failed"].includes(job.status)) {
    throw new Error(`Job ${id} has status "${job.status}" and cannot be run again.`);
  }

  if (!dryRun) {
    await updateJob(id, {
      status: "running",
      attempts: Number(job.attempts || 0) + 1,
      lastError: null,
    });
  }

  try {
    const outcome = await executeBooking(job, { dryRun, headed });
    if (!dryRun) {
      await updateJob(id, {
        status: outcome.status,
        outcome,
        completedAt: ["booked", "payment_required", "needs_attention"].includes(
          outcome.status,
        )
          ? new Date().toISOString()
          : null,
      });
    }
    return outcome;
  } catch (error) {
    if (dryRun) throw error;

    const current = await getJob(id);
    if (error instanceof AuthRequiredError || error.code === "AUTH_REQUIRED") {
      await updateJob(id, {
        status: "auth_required",
        lastError: error.message,
      });
      throw error;
    }

    const attempts = Number(current.attempts || 0);
    const canRetry = attempts < maxAttempts;
    await updateJob(id, {
      status: canRetry ? "retry" : "failed",
      nextAttemptAt: canRetry
        ? new Date(Date.now() + retryMilliseconds).toISOString()
        : null,
      lastError: error.message,
      errorDetails: serializableDetails(error),
    });
    throw error;
  }
}

export async function runDueJobs({ headed = false } = {}) {
  return withSchedulerLock(async () => {
    const due = await dueJobs();
    const results = [];
    for (const job of due) {
      try {
        const outcome = await runJob(job.id, { headed });
        results.push({ id: job.id, ok: true, outcome });
      } catch (error) {
        results.push({ id: job.id, ok: false, error: error.message });
      }
    }
    return { skipped: false, results };
  });
}

// A long-lived process is preferable to repeatedly launching Node at the
// release minute. It polls the small local queue twice per second, while the
// scheduler lock prevents a dashboard and the background service racing.
export async function watchDueJobs({ signal, intervalMilliseconds = 500 } = {}) {
  while (!signal?.aborted) {
    await runDueJobs();
    await wait(intervalMilliseconds, signal);
  }
}
