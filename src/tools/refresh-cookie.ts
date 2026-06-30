import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { chromium } from "playwright-core";
import { z } from "zod";
import { normalizeCookie } from "../config.js";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";

// Chrome supports multiple simultaneous instances; Arc does not.
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ARC_EXECUTABLE = "/Applications/Arc.app/Contents/MacOS/Arc";
const BROWSER_EXECUTABLE = existsSync(CHROME_EXECUTABLE) ? CHROME_EXECUTABLE : ARC_EXECUTABLE;
const PROFILE_DIR = join(homedir(), ".wanderlog-mcp-browser");
const MCP_CONFIG = join(homedir(), ".cursor/mcp.json");
const WANDERLOG_URL = "https://wanderlog.com";

export const refreshCookieInputSchema = {
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Pass true to confirm you want to refresh the cookie. Required to prevent accidental calls.",
    ),
};

export const refreshCookieDescription = `
Refreshes the Wanderlog session cookie automatically using a headless Arc browser.

Call this when Wanderlog tools return an auth error (session expired). The tool:
  1. Launches a headless Arc browser using a saved profile (~/.wanderlog-mcp-browser)
  2. Navigates to wanderlog.com to obtain a fresh connect.sid cookie
  3. Updates WANDERLOG_COOKIE in ~/.cursor/mcp.json for persistence
  4. Applies the new cookie immediately — no server restart required

First-time setup: if no saved profile exists, a visible Arc window opens so you
can log in to Wanderlog. Close the window when done, then call this tool again.

Requires confirm: true to run.
`.trim();

type Args = { confirm?: boolean };

export async function refreshCookie(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!args.confirm) {
    return {
      content: [{ type: "text", text: 'Pass confirm: true to refresh the Wanderlog cookie.' }],
    };
  }

  try {
    // Peek at stored cookies without a full browser launch to decide if login is needed
    const peekContext = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-first-run", "--disable-extensions-except=", "--disable-plugins"],
      timeout: 10_000,
    });
    const storedCookies = await peekContext.cookies([WANDERLOG_URL]);
    await peekContext.close();

    const hasSavedSession = storedCookies.some((c) => c.name === "connect.sid");

    if (!hasSavedSession) {
      // No valid session in profile — open a visible window for login
      const loginContext = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: BROWSER_EXECUTABLE,
        headless: false,
        args: ["--no-first-run", "--disable-extensions-except=", "--disable-plugins"],
        timeout: 10_000,
      });
      const page = loginContext.pages()[0] ?? await loginContext.newPage();
      await page.goto(WANDERLOG_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Wait for the user to close the browser (up to 10 minutes)
      await page.waitForEvent("close", { timeout: 10 * 60 * 1000 }).catch(() => {});
      await loginContext.close().catch(() => {});
      return {
        content: [{
          type: "text",
          text: [
            "✅ Browser closed. Now call wanderlog_refresh_cookie again (with confirm: true) to extract the cookie.",
          ].join("\n"),
        }],
      };
    }

    // Headless run — navigate to refresh session cookies
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: BROWSER_EXECUTABLE,
      headless: true,
      args: ["--no-first-run", "--disable-extensions-except=", "--disable-plugins"],
      timeout: 10_000,
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(WANDERLOG_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);

    const cookies = await context.cookies([WANDERLOG_URL]);
    await context.close();

    const sid = cookies.find((c) => c.name === "connect.sid");
    if (!sid) {
      return {
        content: [{
          type: "text",
          text: [
            "❌ connect.sid not found after navigation.",
            "The session may have expired. To reset:",
            `  rm -rf ${PROFILE_DIR}`,
            "Then call wanderlog_refresh_cookie again to open a login window.",
          ].join("\n"),
        }],
        isError: true,
      };
    }

    // Save old cookie so we can roll back if auth probe fails
    const oldCookieHeader = ctx.config.cookieHeader;

    // Update in-memory config immediately — no restart needed
    const normalized = normalizeCookie(sid.value);
    ctx.config.cookieHeader = normalized;

    // Re-probe auth with the new cookie
    try {
      const user = await ctx.rest.getUser();
      ctx.userId = user.id;
      ctx.authenticated = true;
    } catch {
      // Roll back to the old cookie so existing session continues working
      ctx.config.cookieHeader = oldCookieHeader;
      return {
        content: [{
          type: "text",
          text: [
            "❌ Cookie extracted but auth probe failed — the Chrome session may not be logged in.",
            `Delete the profile and try again:`,
            `  rm -rf ${PROFILE_DIR}`,
            "Then call wanderlog_refresh_cookie to open a login window.",
          ].join("\n"),
        }],
        isError: true,
      };
    }

    // Persist to ~/.cursor/mcp.json
    let persisted = false;
    if (existsSync(MCP_CONFIG)) {
      try {
        const config = JSON.parse(readFileSync(MCP_CONFIG, "utf8"));
        const server = config.mcpServers?.wanderlog;
        if (server) {
          server.env = server.env ?? {};
          server.env.WANDERLOG_COOKIE = sid.value;
          writeFileSync(MCP_CONFIG, JSON.stringify(config, null, 2) + "\n");
          persisted = true;
        }
      } catch {
        // Non-fatal — cookie is already live in memory
      }
    }

    return {
      content: [{
        type: "text",
        text: [
          `✅ Cookie refreshed and applied immediately.`,
          `   Session: authenticated as user ${ctx.userId}`,
          persisted
            ? `   Persisted to: ${MCP_CONFIG} (no restart needed)`
            : `   ⚠️ Could not write to ${MCP_CONFIG} — cookie is live for this session only.`,
        ].join("\n"),
      }],
    };
  } catch (err) {
    const msg = err instanceof WanderlogError
      ? err.toUserMessage()
      : (err as Error).message;
    return {
      content: [{ type: "text", text: `❌ Cookie refresh failed: ${msg}` }],
      isError: true,
    };
  }
}
