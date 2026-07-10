/**
 * Parsing of Seerr / Overseerr / Jellyseerr webhook payloads.
 *
 * The webhook JSON is user-configurable in Seerr, but this parser targets the
 * default template shipped by Seerr:
 *
 *   {
 *     "notification_type": "ISSUE_CREATED",
 *     "subject": "...",
 *     "media": { "media_type": "movie", "tmdbId": "123", "tvdbId": "456", ... },
 *     "issue": { "issue_id": "7", "issue_type": "VIDEO", "issue_status": "OPEN", ... },
 *     "extra": [ { "name": "Affected Season", "value": "1" },
 *                { "name": "Affected Episode", "value": "2" } ]
 *   }
 *
 * All numeric-looking fields arrive as strings after template substitution, so
 * everything here is coerced defensively.
 */

export type MediaType = "movie" | "tv";

/** Seerr IssueType enum values. */
export enum IssueType {
  VIDEO = 1,
  AUDIO = 2,
  SUBTITLES = 3,
  OTHER = 4,
}

export interface ParsedIssue {
  notificationType: string;
  issueId: string | null;
  issueType: IssueType | null;
  mediaType: MediaType;
  tmdbId: number | null;
  tvdbId: number | null;
  /** 0 or null means "all seasons" / not a TV issue. */
  affectedSeason: number | null;
  /** 0 or null means "whole season" / not applicable. */
  affectedEpisode: number | null;
  subject: string;
}

interface RawExtra {
  name?: unknown;
  value?: unknown;
}

interface RawPayload {
  notification_type?: unknown;
  subject?: unknown;
  media?: {
    media_type?: unknown;
    tmdbId?: unknown;
    tvdbId?: unknown;
  } | null;
  issue?: {
    issue_id?: unknown;
    issue_type?: unknown;
    issue_status?: unknown;
  } | null;
  extra?: RawExtra[] | null;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** Coerce a value to a positive integer, ignoring unfilled template tokens like "{{media_tvdbid}}". */
function toInt(v: unknown): number | null {
  const s = toStr(v);
  if (!s || s.startsWith("{{")) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

export function normalizeIssueType(v: unknown): IssueType | null {
  const s = toStr(v);
  if (!s) return null;
  const asNum = Number(s);
  if (Number.isInteger(asNum) && IssueType[asNum] !== undefined) return asNum as IssueType;
  switch (s.toLowerCase()) {
    case "video":
      return IssueType.VIDEO;
    case "audio":
      return IssueType.AUDIO;
    case "subtitle":
    case "subtitles":
      return IssueType.SUBTITLES;
    case "other":
      return IssueType.OTHER;
    default:
      return null;
  }
}

function findExtra(extra: RawExtra[] | null | undefined, keyword: string): number | null {
  if (!Array.isArray(extra)) return null;
  for (const item of extra) {
    const name = toStr(item?.name);
    if (name && name.toLowerCase().includes(keyword)) {
      return toInt(item?.value);
    }
  }
  return null;
}

function normalizeMediaType(v: unknown): MediaType | null {
  const s = toStr(v)?.toLowerCase();
  if (s === "movie") return "movie";
  if (s === "tv" || s === "show" || s === "series") return "tv";
  return null;
}

/**
 * Parse a raw webhook body into a ParsedIssue.
 * Returns null when the body is not an issue notification we can act on.
 */
export function parseWebhook(body: unknown): ParsedIssue | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as RawPayload;

  const notificationType = toStr(raw.notification_type) ?? "";
  const mediaType = normalizeMediaType(raw.media?.media_type);
  if (!mediaType) return null;

  return {
    notificationType,
    issueId: toStr(raw.issue?.issue_id),
    issueType: normalizeIssueType(raw.issue?.issue_type),
    mediaType,
    tmdbId: toInt(raw.media?.tmdbId),
    tvdbId: toInt(raw.media?.tvdbId),
    affectedSeason: findExtra(raw.extra, "season"),
    affectedEpisode: findExtra(raw.extra, "episode"),
    subject: toStr(raw.subject) ?? "",
  };
}

/** Notification types that represent a newly-actionable issue. */
export function isActionableNotification(type: string): boolean {
  const t = type.toUpperCase();
  return t === "ISSUE_CREATED" || t === "ISSUE_REOPENED";
}
