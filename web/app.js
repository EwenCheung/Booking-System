const elements = {
  activity: document.querySelector("#activity"),
  venue: document.querySelector("#venue"),
  date: document.querySelector("#date"),
  start: document.querySelector("#start"),
  end: document.querySelector("#end"),
  resource: document.querySelector("#resource"),
  maxPrice: document.querySelector("#max-price"),
  scheduleMode: document.querySelector("#schedule-mode"),
  runAt: document.querySelector("#run-at"),
  runAtField: document.querySelector("#run-at-field"),
  bookingForm: document.querySelector("#booking-form"),
  availabilityButton: document.querySelector("#availability-button"),
  availability: document.querySelector("#availability"),
  availabilityContent: document.querySelector("#availability-content"),
  releasePreview: document.querySelector("#release-preview"),
  jobList: document.querySelector("#job-list"),
  jobFilter: document.querySelector("#job-filter"),
  loadingOverlay: document.querySelector("#loading-overlay"),
  loadingTitle: document.querySelector("#loading-title"),
  loadingCopy: document.querySelector("#loading-copy"),
};

const activeStatuses = new Set(["pending", "retry", "running"]);
const attentionStatuses = new Set([
  "failed",
  "auth_required",
  "needs_attention",
  "payment_required",
]);
const labels = {
  pending: "Queued",
  retry: "Retrying",
  running: "Running",
  booked: "Booked",
  failed: "Failed",
  auth_required: "Login required",
  needs_attention: "Needs attention",
  payment_required: "Payment required",
};

let dashboardState = null;
let refreshTimer = null;
let busy = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body
      ? { "content-type": "application/json", ...(options.headers || {}) }
      : options.headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setBusy(title, copy = "Please keep this page open.") {
  busy = true;
  elements.loadingTitle.textContent = title;
  elements.loadingCopy.textContent = copy;
  elements.loadingOverlay.classList.remove("hidden");
}

function clearBusy() {
  busy = false;
  elements.loadingOverlay.classList.add("hidden");
}

function toast(message, type = "info") {
  const region = document.querySelector("#toast-region");
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 5_500);
}

function singaporeDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function populateTimes() {
  const times = [];
  for (let hour = 7; hour <= 23; hour += 1) {
    times.push(`${String(hour).padStart(2, "0")}:00`);
  }
  elements.start.innerHTML = times
    .map((time) => `<option value="${time}"${time === "18:00" ? " selected" : ""}>${time}</option>`)
    .join("");
  elements.end.innerHTML = `<option value="">Match start only</option>${times
    .map((time) => `<option value="${time}"${time === "19:00" ? " selected" : ""}>${time}</option>`)
    .join("")}`;
}

function populateSelect(select, items, placeholder) {
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${items
    .map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`)
    .join("")}`;
}

async function loadCatalog(activity) {
  const query = activity ? `?activity=${encodeURIComponent(activity)}` : "";
  const catalog = await api(`/api/catalog${query}`);
  if (!activity) {
    populateSelect(elements.activity, catalog.activities, "Choose an activity");
    elements.venue.disabled = true;
  } else {
    populateSelect(elements.venue, catalog.venues, "Choose a venue");
    elements.venue.disabled = false;
  }
  return catalog;
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value) {
  if (!value) return "No execution time";
  const milliseconds = new Date(value).getTime() - Date.now();
  const absolute = Math.abs(milliseconds);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absolute < 60_000) return formatter.format(Math.round(milliseconds / 1_000), "second");
  if (absolute < 3_600_000) return formatter.format(Math.round(milliseconds / 60_000), "minute");
  if (absolute < 86_400_000) return formatter.format(Math.round(milliseconds / 3_600_000), "hour");
  return formatter.format(Math.round(milliseconds / 86_400_000), "day");
}

function updateReleasePreview() {
  const date = elements.date.value;
  if (!date) {
    elements.releasePreview.textContent = "Choose a target date";
    return;
  }
  if (elements.scheduleMode.value === "custom") {
    elements.runAtField.classList.remove("hidden");
    elements.releasePreview.textContent = elements.runAt.value
      ? `${elements.runAt.value.replace("T", " ")} SGT`
      : "Choose a custom execution time";
    return;
  }
  elements.runAtField.classList.add("hidden");
  const releaseDays = dashboardState?.defaults.releaseDays ?? 13;
  const releaseTime = dashboardState?.defaults.releaseTime ?? "12:00";
  const target = new Date(`${date}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() - releaseDays);
  const releaseDate = target.toISOString().slice(0, 10);
  elements.releasePreview.textContent = `${releaseDate} at ${releaseTime} SGT · automatic`;
}

function bookingPayload() {
  return {
    activity: elements.activity.value,
    venue: elements.venue.value,
    date: elements.date.value,
    start: elements.start.value,
    end: elements.end.value || null,
    resource: elements.resource.value || null,
    maxPrice: elements.maxPrice.value,
    runAt: elements.scheduleMode.value === "custom" ? elements.runAt.value : null,
  };
}

function parseSlotTimes(slot) {
  const source = `${slot.value || ""} ${slot.text || ""}`;
  const twentyFourHour = [...source.matchAll(/(?:^|[^\d])(\d{1,2}):(\d{2})(?::\d{2})?/g)]
    .map((match) => `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`);
  if (twentyFourHour.length >= 2) return twentyFourHour.slice(-2);
  const twelveHour = [...source.matchAll(/(\d{1,2}):(\d{2})\s*(AM|PM)/gi)].map((match) => {
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hour += 12;
    return `${String(hour).padStart(2, "0")}:${match[2]}`;
  });
  return twelveHour.slice(0, 2);
}

function slotButtons(slots, resource = "") {
  if (!slots.length) return '<p class="availability-message">No timeslots were returned.</p>';
  return `<div class="slot-grid">${slots
    .map(
      (slot) => `<button class="slot-button" type="button"
        data-slot='${escapeHtml(JSON.stringify(slot))}'
        data-resource="${escapeHtml(resource)}"
        ${slot.disabled ? "disabled" : ""}>${escapeHtml(slot.label)}</button>`,
    )
    .join("")}</div>`;
}

function renderAvailability(result) {
  let html = "";
  if (result.details?.length) {
    html = result.details
      .map(
        (detail) => `<div class="resource-group">
          <p class="resource-title">${escapeHtml(detail.resource.text || "Bookable resource")}</p>
          ${slotButtons(detail.slots, detail.resource.text)}
          ${!detail.slots.length && detail.message ? `<p class="availability-message">${escapeHtml(detail.message)}</p>` : ""}
        </div>`,
      )
      .join("");
  } else if (result.slots?.length) {
    html = slotButtons(result.slots);
  } else if (result.resources?.length) {
    html = result.resources
      .map((resource) => `<p class="availability-message">${escapeHtml(resource.text || resource.href)}</p>`)
      .join("");
  } else {
    html = `<p class="availability-message">${escapeHtml(result.message || "No matching availability found.")}</p>`;
  }
  elements.availabilityContent.innerHTML = html;
  elements.availability.classList.remove("hidden");
  elements.availability.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function statusClass(status) {
  return `status-${status || "pending"}`;
}

function jobMatchesFilter(job) {
  const filter = elements.jobFilter.value;
  if (filter === "active") return activeStatuses.has(job.status);
  if (filter === "booked") return job.status === "booked";
  if (filter === "attention") return attentionStatuses.has(job.status);
  return true;
}

function renderJobs(jobs) {
  const active = jobs.filter((job) => activeStatuses.has(job.status)).length;
  const booked = jobs.filter((job) => job.status === "booked").length;
  const attention = jobs.filter((job) => attentionStatuses.has(job.status)).length;
  document.querySelector("#stat-active").textContent = active;
  document.querySelector("#stat-booked").textContent = booked;
  document.querySelector("#stat-attention").textContent = attention;

  const filtered = jobs.filter(jobMatchesFilter);
  if (!filtered.length) {
    elements.jobList.innerHTML = `<div class="empty-state"><span aria-hidden="true">◎</span><h3>No matching bookings</h3><p>New requests will appear here.</p></div>`;
    return;
  }
  elements.jobList.innerHTML = filtered
    .map((job) => {
      const execution = job.nextAttemptAt || job.runAt;
      const message = job.lastError || job.outcome?.message;
      const canRun = job.status !== "running";
      return `<article class="job-card">
        <div class="job-card-top">
          <div><h3 class="job-title">${escapeHtml(job.activity)}</h3><p class="job-venue">${escapeHtml(job.venue)}${job.resource ? ` · ${escapeHtml(job.resource)}` : ""}</p></div>
          <span class="status-badge ${statusClass(job.status)}">${escapeHtml(labels[job.status] || job.status)}</span>
        </div>
        <div class="job-meta">
          <div class="job-meta-item"><span>DATE</span>${escapeHtml(job.date)}</div>
          <div class="job-meta-item"><span>TIME</span>${escapeHtml(job.start)}${job.end ? `–${escapeHtml(job.end)}` : ""}</div>
          <div class="job-meta-item"><span>ATTEMPTS</span>${job.attempts || 0}</div>
        </div>
        <div class="job-countdown">Runs ${relativeTime(execution)} · ${formatDateTime(execution)}</div>
        ${message ? `<p class="job-message">${escapeHtml(message)}</p>` : ""}
        <div class="job-actions">
          <button data-action="dry-run" data-id="${job.id}" ${canRun ? "" : "disabled"}>Validate request</button>
          <button data-action="run" data-id="${job.id}" ${canRun ? "" : "disabled"}>Run now</button>
          <button class="danger-action" data-action="remove" data-id="${job.id}" ${job.status === "running" ? "disabled" : ""}>Remove</button>
        </div>
      </article>`;
    })
    .join("");
}

function renderState(state) {
  dashboardState = state;
  const connection = document.querySelector("#connection-pill");
  connection.classList.add("online");
  connection.lastChild.textContent = " Local API online";
  document.querySelector("#scheduler-label").textContent = state.scheduler.schedulerActive
    ? "Active"
    : "Stopped";
  document.querySelector("#scheduler-detail").textContent = state.scheduler.schedulerLastCheckedAt
    ? `Checked ${relativeTime(state.scheduler.schedulerLastCheckedAt)}`
    : "Waiting for first check";

  const notice = document.querySelector("#session-notice");
  notice.classList.toggle("ready", state.sessionSaved);
  document.querySelector("#session-title").textContent = state.sessionSaved
    ? "A local REBOKS session is saved"
    : "NUS login is required before availability or booking";
  document.querySelector("#session-copy").textContent = state.sessionSaved
    ? "Fixed Playwright runs will reuse your saved local browser profile; refresh login if REBOKS expires it."
    : "Credentials and MFA stay inside the NUS browser window.";

  const installed = state.service.installed;
  document.querySelector("#service-indicator").classList.toggle("installed", installed);
  document.querySelector("#service-label").textContent = installed ? "Installed" : "Not installed";
  const serviceButton = document.querySelector("#service-button");
  serviceButton.textContent = installed ? "Remove service" : "Install service";
  serviceButton.dataset.installed = String(installed);
  renderJobs(state.jobs);
  updateReleasePreview();
}

async function refreshState({ silent = false } = {}) {
  try {
    renderState(await api("/api/state"));
  } catch (error) {
    document.querySelector("#connection-pill").classList.remove("online");
    if (!silent) toast(error.message, "error");
  }
}

async function login() {
  setBusy("Complete NUS login", "A separate browser window will open for SSO and MFA.");
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ role: "student" }),
    });
    toast(result.message, "success");
    await refreshState();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    clearBusy();
  }
}

elements.activity.addEventListener("change", async () => {
  elements.venue.disabled = true;
  populateSelect(elements.venue, [], "Loading venues…");
  if (!elements.activity.value) return;
  try {
    await loadCatalog(elements.activity.value);
  } catch (error) {
    toast(error.message, "error");
  }
});

elements.availabilityButton.addEventListener("click", async () => {
  if (!elements.bookingForm.reportValidity()) return;
  setBusy("Checking live availability", "Opening the saved REBOKS browser profile in the background.");
  try {
    const result = await api("/api/availability", {
      method: "POST",
      body: JSON.stringify(bookingPayload()),
    });
    renderAvailability(result);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    clearBusy();
  }
});

elements.bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy("Adding to queue", "Validating the release rule and saving locally.");
  try {
    const result = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify(bookingPayload()),
    });
    toast(`Queued ${result.job.activity} for ${result.job.date}.`, "success");
    await refreshState();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    clearBusy();
  }
});

elements.availabilityContent.addEventListener("click", (event) => {
  const button = event.target.closest("[data-slot]");
  if (!button) return;
  const slot = JSON.parse(button.dataset.slot);
  const [start, end] = parseSlotTimes(slot);
  if (start) elements.start.value = start;
  if (end) elements.end.value = end;
  if (button.dataset.resource) elements.resource.value = button.dataset.resource;
  toast(`Selected ${slot.label}.`, "success");
});

elements.jobList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "remove" && !window.confirm("Remove this booking request?")) return;
  const title = action === "dry-run" ? "Validating fixed route" : action === "run" ? "Running booking now" : "Removing request";
  setBusy(title, action === "run" ? "Following the saved deterministic Playwright route." : "Please wait.");
  try {
    if (action === "remove") {
      await api(`/api/jobs/${id}`, { method: "DELETE" });
      toast("Booking request removed.", "success");
    } else {
      const result = await api(`/api/jobs/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ dryRun: action === "dry-run" }),
      });
      toast(result.outcome.message || "Request completed.", "success");
    }
    await refreshState();
  } catch (error) {
    toast(error.message, "error");
    await refreshState({ silent: true });
  } finally {
    clearBusy();
  }
});

document.querySelector("#service-button").addEventListener("click", async (event) => {
  const installed = event.currentTarget.dataset.installed === "true";
  setBusy(installed ? "Removing background service" : "Installing background service");
  try {
    await api(`/api/service/${installed ? "uninstall" : "install"}`, {
      method: "POST",
      body: "{}",
    });
    toast(installed ? "Background service removed." : "Background service installed.", "success");
    await refreshState();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    clearBusy();
  }
});

document.querySelector("#run-due-button").addEventListener("click", async () => {
  setBusy("Checking due bookings");
  try {
    await api("/api/scheduler/run", { method: "POST", body: "{}" });
    toast("Queue check complete.", "success");
    await refreshState();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    clearBusy();
  }
});

document.querySelector("#close-availability").addEventListener("click", () => {
  elements.availability.classList.add("hidden");
});
document.querySelector("#refresh-button").addEventListener("click", () => refreshState());
document.querySelector("#login-button").addEventListener("click", login);
document.querySelector("#notice-login-button").addEventListener("click", login);
elements.jobFilter.addEventListener("change", () => renderJobs(dashboardState?.jobs || []));
elements.scheduleMode.addEventListener("change", updateReleasePreview);
elements.runAt.addEventListener("input", updateReleasePreview);
elements.date.addEventListener("input", updateReleasePreview);

async function initialise() {
  populateTimes();
  elements.date.min = singaporeDate();
  elements.date.value = singaporeDate(7);
  updateReleasePreview();
  await Promise.all([loadCatalog(), refreshState()]);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!busy) refreshState({ silent: true });
  }, 4_000);
}

initialise().catch((error) => toast(error.message, "error"));
