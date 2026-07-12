import { ArrClient } from "./client.js";
import { RedownloadMode, RedownloadHooks } from "../config.js";
import { episodeId as encodeEpisodeId } from "../store.js";
import { log } from "../logger.js";

interface SonarrSeries {
  id: number;
  title: string;
  tvdbId: number;
}

interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  hasFile: boolean;
  episodeFileId: number;
}

interface QueueRecord {
  id: number;
  seriesId?: number;
  episodeId?: number;
}

export interface SonarrResult {
  matched: boolean;
  title?: string;
  actions: string[];
  /** True when the report was too broad to act on automatically (whole show). */
  skippedTooBroad?: boolean;
  /** For season reports: encoded episodeId()s we kicked off, so all must import before resolving. */
  outstanding?: number[];
}

export class SonarrClient extends ArrClient {
  /** Seerr sends tvdbId for TV; fall back to the full list if the filter is unsupported. */
  private async findByTvdbId(tvdbId: number): Promise<SonarrSeries | null> {
    const series = await this.request<SonarrSeries[]>("GET", "/series", {
      query: { tvdbId },
    });
    return series.find((s) => s.tvdbId === tvdbId) ?? series[0] ?? null;
  }

  /**
   * Startup reconciliation: which episodes of this series imported at or after
   * `sinceMs`, as encoded episodeId()s? Catches imports whose webhook was missed
   * while we were down. Returns null if the series no longer exists in Sonarr.
   */
  async importedEpisodesSince(tvdbId: number, sinceMs: number): Promise<number[] | null> {
    const series = await this.findByTvdbId(tvdbId);
    if (!series) return null;

    // Map Sonarr's internal episodeId -> our season*1000+episode encoding.
    const episodes = await this.getEpisodes(series.id);
    const encodeById = new Map(
      episodes.map((e) => [e.id, encodeEpisodeId(e.seasonNumber, e.episodeNumber)] as const),
    );

    // /history/series returns a bare array with per-record episodeId + date.
    const records = await this.request<
      Array<{ eventType: string; episodeId?: number; date?: string }>
    >("GET", "/history/series", { query: { seriesId: series.id } });

    const imported = new Set<number>();
    for (const r of records ?? []) {
      if (r.eventType !== "downloadFolderImported") continue;
      if (!r.date || Date.parse(r.date) < sinceMs) continue;
      const encoded = r.episodeId !== undefined ? encodeById.get(r.episodeId) : undefined;
      if (encoded !== undefined) imported.add(encoded);
    }
    return [...imported];
  }

  private async getEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    return this.request<SonarrEpisode[]>("GET", "/episode", { query: { seriesId } });
  }

  private async removeFromQueue(episodeIds: Set<number>, blocklist: boolean): Promise<number> {
    const queue = await this.request<{ records: QueueRecord[] }>("GET", "/queue", {
      query: { pageSize: 1000 },
    });
    const records = (queue.records ?? []).filter(
      (r) => r.episodeId !== undefined && episodeIds.has(r.episodeId),
    );
    for (const record of records) {
      await this.request("DELETE", `/queue/${record.id}`, {
        query: { removeFromClient: true, blocklist },
      });
    }
    return records.length;
  }

  /**
   * Redownload for TV. Scope is driven by the Seerr issue's affected fields:
   *   - episode named  -> that single episode (EpisodeSearch)
   *   - season only    -> the whole season   (SeasonSearch, one paced command)
   *   - neither        -> whole show: too broad to auto-act on; skipped
   *
   * A whole-show report is refused so a single click can't blast hundreds of
   * searches at your indexers (and almost never reflects the user's intent).
   */
  async redownload(
    tvdbId: number,
    mode: RedownloadMode,
    affectedSeason: number | null,
    affectedEpisode: number | null,
    hooks?: RedownloadHooks,
  ): Promise<SonarrResult> {
    const series = await this.findByTvdbId(tvdbId);
    if (!series) {
      return { matched: false, actions: [] };
    }

    const season = affectedSeason && affectedSeason > 0 ? affectedSeason : null;
    const episodeNum = affectedEpisode && affectedEpisode > 0 ? affectedEpisode : null;

    // Whole-show report (no season, no episode): refuse to auto-act.
    if (season === null) {
      log.warn("Sonarr: whole-show report, skipping auto-redownload", {
        series: series.title,
        tvdbId,
      });
      return { matched: true, title: series.title, actions: [], skippedTooBroad: true };
    }

    const allEpisodes = await this.getEpisodes(series.id);
    let targets = allEpisodes.filter((e) => e.seasonNumber === season);
    if (episodeNum !== null) targets = targets.filter((e) => e.episodeNumber === episodeNum);

    if (targets.length === 0) {
      log.warn("Sonarr: no episodes matched", { series: series.title, season, episodeNum });
      return { matched: true, title: series.title, actions: ["no matching episodes"] };
    }

    const isSeasonScope = episodeNum === null;
    const actions: string[] = [];
    const targetIds = new Set(targets.map((e) => e.id));

    // For a season report, the issue should only resolve once every episode has
    // re-imported, so track them all. Single-episode reports resolve on first import.
    const outstanding = isSeasonScope
      ? targets.map((e) => encodeEpisodeId(e.seasonNumber, e.episodeNumber))
      : undefined;

    // Durably record intent (including the full outstanding set) BEFORE any
    // mutation. If we die after deleting files but before the search fires,
    // startup recovery re-triggers the search for what's still missing.
    await hooks?.beforeExecute?.({ title: series.title, outstanding });

    const removed = await this.removeFromQueue(targetIds, mode !== "search");
    if (removed > 0) actions.push(`removed ${removed} queue item(s)`);

    if (mode !== "search") {
      const fileIds = [...new Set(targets.filter((e) => e.hasFile).map((e) => e.episodeFileId))];
      for (const fileId of fileIds) {
        await this.request("DELETE", `/episodefile/${fileId}`);
      }
      if (fileIds.length) actions.push(`deleted ${fileIds.length} file(s)`);
    }

    // Prefer Sonarr's native SeasonSearch for a whole season: it's a single
    // command Sonarr paces internally, rather than one search per episode.
    if (isSeasonScope) {
      await this.triggerSeasonSearch(series.id, season);
      actions.push(`triggered season search for S${season} (${targetIds.size} episodes)`);
    } else {
      await this.request("POST", "/command", {
        body: { name: "EpisodeSearch", episodeIds: [...targetIds] },
      });
      actions.push(`triggered search for ${targetIds.size} episode(s)`);
    }

    log.info("Sonarr redownload", {
      series: series.title,
      tvdbId,
      season,
      episodeNum,
      mode,
      actions,
    });
    return { matched: true, title: series.title, actions, outstanding };
  }

  private async triggerSeasonSearch(seriesId: number, season: number): Promise<void> {
    await this.request("POST", "/command", {
      body: { name: "SeasonSearch", seriesId, seasonNumber: season },
    });
  }

  /**
   * Idempotently (re-)trigger a search for specific episodes by their encoded
   * ids (season*1000+episode). Used by startup recovery to fire a search a crash
   * left un-sent — never deletes or blocklists. Returns false if the series is
   * gone; missing episodes are skipped. `encodedEpisodeIds` empty = whole season
   * is unknown, so nothing is done.
   */
  async searchEpisodes(tvdbId: number, encodedEpisodeIds: number[]): Promise<boolean> {
    const series = await this.findByTvdbId(tvdbId);
    if (!series) return false;
    if (encodedEpisodeIds.length === 0) return true;

    const episodes = await this.getEpisodes(series.id);
    const wanted = new Set(encodedEpisodeIds);
    const ids = episodes
      .filter((e) => wanted.has(encodeEpisodeId(e.seasonNumber, e.episodeNumber)))
      .map((e) => e.id);
    if (ids.length === 0) return true;

    await this.request("POST", "/command", {
      body: { name: "EpisodeSearch", episodeIds: ids },
    });
    return true;
  }
}
