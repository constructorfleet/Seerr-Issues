import { ArrConfig } from "../config.js";
import { log } from "../logger.js";

/**
 * Thin wrapper over the Radarr/Sonarr v3 REST API. Both apps share the same
 * API shape (`/api/v3/...`, `X-Api-Key` header, `command` endpoint), so this
 * base client handles transport and the subclasses add domain methods.
 */
export abstract class ArrClient {
  protected readonly baseUrl: string;
  private readonly apiKey: string;
  protected readonly name: string;

  constructor(config: ArrConfig, name: string) {
    this.baseUrl = `${config.url}/api/v3`;
    this.apiKey = config.apiKey;
    this.name = name;
  }

  protected async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: Record<string, string | number | boolean>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `${this.name} ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }

    // DELETE and some commands return empty bodies.
    const raw = await res.text();
    return (raw ? JSON.parse(raw) : undefined) as T;
  }

  /** Verify connectivity and API key at startup. */
  async ping(): Promise<void> {
    const status = await this.request<{ version?: string }>("GET", "/system/status");
    log.info(`${this.name} connected`, {
      version: status?.version ?? "unknown",
      url: this.baseUrl,
    });
  }
}
