import fs from "node:fs/promises";
import readline from "node:readline/promises";
import process from "node:process";
import path from "node:path";
import crypto from "node:crypto";

import { chromium } from "playwright";

import {
  authUrl,
  baseUrl,
  browserProfileDirectory,
  dataDirectory,
  defaultHeadless,
} from "./config.js";
import { AuthRequiredError } from "./errors.js";
import { saveBrowserCookies } from "./session.js";

async function acquireBrowserLock() {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(dataDirectory, "browser.lock");
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(lockFile, "utf8"));
          if (current.token === token) await fs.unlink(lockFile);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await fs.readFile(lockFile, "utf8"));
      } catch {
        await fs.unlink(lockFile).catch(() => {});
        continue;
      }
      try {
        process.kill(owner.pid, 0);
        throw new Error(
          `The saved REBOKS browser is already in use by process ${owner.pid}. Close that helper command first.`,
        );
      } catch (processError) {
        if (processError.code !== "ESRCH") throw processError;
        await fs.unlink(lockFile);
      }
    }
  }
  throw new Error("Could not acquire the saved REBOKS browser profile.");
}

export async function openPersistentBrowser({ headed = false, slowMo = 0 } = {}) {
  await fs.mkdir(browserProfileDirectory, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireBrowserLock();
  let context;
  try {
    context = await chromium.launchPersistentContext(browserProfileDirectory, {
      headless: headed ? false : defaultHeadless,
      slowMo,
      viewport: headed ? null : { width: 1440, height: 1000 },
      locale: "en-SG",
      timezoneId: "Asia/Singapore",
    });
  } catch (error) {
    await releaseLock();
    throw error;
  }
  context.once("close", () => {
    releaseLock().catch(() => {});
  });
  // REBOKS's legacy apps.min.js declares `var Map = ...`, replacing the native
  // constructor that current Playwright uses inside its injected scripts. Keep
  // the native reference, let REBOKS finish its own DOM-ready handlers, then
  // restore it. The legacy value remains available for diagnostics.
  await context.addInitScript(() => {
    const nativeMap = globalThis.Map;
    Object.defineProperty(globalThis, "__playwrightNativeMap", {
      value: nativeMap,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        setTimeout(() => {
          if (globalThis.Map !== nativeMap) {
            globalThis.__reboksLegacyMap = globalThis.Map;
            globalThis.Map = nativeMap;
          }
        }, 0);
      },
      { once: true },
    );
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(45_000);
  return { context, page };
}

export function isAuthPage(page) {
  try {
    const url = new URL(page.url());
    return (
      url.hostname === "vafs.u.nus.edu" ||
      url.pathname.includes("/auth") ||
      url.pathname.includes("/adfs/")
    );
  } catch {
    return false;
  }
}

export async function assertAuthenticated(page) {
  if (isAuthPage(page)) throw new AuthRequiredError();
  const signInLink = page.getByRole("link", { name: /sign in as nus (student|staff)/i });
  if (await signInLink.first().isVisible().catch(() => false)) {
    throw new AuthRequiredError();
  }
}

// REBOKS's legacy JavaScript replaces window.Map. That breaks Playwright's
// injected selector/evaluation helpers until the native constructor is put
// back. CDP executes outside that helper, so it is safe even while Map is
// broken. Waiting for the parsed document avoids changing REBOKS while its
// own startup bundle is still executing.
export async function restoreNativeMap(page, { timeout = 12_000 } = {}) {
  const session = await page.context().newCDPSession(page);
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await session.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (["interactive", "complete"].includes(state.result.value)) break;
      await page.waitForTimeout(50);
    }
    await session.send("Runtime.evaluate", {
      expression:
        "if (globalThis.__playwrightNativeMap) globalThis.Map = globalThis.__playwrightNativeMap;",
    });
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function loginInteractively({
  role = "student",
  waitForEnter = process.stdin.isTTY,
} = {}) {
  if (!new Set(["student", "staff", "guest"]).has(role)) {
    throw new Error("--role must be student, staff, or guest.");
  }

  const { context, page } = await openPersistentBrowser({ headed: true });
  try {
    await page.goto(`${baseUrl}/profile`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(25);
    if (!isAuthPage(page)) {
      await saveBrowserCookies(await context.cookies());
      console.log("The saved REBOKS session is already authenticated.");
      return;
    }

    await page.goto(authUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(25);
    const label =
      role === "guest"
        ? /sign in as university guest/i
        : new RegExp(`sign in as NUS ${role}`, "i");
    await page.getByRole("link", { name: label }).click();

    console.log(
      "Complete NUS sign-in and MFA in the opened browser. Credentials are never read or stored by this script.",
    );
    console.log("Return here and press Enter after REBOKS has loaded.");

    if (waitForEnter) {
      const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
      await prompt.question("");
      prompt.close();
    } else {
      await page.waitForURL(
        (url) =>
          url.hostname === "reboks.nus.edu.sg" &&
          !url.pathname.includes("/auth") &&
          !url.pathname.includes("/nus_saml_provider/"),
        { timeout: 15 * 60_000 },
      );
    }

    await page.goto(`${baseUrl}/profile`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(25);
    await assertAuthenticated(page);
    await saveBrowserCookies(await context.cookies());
    console.log("Login verified. The session is saved in data/browser-profile/.");
  } finally {
    await context.close();
  }
}
