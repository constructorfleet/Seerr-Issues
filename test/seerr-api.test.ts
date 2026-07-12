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
