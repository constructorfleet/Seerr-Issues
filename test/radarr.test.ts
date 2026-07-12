import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { RadarrClient } from "../src/arr/radarr.js";

afterEach(() => mock.restoreAll());

test("blocklist-search removes an imported file and searches without marking its old grab failed", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/movie?")) {
      return Response.json([
        { id: 24, title: "The Salvation", tmdbId: 266285, hasFile: true, movieFile: { id: 88 } },
      ]);
    }
    if (url.includes("/queue?")) return Response.json({ records: [] });
    return new Response(null, { status: 200 });
  });

  const client = new RadarrClient({ url: "http://radarr", apiKey: "key" }, "Radarr");
  const result = await client.redownload(266285, "blocklist-search");

  assert.deepEqual(result.actions, ["deleted existing file", "triggered search"]);
  assert.deepEqual(
    requests.map(({ url, method }) => `${method} ${new URL(url).pathname}`),
    [
      "GET /api/v3/movie",
      "GET /api/v3/queue",
      "DELETE /api/v3/moviefile/88",
      "POST /api/v3/command",
    ],
  );
  assert.equal(
    requests.some(({ url }) => url.includes("/history/failed/")),
    false,
  );
});
