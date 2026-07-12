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

    if (mode !== "search" && movie.hasFile && movie.movieFile) {
      // A search does not reliably replace an existing file. Never mark the
      // old import as failed merely to blocklist it: that corrupts Radarr's
      // history while still leaving no missing-file gap for the search.
      await this.request("DELETE", `/moviefile/${movie.movieFile.id}`);
      actions.push("deleted existing file");
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
