import { Config } from "./config.js";
import { RadarrClient } from "./arr/radarr.js";
import { SonarrClient } from "./arr/sonarr.js";
import { SeerrApi } from "./seerr-api.js";
import { PendingStore, PendingItem, movieKey, tvKey, episodeId } from "./store.js";
import { ParsedIssue, isActionableNotification } from "./seerr.js";
import { ArrImport, isImportEvent } from "./arr-webhook.js";
import { log } from "./logger.js";

export interface HandleResult {
  status: "ok" | "ignored" | "skipped";
  reason?: string;
  detail?: unknown;
}

export class IssueHandler {
  private readonly radarr: RadarrClient | null;
  private readonly sonarr: SonarrClient | null;
  private readonly seerr: SeerrApi | null;
  private readonly store: PendingStore;

  constructor(private readonly config: Config) {
    this.radarr = config.radarr ? new RadarrClient(config.radarr, "Radarr") : null;
    this.sonarr = config.sonarr ? new SonarrClient(config.sonarr, "Sonarr") : null;
    this.seerr = config.seerr ? new SeerrApi(config.seerr) : null;
    this.store = new PendingStore(config.stateFile, config.pendingTtlMs);
  }

  async verifyConnections(): Promise<void> {
    await Promise.all(
      [this.radarr?.ping(), this.sonarr?.ping(), this.seerr?.ping()].filter(Boolean),
    );
  }

  /** Whether auto-resolve is wired up (Seerr API configured). */
  get canResolve(): boolean {
    return this.seerr !== null;
  }

  async handleIssue(issue: ParsedIssue): Promise<HandleResult> {
    if (!isActionableNotification(issue.notificationType)) {
      return {
        status: "ignored",
        reason: `notification_type ${issue.notificationType || "(none)"} is not actionable`,
      };
    }

    if (this.config.issueTypes.size > 0) {
      if (issue.issueType === null || !this.config.issueTypes.has(issue.issueType)) {
        return {
          status: "ignored",
          reason: `issue_type ${issue.issueType ?? "(none)"} not in ISSUE_TYPES filter`,
        };
      }
    }

    if (issue.mediaType === "movie") {
      if (!this.radarr) return { status: "skipped", reason: "Radarr not configured" };
      if (issue.tmdbId === null) return { status: "skipped", reason: "movie issue missing tmdbId" };
      const key = movieKey(issue.tmdbId);
      // Write the pending entry BEFORE any mutation (searchConfirmed=false) so a
      // crash between deleting the file and firing the search is recoverable.
      const result = await this.radarr.redownload(issue.tmdbId, this.config.redownloadMode, {
        beforeExecute: ({ title }) =>
          this.trackPending(issue, key, issue.tmdbId!, title || issue.subject, undefined, false),
      });
      if (!result.matched)
        return { status: "skipped", reason: `no Radarr movie for tmdbId ${issue.tmdbId}` };
      this.store.confirmSearch(key);
      await this.commentSearching(issue, result.title ?? issue.subject);
      return { status: "ok", detail: result };
    }

    // TV
    if (!this.sonarr) return { status: "skipped", reason: "Sonarr not configured" };
    if (issue.tvdbId === null) return { status: "skipped", reason: "tv issue missing tvdbId" };
    const key = tvKey(issue.tvdbId, issue.affectedSeason, issue.affectedEpisode);
    const result = await this.sonarr.redownload(
      issue.tvdbId,
      this.config.redownloadMode,
      issue.affectedSeason,
      issue.affectedEpisode,
      {
        beforeExecute: ({ title, outstanding }) =>
          this.trackPending(issue, key, issue.tvdbId!, title || issue.subject, outstanding, false),
      },
    );
    if (!result.matched)
      return { status: "skipped", reason: `no Sonarr series for tvdbId ${issue.tvdbId}` };

    // Whole-show reports are refused: too broad to auto-act on. Leave the issue
    // open for a human and (optionally) explain why.
    if (result.skippedTooBroad) {
      await this.commentTooBroad(issue, result.title ?? issue.subject);
      return {
        status: "skipped",
        reason: "whole-show report is too broad to auto-redownload; left for manual review",
      };
    }

    this.store.confirmSearch(key);
    await this.commentSearching(issue, result.title ?? issue.subject);
    return { status: "ok", detail: result };
  }

  /**
   * Acknowledge on the issue that a replacement search has started, so the
   * reporter gets feedback before the (possibly slow) re-import lands. Scope-aware
   * for TV. Gated on the same RESOLVE_COMMENT flag as the resolve comment; only
   * called on the initial webhook-triggered redownload, never on startup recovery.
   */
  private async commentSearching(issue: ParsedIssue, title: string): Promise<void> {
    if (!this.seerr || !this.config.resolveComment) return;
    const issueId = Number(issue.issueId);
    if (!Number.isInteger(issueId)) return;

    let scope = "";
    if (issue.mediaType === "tv") {
      const season = issue.affectedSeason && issue.affectedSeason > 0 ? issue.affectedSeason : null;
      const episode = issue.affectedEpisode && issue.affectedEpisode > 0 ? issue.affectedEpisode : null;
      if (season !== null && episode !== null) {
        scope = ` (S${season}E${episode})`;
      } else if (season !== null) {
        scope = ` (season ${season})`;
      }
    }

    try {
      await this.seerr.comment(
        issueId,
        `🔄 Searching for a replacement for **${title}**${scope} — this issue will resolve automatically once it re-imports.`,
      );
    } catch (err) {
      log.warn("Failed to post searching comment", { issueId, error: String(err) });
    }
  }

  /** Post a note explaining a whole-show report wasn't auto-actioned. */
  private async commentTooBroad(issue: ParsedIssue, title: string): Promise<void> {
    if (!this.seerr || !this.config.resolveComment) return;
    const issueId = Number(issue.issueId);
    if (!Number.isInteger(issueId)) return;
    try {
      await this.seerr.comment(
        issueId,
        `⚠️ This issue was reported against the entire series **${title}** without a specific season or episode. ` +
          `That's too broad to auto-redownload safely, so it's been left for manual review. ` +
          `Please re-report against the affected season or episode to trigger an automatic redownload.`,
      );
    } catch (err) {
      log.warn("Failed to post too-broad comment", { issueId, error: String(err) });
    }
  }

  /** Remember this redownload so we can resolve the issue once it imports. */
  private trackPending(
    issue: ParsedIssue,
    key: string,
    mediaId: number,
    title: string,
    outstanding?: number[],
    searchConfirmed = true,
  ): void {
    // We track even without Seerr configured: the entry is also the write-ahead
    // record that lets startup recovery re-fire a search a crash left un-sent
    // (critical for delete-search). Resolution is separately gated on canResolve.
    const issueId = Number(issue.issueId);
    if (!Number.isInteger(issueId)) {
      log.warn("Cannot track redownload: issue_id is not numeric", { issueId: issue.issueId });
      return;
    }
    const item: PendingItem = {
      key,
      issueId,
      mediaType: issue.mediaType,
      mediaId,
      title,
      season: issue.affectedSeason,
      episode: issue.affectedEpisode,
      outstanding: outstanding && outstanding.length ? outstanding : undefined,
      searchConfirmed,
      createdAt: Date.now(),
    };
    this.store.add(item);
  }

  /** Called when Radarr/Sonarr reports an import; resolves the matching issue. */
  async handleImport(imp: ArrImport): Promise<HandleResult> {
    if (!isImportEvent(imp.eventType)) {
      return {
        status: "ignored",
        reason: `eventType ${imp.eventType || "(none)"} is not an import`,
      };
    }
    if (!this.canResolve) {
      return { status: "ignored", reason: "Seerr API not configured; nothing to resolve" };
    }

    const match = this.store.recordImport(imp.candidateKeys, imp.importedEpisodeIds);
    if (!match) {
      return { status: "ignored", reason: "import does not match any pending redownload" };
    }

    // A season report resolves only once every episode has re-imported.
    if (!match.resolved) {
      log.info("Import progress for season redownload", {
        issueId: match.item.issueId,
        title: imp.title,
        remaining: match.remaining,
      });
      return {
        status: "ok",
        detail: { issueId: match.item.issueId, resolved: false, remaining: match.remaining },
      };
    }

    try {
      await this.resolveIssue(match.item.issueId, imp.title);
      return { status: "ok", detail: { issueId: match.item.issueId, resolved: true } };
    } catch (err) {
      // Re-track so a retry (or manual import event) can try again.
      this.store.add(match.item);
      throw err;
    }
  }

  /** Comment (if enabled) and resolve a Seerr issue. */
  private async resolveIssue(issueId: number, title: string): Promise<void> {
    if (this.config.resolveComment) {
      await this.seerr!.comment(
        issueId,
        `✅ A replacement for **${title}** finished importing — resolving this issue automatically. If the problem persists, please reopen.`,
      );
    }
    await this.seerr!.resolve(issueId);
    log.info("Resolved Seerr issue after import", { issueId, title });
  }

  /**
   * Startup reconciliation. Radarr/Sonarr don't retry failed webhook deliveries,
   * so an import that completed while we were down would otherwise be lost. On
   * boot we re-check each pending entry against arr history and resolve (or
   * advance) anything that already imported since it was tracked.
   */
  async reconcile(): Promise<void> {
    const items = this.store.all();
    if (items.length === 0) return;
    log.info("Reconciling pending redownloads against arr history", { count: items.length });

    // Phase 1: recover searches a crash left un-sent (searchConfirmed === false).
    // This is the delete-search crash-safety guarantee and runs even without
    // Seerr configured, since a deleted file must still get a replacement search.
    for (const item of items) {
      if (item.searchConfirmed !== false) continue; // undefined (legacy) or true = done
      try {
        await this.recoverSearch(item);
      } catch (err) {
        log.warn("Recovery search failed; leaving entry unconfirmed to retry", {
          key: item.key,
          error: String(err),
        });
      }
    }

    // Phase 2: resolve issues whose imports we missed while down. Needs Seerr.
    if (!this.canResolve) {
      log.info("Reconciliation complete (recovery only; Seerr not configured)", {
        remaining: this.store.size(),
      });
      return;
    }

    for (const item of items) {
      try {
        if (item.mediaType === "movie") {
          if (!this.radarr) continue;
          const imported = await this.radarr.importedSince(item.mediaId, item.createdAt);
          if (imported === null) {
            log.warn("Reconcile: movie no longer in Radarr; dropping entry", { key: item.key });
            this.store.remove(item.key);
          } else if (imported) {
            await this.resolveIssue(item.issueId, item.title);
            this.store.remove(item.key);
          }
        } else {
          if (!this.sonarr) continue;
          const importedEps = await this.sonarr.importedEpisodesSince(item.mediaId, item.createdAt);
          if (importedEps === null) {
            log.warn("Reconcile: series no longer in Sonarr; dropping entry", { key: item.key });
            this.store.remove(item.key);
            continue;
          }
          if (item.outstanding && item.outstanding.length) {
            const remaining = item.outstanding.filter((id) => !importedEps.includes(id));
            if (remaining.length === 0) {
              await this.resolveIssue(item.issueId, item.title);
              this.store.remove(item.key);
            } else if (remaining.length !== item.outstanding.length) {
              log.info("Reconcile: advanced season progress", {
                key: item.key,
                remaining: remaining.length,
              });
              this.store.setOutstanding(item.key, remaining);
            }
          } else if (item.season !== null && item.episode !== null) {
            // Single-episode entry: resolve only if that specific episode imported.
            const target = episodeId(item.season, item.episode);
            if (importedEps.includes(target)) {
              await this.resolveIssue(item.issueId, item.title);
              this.store.remove(item.key);
            }
          }
        }
      } catch (err) {
        log.warn("Reconcile failed for entry; leaving it pending", {
          key: item.key,
          error: String(err),
        });
      }
    }
    log.info("Reconciliation complete", { remaining: this.store.size() });
  }

  /**
   * Re-fire a replacement search that a crash left un-sent (searchConfirmed
   * false). Uses a plain, idempotent search — never re-deletes or re-blocklists,
   * so it's safe even if the original search did partially fire. For seasons the
   * search covers whatever episodes are still outstanding. On success the entry
   * is marked confirmed so it isn't retried next boot.
   */
  private async recoverSearch(item: PendingItem): Promise<void> {
    if (item.mediaType === "movie") {
      if (!this.radarr) return;
      const ok = await this.radarr.search(item.mediaId);
      if (!ok) {
        log.warn("Recovery: movie no longer in Radarr; dropping entry", { key: item.key });
        this.store.remove(item.key);
        return;
      }
    } else {
      if (!this.sonarr) return;
      // Season entry: search everything still outstanding. Single-episode entry:
      // search that one episode. Fall back to the entry's own season/episode.
      const encoded =
        item.outstanding && item.outstanding.length
          ? item.outstanding
          : item.season !== null && item.episode !== null
            ? [episodeId(item.season, item.episode)]
            : [];
      if (encoded.length === 0) {
        log.warn("Recovery: TV entry has no episodes to search; dropping", { key: item.key });
        this.store.remove(item.key);
        return;
      }
      const ok = await this.sonarr.searchEpisodes(item.mediaId, encoded);
      if (!ok) {
        log.warn("Recovery: series no longer in Sonarr; dropping entry", { key: item.key });
        this.store.remove(item.key);
        return;
      }
    }
    this.store.confirmSearch(item.key);
    log.info("Recovery: re-fired search a crash left un-sent", { key: item.key, title: item.title });
  }

  /** Expire stale pending entries. */
  prunePending(): number {
    return this.store.prune();
  }
}
