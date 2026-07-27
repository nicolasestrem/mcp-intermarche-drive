import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface IntermarcheConfig {
  chromePath?: string;
  chromeProfileDir: string;
  chromePort: number;
  headless: boolean;
  autoLaunch: boolean;
  catalogId: string;
  pdvRef?: string;
  minIntervalMs: number;
  jitterMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  cdpTimeoutMs: number;
}

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function defaultChromePath(): string | undefined {
  if (platform() === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (platform() === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return undefined;
}

export function loadConfig(): IntermarcheConfig {
  return {
    chromePath: process.env.INTERMARCHE_CHROME_PATH?.trim() || defaultChromePath(),
    chromeProfileDir:
      process.env.INTERMARCHE_CHROME_PROFILE_DIR?.trim() ||
      join(homedir(), ".mcp-intermarche-drive", "chrome"),
    chromePort: intEnv("INTERMARCHE_CHROME_PORT", 9222),
    headless: boolEnv("INTERMARCHE_HEADLESS", false),
    autoLaunch: boolEnv("INTERMARCHE_AUTO_LAUNCH", true),
    catalogId: process.env.INTERMARCHE_CATALOG_ID?.trim() || "641",
    pdvRef: process.env.INTERMARCHE_PDV_REF?.trim() || undefined,
    minIntervalMs: intEnv("INTERMARCHE_MIN_INTERVAL_MS", 1100),
    jitterMs: intEnv("INTERMARCHE_JITTER_MS", 500),
    maxRetries: intEnv("INTERMARCHE_MAX_RETRIES", 2),
    backoffBaseMs: intEnv("INTERMARCHE_BACKOFF_BASE_MS", 1800),
    cdpTimeoutMs: intEnv("INTERMARCHE_CDP_TIMEOUT_MS", 30_000),
  };
}
