import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { normalizeCookie } from "../config.js";
import type { AppContext } from "../context.js";

const MCP_CONFIG = join(homedir(), ".cursor/mcp.json");

export const setCookieInputSchema = {
  cookie: z
    .string()
    .describe(
      "The connect.sid cookie value from wanderlog.com. " +
      "Get it from DevTools → Application → Cookies → wanderlog.com → connect.sid. " +
      "Accepts the raw value (s%3A...) or a full cookie string (connect.sid=s%3A...).",
    ),
};

export const setCookieDescription = `
Updates the Wanderlog session cookie immediately — no server restart required.

Use this when Wanderlog tools return an auth error (session expired):
  1. Open wanderlog.com in your browser
  2. Open DevTools (Cmd+Option+I)
  3. Go to Application → Cookies → https://wanderlog.com
  4. Copy the value of the "connect.sid" cookie
  5. Call this tool with that value

The new cookie is applied immediately in memory and persisted to ~/.cursor/mcp.json.
`.trim();

type Args = { cookie: string };

export async function setCookie(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const normalized = normalizeCookie(args.cookie.trim());

  // Save old cookie so we can roll back if auth probe fails
  const oldCookieHeader = ctx.config.cookieHeader;
  ctx.config.cookieHeader = normalized;

  // Probe auth with the new cookie
  try {
    const user = await ctx.rest.getUser();
    ctx.userId = user.id;
    ctx.authenticated = true;
  } catch {
    ctx.config.cookieHeader = oldCookieHeader;
    return {
      content: [{
        type: "text",
        text: [
          "❌ Auth probe failed — the cookie value may be invalid or expired.",
          "Make sure you copied the full connect.sid value from DevTools → Application → Cookies.",
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
        // Store the raw value (without the "connect.sid=" prefix)
        const raw = normalized.replace(/^connect\.sid=/, "");
        server.env.WANDERLOG_COOKIE = raw;
        writeFileSync(MCP_CONFIG, JSON.stringify(config, null, 2) + "\n");
        persisted = true;
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    content: [{
      type: "text",
      text: [
        `✅ Cookie updated — authenticated as user ${ctx.userId}`,
        persisted
          ? `   Persisted to ${MCP_CONFIG} (survives restarts)`
          : `   ⚠️ Could not write to ${MCP_CONFIG} — live for this session only`,
      ].join("\n"),
    }],
  };
}
