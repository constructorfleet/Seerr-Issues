import express, { type Request, type Response, type NextFunction } from "express";
import { loadConfig } from "./config.js";
import { IssueHandler } from "./handler.js";
import { parseWebhook } from "./seerr.js";
import { parseArrWebhook } from "./arr-webhook.js";
import { log } from "./logger.js";

const config = loadConfig();
const handler = new IssueHandler(config);

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * Optional shared-secret auth. Configure a Header in Seerr's webhook agent, or
 * append `?token=...` to the webhook URL. Compared in constant time.
 */
function authorized(req: Request): boolean {
  if (!config.webhookSecret) return true;
  const provided =
    (req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
      req.header("x-webhook-secret") ||
      (typeof req.query.token === "string" ? req.query.token : "")) ??
    "";
  return timingSafeEqual(provided, config.webhookSecret);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post("/webhook", async (req: Request, res: Response) => {
  if (!authorized(req)) {
    log.warn("Rejected unauthorized webhook", { ip: req.ip });
    return res.status(401).json({ error: "unauthorized" });
  }

  const issue = parseWebhook(req.body);
  if (!issue) {
    // Seerr sends a test payload with no media on "Test" — acknowledge it.
    log.info("Received non-issue or test webhook", {
      notificationType: (req.body as { notification_type?: string })?.notification_type,
    });
    return res.status(200).json({ status: "ignored", reason: "not an actionable issue payload" });
  }

  log.info("Issue received", {
    notificationType: issue.notificationType,
    issueId: issue.issueId,
    mediaType: issue.mediaType,
    tmdbId: issue.tmdbId,
    tvdbId: issue.tvdbId,
    season: issue.affectedSeason,
    episode: issue.affectedEpisode,
  });

  try {
    const result = await handler.handleIssue(issue);
    if (result.status === "ok") {
      log.info("Issue handled", { issueId: issue.issueId, detail: result.detail });
    } else {
      log.info(`Issue ${result.status}`, { issueId: issue.issueId, reason: result.reason });
    }
    return res.status(200).json(result);
  } catch (err) {
    log.error("Failed to handle issue", { issueId: issue.issueId, error: String(err) });
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

/**
 * Import webhook target for Radarr/Sonarr "On Import"/"On Upgrade" connections.
 * When a replacement finishes importing, the matching Seerr issue is resolved.
 */
app.post("/import", async (req: Request, res: Response) => {
  if (!authorized(req)) {
    log.warn("Rejected unauthorized import webhook", { ip: req.ip });
    return res.status(401).json({ error: "unauthorized" });
  }

  const imp = parseArrWebhook(req.body);
  if (!imp) {
    log.info("Received non-import or test arr webhook", {
      eventType: (req.body as { eventType?: string })?.eventType,
    });
    return res.status(200).json({ status: "ignored", reason: "not an import payload" });
  }

  log.info("Import received", {
    eventType: imp.eventType,
    title: imp.title,
    candidateKeys: imp.candidateKeys,
  });

  try {
    const result = await handler.handleImport(imp);
    log.info(`Import ${result.status}`, {
      title: imp.title,
      reason: result.reason,
      detail: result.detail,
    });
    return res.status(200).json(result);
  } catch (err) {
    log.error("Failed to handle import", { title: imp.title, error: String(err) });
    return res.status(500).json({ status: "error", error: String(err) });
  }
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error("Unhandled request error", { error: String(err) });
  res.status(400).json({ error: "bad request" });
});

async function main() {
  try {
    await handler.verifyConnections();
  } catch (err) {
    log.warn("Startup connectivity check failed; continuing anyway", { error: String(err) });
  }

  // Catch imports that completed while we were down (arr webhooks aren't retried).
  try {
    await handler.reconcile();
  } catch (err) {
    log.warn("Startup reconciliation failed; continuing anyway", { error: String(err) });
  }

  // Periodically expire pending redownloads that never imported.
  if (handler.canResolve) {
    const hourly = 60 * 60 * 1000;
    setInterval(() => {
      const removed = handler.prunePending();
      if (removed) log.info("Pruned stale pending redownloads", { removed });
    }, hourly).unref();
  }

  app.listen(config.port, () => {
    log.info(`seerr-issues listening on port ${config.port}`, {
      issueWebhook: "/webhook",
      importWebhook: handler.canResolve ? "/import" : "disabled (Seerr API not configured)",
    });
  });
}

main();
