#!/usr/bin/env node
/**
 * refresh-cookie.mjs
 *
 * Extracts a fresh Wanderlog connect.sid cookie and writes it to
 * ~/.cursor/mcp.json automatically.
 *
 * First run:  opens a visible Arc window so you can log in to Wanderlog.
 *             The session is saved to ~/.wanderlog-mcp-browser.
 * Later runs: headless — grabs the cookie silently and updates the config.
 *
 * Usage:
 *   node ~/Code/wanderlog-mcp/scripts/refresh-cookie.mjs
 *   npm run refresh-cookie   (from the wanderlog-mcp directory)
 */

import { chromium } from "playwright-core";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Chrome supports multiple simultaneous instances; Arc does not.
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ARC_EXECUTABLE = "/Applications/Arc.app/Contents/MacOS/Arc";
const BROWSER_EXECUTABLE = existsSync(CHROME_EXECUTABLE) ? CHROME_EXECUTABLE : ARC_EXECUTABLE;
const PROFILE_DIR = join(homedir(), ".wanderlog-mcp-browser");
const MCP_CONFIG = join(homedir(), ".cursor/mcp.json");
const WANDERLOG_URL = "https://wanderlog.com";

const isFirstRun = !existsSync(join(PROFILE_DIR, "Default"));

if (isFirstRun) {
  console.log("First run — opening Arc so you can log in to Wanderlog.");
  console.log("Once logged in, close the browser window to continue.\n");
} else {
  console.log("Extracting fresh Wanderlog cookie (headless)…");
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: BROWSER_EXECUTABLE,
  headless: !isFirstRun,
  args: ["--no-first-run", "--disable-extensions-except=", "--disable-plugins"],
});

const page = context.pages()[0] ?? await context.newPage();

await page.goto(WANDERLOG_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

if (isFirstRun) {
  console.log("Log in to Wanderlog, then close the browser window.");
  // Wait until the browser is closed by the user
  await context.waitForEvent("close").catch(() => {});
  console.log("\nBrowser closed. Re-run this script to extract the cookie.");
  process.exit(0);
}

// Give the page a moment to settle and send auth cookies
await page.waitForTimeout(2000);

const cookies = await context.cookies([WANDERLOG_URL]);
const sid = cookies.find((c) => c.name === "connect.sid");

await context.close();

if (!sid) {
  console.error(
    "\n❌ connect.sid not found.\n" +
    "   You may not be logged in. Run the script once with a visible browser:\n" +
    `   rm -rf ${PROFILE_DIR} && node ${import.meta.filename}`,
  );
  process.exit(1);
}

// Update ~/.cursor/mcp.json
if (!existsSync(MCP_CONFIG)) {
  console.error(`\n❌ MCP config not found at ${MCP_CONFIG}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(MCP_CONFIG, "utf8"));
const server = config.mcpServers?.wanderlog;

if (!server) {
  console.error('\n❌ No "wanderlog" entry found in mcp.json');
  process.exit(1);
}

server.env = server.env ?? {};
server.env.WANDERLOG_COOKIE = sid.value;
writeFileSync(MCP_CONFIG, JSON.stringify(config, null, 2) + "\n");

console.log(`\n✅ Cookie refreshed: ${sid.value.slice(0, 24)}…`);
console.log(`   Written to: ${MCP_CONFIG}`);
console.log("   Restart the MCP server in Cursor to apply (Settings → MCP → Refresh).");
