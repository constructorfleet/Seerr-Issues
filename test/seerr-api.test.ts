import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { SeerrApi } from "../src/seerr-api.js";

afterEach(() => mock.restoreAll());

test("includes the underlying transport failure when a Seerr request cannot connect", async () => {
  const cause = new Error("getaddrinfo ENOTFOUND mediastack_seerr");
  mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed", { cause });
  });
  const client = new SeerrApi({ url: "http://mediastack_seerr:5055", apiKey: "key" });

  await assert.rejects(
    () => client.comment(9, "hello"),
    /fetch failed.*ENOTFOUND mediastack_seerr/,
  );
});

test("getIssueMedia returns the issue's media ids", async () => {
  mock.method(globalThis, "fetch", async (input) => {
    assert.equal(new URL(String(input)).pathname, "/api/v1/issue/9");
    return Response.json({
      id: 9,
      media: { id: 3, tmdbId: null, imdbId: "tt123", externalServiceId: 24 },
    });
  });
  const client = new SeerrApi({ url: "http://seerr:5055", apiKey: "key" });

  assert.deepEqual(await client.getIssueMedia(9), {
    tmdbId: null,
    tvdbId: null,
    imdbId: "tt123",
    externalServiceId: 24,
    externalServiceId4k: null,
  });
});
