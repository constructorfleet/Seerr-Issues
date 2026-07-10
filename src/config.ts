import { log } from "./logger.js";
import { env } from "./env.js";

export type RedownloadMode = "blocklist-search" | "search" | "delete-search";

/**
 * Hooks the caller can pass into an arr `redownload()` to make the operation
 * crash-safe. `beforeExecute` fires once the target is resolved but BEFORE any
 * mutation (queue removal, file delete, search), so the caller can durably
 * record intent and recover an interrupted sequence on restart.
 */
export interface RedownloadHooks {
  beforeExecute?: (info: { title: string; outstanding?: number[] }) => void | Promise<void>;
}

export interface ArrConfig {
  url: string;
  apiKey: string;
}

export interface SeerrConfig {
  url: string;
  apiKey: string;
}

export interface Config {
  port: number;
  webhookSecret: string | null;
  redownloadMode: RedownloadMode;
  /** Only act on issues whose type is in this set, or empty to act on all. */
  issueTypes: Set<number>;
  radarr: ArrConfig | null;
  sonarr: ArrConfig | null;
  /** Seerr API access, for resolving issues once the replacement imports. */
  seerr: SeerrConfig | null;
  /** Whether to post a comment on the issue when resolving it. */
  resolveComment: boolean;
  /** Where pending redownloads are persisted so they survive restarts. */
  stateFile: string;
  /** How long to wait for a replacement import before giving up (ms). */
  pendingTtlMs: number;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseArr(prefix: string): ArrConfig | null {
  const url = env(`${prefix}_URL`);
  const apiKey = env(`${prefix}_API_KEY`);
  if (!url && !apiKey) return null;
  if (!url || !apiKey) {
    throw new Error(`${prefix}_URL and ${prefix}_API_KEY must be set together`);
  }
  return { url: trimTrailingSlash(url), apiKey };
}

function parseMode(raw: string | undefined): RedownloadMode {
  const value = (raw ?? "blocklist-search").trim();
  if (value === "blocklist-search" || value === "search" || value === "delete-search") {
    return value;
  }
  throw new Error(
    `Invalid REDOWNLOAD_MODE "${value}". Expected blocklist-search | search | delete-search`,
  );
}

function parseIssueTypes(raw: string | undefined): Set<number> {
  if (!raw || !raw.trim()) return new Set();
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  return new Set(ids);
}

function parseSeerr(): SeerrConfig | null {
  const url = env("SEERR_URL");
  const apiKey = env("SEERR_API_KEY");
  if (!url && !apiKey) return null;
  if (!url || !apiKey) {
    throw new Error("SEERR_URL and SEERR_API_KEY must be set together");
  }
  return { url: trimTrailingSlash(url), apiKey };
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function loadConfig(): Config {
  const radarr = parseArr("RADARR");
  const sonarr = parseArr("SONARR");

  if (!radarr && !sonarr) {
    throw new Error(
      "At least one of Radarr or Sonarr must be configured (set RADARR_URL/RADARR_API_KEY or SONARR_URL/SONARR_API_KEY)",
    );
  }

  const ttlDays = Number(env("PENDING_TTL_DAYS") ?? 7);

  const config: Config = {
    port: Number(env("PORT") ?? 3939),
    webhookSecret: env("WEBHOOK_SECRET")?.trim() || null,
    redownloadMode: parseMode(env("REDOWNLOAD_MODE")),
    issueTypes: parseIssueTypes(env("ISSUE_TYPES")),
    radarr,
    sonarr,
    seerr: parseSeerr(),
    resolveComment: parseBool(env("RESOLVE_COMMENT"), true),
    stateFile: env("STATE_FILE")?.trim() || "/data/pending.json",
    pendingTtlMs: (Number.isFinite(ttlDays) ? ttlDays : 7) * 24 * 60 * 60 * 1000,
  };

  log.info("Configuration loaded", {
    port: config.port,
    redownloadMode: config.redownloadMode,
    webhookAuth: config.webhookSecret ? "enabled" : "disabled",
    issueTypes: config.issueTypes.size ? [...config.issueTypes] : "all",
    radarr: config.radarr ? config.radarr.url : "not configured",
    sonarr: config.sonarr ? config.sonarr.url : "not configured",
    seerr: config.seerr
      ? `${config.seerr.url} (auto-resolve enabled)`
      : "not configured (fire-and-forget)",
  });

  return config;
}
