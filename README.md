# seerr-issues

Auto-redownload media when a [Seerr](https://github.com/seerr-team/seerr)
(Overseerr / Jellyseerr) **Issue** is reported.

Seerr lets users report problems with a movie or episode ("video is corrupt",
"wrong audio", …) but has no way to kick off a re-download. This service closes
that gap: it receives Seerr's issue webhook and tells **Radarr** / **Sonarr** to
blocklist the bad release and search for a replacement.

```
User reports issue ─▶ Seerr webhook ─▶ seerr-issues ─▶ Radarr / Sonarr
                                                          (blocklist + search)
                                                                │
                        Seerr issue  ◀── resolve + comment ◀────┘
                        resolved              (on import webhook)
```

Optionally, when the replacement finishes importing, Radarr/Sonarr notify this
service back and it **resolves the Seerr issue automatically** (with a comment).

## What it does

On an `ISSUE_CREATED` (or `ISSUE_REOPENED`) webhook it:

1. Matches the media in Radarr (by `tmdbId`) or Sonarr (by `tvdbId`).
2. Removes any in-progress download from the queue (blocklisting it).
3. Depending on `REDOWNLOAD_MODE`, handles the existing file.
4. Triggers an automatic search for a replacement.

### TV report scope

For TV, the scope depends on what the user reported in Seerr:

| Reported                                  | What happens                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A specific **episode** (season + episode) | Redownloads just that episode. Resolves on its import.                                                                                                                                                                                                                          |
| A whole **season** (season, no episode)   | Uses Sonarr's native `SeasonSearch` (one paced command, not one search per episode). The issue resolves only once **every** episode in the season has re-imported.                                                                                                              |
| The whole **show** (no season/episode)    | **Not auto-actioned.** A whole-series redownload could fire hundreds of searches at your indexers and rarely reflects the real problem, so the issue is left open for manual review with an explanatory comment asking the user to re-report against a specific season/episode. |

### Redownload modes

| `REDOWNLOAD_MODE`              | Existing file | Behavior                                                                                                                                                                       |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blocklist-search` _(default)_ | kept          | Blocklists the imported release (marks its grab as failed) then searches, so the search only replaces it with a **different** release. Best for "grabbed a bad release" cases. |
| `search`                       | kept          | Just searches. Simplest, but your indexer may hand back the same release.                                                                                                      |
| `delete-search`                | **deleted**   | Deletes the file, then searches. Most reliable for a genuinely corrupt file, but leaves a gap until the replacement arrives.                                                   |

> **Tip:** `delete-search` is the most robust for corrupt-file complaints because
> blocklisting only helps if the _release_ was bad and a distinct one exists.
> The trade-off is the media is unavailable until a replacement imports.

## Setup

### 1. Run the service

With Docker Compose (see [`docker-compose.yml`](docker-compose.yml)):

```bash
cp .env.example .env   # fill in API keys + a WEBHOOK_SECRET
docker compose up -d --build
```

Get each API key from Radarr/Sonarr under **Settings → General → API Key**.
If Seerr/Radarr/Sonarr already run in a compose project, join their network and
use the container names (`http://radarr:7878`) as the URLs.

Verify it's up:

```bash
curl http://localhost:3939/health   # {"status":"ok"}
```

### 2. Point Seerr at it

In Seerr: **Settings → Notifications → Webhook**

- **Webhook URL:** `http://seerr-issues:3939/webhook`
  (or the host/IP where this runs)
- **Authorization Header:** `Bearer <your WEBHOOK_SECRET>` — or leave
  `WEBHOOK_SECRET` unset to disable auth. You can alternatively append
  `?token=<secret>` to the URL.
- **Notification Types:** enable **Issue Reported** (and optionally
  **Issue Reopened**).
- Leave the default JSON payload template — this service parses it.

Hit **Test** in Seerr; the service logs the test payload and returns
`ignored` (a test has no media), confirming connectivity.

### 3. (Optional) Auto-resolve issues on import

To have issues resolved automatically once the replacement imports, set
`SEERR_URL` + `SEERR_API_KEY` (Seerr **Settings → General → API Key**), then add
an outbound webhook in **both** Radarr and Sonarr:

**Settings → Connect → + → Webhook**

- **Name:** `seerr-issues`
- **Triggers:** enable **On Import** and **On Upgrade** (Sonarr calls the latter
  "On Import" too depending on version — enable anything import-related).
- **URL:** `http://seerr-issues:3939/import`
- **Method:** `POST`
- If you set `WEBHOOK_SECRET`, add a header `X-Webhook-Secret: <secret>` (Radarr/
  Sonarr don't send an Authorization header, so use the header or `?token=`).

When a redownload is triggered, the service posts a 🔄 acknowledgment comment on
the issue (scope-aware for TV, e.g. "S2E5" or "season 2") so the reporter knows a
replacement is being searched for. When the replacement later imports, it posts a
✅ comment and marks the issue resolved. Both comments are gated on
`RESOLVE_COMMENT`. Pending redownloads are persisted to `STATE_FILE` (mount
`/data`) so this survives restarts, and expire after `PENDING_TTL_DAYS`. If
`SEERR_URL` is unset, the service stays fire-and-forget and the `/import`
endpoint is disabled.

**Missed imports are recovered on startup.** Radarr/Sonarr don't retry failed
webhook deliveries, so an import that completes while this service is down would
otherwise be lost. On boot, the service reconciles each pending redownload
against Radarr/Sonarr history and resolves anything that already imported since
it was tracked (using the tracked timestamp, so the _original_ bad file's import
never counts). This makes the auto-resolve loop robust to restarts and dropped
webhooks.

**A crash mid-redownload can't strand a deleted file.** The redownload sequence
(remove from queue → optionally delete the file → search) isn't atomic — if the
process is killed after `delete-search` removes the file but before the search
command fires, the media would be gone with nothing pending. To prevent this the
service persists a _write-ahead_ record **before** touching anything, marked
"search not yet confirmed", and only flips it to confirmed once the search
actually fires. On boot, any record still unconfirmed has its search re-issued
(idempotently — recovery only searches, it never re-deletes or re-blocklists), so
a deleted file always gets a replacement search. This recovery runs even when
Seerr isn't configured, since a missing file must be refilled regardless of
whether an issue can be auto-resolved.

## Configuration

All via environment variables. At least one of Radarr / Sonarr is required.

| Variable                        | Default              | Description                                                                                                                                 |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                          | `3939`               | HTTP listen port.                                                                                                                           |
| `LOG_LEVEL`                     | `info`               | `debug` \| `info` \| `warn` \| `error`.                                                                                                     |
| `WEBHOOK_SECRET`                | _(none)_             | Shared secret Seerr must present. Unset = no auth.                                                                                          |
| `REDOWNLOAD_MODE`               | `blocklist-search`   | See modes table above.                                                                                                                      |
| `ISSUE_TYPES`                   | _(all)_              | Comma-separated Seerr issue type ids to act on: `1`=video, `2`=audio, `3`=subtitles, `4`=other. E.g. `1,2` to ignore subtitle/other issues. |
| `RADARR_URL` / `RADARR_API_KEY` | —                    | Radarr base URL + API key (set together).                                                                                                   |
| `SONARR_URL` / `SONARR_API_KEY` | —                    | Sonarr base URL + API key (set together).                                                                                                   |
| `SEERR_URL` / `SEERR_API_KEY`   | _(none)_             | Seerr base URL + API key. Enables auto-resolve; unset = fire-and-forget.                                                                    |
| `RESOLVE_COMMENT`               | `true`               | Post a comment on the issue when resolving it.                                                                                              |
| `PENDING_TTL_DAYS`              | `7`                  | Discard a pending redownload if no import arrives within this window.                                                                       |
| `STATE_FILE`                    | `/data/pending.json` | Where pending redownloads are persisted.                                                                                                    |

### Docker secrets (`_FILE`)

Any variable above can be supplied from a file instead of an inline value using
the Docker secrets convention: append `_FILE` to the name and point it at a file
whose contents are the value (a single trailing newline is trimmed). `NAME_FILE`
takes precedence over `NAME`. Handy for keeping API keys out of `docker-compose.yml`:

```yaml
services:
  seerr-issues:
    environment:
      RADARR_API_KEY_FILE: /run/secrets/radarr_api_key
    secrets:
      - radarr_api_key
secrets:
  radarr_api_key:
    file: ./secrets/radarr_api_key
```

## Notes & limitations

- **Idempotency:** Seerr may resend a webhook. Re-running a search is harmless;
  in `delete-search` mode a duplicate could delete a freshly-imported file, so
  prefer `blocklist-search` if you're concerned about retries.
- **Subtitle issues** (`3`) usually aren't fixed by a re-download — consider
  excluding them via `ISSUE_TYPES` and using Bazarr instead.
- **Matching** relies on the `tmdbId` (movies) / `tvdbId` (TV) that Seerr sends
  matching what Radarr/Sonarr hold, which is the normal case for media added
  through Seerr.
- **Auto-resolve matching:** an import is matched back to an issue by
  `tmdbId`/`tvdbId` (+ season/episode for TV), not by a per-request token. If two
  issues target the same episode, the first import resolves whichever pending
  entry it finds. This is rare in practice and self-corrects on the TTL sweep.
- Auto-resolve requires `SEERR_URL`/`SEERR_API_KEY` **and** the Radarr/Sonarr
  import webhooks pointing at `/import`. Without Seerr configured the service
  only triggers the re-download and leaves the issue open.

## Development

```bash
npm install
npm run dev        # tsx watch
npm run typecheck
npm run build && npm start
```

## License

MIT
