import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWebhook,
  normalizeIssueType,
  isActionableNotification,
  IssueType,
} from "../src/seerr.js";

test("parseWebhook returns null for non-object bodies", () => {
  assert.equal(parseWebhook(null), null);
  assert.equal(parseWebhook(undefined), null);
  assert.equal(parseWebhook("string"), null);
  assert.equal(parseWebhook(42), null);
});

test("parseWebhook returns null when media type is missing or unknown", () => {
  assert.equal(parseWebhook({ notification_type: "ISSUE_CREATED" }), null);
  assert.equal(parseWebhook({ media: { media_type: "podcast" } }), null);
});

test("parseWebhook parses a movie issue with string-encoded ids", () => {
  const parsed = parseWebhook({
    notification_type: "ISSUE_CREATED",
    subject: "Bad video for Dune",
    media: { media_type: "movie", tmdbId: "438631", tvdbId: "{{media_tvdbid}}" },
    issue: { issue_id: "12", issue_type: "VIDEO", issue_status: "OPEN" },
  });
  assert.ok(parsed);
  assert.equal(parsed.mediaType, "movie");
  assert.equal(parsed.tmdbId, 438631);
  // Unfilled template token must not be coerced to a number.
  assert.equal(parsed.tvdbId, null);
  assert.equal(parsed.issueId, "12");
  assert.equal(parsed.issueType, IssueType.VIDEO);
  assert.equal(parsed.subject, "Bad video for Dune");
});

test("parseWebhook maps tv aliases and reads affected season/episode from extra", () => {
  for (const alias of ["tv", "show", "series"]) {
    const parsed = parseWebhook({
      notification_type: "ISSUE_CREATED",
      media: { media_type: alias, tvdbId: "121361" },
      issue: { issue_id: "3", issue_type: "2" },
      extra: [
        { name: "Affected Season", value: "4" },
        { name: "Affected Episode", value: "9" },
      ],
    });
    assert.ok(parsed, `alias ${alias} should parse`);
    assert.equal(parsed.mediaType, "tv");
    assert.equal(parsed.tvdbId, 121361);
    assert.equal(parsed.affectedSeason, 4);
    assert.equal(parsed.affectedEpisode, 9);
    // issue_type given as numeric string.
    assert.equal(parsed.issueType, IssueType.AUDIO);
  }
});

test("parseWebhook tolerates missing optional fields", () => {
  const parsed = parseWebhook({ media: { media_type: "movie" } });
  assert.ok(parsed);
  assert.equal(parsed.notificationType, "");
  assert.equal(parsed.issueId, null);
  assert.equal(parsed.issueType, null);
  assert.equal(parsed.tmdbId, null);
  assert.equal(parsed.affectedSeason, null);
  assert.equal(parsed.affectedEpisode, null);
  assert.equal(parsed.subject, "");
});

test("parseWebhook extra matching is case-insensitive and substring-based", () => {
  const parsed = parseWebhook({
    media: { media_type: "tv", tvdbId: "1" },
    extra: [
      { name: "The affected SEASON number", value: "2" },
      { name: "Some Episode Info", value: "5" },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.affectedSeason, 2);
  assert.equal(parsed.affectedEpisode, 5);
});

test("normalizeIssueType accepts numbers, names, and rejects garbage", () => {
  assert.equal(normalizeIssueType(1), IssueType.VIDEO);
  assert.equal(normalizeIssueType("2"), IssueType.AUDIO);
  assert.equal(normalizeIssueType("video"), IssueType.VIDEO);
  assert.equal(normalizeIssueType("AUDIO"), IssueType.AUDIO);
  assert.equal(normalizeIssueType("subtitle"), IssueType.SUBTITLES);
  assert.equal(normalizeIssueType("subtitles"), IssueType.SUBTITLES);
  assert.equal(normalizeIssueType("other"), IssueType.OTHER);
  assert.equal(normalizeIssueType("nonsense"), null);
  assert.equal(normalizeIssueType(""), null);
  assert.equal(normalizeIssueType(null), null);
  // Out-of-range numeric is not a valid enum member.
  assert.equal(normalizeIssueType(99), null);
});

test("isActionableNotification only matches created/reopened, case-insensitively", () => {
  assert.equal(isActionableNotification("ISSUE_CREATED"), true);
  assert.equal(isActionableNotification("issue_reopened"), true);
  assert.equal(isActionableNotification("Issue_Created"), true);
  assert.equal(isActionableNotification("ISSUE_COMMENT"), false);
  assert.equal(isActionableNotification("ISSUE_RESOLVED"), false);
  assert.equal(isActionableNotification(""), false);
});
