import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

/**
 * A redownload we triggered and are waiting on. When Radarr/Sonarr reports a
 * matching import, we resolve the linked Seerr issue.
 *
 * The `key` uniquely identifies the media target so import webhooks can match:
 *   movie:<tmdbId>
 *   tv:<tvdbId>:s<season>e<episode>   (episode/season default to 0 = any)
 *
 * A season-wide report tracks every episode it kicked off in `outstanding`
 * (season*100+episode encoded ids); the Seerr issue is only resolved once the
 * last one has re-imported. Single-episode and movie entries leave it empty and
 * resolve on the first matching import.
 */
export interface PendingItem {
  key: string;
  issueId: number;
  mediaType: "movie" | "tv";
  /** The arr lookup id: tmdbId for movies, tvdbId for TV. Used by startup reconciliation. */
  mediaId: number;
  title: string;
  season: number | null;
  episode: number | null;
  /** Episode ids (season*1000+episode) still awaiting import; empty = resolve on first match. */
  outstanding?: number[];
  /**
   * Whether the replacement search is known to have fired. Written `false`
   * BEFORE any destructive step (queue removal, file delete) and flipped `true`
   * only once the search command succeeds. If the process dies mid-sequence the
   * entry survives as `false`, and startup recovery re-fires the search so a
   * deleted file is never left without a pending replacement. Entries written by
   * older versions omit this field; a missing value is treated as confirmed.
   */
  searchConfirmed?: boolean;
  createdAt: number;
}

export function movieKey(tmdbId: number): string {
  return `movie:${tmdbId}`;
}

export function tvKey(tvdbId: number, season: number | null, episode: number | null): string {
  return `tv:${tvdbId}:s${season ?? 0}e${episode ?? 0}`;
}

/** Stable id for an episode within a series, used in `outstanding`. */
export function episodeId(season: number, episode: number): number {
  return season * 1000 + episode;
}

export interface ImportMatch {
  item: PendingItem;
  /** True when this import completes the entry (so the issue should resolve now). */
  resolved: boolean;
  /** Episodes still outstanding after this import (for logging). */
  remaining: number;
}

/**
 * File-backed store of pending redownloads. Small enough to keep entirely in
 * memory; every mutation is flushed atomically to disk so it survives restarts.
 */
export class PendingStore {
  private items = new Map<string, PendingItem>();

  constructor(
    private readonly path: string,
    private readonly ttlMs: number,
  ) {
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as PendingItem[];
      for (const item of parsed) this.items.set(item.key, item);
      this.prune();
      log.info("Loaded pending redownloads", { count: this.items.size, path: this.path });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        log.warn("Could not read state file; starting empty", {
          path: this.path,
          error: String(err),
        });
      }
    }
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      log.error("Failed to persist state file", { path: this.path, error: String(err) });
    }
  }

  /** Drop entries older than the TTL. Returns the number removed. */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, item] of this.items) {
      if (now - item.createdAt > this.ttlMs) {
        this.items.delete(key);
        removed++;
      }
    }
    if (removed) this.flush();
    return removed;
  }

  add(item: PendingItem): void {
    this.items.set(item.key, item);
    this.flush();
    log.debug("Pending redownload tracked", {
      key: item.key,
      issueId: item.issueId,
      outstanding: item.outstanding?.length ?? 0,
    });
  }

  /**
   * Record an import against a pending entry. `candidateKeys` are the keys the
   * import could satisfy (most specific first); `importedEpisodeIds` are the
   * episodeId()s it delivered (empty for movies).
   *
   * For a season entry with `outstanding`, the imported episodes are struck off
   * and the entry only resolves once none remain. For episode/movie entries the
   * first match resolves. Returns null when nothing matched.
   */
  recordImport(candidateKeys: string[], importedEpisodeIds: number[]): ImportMatch | null {
    for (const key of candidateKeys) {
      const item = this.items.get(key);
      if (!item) continue;

      if (item.outstanding && item.outstanding.length > 0) {
        const remaining = item.outstanding.filter((id) => !importedEpisodeIds.includes(id));
        if (remaining.length === item.outstanding.length) {
          // Matched the season key but none of these episodes were awaited
          // (e.g. an unrelated episode imported); leave the entry untouched.
          continue;
        }
        if (remaining.length === 0) {
          this.items.delete(key);
          this.flush();
          return { item, resolved: true, remaining: 0 };
        }
        item.outstanding = remaining;
        this.flush();
        return { item, resolved: false, remaining: remaining.length };
      }

      // No per-episode tracking: first match resolves.
      this.items.delete(key);
      this.flush();
      return { item, resolved: true, remaining: 0 };
    }
    return null;
  }

  /** Snapshot of all pending items (for reconciliation). */
  all(): PendingItem[] {
    return [...this.items.values()];
  }

  /** Remove an entry by key (used when reconciliation resolves it). */
  remove(key: string): void {
    if (this.items.delete(key)) this.flush();
  }

  /** Replace the outstanding set for an entry (partial season progress). */
  setOutstanding(key: string, outstanding: number[]): void {
    const item = this.items.get(key);
    if (!item) return;
    item.outstanding = outstanding;
    this.flush();
  }

  /** Mark an entry's replacement search as confirmed-fired (crash-safety). */
  confirmSearch(key: string): void {
    const item = this.items.get(key);
    if (!item || item.searchConfirmed) return;
    item.searchConfirmed = true;
    this.flush();
  }

  size(): number {
    return this.items.size;
  }
}
