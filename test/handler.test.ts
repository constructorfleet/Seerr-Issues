import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueHandler } from "../src/handler.js";
import { Config } from "../src/config.js";
import { ParsedIssue, IssueType } from "../src/seerr.js";
import { ArrImport } from "../src/arr-webhook.js";
import { RadarrClient, RadarrResult } from "../src/arr/radarr.js";
import { SonarrClient, SonarrResult } from "../src/arr/sonarr.js";
import { RedownloadHooks } from "../src/config.js";
import { SeerrApi } from "../src/seerr-api.js";
import { movieKey, tvKey, episodeId } from "../src/store.js";

const DAY = 24 * 60 * 60 * 1000;

function baseConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "seerr-handler-"));
  return {
    port: 3939,
    webhookSecret: null,
    redownloadMode: "blocklist-search",
    issueTypes: new Set(),
    radarr: { url: "http://radarr", apiKey: "k" },
    sonarr: { url: "http://sonarr", apiKey: "k" },
    seerr: { url: "http://seerr", apiKey: "k" },
    resolveComment: true,
    stateFile: join(dir, "pending.json"),
    pendingTtlMs: 7 * DAY,
    ...overrides,
  };
}

function issue(overrides: Partial<ParsedIssue> = {}): ParsedIssue {
  return {
    notificationType: "ISSUE_CREATED",
    issueId: "42",
    issueType: IssueType.VIDEO,
    mediaType: "movie",
    tmdbId: 603,
    tvdbId: null,
    affectedSeason: null,
    affectedEpisode: null,
    subject: "Broken",
    ...overrides,
  };
}

// Stub the network-touching client methods; the handler builds these instances
// internally, so mocking the prototype covers whatever it constructs.
let redownloadMovie: ReturnType<typeof mock.method>;
let redownloadTv: ReturnType<typeof mock.method>;
let comment: ReturnType<typeof mock.method>;
let resolve: ReturnType<typeof mock.method>;

beforeEach(() => {
  // The real clients invoke hooks.beforeExecute (with the resolved title and,
  // for seasons, the outstanding set) BEFORE mutating — that's where the handler
  // writes its write-ahead pending entry. Mocks must honor the same contract.
  redownloadMovie = mock.method(
    RadarrClient.prototype,
    "redownload",
    async (_tmdbId: number, _mode, hooks?: RedownloadHooks): Promise<RadarrResult> => {
      await hooks?.beforeExecute?.({ title: "The Matrix" });
      return { matched: true, title: "The Matrix", actions: ["triggered search"] };
    },
  );
  redownloadTv = mock.method(
    SonarrClient.prototype,
    "redownload",
    async (_tvdbId: number, _mode, _s, _e, hooks?: RedownloadHooks): Promise<SonarrResult> => {
      await hooks?.beforeExecute?.({ title: "Show" });
      return { matched: true, title: "Show", actions: ["triggered search"] };
    },
  );
  comment = mock.method(SeerrApi.prototype, "comment", async () => {});
  resolve = mock.method(SeerrApi.prototype, "resolve", async () => {});
});

afterEach(() => {
  mock.restoreAll();
});

test("ignores non-actionable notification types", async () => {
  const handler = new IssueHandler(baseConfig());
  const result = await handler.handleIssue(issue({ notificationType: "ISSUE_COMMENT" }));
  assert.equal(result.status, "ignored");
  assert.match(result.reason!, /not actionable/);
  assert.equal(redownloadMovie.mock.callCount(), 0);
});

test("ignores issues whose type is outside the ISSUE_TYPES filter", async () => {
  const handler = new IssueHandler(baseConfig({ issueTypes: new Set([IssueType.AUDIO]) }));
  const result = await handler.handleIssue(issue({ issueType: IssueType.VIDEO }));
  assert.equal(result.status, "ignored");
  assert.match(result.reason!, /not in ISSUE_TYPES/);
});

test("acts on issues whose type is inside the ISSUE_TYPES filter", async () => {
  const handler = new IssueHandler(baseConfig({ issueTypes: new Set([IssueType.VIDEO]) }));
  const result = await handler.handleIssue(issue({ issueType: IssueType.VIDEO }));
  assert.equal(result.status, "ok");
  assert.equal(redownloadMovie.mock.callCount(), 1);
});

test("movie issue triggers a Radarr redownload and tracks it as pending", async () => {
  const handler = new IssueHandler(baseConfig());
  const result = await handler.handleIssue(issue({ tmdbId: 603 }));
  assert.equal(result.status, "ok");
  assert.equal(redownloadMovie.mock.callCount(), 1);
  const [tmdbId, mode] = redownloadMovie.mock.calls[0].arguments;
  assert.deepEqual([tmdbId, mode], [603, "blocklist-search"]);
});

test("movie issue is skipped when Radarr is not configured", async () => {
  const handler = new IssueHandler(baseConfig({ radarr: null }));
  const result = await handler.handleIssue(issue({ mediaType: "movie" }));
  assert.equal(result.status, "skipped");
  assert.match(result.reason!, /Radarr not configured/);
});

test("movie issue without a tmdbId is skipped", async () => {
  const handler = new IssueHandler(baseConfig());
  const result = await handler.handleIssue(issue({ tmdbId: null }));
  assert.equal(result.status, "skipped");
  assert.match(result.reason!, /missing tmdbId/);
});

test("movie issue with no matching Radarr movie is skipped", async () => {
  redownloadMovie.mock.mockImplementation(async () => ({ matched: false, actions: [] }));
  const handler = new IssueHandler(baseConfig());
  const result = await handler.handleIssue(issue({ tmdbId: 999 }));
  assert.equal(result.status, "skipped");
  assert.match(result.reason!, /no Radarr movie for tmdbId 999/);
});

test("tv issue triggers a Sonarr redownload with season/episode scope", async () => {
  const handler = new IssueHandler(baseConfig());
  const result = await handler.handleIssue(
    issue({ mediaType: "tv", tmdbId: null, tvdbId: 100, affectedSeason: 2, affectedEpisode: 5 }),
  );
  assert.equal(result.status, "ok");
  const [tvdbId, mode, season, ep] = redownloadTv.mock.calls[0].arguments;
  assert.deepEqual([tvdbId, mode, season, ep], [100, "blocklist-search", 2, 5]);
});

test("tv issue is skipped when Sonarr is not configured", async () => {
  const handler = new IssueHandler(baseConfig({ sonarr: null }));
  const result = await handler.handleIssue(issue({ mediaType: "tv", tmdbId: null, tvdbId: 1 }));
  assert.equal(result.status, "skipped");
  assert.match(result.reason!, /Sonarr not configured/);
});

test("tv issue without a tvdbId is skipped", async () => {
  const handler = new IssueHandler(baseConfig());
  const result = await handler.handleIssue(issue({ mediaType: "tv", tmdbId: null, tvdbId: null }));
  assert.equal(result.status, "skipped");
  assert.match(result.reason!, /missing tvdbId/);
});

test("a whole-show report is refused and a too-broad comment is posted", async () => {
  redownloadTv.mock.mockImplementation(async () => ({
    matched: true,
    title: "Show",
    actions: [],
    skippedTooBroad: true,
  }));
  const handler = new IssueHandler(baseConfig());
  const result = await handler.handleIssue(
    issue({ mediaType: "tv", tmdbId: null, tvdbId: 100, affectedSeason: null }),
  );
  assert.equal(result.status, "skipped");
  assert.match(result.reason!, /too broad/);
  assert.equal(comment.mock.callCount(), 1);
  assert.equal(comment.mock.calls[0].arguments[0], 42); // issueId
  assert.match(String(comment.mock.calls[0].arguments[1]), /entire series/);
});

test("too-broad comment is not posted when resolveComment is disabled", async () => {
  redownloadTv.mock.mockImplementation(async () => ({
    matched: true,
    title: "Show",
    actions: [],
    skippedTooBroad: true,
  }));
  const handler = new IssueHandler(baseConfig({ resolveComment: false }));
  const result = await handler.handleIssue(
    issue({ mediaType: "tv", tmdbId: null, tvdbId: 100, affectedSeason: null }),
  );
  assert.equal(result.status, "skipped");
  assert.equal(comment.mock.callCount(), 0);
});

test("no pending entry is tracked when Seerr API is not configured", async () => {
  const handler = new IssueHandler(baseConfig({ seerr: null }));
  assert.equal(handler.canResolve, false);
  const result = await handler.handleIssue(issue({ tmdbId: 603 }));
  assert.equal(result.status, "ok");
  // With nothing tracked, an import can't resolve anything.
  const imp: ArrImport = {
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  };
  const importResult = await handler.handleImport(imp);
  assert.equal(importResult.status, "ignored");
  assert.match(importResult.reason!, /Seerr API not configured/);
});

test("a non-numeric issue_id is not tracked", async () => {
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(issue({ issueId: "not-a-number", tmdbId: 603 }));
  // Import for the same movie should find nothing pending.
  const result = await handler.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(result.status, "ignored");
  assert.match(result.reason!, /does not match any pending/);
});

test("end-to-end: a movie import resolves the tracked issue", async () => {
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));

  const result = await handler.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.detail, { issueId: 42, resolved: true });
  // One acknowledgment comment on redownload, one on resolve.
  assert.equal(comment.mock.callCount(), 2);
  assert.match(String(comment.mock.calls[0].arguments[1]), /Searching for a replacement/);
  assert.match(String(comment.mock.calls[1].arguments[1]), /finished importing/);
  assert.equal(resolve.mock.callCount(), 1);
  assert.equal(resolve.mock.calls[0].arguments[0], 42);
});

test("resolve is not commented when resolveComment is disabled", async () => {
  const handler = new IssueHandler(baseConfig({ resolveComment: false }));
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));
  await handler.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(comment.mock.callCount(), 0);
  assert.equal(resolve.mock.callCount(), 1);
});

test("a movie redownload acknowledges with a searching comment", async () => {
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));
  assert.equal(comment.mock.callCount(), 1);
  assert.equal(comment.mock.calls[0].arguments[0], 42);
  assert.match(String(comment.mock.calls[0].arguments[1]), /Searching for a replacement/);
});

test("the searching comment for a TV episode names the season and episode", async () => {
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(
    issue({
      mediaType: "tv",
      tmdbId: null,
      tvdbId: 100,
      issueId: "7",
      affectedSeason: 2,
      affectedEpisode: 5,
    }),
  );
  assert.equal(comment.mock.callCount(), 1);
  assert.match(String(comment.mock.calls[0].arguments[1]), /S2E5/);
});

test("the searching comment for a season names the season only", async () => {
  redownloadTv.mock.mockImplementation(async (_t, _m, _s, _e, hooks?: RedownloadHooks) => {
    const outstanding = [episodeId(2, 1), episodeId(2, 2)];
    await hooks?.beforeExecute?.({ title: "Show", outstanding });
    return { matched: true, title: "Show", actions: [], outstanding };
  });
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(
    issue({
      mediaType: "tv",
      tmdbId: null,
      tvdbId: 100,
      issueId: "7",
      affectedSeason: 2,
      affectedEpisode: null,
    }),
  );
  assert.equal(comment.mock.callCount(), 1);
  assert.match(String(comment.mock.calls[0].arguments[1]), /season 2/);
});

test("no searching comment is posted when resolveComment is disabled", async () => {
  const handler = new IssueHandler(baseConfig({ resolveComment: false }));
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));
  assert.equal(comment.mock.callCount(), 0);
});

test("startup recovery does not post a searching comment", async () => {
  redownloadMovie.mock.mockImplementation(crashAfterTracking("The Matrix"));
  mock.method(RadarrClient.prototype, "search", async () => true);
  mock.method(RadarrClient.prototype, "importedSince", async () => false);

  const config = baseConfig();
  const handler = new IssueHandler(config);
  await assert.rejects(() => handler.handleIssue(issue({ issueId: "42", tmdbId: 603 })), /crash/);
  // The crash happens before confirmSearch, so no ack comment on the initial run…
  const afterCrash = comment.mock.callCount();

  const reloaded = new IssueHandler(config);
  await reloaded.reconcile();
  // …and recovery must not add one either.
  assert.equal(comment.mock.callCount(), afterCrash);
});

test("handleImport ignores non-import event types", async () => {
  const handler = new IssueHandler(baseConfig());
  const result = await handler.handleImport({
    eventType: "Test",
    title: "x",
    candidateKeys: [movieKey(1)],
    importedEpisodeIds: [],
  });
  assert.equal(result.status, "ignored");
  assert.match(result.reason!, /not an import/);
});

test("a failed resolve re-tracks the item and rethrows so a retry can succeed", async () => {
  resolve.mock.mockImplementationOnce(async () => {
    throw new Error("seerr down");
  });
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));

  await assert.rejects(
    () =>
      handler.handleImport({
        eventType: "Download",
        title: "The Matrix",
        candidateKeys: [movieKey(603)],
        importedEpisodeIds: [],
      }),
    /seerr down/,
  );

  // Item was re-tracked; a second import (with resolve now succeeding) works.
  const retry = await handler.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(retry.status, "ok");
  assert.deepEqual(retry.detail, { issueId: 42, resolved: true });
});

test("season import reports progress before all episodes land, then resolves", async () => {
  redownloadTv.mock.mockImplementation(async (_t, _m, _s, _e, hooks?: RedownloadHooks) => {
    const outstanding = [episodeId(2, 1), episodeId(2, 2)];
    await hooks?.beforeExecute?.({ title: "Show", outstanding });
    return { matched: true, title: "Show", actions: ["triggered season search"], outstanding };
  });
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(
    issue({
      mediaType: "tv",
      tmdbId: null,
      tvdbId: 100,
      issueId: "7",
      affectedSeason: 2,
      affectedEpisode: null,
    }),
  );

  const key = tvKey(100, 2, null);
  const first = await handler.handleImport({
    eventType: "Download",
    title: "Show",
    candidateKeys: [key],
    importedEpisodeIds: [episodeId(2, 1)],
  });
  assert.equal(first.status, "ok");
  assert.deepEqual(first.detail, { issueId: 7, resolved: false, remaining: 1 });
  assert.equal(resolve.mock.callCount(), 0);

  const second = await handler.handleImport({
    eventType: "Download",
    title: "Show",
    candidateKeys: [key],
    importedEpisodeIds: [episodeId(2, 2)],
  });
  assert.equal(second.status, "ok");
  assert.deepEqual(second.detail, { issueId: 7, resolved: true });
  assert.equal(resolve.mock.callCount(), 1);
});

test("pending entries survive being reloaded into a fresh handler", async () => {
  const config = baseConfig();
  const handler = new IssueHandler(config);
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));

  // A brand-new handler pointed at the same state file resolves the import.
  const reloaded = new IssueHandler(config);
  const result = await reloaded.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.detail, { issueId: 42, resolved: true });
});

test("prunePending removes expired entries", async () => {
  const handler = new IssueHandler(baseConfig({ pendingTtlMs: -1 }));
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));
  // Negative ttl means everything is instantly stale.
  const removed = handler.prunePending();
  assert.equal(removed, 1);
});

test("reconcile resolves a movie whose import was missed while down", async () => {
  const importedSince = mock.method(RadarrClient.prototype, "importedSince", async () => true);
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));

  await handler.reconcile();
  assert.equal(importedSince.mock.callCount(), 1);
  assert.equal(resolve.mock.callCount(), 1);
  assert.equal(resolve.mock.calls[0].arguments[0], 42);
  // Entry cleared, so a later import won't double-resolve.
  const after = await handler.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(after.status, "ignored");
});

test("reconcile drops a movie entry when Radarr no longer knows the movie", async () => {
  const importedSince = mock.method(RadarrClient.prototype, "importedSince", async () => null);
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));

  await handler.reconcile();
  assert.equal(importedSince.mock.callCount(), 1);
  assert.equal(resolve.mock.callCount(), 0);
  // Dropped, not resolved.
  const after = await handler.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(after.status, "ignored");
});

test("reconcile leaves a movie pending when nothing imported yet", async () => {
  mock.method(RadarrClient.prototype, "importedSince", async () => false);
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));

  await handler.reconcile();
  assert.equal(resolve.mock.callCount(), 0);
  // Still pending, so a subsequent real import resolves it.
  const after = await handler.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(after.status, "ok");
});

test("reconcile advances a season entry and resolves once all episodes imported", async () => {
  redownloadTv.mock.mockImplementation(async (_t, _m, _s, _e, hooks?: RedownloadHooks) => {
    const outstanding = [episodeId(2, 1), episodeId(2, 2)];
    await hooks?.beforeExecute?.({ title: "Show", outstanding });
    return { matched: true, title: "Show", actions: [], outstanding };
  });
  // First reconcile: only ep 1 has imported.
  const importedEps = mock.method(SonarrClient.prototype, "importedEpisodesSince", async () => [
    episodeId(2, 1),
  ]);
  const config = baseConfig();
  const handler = new IssueHandler(config);
  await handler.handleIssue(
    issue({
      mediaType: "tv",
      tmdbId: null,
      tvdbId: 100,
      issueId: "7",
      affectedSeason: 2,
      affectedEpisode: null,
    }),
  );

  await handler.reconcile();
  assert.equal(resolve.mock.callCount(), 0);

  // Second reconcile (fresh handler off the same file): both episodes imported.
  importedEps.mock.mockImplementation(async () => [episodeId(2, 1), episodeId(2, 2)]);
  const reloaded = new IssueHandler(config);
  await reloaded.reconcile();
  assert.equal(resolve.mock.callCount(), 1);
  assert.equal(resolve.mock.calls[0].arguments[0], 7);
});

test("reconcile resolves a single-episode entry only when that episode imported", async () => {
  // The Sonarr redownload returns no `outstanding` for a single-episode report.
  redownloadTv.mock.mockImplementation(async (_t, _m, _s, _e, hooks?: RedownloadHooks) => {
    await hooks?.beforeExecute?.({ title: "Show" });
    return { matched: true, title: "Show", actions: ["triggered search"] };
  });
  const importedEps = mock.method(
    SonarrClient.prototype,
    "importedEpisodesSince",
    async () => [episodeId(2, 9)], // a different episode
  );
  const config = baseConfig();
  const handler = new IssueHandler(config);
  await handler.handleIssue(
    issue({
      mediaType: "tv",
      tmdbId: null,
      tvdbId: 100,
      issueId: "7",
      affectedSeason: 2,
      affectedEpisode: 5,
    }),
  );

  await handler.reconcile();
  assert.equal(resolve.mock.callCount(), 0); // ep 5 hasn't imported

  importedEps.mock.mockImplementation(async () => [episodeId(2, 5)]);
  const reloaded = new IssueHandler(config);
  await reloaded.reconcile();
  assert.equal(resolve.mock.callCount(), 1);
});

test("reconcile is a no-op when Seerr API is not configured", async () => {
  const importedSince = mock.method(RadarrClient.prototype, "importedSince", async () => true);
  const handler = new IssueHandler(baseConfig({ seerr: null }));
  await handler.reconcile();
  assert.equal(importedSince.mock.callCount(), 0);
});

test("reconcile keeps an entry pending when the arr lookup throws", async () => {
  mock.method(RadarrClient.prototype, "importedSince", async () => {
    throw new Error("radarr timeout");
  });
  const handler = new IssueHandler(baseConfig());
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));

  await handler.reconcile(); // should swallow the error
  assert.equal(resolve.mock.callCount(), 0);
  // Entry survived, so a real import can still resolve it.
  const after = await handler.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(after.status, "ok");
});

// --- Crash-safety: a search a crash left un-sent is recovered on startup ---

/** Simulate a crash mid-redownload: the write-ahead entry is persisted (via the
 *  hook) but the process dies before the search is confirmed. */
function crashAfterTracking(title: string, outstanding?: number[]) {
  return async (
    _a?: unknown,
    _b?: unknown,
    _c?: unknown,
    _d?: unknown,
    hooks?: RedownloadHooks,
  ): Promise<never> => {
    // Sonarr passes hooks as the 5th arg, Radarr as the 3rd; normalize.
    const h = (hooks ?? _c) as RedownloadHooks | undefined;
    await h?.beforeExecute?.({ title, outstanding });
    throw new Error("crash before search confirmed");
  };
}

test("crash before search leaves the entry unconfirmed; recovery re-fires the movie search", async () => {
  redownloadMovie.mock.mockImplementation(crashAfterTracking("The Matrix"));
  const search = mock.method(RadarrClient.prototype, "search", async () => true);
  mock.method(RadarrClient.prototype, "importedSince", async () => false);

  const config = baseConfig();
  const handler = new IssueHandler(config);
  await assert.rejects(() => handler.handleIssue(issue({ issueId: "42", tmdbId: 603 })), /crash/);

  // A fresh boot reconciles: the unconfirmed search is re-fired idempotently.
  const reloaded = new IssueHandler(config);
  await reloaded.reconcile();
  assert.equal(search.mock.callCount(), 1);
  assert.equal(search.mock.calls[0].arguments[0], 603);
  assert.equal(resolve.mock.callCount(), 0); // nothing imported yet

  // Re-firing marks it confirmed, so a second boot does NOT search again.
  const thirdBoot = new IssueHandler(config);
  await thirdBoot.reconcile();
  assert.equal(search.mock.callCount(), 1);
});

test("recovery re-fires the search even when Seerr is not configured", async () => {
  redownloadMovie.mock.mockImplementation(crashAfterTracking("The Matrix"));
  const search = mock.method(RadarrClient.prototype, "search", async () => true);

  const config = baseConfig({ seerr: null });
  const handler = new IssueHandler(config);
  await assert.rejects(() => handler.handleIssue(issue({ issueId: "42", tmdbId: 603 })), /crash/);

  const reloaded = new IssueHandler(config);
  await reloaded.reconcile();
  // Even with no Seerr (no auto-resolve), a deleted file still gets its search.
  assert.equal(search.mock.callCount(), 1);
});

test("recovery re-fires a season search for the outstanding episodes", async () => {
  const outstanding = [episodeId(2, 1), episodeId(2, 2)];
  redownloadTv.mock.mockImplementation(crashAfterTracking("Show", outstanding));
  const searchEpisodes = mock.method(SonarrClient.prototype, "searchEpisodes", async () => true);
  mock.method(SonarrClient.prototype, "importedEpisodesSince", async () => []);

  const config = baseConfig();
  const handler = new IssueHandler(config);
  await assert.rejects(
    () =>
      handler.handleIssue(
        issue({ mediaType: "tv", tmdbId: null, tvdbId: 100, issueId: "7", affectedSeason: 2 }),
      ),
    /crash/,
  );

  const reloaded = new IssueHandler(config);
  await reloaded.reconcile();
  assert.equal(searchEpisodes.mock.callCount(), 1);
  assert.deepEqual(searchEpisodes.mock.calls[0].arguments, [100, outstanding]);
});

test("recovery drops a movie entry whose movie no longer exists in Radarr", async () => {
  redownloadMovie.mock.mockImplementation(crashAfterTracking("The Matrix"));
  const search = mock.method(RadarrClient.prototype, "search", async () => false); // gone

  const config = baseConfig();
  const handler = new IssueHandler(config);
  await assert.rejects(() => handler.handleIssue(issue({ issueId: "42", tmdbId: 603 })), /crash/);

  const reloaded = new IssueHandler(config);
  await reloaded.reconcile();
  assert.equal(search.mock.callCount(), 1);
  // Entry dropped: a later import for it finds nothing pending.
  const after = await reloaded.handleImport({
    eventType: "Download",
    title: "The Matrix",
    candidateKeys: [movieKey(603)],
    importedEpisodeIds: [],
  });
  assert.equal(after.status, "ignored");
});

test("a confirmed entry is never re-searched by recovery", async () => {
  const search = mock.method(RadarrClient.prototype, "search", async () => true);
  mock.method(RadarrClient.prototype, "importedSince", async () => false);

  const config = baseConfig();
  const handler = new IssueHandler(config);
  // Normal (non-crashing) mock -> handler confirms the search after redownload.
  await handler.handleIssue(issue({ issueId: "42", tmdbId: 603 }));

  const reloaded = new IssueHandler(config);
  await reloaded.reconcile();
  assert.equal(search.mock.callCount(), 0); // already confirmed, nothing to recover
});
