const { createHash } = require('node:crypto');
const polyline = require('@mapbox/polyline');

const { fresh, REFRESH_AGE } = require('./public-data');

const API_BASE = 'https://www.strava.com/api/v3';

// Fail before publishing any partial results. Long quota waits are left to the
// operator for daily exhaustion; short windows pause and resume automatically.
function createReader(axios, token, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, log = console.log,
} = {}) {
  let quotaError, waitUntil = 0;
  const nextWindow = () => Math.floor(now() / 900000) * 900000 + 901000;
  async function waitForWindow() {
    let remaining = Math.max(0, waitUntil - now());
    if (remaining) log(`Waiting ${Math.ceil(remaining / 1000)} seconds for Strava's request quota.`);
    while (remaining > 0) {
      const chunk = Math.min(remaining, 30000);
      await sleep(chunk);
      remaining -= chunk;
      if (remaining > 0) log(`Still waiting for Strava's request quota (${Math.ceil(remaining / 1000)} seconds remaining).`);
    }
    waitUntil = 0;
  }
  return async function read(endpoint, params) {
    if (quotaError) throw new Error(quotaError);
    for (let attempt = 0; ; attempt++) {
      await waitForWindow();
      try {
        const response = await axios.get(`${API_BASE}${endpoint}`, {
          headers: { Authorization: `Bearer ${token}` }, params, timeout: 30000,
        });
        for (const prefix of ['x-ratelimit', 'x-readratelimit']) {
          const limit = String(response.headers?.[`${prefix}-limit`] || '').split(',').map(Number);
          const usage = String(response.headers?.[`${prefix}-usage`] || '').split(',').map(Number);
          if (limit[1] > 0 && usage[1] >= limit[1]) {
            quotaError = 'Strava daily quota exhausted. Retry after midnight UTC.';
            break;
          }
          if (limit[0] > 0 && usage[0] >= limit[0]) {
            waitUntil = nextWindow();
          }
        }
        return response.data;
      } catch (error) {
        const status = error.response?.status;
        if (status === 429) {
          const headers = error.response.headers || {};
          const dailyExhausted = ['x-ratelimit', 'x-readratelimit'].some(prefix => {
            const limit = Number(String(headers[`${prefix}-limit`] || '').split(',')[1]);
            const usage = Number(String(headers[`${prefix}-usage`] || '').split(',')[1]);
            return limit > 0 && usage >= limit;
          });
          if (dailyExhausted || attempt >= 2) throw new Error('Strava rate limit reached. Retry after the quota resets; saved data was not replaced.');
          waitUntil = nextWindow();
          continue;
        }
        if ((!status || status >= 500) && attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        // Do not leak Axios request configuration, which contains credentials.
        throw new Error(`Strava request failed (${status || error.code || 'network error'}) at ${endpoint}`);
      }
    }
  };
}

function properties(activity) {
  return {
    name: activity.name, date: activity.start_date_local,
    distance: activity.distance, moving_time: activity.moving_time,
    elapsed_time: activity.elapsed_time, elevation_gain: activity.total_elevation_gain,
  };
}

function legacyKey(p) {
  return JSON.stringify([p.name, p.date, p.distance, p.moving_time, p.elapsed_time, p.elevation_gain]);
}

function signature(activity) {
  return createHash('sha256').update(JSON.stringify([
    properties(activity), activity.type, activity.sport_type,
    activity.map?.summary_polyline,
  ])).digest('hex');
}

function kind(activity) {
  if (activity.private === true || (activity.visibility && activity.visibility !== 'everyone')) return null;
  if (!activity.map?.summary_polyline) return null;
  if (activity.type === 'EBikeRide' || activity.sport_type === 'EBikeRide') return 'ebike';
  if (activity.type === 'Ride' || activity.sport_type === 'Ride') return 'ride';
  return null;
}

async function syncRides({ read, existing = [], full = false, now = Date.now, onFeature = async () => {}, onList = async () => {}, log = () => {} }) {
  // A complete summary scan catches older uploads, edits, deletions, and type
  // changes without making a detail request for every saved activity.
  const all = new Map();
  for (let page = 1; ; page++) {
    const batch = await read('/athlete/activities', { per_page: 200, page });
    if (!Array.isArray(batch) || batch.some(a => !a || !Number.isSafeInteger(a.id))) {
      throw new Error('Invalid activity list; refresh aborted.');
    }
    for (const a of batch) all.set(a.id, a);
    log(`Summary page ${page}: received ${batch.length} activities (${all.size} unique total).`);
    if (batch.length < 200) break;
  }

  await onList([...all.values()].filter(a => kind(a)).map(a => a.id));
  const byId = new Map();
  const legacy = new Map();
  for (const feature of existing) {
    const id = feature.properties.strava_id;
    if (id != null) byId.set(id, feature);
    else {
      const key = legacyKey(feature.properties);
      legacy.set(key, [...(legacy.get(key) || []), feature]);
    }
  }
  const activities = [...all.values()].filter(a => kind(a));
  const keyCounts = new Map();
  for (const a of activities) {
    const key = legacyKey(properties(a));
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }

  const rides = [], ebikeRides = [];
  let reused = 0, fetched = 0, migrated = 0;
  log(`Prepared ${activities.length} public rides from ${all.size} activities; checking cached routes.`);
  let processed = 0;
  for (const activity of activities) {
    const hash = signature(activity);
    let saved = byId.get(activity.id);
    let legacyMatch = false;
    if (!saved && !full) {
      const key = legacyKey(properties(activity));
      const matches = legacy.get(key) || [];
      if (matches.length === 1 && keyCounts.get(key) === 1) {
        saved = matches[0];
        legacyMatch = true;
      }
    }
    let geometry, detail, fetchedAt;
    if (!full && saved && fresh(saved.properties.detail_fetched_at, now(), REFRESH_AGE) && (legacyMatch || saved.properties.summary_hash === hash)) {
      geometry = saved.geometry;
      fetchedAt = saved.properties.detail_fetched_at;
      reused++;
      if (legacyMatch) migrated++;
    } else {
      detail = await read(`/activities/${activity.id}`);
      if (!detail || detail.id !== activity.id) throw new Error('Invalid activity detail; refresh aborted.');
      // A privacy change can happen between listing and fetching details.
      if (detail.private === true || (detail.visibility && detail.visibility !== 'everyone')) continue;
      const encoded = detail.map?.polyline || detail.map?.summary_polyline;
      if (!encoded) throw new Error(`Activity ${activity.id} returned no route; refresh aborted.`);
      geometry = polyline.toGeoJSON(encoded);
      if (geometry.coordinates.length < 2 || geometry.coordinates.some(p => p.some(v => !Number.isFinite(v)))) {
        throw new Error(`Activity ${activity.id} returned an invalid route; refresh aborted.`);
      }
      fetched++;
      fetchedAt = new Date(now()).toISOString();
    }
    const feature = {
      type: 'Feature',
      properties: {
        ...properties(activity), strava_id: activity.id, summary_hash: hash,
        detail_fetched_at: fetchedAt,
        photo_count: activity.total_photo_count ?? detail?.photos?.count ?? null,
        photos: saved?.properties.photos || [],
      },
      geometry,
    };
    await onFeature(feature, activity);
    (kind(activity) === 'ebike' ? ebikeRides : rides).push(feature);
    processed++;
    if (processed % 10 === 0 || processed === activities.length) log(`Routes processed: ${processed}/${activities.length} (${fetched} fetched, ${reused} reused).`);
  }
  return { rides, ebikeRides, reused, fetched, migrated };
}

module.exports = { createReader, syncRides };
