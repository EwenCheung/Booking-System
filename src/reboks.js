import fs from "node:fs/promises";
import path from "node:path";

import { facilitiesUrl, outputDirectory } from "./config.js";
import { assertAuthenticated, openPersistentBrowser, restoreNativeMap } from "./browser.js";
import { BookingFlowError } from "./errors.js";
import { formatReboksDate, textContainsTime } from "./time.js";

const resourceLinkSelector = 'a[href*="/facilities/"]';
const slotSelector = [
  '#formTimeslots input[name="timeslots[]"]',
  '#formFacBooking input[name="timeslots[]"]',
  '.timeslot-container input[type="checkbox"]',
  '.timeslot-container input[type="radio"]',
].join(", ");
const bookingFormSelector = "#formTimeslots, #formFacBooking";
const checkoutFormSelector =
  '#formCartPayment, form[action*="checkout"], form[action*="payment"], form[action*="cart"]';

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sameName(left, right) {
  return cleanText(left).toLowerCase() === cleanText(right).toLowerCase();
}

function isResourceLink(href) {
  return (
    href &&
    href.includes("/facilities/") &&
    !["/facilities/result", "/facilities/onetouch", "/facilities/capacity", "/facilities/ajax/"].some(
      (excluded) => href.includes(excluded),
    )
  );
}

async function saveDebugArtifact(page, label) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const prefix = `${Date.now()}-${label.replace(/[^a-z0-9_-]+/gi, "-")}`;
  const screenshot = path.join(outputDirectory, `${prefix}.png`);
  const html = path.join(outputDirectory, `${prefix}.html`);
  await Promise.all([
    page.screenshot({ path: screenshot, fullPage: true }).catch(() => {}),
    page.content().then((contents) => fs.writeFile(html, contents, { mode: 0o600 })).catch(() => {}),
  ]);
  return { screenshot, html };
}

async function settleLegacyPage(page) {
  // The site's legacy bundle replaces window.Map. Playwright's selector
  // engine needs the native constructor, so wait for the document parser and
  // restore it before using locators on a newly navigated REBOKS page.
  await restoreNativeMap(page);
}

async function selectLabel(page, selector, label, description) {
  await page.locator(selector).waitFor({ state: "attached" });
  await page.waitForFunction(
    (target) => document.querySelector(target)?.querySelectorAll("option").length > 1,
    selector,
  );
  const options = await page.locator(`${selector} option`).evaluateAll((nodes) =>
    nodes.map((node) => ({ label: node.textContent?.trim() || "", value: node.value })),
  );
  const match = options.find((option) => sameName(option.label, label));
  if (!match?.value) {
    throw new BookingFlowError(
      `Unknown ${description} "${label}". Available: ${options
        .filter((option) => option.value)
        .map((option) => option.label)
        .join(", ")}.`,
    );
  }
  await page.locator(selector).selectOption(match.value);
  return match;
}

async function search(page, criteria) {
  // REBOKS loads many legacy third-party scripts. Waiting for the first
  // response is enough; the next selector waits target the actual controls.
  await page.goto(facilitiesUrl, { waitUntil: "commit" });
  await settleLegacyPage(page);
  await assertAuthenticated(page);

  await selectLabel(page, "#activity_filter", criteria.activity, "activity");
  await page.waitForFunction(
    (venue) => document.querySelector("#venue_filter")?.querySelectorAll("option").length > 1,
    criteria.venue,
  );
  await selectLabel(page, "#venue_filter", criteria.venue, "venue");
  await page.locator("#date_filter").fill(formatReboksDate(criteria.date));

  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname.includes("/facilities/result") ||
        url.pathname.includes("/auth") ||
        url.hostname === "vafs.u.nus.edu",
      { waitUntil: "commit" },
    ),
    page.locator("#formFacFilter input[type=submit], #formFacFilter button[type=submit]").first().click(),
  ]);
  await assertAuthenticated(page);
}

async function collectResources(page) {
  const links = await page.locator(resourceLinkSelector).evaluateAll((nodes) =>
    nodes.map((node) => ({
      href: node.href,
      text: node.textContent?.replace(/\s+/g, " ").trim() || "",
    })),
  );
  const unique = new Map();
  for (const link of links) {
    if (isResourceLink(link.href) && !unique.has(link.href)) unique.set(link.href, link);
  }
  return [...unique.values()];
}

async function collectSlots(page) {
  return page.locator(slotSelector).evaluateAll((nodes) =>
    nodes.map((node, index) => {
      const label = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null;
      const container = label || node.closest("label, li, tr, .timeslot, .slot, .timeslot-grid") || node.parentElement;
      const text = (container?.textContent || node.getAttribute("value") || "").replace(/\s+/g, " ").trim();
      return {
        index,
        id: node.id || null,
        value: node.getAttribute("value") || "",
        text,
        label: text || node.getAttribute("value") || `Timeslot ${index + 1}`,
        disabled: node.disabled,
      };
    }),
  );
}

function chooseResource(resources, requested) {
  if (!resources.length) return null;
  if (requested) {
    const expected = requested.toLowerCase();
    const match = resources.find(
      (resource) =>
        resource.text.toLowerCase().includes(expected) || resource.href.toLowerCase().includes(expected),
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
    `More than one resource matched. Choose one: ${resources
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
        slots.filter((slot) => !slot.disabled).map((slot) => slot.label).join(", ") || "none"
      }.`,
      { slots },
    );
  }
  throw new BookingFlowError(
    `The requested time matched multiple slots: ${matches.map((slot) => slot.label).join(", ")}.`,
    { matches },
  );
}

async function resolveSearch(page, criteria, requestedResource) {
  await search(page, criteria);
  let slots = await collectSlots(page);
  let resource;
  if (!slots.length) {
    resource = chooseResource(await collectResources(page), requestedResource);
    if (!resource) {
      throw new BookingFlowError("REBOKS returned no bookable resource for this search.");
    }
    await page.goto(resource.href, { waitUntil: "commit" });
    await settleLegacyPage(page);
    await assertAuthenticated(page);
    slots = await collectSlots(page);
  }
  return { slots, resource };
}

async function clickSubmit(page, formSelector) {
  const form = page.locator(formSelector).first();
  const submit = form.locator('button[type="submit"], input[type="submit"]').filter({
    hasText: /confirm|checkout|complete|book|submit|continue|pay/i,
  });
  const fallback = form.locator('button[type="submit"], input[type="submit"]').first();
  const button = (await submit.count()) ? submit.first() : fallback;
  if (!(await button.count())) return false;
  await button.click();
  await page.waitForTimeout(150);
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await restoreNativeMap(page).catch(() => {});
  return true;
}

function priceFromText(text) {
  const total = /total[^\d]{0,30}(?:s\$|sgd)\s*([\d,.]+)/i.exec(text);
  if (total) return Number(total[1].replaceAll(",", ""));
  const prices = [...text.matchAll(/(?:s\$|sgd)\s*([\d,.]+)/gi)].map((match) =>
    Number(match[1].replaceAll(",", "")),
  );
  return prices.length ? Math.max(...prices) : 0;
}

async function checkout(page, job) {
  for (let step = 0; step < 4; step += 1) {
    await assertAuthenticated(page);
    const body = cleanText(await page.locator("body").innerText());
    if (/booking (?:is )?(?:confirmed|successful|completed)|successfully booked|confirmation number|booking receipt/i.test(body)) {
      return { status: "booked", message: body.slice(0, 700), url: page.url() };
    }
    if (new URL(page.url()).hostname !== "reboks.nus.edu.sg") {
      return { status: "payment_required", message: "Checkout requires manual completion.", url: page.url() };
    }
    const total = priceFromText(body);
    if (total > Number(job.maxPrice || 0)) {
      return {
        status: "payment_required",
        message: `REBOKS shows S$${total.toFixed(2)}, above the authorised S$${Number(job.maxPrice || 0).toFixed(2)} limit.`,
        total,
        url: page.url(),
      };
    }
    const form = page.locator(checkoutFormSelector).first();
    if (!(await form.count())) {
      const debug = await saveDebugArtifact(page, `${job.id}-needs-attention`);
      return {
        status: "needs_attention",
        message: "No deterministic checkout form was found.",
        url: page.url(),
        debug,
      };
    }
    const terms = form.locator('input[type="checkbox"][name*="term" i], input[type="checkbox"][name*="agree" i], input[type="checkbox"][name*="accept" i]').first();
    if ((await terms.count()) && !(await terms.isChecked())) await terms.check();
    if (!(await clickSubmit(page, checkoutFormSelector))) {
      const debug = await saveDebugArtifact(page, `${job.id}-checkout-submit-missing`);
      return { status: "needs_attention", message: "Checkout confirmation control was not found.", url: page.url(), debug };
    }
  }
  const debug = await saveDebugArtifact(page, `${job.id}-checkout-loop`);
  return { status: "needs_attention", message: "REBOKS did not confirm after four checkout steps.", url: page.url(), debug };
}

async function withBrowser(options, callback) {
  const { context, page } = await openPersistentBrowser(options);
  try {
    return await callback(page);
  } finally {
    await context.close();
  }
}

export async function getAvailability(criteria, { headed = false } = {}) {
  return withBrowser({ headed }, async (page) => {
    const { slots, resource } = await resolveSearch(page, criteria, criteria.resource);
    return { url: page.url(), resource, resources: await collectResources(page), slots };
  });
}

export async function executeBooking(job, { dryRun = false, headed = false } = {}) {
  return withBrowser({ headed }, async (page) => {
    const { slots, resource } = await resolveSearch(page, job, job.resource);
    const slot = chooseSlot(slots, job);
    if (dryRun) {
      return { status: "dry_run", message: `Matched ${slot.label}; no booking was submitted.`, url: page.url(), resource };
    }

    const target = page.locator(slotSelector).nth(slot.index);
    await target.check({ force: false });
    if (!(await clickSubmit(page, bookingFormSelector))) {
      const debug = await saveDebugArtifact(page, `${job.id}-booking-submit-missing`);
      throw new BookingFlowError("A slot matched, but the booking submission control was not found.", { slot, debug });
    }
    return checkout(page, job);
  });
}
