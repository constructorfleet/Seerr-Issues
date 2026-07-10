import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingStore, PendingItem, movieKey, tvKey, episodeId } from "../src/store.js";

const DAY = 24 * 60 * 60 * 1000;

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "seerr-store-"));
  return join(dir, "pending.json");
}

function item(overrides: Partial<PendingItem> = {}): PendingItem {
  return {
    key: overrides.key ?? movieKey(1),
    issueId: 10,
    mediaType: "movie",
    mediaId: 1,
    title: "Test",
    season: null,
    episode: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

test("key helpers encode media targets", () => {
  assert.equal(movieKey(42), "movie:42");
  assert.equal(tvKey(7, 2, 5), "tv:7:s2e5");
  assert.equal(tvKey(7, null, null), "tv:7:s0e0");
  assert.equal(tvKey(7, 3, null), "tv:7:s3e0");
  assert.equal(episodeId(2, 5), 2005);
  assert.equal(episodeId(0, 0), 0);
});

test("add persists to disk and size reflects it", () => {
  const path = tmpFile();
  const store = new PendingStore(path, 7 * DAY);
  store.add(item({ key: movieKey(1) }));
  assert.equal(store.size(), 1);
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as PendingItem[];
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].key, "movie:1");
});

test("state survives reload from disk", () => {
  const path = tmpFile();
  const first = new PendingStore(path, 7 * DAY);
  first.add(item({ key: movieKey(1) }));
  first.add(item({ key: movieKey(2), mediaId: 2 }));

  const reloaded = new PendingStore(path, 7 * DAY);
  assert.equal(reloaded.size(), 2);
  assert.deepEqual(
    reloaded
      .all()
      .map((i) => i.key)
      .sort(),
    ["movie:1", "movie:2"],
  );
});

test("missing state file starts empty without error", () => {
  const store = new PendingStore(join(tmpdir(), "does-not-exist-xyz", "p.json"), 7 * DAY);
  assert.equal(store.size(), 0);
});

test("corrupt state file starts empty without throwing", () => {
  const path = tmpFile();
  writeFileSync(path, "{ not valid json");
  const store = new PendingStore(path, 7 * DAY);
  assert.equal(store.size(), 0);
});

test("prune drops entries older than the ttl and persists", () => {
  const path = tmpFile();
  const store = new PendingStore(path, 7 * DAY);
  const now = 100 * DAY;
  store.add(item({ key: movieKey(1), createdAt: now - 8 * DAY })); // stale
  store.add(item({ key: movieKey(2), mediaId: 2, createdAt: now - 1 * DAY })); // fresh

  const removed = store.prune(now);
  assert.equal(removed, 1);
  assert.equal(store.size(), 1);
  assert.deepEqual(
    store.all().map((i) => i.key),
    ["movie:2"],
  );
  // Flushed to disk.
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as PendingItem[];
  assert.equal(onDisk.length, 1);
});

test("prune on load discards already-expired entries", () => {
  const path = tmpFile();
  // Very old entry, then construct a store whose ttl is short. Since load()
  // prunes with the real Date.now(), a 1970-era createdAt is always stale.
  writeFileSync(path, JSON.stringify([item({ key: movieKey(1), createdAt: 0 })]));
  const store = new PendingStore(path, 1 * DAY);
  assert.equal(store.size(), 0);
});

test("recordImport resolves a movie entry on first match and removes it", () => {
  const path = tmpFile();
  const store = new PendingStore(path, 7 * DAY);
  store.add(item({ key: movieKey(603) }));

  const match = store.recordImport([movieKey(603)], []);
  assert.ok(match);
  assert.equal(match.resolved, true);
  assert.equal(match.remaining, 0);
  assert.equal(store.size(), 0);
});

test("recordImport returns null when no candidate key matches", () => {
  const store = new PendingStore(tmpFile(), 7 * DAY);
  store.add(item({ key: movieKey(1) }));
  assert.equal(store.recordImport([movieKey(999)], []), null);
  assert.equal(store.size(), 1);
});

test("recordImport uses the first matching candidate key", () => {
  const store = new PendingStore(tmpFile(), 7 * DAY);
  store.add(item({ key: tvKey(5, 2, 5), season: 2, episode: 5 }));
  // Episode key is most specific and present; series key would also exist but
  // shouldn't be reached.
  const match = store.recordImport(
    [tvKey(5, 2, 5), tvKey(5, 2, null), tvKey(5, null, null)],
    [episodeId(2, 5)],
  );
  assert.ok(match);
  assert.equal(match.item.key, tvKey(5, 2, 5));
  assert.equal(match.resolved, true);
});

test("recordImport strikes episodes off a season entry and only resolves when empty", () => {
  const path = tmpFile();
  const store = new PendingStore(path, 7 * DAY);
  const key = tvKey(5, 2, null);
  store.add(
    item({
      key,
      mediaType: "tv",
      mediaId: 5,
      season: 2,
      episode: null,
      outstanding: [episodeId(2, 1), episodeId(2, 2), episodeId(2, 3)],
    }),
  );

  // First import delivers ep 1 -> progress, not resolved.
  let match = store.recordImport([key], [episodeId(2, 1)]);
  assert.ok(match);
  assert.equal(match.resolved, false);
  assert.equal(match.remaining, 2);
  assert.equal(store.size(), 1);
  // Persisted outstanding reflects the progress.
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as PendingItem[];
  assert.deepEqual(onDisk[0].outstanding, [episodeId(2, 2), episodeId(2, 3)]);

  // Second import delivers eps 2 and 3 -> resolves and removes.
  match = store.recordImport([key], [episodeId(2, 2), episodeId(2, 3)]);
  assert.ok(match);
  assert.equal(match.resolved, true);
  assert.equal(match.remaining, 0);
  assert.equal(store.size(), 0);
});

test("recordImport leaves a season entry untouched when an unrelated episode imports", () => {
  const store = new PendingStore(tmpFile(), 7 * DAY);
  const key = tvKey(5, 2, null);
  store.add(
    item({
      key,
      mediaType: "tv",
      mediaId: 5,
      season: 2,
      episode: null,
      outstanding: [episodeId(2, 1)],
    }),
  );
  // Season key matches, but episode 9 wasn't awaited.
  const match = store.recordImport([key], [episodeId(2, 9)]);
  assert.equal(match, null);
  assert.equal(store.size(), 1);
});

test("remove deletes by key and only flushes when something changed", () => {
  const path = tmpFile();
  const store = new PendingStore(path, 7 * DAY);
  store.add(item({ key: movieKey(1) }));
  store.remove(movieKey(1));
  assert.equal(store.size(), 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
  // Removing a non-existent key is a no-op.
  store.remove(movieKey(999));
  assert.equal(store.size(), 0);
});

test("setOutstanding replaces the outstanding set for an entry", () => {
  const store = new PendingStore(tmpFile(), 7 * DAY);
  const key = tvKey(5, 2, null);
  store.add(item({ key, mediaType: "tv", season: 2, episode: null, outstanding: [1, 2, 3] }));
  store.setOutstanding(key, [3]);
  assert.deepEqual(store.all()[0].outstanding, [3]);
  // Unknown key is a no-op.
  store.setOutstanding("nope", [9]);
});
