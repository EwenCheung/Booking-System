import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { dataDirectory, projectDirectory } from "./config.js";

const executeFile = promisify(execFile);
const serviceLabel = "local.reboks-booking-helper";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serviceFile() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${serviceLabel}.plist`);
}

function serviceDomain() {
  return `gui/${process.getuid()}`;
}

function plistContents() {
  const cli = path.join(projectDirectory, "src", "cli.js");
  const stdout = path.join(dataDirectory, "scheduler.out.log");
  const stderr = path.join(dataDirectory, "scheduler.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${serviceLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(cli)}</string>
    <string>watch</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(projectDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(stderr)}</string>
</dict>
</plist>
`;
}

export async function installService() {
  if (process.platform !== "darwin") {
    throw new Error("Automatic service installation is currently supported only on macOS.");
  }
  await fs.mkdir(path.dirname(serviceFile()), { recursive: true });
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(serviceFile(), plistContents(), { mode: 0o600 });
  await executeFile("launchctl", ["bootout", serviceDomain(), serviceFile()]).catch(() => {});
  await executeFile("launchctl", ["bootstrap", serviceDomain(), serviceFile()]);
  return serviceFile();
}

export async function uninstallService() {
  if (process.platform !== "darwin") {
    throw new Error("Automatic service installation is currently supported only on macOS.");
  }
  await executeFile("launchctl", ["bootout", serviceDomain(), serviceFile()]).catch(() => {});
  await fs.unlink(serviceFile()).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return serviceFile();
}

export async function serviceStatus() {
  if (process.platform !== "darwin") return { installed: false, platform: process.platform };
  try {
    const { stdout } = await executeFile("launchctl", [
      "print",
      `${serviceDomain()}/${serviceLabel}`,
    ]);
    return { installed: true, details: stdout };
  } catch {
    return { installed: false };
  }
}
