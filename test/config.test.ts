import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { env } from "../src/env.js";

// Keys this suite touches, so we can reset a clean slate each time.
const KEYS = [
  "RADARR_URL",
  "RADARR_API_KEY",
  "SONARR_URL",
  "SONARR_API_KEY",
  "SEERR_URL",
  "SEERR_API_KEY",
  "SEERR_URL_FILE",
  "SEERR_API_KEY_FILE",
  "PORT",
  "WEBHOOK_SECRET",
  "REDOWNLOAD_MODE",
  "ISSUE_TYPES",
  "RESOLVE_COMMENT",
  "STATE_FILE",
  "PENDING_TTL_DAYS",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("loadConfig throws when neither Radarr nor Sonarr is configured", () => {
  assert.throws(() => loadConfig(), /At least one of Radarr or Sonarr/);
});

test("loadConfig throws when an arr url is set without its api key", () => {
  process.env.RADARR_URL = "http://radarr:7878";
  assert.throws(() => loadConfig(), /RADARR_URL and RADARR_API_KEY must be set together/);
});

test("loadConfig applies defaults with a single arr configured", () => {
  process.env.RADARR_URL = "http://radarr:7878/";
  process.env.RADARR_API_KEY = "abc";
  const config = loadConfig();

  assert.equal(config.port, 3939);
  assert.equal(config.webhookSecret, null);
  assert.equal(config.redownloadMode, "blocklist-search");
  assert.equal(config.issueTypes.size, 0);
  assert.equal(config.resolveComment, true);
  assert.equal(config.stateFile, "/data/pending.json");
  assert.equal(config.pendingTtlMs, 7 * 24 * 60 * 60 * 1000);
  // Trailing slash trimmed.
  assert.deepEqual(config.radarr, { url: "http://radarr:7878", apiKey: "abc" });
  assert.equal(config.sonarr, null);
  assert.equal(config.seerr, null);
});

test("loadConfig parses overrides for every field", () => {
  process.env.SONARR_URL = "http://sonarr:8989///";
  process.env.SONARR_API_KEY = "key";
  process.env.SEERR_URL = "http://seerr:5055";
  process.env.SEERR_API_KEY = "seerrkey";
  process.env.PORT = "8080";
  process.env.WEBHOOK_SECRET = "  s3cret  ";
  process.env.REDOWNLOAD_MODE = "delete-search";
  process.env.ISSUE_TYPES = "1, 3 ,bad,4";
  process.env.RESOLVE_COMMENT = "no";
  process.env.STATE_FILE = "/tmp/state.json";
  process.env.PENDING_TTL_DAYS = "2";
  const config = loadConfig();

  assert.equal(config.port, 8080);
  assert.equal(config.webhookSecret, "s3cret");
  assert.equal(config.redownloadMode, "delete-search");
  assert.deepEqual([...config.issueTypes].sort(), [1, 3, 4]);
  assert.equal(config.resolveComment, false);
  assert.equal(config.stateFile, "/tmp/state.json");
  assert.equal(config.pendingTtlMs, 2 * 24 * 60 * 60 * 1000);
  assert.equal(config.sonarr!.url, "http://sonarr:8989");
  assert.deepEqual(config.seerr, { url: "http://seerr:5055", apiKey: "seerrkey" });
});

test("loadConfig rejects an invalid redownload mode", () => {
  process.env.RADARR_URL = "http://r";
  process.env.RADARR_API_KEY = "k";
  process.env.REDOWNLOAD_MODE = "nuke-everything";
  assert.throws(() => loadConfig(), /Invalid REDOWNLOAD_MODE/);
});

test("loadConfig throws when Seerr url and key are not set together", () => {
  process.env.RADARR_URL = "http://r";
  process.env.RADARR_API_KEY = "k";
  process.env.SEERR_URL = "http://seerr";
  assert.throws(() => loadConfig(), /SEERR_URL and SEERR_API_KEY must be set together/);
});

test("loadConfig falls back to a 7-day ttl when PENDING_TTL_DAYS is not a number", () => {
  process.env.RADARR_URL = "http://r";
  process.env.RADARR_API_KEY = "k";
  process.env.PENDING_TTL_DAYS = "not-a-number";
  const config = loadConfig();
  assert.equal(config.pendingTtlMs, 7 * 24 * 60 * 60 * 1000);
});

test("RESOLVE_COMMENT accepts a range of truthy/falsy spellings", () => {
  process.env.RADARR_URL = "http://r";
  process.env.RADARR_API_KEY = "k";
  for (const [raw, expected] of [
    ["1", true],
    ["true", true],
    ["YES", true],
    ["on", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["nonsense", false],
  ] as const) {
    process.env.RESOLVE_COMMENT = raw;
    assert.equal(loadConfig().resolveComment, expected, `RESOLVE_COMMENT=${raw}`);
  }
});

test("env() reads NAME_FILE and trims a single trailing newline, overriding NAME", () => {
  const dir = mkdtempSync(join(tmpdir(), "seerr-env-"));
  const secretPath = join(dir, "secret");
  writeFileSync(secretPath, "file-secret\n");
  process.env.SEERR_API_KEY = "plain-secret";
  process.env.SEERR_API_KEY_FILE = secretPath;
  try {
    assert.equal(env("SEERR_API_KEY"), "file-secret");
  } finally {
    delete process.env.SEERR_API_KEY_FILE;
  }
});

test("env() throws a helpful error when NAME_FILE points at a missing file", () => {
  process.env.SEERR_API_KEY_FILE = join(tmpdir(), "definitely-missing-secret-file");
  try {
    assert.throws(() => env("SEERR_API_KEY"), /Failed to read SEERR_API_KEY_FILE/);
  } finally {
    delete process.env.SEERR_API_KEY_FILE;
  }
});

test("env() returns the plain variable when no NAME_FILE is set", () => {
  process.env.PORT = "1234";
  assert.equal(env("PORT"), "1234");
  assert.equal(env("SOMETHING_UNSET"), undefined);
});
