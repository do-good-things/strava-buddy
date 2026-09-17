# Strava Buddy / ridesometime

A personal cycling heatmap with detailed routes and ride photos. The website reads a prepared snapshot; visitors never trigger Strava requests.

## Services and data

- `server.js`: website and allowlisted map/photo endpoints. No Strava credentials needed.
- `refresh.js`: one scheduled job, then exit. Checks summaries, refreshes details/photos, and publishes a complete snapshot.
- `lib/refresh-rides.js`, `photos.js`, `regions.js`: synchronization and region naming.
- `lib/public-data.js`: the explicit public-data boundary and expiration rules.
- `lib/storage.js`: local development storage or Railway's private S3-compatible bucket.
- `test/`: synthetic offline tests; no live Strava data or credentials.

Only geometry, ride name, mileage, riding time, elapsed time, and anonymous photo URLs leave the map endpoint. App-level region navigation and snapshot timestamps are also public. Dates, elevation, Strava IDs, summary fingerprints, original photo URLs, and refresh state are private. Images are re-encoded without EXIF/GPS metadata. GPX export contains only the already-public route geometry and name.

Raw API data is not committed or served from `public/`. The worker's private volume holds token rotations and resumable state. The shared bucket holds only `current.json` and sanitized JPEGs. Express serves allowlisted data rather than proxying arbitrary bucket keys. The old `/sarah/data/*` paths return 404.

## Local development

Use Node.js 22.10 or newer:

```sh
npm ci
cp .env.example .env  # only if you do not already have .env
npm test
npm start
```

Set the browser-safe `MAPBOX_TOKEN` in `.env`. The landing page is `/`; the map is `/sarah/`. Until a fresh snapshot exists, the map displays an unavailable message.

```sh
npm run refresh
npm run refresh -- --full
```

A refresh consumes Strava/Mapbox requests and changes private cache and published data. Local storage defaults to `.runtime/private` and `.runtime/published`. An existing local `.tokens.json` can bootstrap the private token store; alternatively provide `STRAVA_REFRESH_TOKEN` with your Strava client ID and secret. There is no interactive OAuth server in the scheduled job: missing credentials fail promptly. A newly authorized token can be provisioned privately after completing Strava OAuth separately.

The checked-in tests provide offline synthetic coverage. A live local map requires a successful refresh (or a separately provisioned published snapshot); it still needs a browser-safe Mapbox token for the basemap.

## Refresh behavior

Every run scans all paginated summaries, so it catches older uploads and removals. Unchanged detailed routes are reused for less than six days; changed, new, or aging routes are fetched again. Regular rides and e-bike rides are included without publishing their type. Explicitly private/followers-only activities, activities no longer returned, and routes without maps are omitted.

Photo lists are checked each run for rides with photos or an unknown photo count. This detects additions/removals/replacements even when the route summary is unchanged. Images are fetched again at six days, stripped of metadata, and stored with random public filenames. The photo-list endpoint is inherited from the earlier photo implementation; it is not covered by Strava's complete public API reference, so a live verification is required before rollout. A photo failure aborts publication rather than silently losing photos.

The worker checkpoints completed routes and photos privately. A failed run keeps the previous published snapshot and resumes from its checkpoints on the next run. It retries short-lived request errors and waits for short-term quota resets; daily exhaustion stops the run. `--full` refetches every detailed route; normal photo freshness rules still apply.

New routes and photo data have real fetch timestamps. Old repository files have no trustworthy detail-fetch timestamps, so the first production refresh intentionally fetches them anew. The local legacy files were preserved in ignored `.runtime/legacy-data` for migration review; they are not an input to the new publisher.

## Expiration and failures

- Refresh detailed routes and photo bytes at six days.
- Never publish content beyond its seven-day fetch lifetime.
- Expire the whole snapshot at the earlier of its oldest content expiration or 36 hours since a successful refresh. This prevents an outage from leaving deleted/private rides visible indefinitely.
- Use `Cache-Control: no-store` for data/photos. Open map tabs clear their displayed snapshot when it expires.
- Delete obsolete images after publishing. Prune expired private state, images, and snapshots at job startup, including before Strava authentication.
- Cap jobs at two hours, with a worker-volume lock to prevent overlap. A crashed lock is reclaimable after three hours.

Expiration prevents serving old content; physical cleanup still requires the scheduled worker to run. A Railway/storage outage can delay deletion. Do not enable long-lived backups/versioning for the data cache if those would retain expired copies. Credentials are persistent authorization state, separate from the expiring ride cache.

`/healthz` reports that the web process is running. `/readyz` returns 503 if its snapshot is missing, expired, or unreadable. Use `/readyz` for ongoing stale-data monitoring, and `/healthz` for Railway deployment health checks. The worker records a private success/failure status and exits nonzero on failure. Notification delivery requires configuring an external monitor or Railway notifications; none is sent by this code.

## Railway deployment

See [railway/README.md](railway/README.md) for the exact service settings, storage mapping, and rollout order. Develop on `incremental-refresh`; both production services should use `main` after review and merge. The staging worker is intentionally manual: leave its Cron Schedule empty and use Railway's **Run now** action until the first complete snapshot is verified. Code deployment is separate from data publication.

Deleting raw JSON from the current tree does not remove it from existing Git history, old deployment images, or your previous checkout. Those require separate cleanup if desired; this change does not rewrite repository history.
