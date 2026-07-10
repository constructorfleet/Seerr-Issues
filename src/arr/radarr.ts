import { ArrClient } from "./client.js";
import { RedownloadMode, RedownloadHooks } from "../config.js";
import { log } from "../logger.js";

interface RadarrMovie {
  id: number;
  title: string;
  tmdbId: number;
  hasFile: boolean;
  movieFile?: { id: number };
}

interface QueueRecord {
  id: number;
  movieId?: number;
}

interface HistoryRecord {
  id: number;
  eventType: string;
  date?: string;
}

export interface RadarrResult {
  matched: boolean;
  title?: string;
  actions: string[];
}

export class RadarrClient extends ArrClient {
  /** Look up a movie by its TMDB id (the id Seerr sends for movies). */
  private async findByTmdbId(tmdbId: number): Promise<RadarrMovie | null> {
    const movies = await this.request<RadarrMovie[]>("GET", "/movie", {
      query: { tmdbId },
    });
    return movies.find((m) => m.tmdbId === tmdbId) ?? movies[0] ?? null;
  }

  /**
   * Startup reconciliation: did a replacement for this movie import at or after
   * `sinceMs`? Catches imports whose webhook was missed while we were down.
   * Returns null if the movie no longer exists in Radarr.
   */
  async importedSince(tmdbId: number, sinceMs: number): Promise<boolean | null> {
    const movie = await this.findByTmdbId(tmdbId);
    if (!movie) return null;
    const records = await this.request<HistoryRecord[]>("GET", "/history/movie", {
      query: { movieId: movie.id },
    });
    return (records ?? []).some(
      (r) =>
        r.eventType === "downloadFolderImported" &&
        r.date !== undefined &&
        Date.parse(r.date) >= sinceMs,
    );
  }

  /**
   * Remove any active queue items for this movie so a re-search isn't blocked.
   * When `blocklist` is set, the in-flight release is blocklisted so the same
   * one isn't grabbed again.
   */
  private async removeFromQueue(movieId: number, blocklist: boolean): Promise<number> {
    const queue = await this.request<{ records: QueueRecord[] }>("GET", "/queue", {
      query: { pageSize: 1000 },
    });
    const records = (queue.records ?? []).filter((r) => r.movieId === movieId);
    for (const record of records) {
      await this.request("DELETE", `/queue/${record.id}`, {
        query: { removeFromClient: true, blocklist },
      });
    }
    return records.length;
  }

  /**
   * Blocklist the release that produced the currently-imported file by marking
   * its most recent "grabbed" history event as failed. This stops the indexer
   * from handing back the same bad release on the next search.
   */
  private async blocklistImported(movieId: number): Promise<boolean> {
    // Radarr's /history/movie returns a bare array (unlike the paged /history
    // endpoint, which wraps records in an object). Records are newest-first.
    const records = await this.request<HistoryRecord[]>("GET", "/history/movie", {
      query: { movieId },
    });
    // Pick the most recent grab by date rather than trusting array order.
    const grabbed = (records ?? [])
      .filter((r) => r.eventType === "grabbed")
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0];
    if (!grabbed) return false;
    await this.request("POST", `/history/failed/${grabbed.id}`);
    return true;
  }

  async redownload(
    tmdbId: number,
    mode: RedownloadMode,
    hooks?: RedownloadHooks,
  ): Promise<RadarrResult> {
    const movie = await this.findByTmdbId(tmdbId);
    if (!movie) {
      return { matched: false, actions: [] };
    }

    // Durably record intent BEFORE any mutation. If we die after deleting the
    // file but before the search fires, startup recovery re-triggers the search.
    await hooks?.beforeExecute?.({ title: movie.title });

    const actions: string[] = [];

    // Clear anything currently downloading; blocklist it (unless mode is a bare
    // search) so the same release isn't re-grabbed on the next search.
    const removed = await this.removeFromQueue(movie.id, mode !== "search");
    if (removed > 0) actions.push(`removed ${removed} queue item(s)`);

    if (mode === "delete-search" && movie.hasFile && movie.movieFile) {
      // Remove the imported file so the search has a gap to fill.
      await this.request("DELETE", `/moviefile/${movie.movieFile.id}`);
      actions.push("deleted existing file");
    } else if (mode === "blocklist-search" && movie.hasFile) {
      // Keep the file in place but blocklist its release so the search upgrades it.
      const blocklisted = await this.blocklistImported(movie.id);
      if (blocklisted) actions.push("blocklisted imported release");
    }

    await this.triggerSearch(movie.id);
    actions.push("triggered search");

    log.info("Radarr redownload", { movie: movie.title, tmdbId, mode, actions });
    return { matched: true, title: movie.title, actions };
  }

  private async triggerSearch(movieId: number): Promise<void> {
    await this.request("POST", "/command", {
      body: { name: "MoviesSearch", movieIds: [movieId] },
    });
  }

  /**
   * Idempotently (re-)trigger a search for a movie by tmdbId. Used by startup
   * recovery to fire the search a crash left un-sent — never deletes or
   * blocklists, so it's safe to call again. Returns false if the movie is gone.
   */
  async search(tmdbId: number): Promise<boolean> {
    const movie = await this.findByTmdbId(tmdbId);
    if (!movie) return false;
    await this.triggerSearch(movie.id);
    return true;
  }
}
