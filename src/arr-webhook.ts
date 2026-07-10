import { movieKey, tvKey, episodeId } from "./store.js";

/**
 * Parsing of Radarr/Sonarr "On Import"/"On Upgrade" webhook payloads.
 *
 * Radarr:  { eventType: "Download", movie: { tmdbId, title }, isUpgrade }
 * Sonarr:  { eventType: "Download", series: { tvdbId, title },
 *            episodes: [ { seasonNumber, episodeNumber } ] }
 *
 * `eventType: "Download"` is what both apps send on a successful import
 * (including upgrades). Test payloads use `eventType: "Test"`.
 */

export interface ArrImport {
  eventType: string;
  title: string;
  /** Ordered most-specific-first keys this import could satisfy. */
  candidateKeys: string[];
  /** Encoded episodeId()s delivered by this import (empty for movies). */
  importedEpisodeIds: number[];
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export function parseArrWebhook(body: unknown): ArrImport | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as {
    eventType?: unknown;
    movie?: { tmdbId?: unknown; title?: unknown };
    series?: { tvdbId?: unknown; title?: unknown };
    episodes?: Array<{ seasonNumber?: unknown; episodeNumber?: unknown }>;
  };

  const eventType = String(raw.eventType ?? "");

  // Radarr movie import.
  if (raw.movie) {
    const tmdbId = toInt(raw.movie.tmdbId);
    if (tmdbId === null) return null;
    return {
      eventType,
      title: String(raw.movie.title ?? `tmdb ${tmdbId}`),
      candidateKeys: [movieKey(tmdbId)],
      importedEpisodeIds: [],
    };
  }

  // Sonarr episode import.
  if (raw.series) {
    const tvdbId = toInt(raw.series.tvdbId);
    if (tvdbId === null) return null;
    const keys = new Set<string>();
    const episodeIds = new Set<number>();
    for (const ep of raw.episodes ?? []) {
      const season = toInt(ep.seasonNumber);
      const episode = toInt(ep.episodeNumber);
      // Most specific first: this exact episode, then whole-season, then whole-series.
      if (season !== null && episode !== null) {
        keys.add(tvKey(tvdbId, season, episode));
        episodeIds.add(episodeId(season, episode));
      }
      if (season !== null) keys.add(tvKey(tvdbId, season, null));
      keys.add(tvKey(tvdbId, null, null));
    }
    if (keys.size === 0) keys.add(tvKey(tvdbId, null, null));
    return {
      eventType,
      title: String(raw.series.title ?? `tvdb ${tvdbId}`),
      candidateKeys: [...keys],
      importedEpisodeIds: [...episodeIds],
    };
  }

  return null;
}

export function isImportEvent(eventType: string): boolean {
  const t = eventType.toLowerCase();
  return t === "download" || t === "downloadfolderimported" || t === "import";
}
