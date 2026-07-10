import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArrWebhook, isImportEvent } from "../src/arr-webhook.js";
import { movieKey, tvKey, episodeId } from "../src/store.js";

test("parseArrWebhook returns null for non-object bodies", () => {
  assert.equal(parseArrWebhook(null), null);
  assert.equal(parseArrWebhook("x"), null);
  assert.equal(parseArrWebhook({}), null);
});

test("parseArrWebhook parses a Radarr movie import", () => {
  const imp = parseArrWebhook({
    eventType: "Download",
    movie: { tmdbId: 603, title: "The Matrix" },
  });
  assert.ok(imp);
  assert.equal(imp.eventType, "Download");
  assert.equal(imp.title, "The Matrix");
  assert.deepEqual(imp.candidateKeys, [movieKey(603)]);
  assert.deepEqual(imp.importedEpisodeIds, []);
});

test("parseArrWebhook falls back to a synthetic title for movies", () => {
  const imp = parseArrWebhook({ eventType: "Download", movie: { tmdbId: 7 } });
  assert.ok(imp);
  assert.equal(imp.title, "tmdb 7");
});

test("parseArrWebhook returns null when a movie has no usable tmdbId", () => {
  assert.equal(parseArrWebhook({ eventType: "Download", movie: { title: "x" } }), null);
  assert.equal(parseArrWebhook({ eventType: "Download", movie: { tmdbId: "abc" } }), null);
});

test("parseArrWebhook builds most-specific-first keys for a Sonarr episode", () => {
  const imp = parseArrWebhook({
    eventType: "Download",
    series: { tvdbId: 100, title: "Show" },
    episodes: [{ seasonNumber: 2, episodeNumber: 5 }],
  });
  assert.ok(imp);
  assert.deepEqual(imp.candidateKeys, [
    tvKey(100, 2, 5),
    tvKey(100, 2, null),
    tvKey(100, null, null),
  ]);
  assert.deepEqual(imp.importedEpisodeIds, [episodeId(2, 5)]);
});

test("parseArrWebhook dedupes keys and collects ids across a multi-episode import", () => {
  const imp = parseArrWebhook({
    eventType: "Download",
    series: { tvdbId: 100, title: "Show" },
    episodes: [
      { seasonNumber: 2, episodeNumber: 5 },
      { seasonNumber: 2, episodeNumber: 6 },
    ],
  });
  assert.ok(imp);
  assert.deepEqual(imp.candidateKeys, [
    tvKey(100, 2, 5),
    tvKey(100, 2, null),
    tvKey(100, null, null),
    tvKey(100, 2, 6),
  ]);
  assert.deepEqual(imp.importedEpisodeIds.sort(), [episodeId(2, 5), episodeId(2, 6)].sort());
});

test("parseArrWebhook falls back to the series key when episodes are missing", () => {
  const imp = parseArrWebhook({
    eventType: "Download",
    series: { tvdbId: 100, title: "Show" },
  });
  assert.ok(imp);
  assert.deepEqual(imp.candidateKeys, [tvKey(100, null, null)]);
  assert.deepEqual(imp.importedEpisodeIds, []);
});

test("parseArrWebhook returns null for a series without a tvdbId", () => {
  assert.equal(parseArrWebhook({ eventType: "Download", series: { title: "x" } }), null);
});

test("isImportEvent recognises import-shaped event types only", () => {
  assert.equal(isImportEvent("Download"), true);
  assert.equal(isImportEvent("downloadFolderImported"), true);
  assert.equal(isImportEvent("Import"), true);
  assert.equal(isImportEvent("Test"), false);
  assert.equal(isImportEvent("Grab"), false);
  assert.equal(isImportEvent(""), false);
});
