import { SeerrConfig } from "./config.js";
import { log } from "./logger.js";

/**
 * Client for Seerr's own REST API (Overseerr/Jellyseerr compatible), used to
 * close the loop on an issue once the replacement media has imported.
 *
 * Endpoints used:
 *   GET  /api/v1/issue/{id}           (media ids missing from the webhook)
 *   POST /api/v1/issue/{id}/comment   { message }
 *   POST /api/v1/issue/{id}/resolved  (status transition)
 */
/** The media ids Seerr stores for an issue's media. */
export interface SeerrMediaIds {
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  /** The Radarr movie id / Sonarr series id on the default server. */
  externalServiceId: number | null;
  /** Same, on the 4K server. */
  externalServiceId4k: number | null;
}

interface RawMedia {
  tmdbId?: number | null;
  tvdbId?: number | null;
  imdbId?: string | null;
  externalServiceId?: number | null;
  externalServiceId4k?: number | null;
}

function idOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

export class SeerrApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: SeerrConfig) {
    this.baseUrl = `${config.url}/api/v1`;
    this.apiKey = config.apiKey;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-Api-Key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.cause : undefined;
      throw new Error(
        `Seerr ${method} ${path} request failed: ${String(err)}${cause ? `; cause: ${String(cause)}` : ""}`,
        { cause: err },
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Seerr ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }
    const raw = await res.text();
    return (raw ? JSON.parse(raw) : undefined) as T;
  }

  async ping(): Promise<void> {
    const status = await this.request<{ version?: string }>("GET", "/status");
    log.info("Seerr connected", { version: status?.version ?? "unknown", url: this.baseUrl });
  }

  /** Fetch the media ids Seerr has for an issue, or null if the issue has no media. */
  async getIssueMedia(issueId: number): Promise<SeerrMediaIds | null> {
    const issue = await this.request<{ media?: RawMedia | null }>("GET", `/issue/${issueId}`);
    const media = issue?.media;
    if (!media) return null;
    return {
      tmdbId: idOrNull(media.tmdbId),
      tvdbId: idOrNull(media.tvdbId),
      imdbId: typeof media.imdbId === "string" && media.imdbId ? media.imdbId : null,
      externalServiceId: idOrNull(media.externalServiceId),
      externalServiceId4k: idOrNull(media.externalServiceId4k),
    };
  }

  async comment(issueId: number, message: string): Promise<void> {
    await this.request("POST", `/issue/${issueId}/comment`, { message });
  }

  /** Transition an issue to resolved. */
  async resolve(issueId: number): Promise<void> {
    await this.request("POST", `/issue/${issueId}/resolved`);
  }
}
