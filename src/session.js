import fs from "node:fs/promises";
import path from "node:path";

import { Cookie, CookieJar } from "tough-cookie";

import { dataDirectory } from "./config.js";

export const sessionFile = path.join(dataDirectory, "reboks-session.json");

async function ensureDataDirectory() {
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
}

export async function saveBrowserCookies(cookies) {
  const jar = new CookieJar();
  for (const item of cookies) {
    const domain = item.domain.replace(/^\./, "");
    const cookie = new Cookie({
      key: item.name,
      value: item.value,
      domain,
      path: item.path || "/",
      secure: Boolean(item.secure),
      httpOnly: Boolean(item.httpOnly),
      expires: item.expires > 0 ? new Date(item.expires * 1000) : "Infinity",
      sameSite: item.sameSite ? item.sameSite.toLowerCase() : undefined,
      hostOnly: !item.domain.startsWith("."),
    });
    const protocol = item.secure ? "https" : "http";
    await jar.setCookie(cookie, `${protocol}://${domain}${item.path || "/"}`);
  }
  await saveSessionJar(jar);
}

export async function loadSessionJar() {
  try {
    const serialized = JSON.parse(await fs.readFile(sessionFile, "utf8"));
    return CookieJar.deserialize(serialized);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("No saved REBOKS session. Use the Login button first.");
    }
    throw error;
  }
}

export async function saveSessionJar(jar) {
  await ensureDataDirectory();
  const temporaryFile = `${sessionFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(jar.serializeSync(), null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryFile, sessionFile);
}

export async function hasSavedSession() {
  try {
    await fs.access(sessionFile);
    return true;
  } catch {
    return false;
  }
}
