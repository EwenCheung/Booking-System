import fs from "node:fs/promises";
import path from "node:path";

import * as cheerio from "cheerio";
import makeFetchCookie from "fetch-cookie";

import { baseUrl, outputDirectory } from "./config.js";
import { AuthRequiredError, BookingFlowError } from "./errors.js";
import { loadSessionJar, saveSessionJar } from "./session.js";
import { formatReboksDate, textContainsTime } from "./time.js";

const facilitiesUrl = `${baseUrl}/facilities`;
const REQUEST_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en-SG,en;q=0.9",
  "user-agent": "NUS-REBOKS-Booking-Helper/0.1 (+local user automation)",
};

let sessionQueue = Promise.resolve();

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function phpValue(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`PHPJS\\.${escaped}\\s*=\\s*([^;]+);`).exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function csrfToken(html) {
  const $ = cheerio.load(html);
  return (
    $('input[name="csrf_test_name"]').first().attr("value") ||
    $('meta[name="csrf-token"]').attr("content") ||
    null
  );
}

function assertNotAuth(url, html) {
  if (
    url.includes("/auth") ||
    /sign in as nus student|please sign in to continue/i.test(html)
  ) {
    throw new AuthRequiredError(
      "The exported REBOKS session has expired. Use the Login button to refresh it.",
    );
  }
}

function responsePayload(text, contentType = "") {
  const normalized = text.trim();
  if (contentType.includes("application/json") || /^[{[]/.test(normalized)) {
    try {
      return JSON.parse(normalized);
    } catch {
      // Some legacy endpoints incorrectly label HTML as JSON.
    }
  }
  const $ = cheerio.load(text);
  const pre = $("pre").first().text().trim();
  if (/^[{[]/.test(pre)) {
    try {
      return JSON.parse(pre);
    } catch {
      return null;
    }
  }
  return null;
}

class DirectClient {
  constructor(jar) {
    this.jar = jar;
    this.fetch = makeFetchCookie(globalThis.fetch, jar);
    this.token = null;
  }

  async request(url, options = {}) {
    const headers = { ...REQUEST_HEADERS, ...(options.headers || {}) };
    if (this.token) headers["x-csrf-token"] = this.token;
    const response = await this.fetch(url, {
      redirect: "follow",
      ...options,
      headers,
    });
    const text = await response.text();
    const token = csrfToken(text);
    if (token) this.token = token;
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType: response.headers.get("content-type") || "",
      text,
    };
  }

  async get(url, { ajax = false } = {}) {
    return this.request(url, {
      headers: ajax
        ? { accept: "application/json, text/javascript, */*; q=0.01", "x-requested-with": "XMLHttpRequest" }
        : {},
    });
  }
}

async function withSessionClient(callback) {
  const operation = sessionQueue.then(async () => {
    const jar = await loadSessionJar();
    const client = new DirectClient(jar);
    try {
      return await callback(client);
    } finally {
      await saveSessionJar(jar);
    }
  });
  sessionQueue = operation.catch(() => {});
  return operation;
}

async function anonymousPage(url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS, redirect: "follow" });
  if (!response.ok) throw new Error(`REBOKS returned HTTP ${response.status}.`);
  return response.text();
}

export function parseCatalogHtml(html) {
  const activities = phpValue(html, "activity_list") || [];
  return activities.map((activity) => ({
    name: activity.name,
    id: String(activity.activity_id),
  }));
}

export async function discoverFacilitiesDirect(activityName) {
  const html = await anonymousPage(facilitiesUrl);
  const activities = parseCatalogHtml(html);
  if (!activityName) return { activities, venues: [] };
  const activity = activities.find(
    (candidate) => candidate.name.toLowerCase() === activityName.toLowerCase(),
  );
  if (!activity) {
    throw new BookingFlowError(
      `Unknown activity "${activityName}". Available: ${activities
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    );
  }
  const response = await fetch(`${baseUrl}/ajax/getVenues/${activity.id}`, {
    headers: { ...REQUEST_HEADERS, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`REBOKS venue lookup returned HTTP ${response.status}.`);
  const payload = await response.json();
  const venues = (payload.venues || []).map((venue) => ({
    name: venue.name,
    id: String(venue.venue_id),
  }));
  return { activities, venues, maxDate: payload.max_date || null };
}

export function parseTimeslotsHtml(html) {
  const $ = cheerio.load(html);
  const selector = [
    'input[name="timeslots[]"]',
    '.timeslot-container input[type="checkbox"]',
    '.timeslot-container input[type="radio"]',
    '#formTimeslots input[type="checkbox"]',
    '#formTimeslots input[type="radio"]',
  ].join(",");
  const slots = [];
  $(selector).each((index, element) => {
    const input = $(element);
    const id = input.attr("id");
    const explicitLabel = id ? $(`label[for="${id.replaceAll('"', '\\"')}"]`).first() : null;
    const container =
      explicitLabel?.length
        ? explicitLabel
        : input.closest("label, li, tr, .timeslot, .slot, .timeslot-grid").first();
    const text = cleanText(container.length ? container.text() : input.parent().text());
    const value = input.attr("value") || "";
    slots.push({
      index,
      id: id || null,
      name: input.attr("name") || null,
      value,
      text,
      label: text || value || `Timeslot ${index + 1}`,
      disabled: input.is(":disabled"),
    });
  });
  return slots;
}

function candidateLinks(html, currentUrl) {
  const $ = cheerio.load(html);
  const excluded = [
    "/facilities/result",
    "/facilities/onetouch",
    "/facilities/capacity",
    "/facilities/ajax/",
    "/facilities/suggest",
  ];
  const unique = new Map();
  $('a[href*="/facilities/"]').each((_index, anchor) => {
    const href = new URL($(anchor).attr("href"), currentUrl).href;
    if (href === currentUrl || excluded.some((part) => href.includes(part))) return;
    if (!unique.has(href)) unique.set(href, { href, text: cleanText($(anchor).text()) });
  });
  return [...unique.values()];
}

async function fillDynamicTimeslots(client, page, targetDate) {
  let slots = parseTimeslotsHtml(page.text);
  if (slots.length) return slots;
  const facility = phpValue(page.text, "facilities");
  if (!facility?.activity_id || !facility?.venue_id) return slots;
  const query = new URLSearchParams({
    activity_id: facility.activity_id,
    venue_id: facility.venue_id,
    date: targetDate,
  });
  const response = await client.get(`${baseUrl}/facilities/ajax/getTimeslots?${query}`, {
    ajax: true,
  });
  assertNotAuth(response.url, response.text);
  slots = parseTimeslotsHtml(response.text);
  return slots;
}

function pageMessage(html) {
  const $ = cheerio.load(html);
  return cleanText(
    $(".timeslot-container, .facilities-list, main, #main, body").first().text(),
  ).slice(0, 700);
}

async function collectPage(client, page, targetDate) {
  const slots = await fillDynamicTimeslots(client, page, targetDate);
  const resources = candidateLinks(page.text, page.url);
  return {
    url: page.url,
    title: cheerio.load(page.text)("title").text(),
    slots,
    resources,
    message: slots.length || resources.length ? "" : pageMessage(page.text),
  };
}

async function activityAndVenue(client, activityName, venueName) {
  const landing = await client.get(facilitiesUrl);
  const activities = parseCatalogHtml(landing.text);
  const activity = activities.find(
    (candidate) => candidate.name.toLowerCase() === activityName.toLowerCase(),
  );
  if (!activity) throw new BookingFlowError(`Unknown activity "${activityName}".`);
  const venueResponse = await client.get(`${baseUrl}/ajax/getVenues/${activity.id}`, {
    ajax: true,
  });
  const payload = responsePayload(venueResponse.text, venueResponse.contentType);
  const venues = (payload?.venues || []).map((venue) => ({
    name: venue.name,
    id: String(venue.venue_id),
  }));
  const venue = venues.find(
    (candidate) => candidate.name.toLowerCase() === venueName.toLowerCase(),
  );
  if (!venue) {
    throw new BookingFlowError(
      `Unknown venue "${venueName}" for ${activityName}. Available: ${venues
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    );
  }
  return { landing, activity, venue };
}

async function searchFacilities(client, criteria) {
  const { landing, activity, venue } = await activityAndVenue(
    client,
    criteria.activity,
    criteria.venue,
  );
  const query = new URLSearchParams({
    activity_filter: activity.id,
    venue_filter: venue.id,
    date_filter: formatReboksDate(criteria.date),
    search: "Search",
  });
  const token = csrfToken(landing.text);
  if (token) query.set("csrf_test_name", token);
  const page = await client.get(`${baseUrl}/facilities/result?${query}`);
  assertNotAuth(page.url, page.text);
  return { page, summary: await collectPage(client, page, criteria.date) };
}

export async function getAvailabilityDirect(criteria) {
  return withSessionClient(async (client) => {
    const initial = await searchFacilities(client, criteria);
    if (initial.summary.slots.length || !initial.summary.resources.length) {
      return initial.summary;
    }
    const details = [];
    for (const resource of initial.summary.resources.slice(0, 20)) {
      const page = await client.get(resource.href);
      assertNotAuth(page.url, page.text);
      details.push({
        resource,
        ...(await collectPage(client, page, criteria.date)),
      });
    }
    return { ...initial.summary, details };
  });
}

function chooseResource(resources, requested) {
  if (!resources.length) return null;
  if (requested) {
    const normalized = requested.toLowerCase();
    const match = resources.find(
      (resource) =>
        resource.text.toLowerCase().includes(normalized) ||
        resource.href.toLowerCase().includes(normalized),
    );
    if (match) return match;
    throw new BookingFlowError(
      `No resource matched "${requested}". Candidates: ${resources
        .map((resource) => resource.text || resource.href)
        .join(", ")}.`,
      { resources },
    );
  }
  if (resources.length === 1) return resources[0];
  throw new BookingFlowError(
    `More than one resource matched. Choose one of: ${resources
      .map((resource) => resource.text || resource.href)
      .join(", ")}.`,
    { resources },
  );
}

function chooseSlot(slots, job) {
  const matches = slots.filter(
    (slot) =>
      !slot.disabled &&
      textContainsTime(`${slot.text} ${slot.value}`, job.start) &&
      (!job.end || textContainsTime(`${slot.text} ${slot.value}`, job.end)),
  );
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw new BookingFlowError(
      `The ${job.start}${job.end ? `-${job.end}` : ""} slot is unavailable. Available: ${
        slots
          .filter((slot) => !slot.disabled)
          .map((slot) => slot.label)
          .join(", ") || "none"
      }.`,
      { slots },
    );
  }
  throw new BookingFlowError(
    `The requested time matched multiple slots: ${matches.map((slot) => slot.label).join(", ")}.`,
    { matches },
  );
}

export function buildFormSubmission(
  html,
  pageUrl,
  selector,
  { selectedSlot, checkTerms = false } = {},
) {
  const $ = cheerio.load(html);
  const form = $(selector).first();
  if (!form.length) return null;
  const parameters = new URLSearchParams();
  let selectedSlotAdded = false;
  form.find("input, select, textarea").each((_index, element) => {
    const field = $(element);
    const name = field.attr("name");
    if (!name || field.is(":disabled")) return;
    const tag = element.tagName.toLowerCase();
    const type = String(field.attr("type") || "text").toLowerCase();
    if (["submit", "button", "image", "file", "reset"].includes(type)) return;
    if (tag === "select") {
      field.find("option:selected").each((_optionIndex, option) => {
        parameters.append(name, $(option).attr("value") || $(option).text());
      });
      return;
    }
    if (type === "checkbox" || type === "radio") {
      const isSelectedSlot =
        selectedSlot && name === selectedSlot.name && field.attr("value") === selectedSlot.value;
      const isTerms = checkTerms && /term|agree|accept/i.test(`${name} ${field.attr("id") || ""}`);
      if (!field.is(":checked") && !isSelectedSlot && !isTerms) return;
      if (isSelectedSlot) selectedSlotAdded = true;
    }
    const attributeValue = field.attr("value");
    const value =
      attributeValue !== undefined
        ? attributeValue
        : type === "checkbox" || type === "radio"
          ? "on"
          : tag === "textarea"
            ? field.text()
            : "";
    parameters.append(name, value);
  });
  if (selectedSlot?.name && !selectedSlotAdded) {
    parameters.append(selectedSlot.name, selectedSlot.value);
  }

  const submit = form
    .find('button[type="submit"], input[type="submit"]')
    .filter((_index, element) =>
      /confirm|checkout|complete|book|submit|continue|pay/i.test(
        `${$(element).text()} ${$(element).attr("value") || ""}`,
      ),
    )
    .first();
  if (submit.length && submit.attr("name")) {
    parameters.append(submit.attr("name"), submit.attr("value") || submit.text());
  }
  return {
    action: new URL(form.attr("action") || pageUrl, pageUrl).href,
    method: String(form.attr("method") || "GET").toUpperCase(),
    parameters,
  };
}

async function submitForm(client, form) {
  if (form.method === "GET") {
    const url = new URL(form.action);
    for (const [key, value] of form.parameters) url.searchParams.append(key, value);
    return client.get(url.href);
  }
  return client.request(form.action, {
    method: form.method,
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    },
    body: form.parameters.toString(),
  });
}

async function resolveServerResponse(client, response) {
  const payload = responsePayload(response.text, response.contentType);
  if (!payload) return response;
  if (payload.redirect) {
    return client.get(new URL(payload.redirect, response.url).href);
  }
  if (payload.method === "alert" || payload.code) {
    throw new BookingFlowError(payload.message || "REBOKS rejected the booking.", payload);
  }
  return response;
}

function extractTotalPrice(html) {
  const text = cleanText(cheerio.load(html)("body").text());
  const total = /total[^\d]{0,30}(?:s\$|sgd)\s*([\d,.]+)/i.exec(text);
  if (total) return Number(total[1].replaceAll(",", ""));
  const prices = [...text.matchAll(/(?:s\$|sgd)\s*([\d,.]+)/gi)].map((match) =>
    Number(match[1].replaceAll(",", "")),
  );
  return prices.length ? Math.max(...prices) : 0;
}

function successMessage(html) {
  const text = cleanText(cheerio.load(html)("body").text());
  if (
    /booking (?:is )?(?:confirmed|successful|completed)|successfully booked|confirmation number|booking receipt/i.test(
      text,
    )
  ) {
    return text.slice(0, 700);
  }
  return null;
}

async function debugHtml(label, html) {
  const directory = path.join(path.dirname(outputDirectory), "http");
  await fs.mkdir(directory, { recursive: true });
  const safe = label.replace(/[^a-z0-9_-]+/gi, "-");
  const file = path.join(directory, `${Date.now()}-${safe}.html`);
  await fs.writeFile(file, html, { mode: 0o600 });
  return file;
}

async function finishCheckout(client, initialPage, job) {
  let page = initialPage;
  for (let step = 0; step < 4; step += 1) {
    assertNotAuth(page.url, page.text);
    const success = successMessage(page.text);
    if (success) return { status: "booked", message: success, url: page.url };
    if (new URL(page.url).hostname !== "reboks.nus.edu.sg") {
      return {
        status: "payment_required",
        message: "Checkout left REBOKS and requires manual completion.",
        url: page.url,
      };
    }
    const total = extractTotalPrice(page.text);
    if (total > Number(job.maxPrice || 0)) {
      return {
        status: "payment_required",
        message: `REBOKS shows S$${total.toFixed(2)}, above the authorised S$${Number(
          job.maxPrice || 0,
        ).toFixed(2)} limit.`,
        total,
        url: page.url,
      };
    }
    const form = buildFormSubmission(
      page.text,
      page.url,
      '#formCartPayment, form[action*="checkout"], form[action*="payment"], form[action*="cart"]',
      { checkTerms: true },
    );
    if (!form) {
      return {
        status: "needs_attention",
        message: pageMessage(page.text) || "No deterministic checkout form was found.",
        url: page.url,
        debugFile: await debugHtml(`${job.id}-needs-attention`, page.text),
      };
    }
    page = await resolveServerResponse(client, await submitForm(client, form));
  }
  return {
    status: "needs_attention",
    message: "REBOKS did not confirm the booking after four deterministic form submissions.",
    url: page.url,
    debugFile: await debugHtml(`${job.id}-checkout-loop`, page.text),
  };
}

export async function executeBookingDirect(job, { dryRun = false } = {}) {
  return withSessionClient(async (client) => {
    const initial = await searchFacilities(client, job);
    let page = initial.page;
    let summary = initial.summary;
    if (!summary.slots.length) {
      if (!summary.resources.length) {
        throw new BookingFlowError(
          summary.message || "REBOKS returned no bookable facility.",
          summary,
        );
      }
      const resource = chooseResource(summary.resources, job.resource);
      page = await client.get(resource.href);
      assertNotAuth(page.url, page.text);
      summary = await collectPage(client, page, job.date);
    }
    const slot = chooseSlot(summary.slots, job);
    if (dryRun) {
      return {
        status: "dry_run",
        message: `Matched ${slot.label}; no request was submitted.`,
        url: page.url,
      };
    }
    const form = buildFormSubmission(page.text, page.url, "#formTimeslots, #formFacBooking", {
      selectedSlot: slot,
    });
    if (!form) {
      throw new BookingFlowError("A slot matched, but the booking form was not found.", {
        slot,
        debugFile: await debugHtml(`${job.id}-no-booking-form`, page.text),
      });
    }
    const nextPage = await resolveServerResponse(client, await submitForm(client, form));
    return finishCheckout(client, nextPage, job);
  });
}
