# Railway rollout

The implementation is ready for an authenticated Railway setup and live smoke test. These settings have not been applied to a Railway project.

Use two services from `do-good-things/strava-buddy`, one private bucket, and one volume attached only to the worker. Both services ultimately follow `main`; validate the branch in an isolated staging environment first.

## Service settings

| Setting | Existing website | New refresh worker |
| --- | --- | --- |
| Source branch | `main` after merge | `main` after merge |
| Root directory | `/` | `/` |
| Build | Railpack / Node.js | Railpack / Node.js |
| Start command | `npm start` | `npm run refresh` |
| Cron schedule | None | `0 10 * * *` (daily 10:00 UTC) |
| Restart policy | On failure | Never |
| Health check | `/healthz` | None (job exits) |
| Public domain | Keep current domain | None |
| Replicas | Existing configuration | One |
| Persistent volume | Not needed | Mount at `/data` |

Configure these through the service settings or import your existing project with Railway's current Infrastructure as Code workflow (`railway config pull`, then review `railway config plan`). Do not use a new `railway.json`/`railway.toml`: Railway documents those as deprecated and unavailable for new services. We deliberately do not supply a whole-project IaC file until the existing project's resources have been imported, to avoid inadvertently replacing unrelated services or domains.

## Bucket variables on both services

Create a dedicated private bucket called, for example, `heatmap`. Map its Railway reference variables as follows:

| App variable | Reference |
| --- | --- |
| `STORAGE_BACKEND` | `s3` |
| `AWS_ENDPOINT_URL` | `${{heatmap.ENDPOINT}}` |
| `AWS_S3_BUCKET_NAME` | `${{heatmap.BUCKET}}` |
| `AWS_ACCESS_KEY_ID` | `${{heatmap.ACCESS_KEY_ID}}` |
| `AWS_SECRET_ACCESS_KEY` | `${{heatmap.SECRET_ACCESS_KEY}}` |
| `AWS_DEFAULT_REGION` | `${{heatmap.REGION}}` |
| `MAPBOX_TOKEN` | Your public browser-safe token |

Leave `S3_FORCE_PATH_STYLE=false` for new virtual-hosted buckets; use `true` only if the bucket's Credentials tab specifies path-style access. Bucket credentials never go to the browser. Use read-only credentials for the web service if the provider supports them; the application's routes never expose arbitrary keys regardless.

## Worker-only variables and authorization

- `PRIVATE_DATA_DIR=/data/private` (the volume must be mounted at `/data`).
- `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` as Railway secrets.
- Bootstrap with `STRAVA_REFRESH_TOKEN`, or provision the current token file directly to `/data/private/tokens.json` using a secure upload. Never paste credentials into a commit or deployment log.

The worker writes rotated tokens to its persistent volume immediately. After a successful first run and restart test, remove the bootstrap environment variable; the persisted token takes precedence. Avoid running local and Railway refreshes concurrently against the same authorization. Losing the volume means restoring authorization, not falling back to a stale token indefinitely.

## Rollout order

1. Create the bucket and worker-only volume in staging; attach variables and use this branch for both staging services. Keep the current production website unchanged.
2. Run the worker manually once. The initial fetch can span multiple Strava quota windows. It needs to successfully fetch route details, photo lists/images, and geocoding data.
3. Check that the worker exits, then run it again: unchanged detailed routes and fresh photo bytes should be reused, while summaries/photo lists are checked.
4. Check `/readyz`, the map, region filters, ride selection, stats, GPX download, and photos at desktop and mobile sizes. Inspect `/sarah/map.json` to confirm only approved fields. Confirm `/sarah/data/rides.json` and `/sarah/data/profile.json` return 404.
5. Enable the daily cron and monitor `/readyz` plus worker failures. Railway skips a cron execution if the previous one is still running. The script caps runtime and releases/reclaims its lock.
6. After review, merge to `main`, point the production worker at `main`, and produce a fresh production snapshot before deploying the new web service against that bucket. This avoids an empty map during cutover.

The web deployment does not carry any API-data fallback. Do not roll back to the old static-data deployment to handle a refresh outage: it would restore raw JSON exposure. Keep the last working version of the new server for rollback.

## What needs live verification

S3 upload/read/delete permissions, token persistence across worker restarts, the inherited photo-list endpoint and CDN hosts, Railway cron execution, and visual rendering with the real Mapbox token. Offline tests cover the data boundaries, expiry, metadata stripping, checkpoint recovery, and failure behavior. No live Strava refresh or Railway deployment was performed during implementation.

## References

- [Railway cron jobs](https://docs.railway.com/cron-jobs)
- [Railway storage buckets and variable references](https://docs.railway.com/storage-buckets)
- [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
