import { SeerrConfig } from "./config.js";
import { log } from "./logger.js";

/**
 * Client for Seerr's own REST API (Overseerr/Jellyseerr compatible), used to
 * close the loop on an issue once the replacement media has imported.
 *
 * Endpoints used:
 *   POST /api/v1/issue/{id}/comment   { message }
 *   POST /api/v1/issue/{id}/resolved  (status transition)
 */
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

  async comment(issueId: number, message: string): Promise<void> {
    await this.request("POST", `/issue/${issueId}/comment`, { message });
  }

  /** Transition an issue to resolved. */
  async resolve(issueId: number): Promise<void> {
    await this.request("POST", `/issue/${issueId}/resolved`);
  }
}
