#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ChromeSession } from "./browser.js";
import { loadConfig } from "./config.js";
import { IntermarcheClient } from "./intermarche/client.js";
import { createServer } from "./server.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export async function main(): Promise<void> {
  const config = loadConfig();
  const browser = new ChromeSession({
    chromePath: config.chromePath,
    profileDir: config.chromeProfileDir,
    port: config.chromePort,
    headless: config.headless,
    autoLaunch: config.autoLaunch,
    timeoutMs: config.cdpTimeoutMs,
  });
  const client = new IntermarcheClient(config, browser);
  const server = createServer(client, packageJson.version);
  const shutdown = async () => {
    await client.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await server.connect(new StdioServerTransport());
  console.error(
    `mcp-intermarche-drive ${packageJson.version} ready (CDP :${config.chromePort}; one visible tab; no checkout tool)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal:", error);
    process.exit(1);
  });
}
