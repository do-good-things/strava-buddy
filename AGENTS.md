# Project guidance

ridesometime / strava-buddy is a single-athlete heatmap built with CommonJS Node.js, Express, plain browser JavaScript/CSS, and Mapbox. There is no frontend build step.

## Architecture

- `server.js` serves explicit static assets and sanitized map/photo endpoints. Never expose private refresh storage or add a generic bucket/static data proxy.
- `refresh.js` runs once and exits; production scheduling belongs to Railway.
- `lib/refresh-rides.js`, `photos.js`, `regions.js`, `refresh-job.js` implement the worker.
- `lib/public-data.js` owns public field allowlists and expiry. Per-ride public fields are geometry, name, mileage, riding time, elapsed time, and photo links only.
- `lib/storage.js` handles local/S3 published storage. Worker-private tokens and checkpoints live on a separate persistent volume.
- `railway/README.md` contains the production rollout plan and variables.
- `archive/` contains obsolete scripts; do not use them for current refreshes.

## Development and verification

- Install with `npm ci`; run the website with `npm start` and tests with `npm test`.
- Tests must use synthetic data and injected/mock clients, without reading real credentials or athlete payloads.
- Use synthetic fixtures and injected/mock clients for data QA; do not use real athlete data as test fixtures.
- Do not run a live refresh as a test. `npm run refresh` makes paid/quota-limited external requests and changes runtime data.
- Keep the existing plain JavaScript/CSS architecture unless a task calls for changing it.

## Data boundaries

- Never commit `.env`, tokens, API-derived ride/profile JSON, photo originals, or `.runtime`.
- The copied legacy files in `.runtime/legacy-data` are private local migration material; never serve or publish them automatically.
- Detailed routes/photo bytes refresh at six days and expire at seven. Snapshots expire at most 36 hours after the last successful publication.
- Preserve resumable private checkpoints, atomic single-snapshot publication, and blocked `/sarah/data/*` routes.
- Strip image metadata and use anonymous photo keys. Browser-visible geometry and explicitly approved fields are inherently inspectable.
- Do not log bearer tokens, credentials, raw Axios errors, or signed image URLs.
- Railway setup requires authenticated access and staging verification; do not imply configuration or deployment occurred unless verified.
