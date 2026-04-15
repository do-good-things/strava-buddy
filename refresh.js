// Fetches all rides and e-bike rides from Strava, generates region clusters,
// and writes rides.json, ebike-rides.json, profile.json, and regions.json.
//
// Usage:
//   1. Create a .env with STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, MAPBOX_TOKEN
//   2. Run: node refresh.js
//   3. If no saved tokens, visit http://localhost:3000/auth/strava to authenticate

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const polyline = require('@mapbox/polyline');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'public', 'data');
const TOKENS_PATH = path.join(__dirname, '.tokens.json');

const CLUSTER_RADIUS_KM = 80;
const BOUNDS_PADDING = 0.15;

const NAME_OVERRIDES = {
  'Sausalito': 'Bay Area',
  'Medina': 'Seattle',
  '沼津市': 'Japan',
  'Santa Ysabel': 'San Diego',
  'Röthenbach im Emmental': 'Switzerland',
  'Kill Devil Hills': 'Outer Banks',
  'Kanahena': 'Maui',
  'La Cañada Flintridge': 'Los Angeles',
  'Washington': 'British Columbia',
  'Stephens City': 'Virginia',
};

let tokenData = null;
try {
  tokenData = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  console.log('Loaded saved tokens');
} catch { /* no saved tokens */ }

// --- Auth ---

async function getAccessToken() {
  if (!tokenData) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tokenData.expires_at > now) return tokenData.access_token;

  const response = await axios.post('https://www.strava.com/oauth/token', {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: tokenData.refresh_token,
    grant_type: 'refresh_token',
  });
  tokenData = { ...tokenData, ...response.data };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));
  return tokenData.access_token;
}

// --- Strava fetch ---

async function fetchAllActivities(token) {
  let page = 1;
  const rides = [];
  const ebikeRides = [];

  while (true) {
    const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${token}` },
      params: { per_page: 200, page },
    });
    console.log(`Page ${page}: ${data.length} activities`);

    for (const a of data) {
      if (!a.map?.summary_polyline) continue;
      if (a.type === 'EBikeRide' || a.sport_type === 'EBikeRide') ebikeRides.push(a);
      else if (a.type === 'Ride' || a.sport_type === 'Ride') rides.push(a);
    }

    if (data.length < 200) break;
    page++;
  }

  return { rides, ebikeRides };
}

async function fetchDetailedFeatures(activities, token, label) {
  console.log(`Fetching ${activities.length} ${label} detailed polylines...`);
  const features = [];

  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    try {
      const { data: detail } = await axios.get(`https://www.strava.com/api/v3/activities/${a.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const poly = detail.map?.polyline || detail.map?.summary_polyline;
      if (poly) {
        features.push({
          type: 'Feature',
          properties: {
            name: a.name,
            date: a.start_date_local,
            distance: a.distance,
            moving_time: a.moving_time,
            elapsed_time: a.elapsed_time,
            elevation_gain: a.total_elevation_gain,
          },
          geometry: polyline.toGeoJSON(poly),
        });
      }
      if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${activities.length} ${label} polylines fetched`);
    } catch (err) {
      console.warn(`  Skipped activity ${a.id}: ${err.response?.status || err.message}`);
    }
  }

  return features;
}

// --- Region generation (ported from filter-label-generate.py) ---

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dlat = (lat2 - lat1) * Math.PI / 180;
  const dlng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dlat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dlng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getRideMidpoint(feature) {
  const geom = feature.geometry;
  const coords = geom.type === 'MultiLineString'
    ? geom.coordinates.flat()
    : geom.coordinates;
  const mid = coords[Math.floor(coords.length / 2)];
  return [mid[1], mid[0]]; // [lat, lng]
}

function clusterRides(midpoints) {
  const n = midpoints.length;
  const labels = Array.from({ length: n }, (_, i) => i);

  function find(x) {
    while (labels[x] !== x) { labels[x] = labels[labels[x]]; x = labels[x]; }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) labels[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineKm(midpoints[i][0], midpoints[i][1], midpoints[j][0], midpoints[j][1]) < CLUSTER_RADIUS_KM) {
        union(i, j);
      }
    }
  }

  const clusters = {};
  for (let i = 0; i < n; i++) {
    const root = find(i);
    (clusters[root] ||= []).push(i);
  }
  return Object.values(clusters);
}

async function reverseGeocode(lat, lng) {
  const token = process.env.MAPBOX_TOKEN;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?types=place,locality,region&access_token=${encodeURIComponent(token)}`;
  try {
    const { data } = await axios.get(url);
    const features = data.features || [];
    if (!features.length) return `Region (${lat.toFixed(1)}, ${lng.toFixed(1)})`;

    let place = null, region = null;
    for (const f of features) {
      const types = f.place_type || [];
      if (types.includes('place') && !place) place = f.text;
      if (types.includes('locality') && !place) place = f.text;
      if (types.includes('region') && !region) region = f.text;
    }
    return place || region || features[0].text;
  } catch (err) {
    console.warn(`  Warning: reverse geocode failed for (${lat}, ${lng}): ${err.message}`);
    return `Region (${lat.toFixed(1)}, ${lng.toFixed(1)})`;
  }
}

async function generateRegions(rideFeatures) {
  const midpoints = rideFeatures.map(getRideMidpoint);
  const clusters = clusterRides(midpoints);
  console.log(`\nFound ${clusters.length} region(s) from ${rideFeatures.length} rides:\n`);

  // Sort clusters largest-first
  clusters.sort((a, b) => b.length - a.length);

  const regions = [];
  for (const indices of clusters) {
    const pts = indices.map(i => midpoints[i]);
    const centroidLat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const centroidLng = pts.reduce((s, p) => s + p[1], 0) / pts.length;

    const minLat = Math.min(...pts.map(p => p[0])) - BOUNDS_PADDING;
    const maxLat = Math.max(...pts.map(p => p[0])) + BOUNDS_PADDING;
    const minLng = Math.min(...pts.map(p => p[1])) - BOUNDS_PADDING;
    const maxLng = Math.max(...pts.map(p => p[1])) + BOUNDS_PADDING;

    let name = await reverseGeocode(centroidLat, centroidLng);
    name = NAME_OVERRIDES[name] || name;

    // Avoid duplicate names
    const existingNames = regions.map(r => r.name);
    if (existingNames.includes(name)) {
      const name2 = await reverseGeocode(centroidLat, centroidLng);
      if (name2 !== name) name = name2;
      else name = `${name} (${indices.length})`;
    }

    regions.push({
      name,
      bounds: [
        [+minLng.toFixed(4), +minLat.toFixed(4)],
        [+maxLng.toFixed(4), +maxLat.toFixed(4)],
      ],
      count: indices.length,
    });
    console.log(`  ${name}: ${indices.length} ride(s)`);
  }

  return regions;
}

// --- Main pipeline ---

async function refresh() {
  const token = await getAccessToken();
  if (!token) {
    console.log('Not authenticated. Visit http://localhost:3000/auth/strava');
    return;
  }

  // 1. Fetch profile
  console.log('\n=== Fetching profile ===');
  const { data: profile } = await axios.get('https://www.strava.com/api/v3/athlete', {
    headers: { Authorization: `Bearer ${token}` },
  });
  fs.writeFileSync(path.join(DATA_DIR, 'profile.json'), JSON.stringify(profile, null, 2));
  console.log('Profile saved.');

  // 2. Fetch all activities (single pass)
  console.log('\n=== Fetching activities ===');
  const { rides, ebikeRides } = await fetchAllActivities(token);
  console.log(`Found ${rides.length} rides and ${ebikeRides.length} e-bike rides.`);

  // 3. Fetch detailed polylines
  console.log('\n=== Fetching ride details ===');
  const rideFeatures = await fetchDetailedFeatures(rides, token, 'ride');
  const ebikeFeatures = await fetchDetailedFeatures(ebikeRides, token, 'e-bike');

  // 4. Write ride data
  const ridesGeoJson = { type: 'FeatureCollection', features: rideFeatures };
  fs.writeFileSync(path.join(DATA_DIR, 'rides.json'), JSON.stringify(ridesGeoJson));
  console.log(`\n${rideFeatures.length} rides saved to public/data/rides.json`);

  const ebikeGeoJson = { type: 'FeatureCollection', features: ebikeFeatures };
  fs.writeFileSync(path.join(DATA_DIR, 'ebike-rides.json'), JSON.stringify(ebikeGeoJson));
  console.log(`${ebikeFeatures.length} e-bike rides saved to public/data/ebike-rides.json`);

  // 5. Generate regions from all rides (regular + e-bike)
  console.log('\n=== Generating regions ===');
  const allFeatures = [...rideFeatures, ...ebikeFeatures];
  const regions = await generateRegions(allFeatures);
  fs.writeFileSync(path.join(DATA_DIR, 'regions.json'), JSON.stringify(regions, null, 2));
  console.log(`\n${regions.length} regions saved to public/data/regions.json`);

  console.log('\nDone!');
  process.exit(0);
}

// --- Server for auth flow ---

const app = express();

app.get('/auth/strava', (req, res) => {
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=http://localhost:${PORT}/auth/callback&approval_prompt=force&scope=read,activity:read`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });
    tokenData = response.data;
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(response.data, null, 2));
    console.log('Authenticated!');
    await refresh();
    res.send('Done! All data refreshed. You can close this tab.');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Authentication failed');
  }
});

app.listen(PORT, async () => {
  console.log(`Refresh server running at http://localhost:${PORT}`);

  if (tokenData) {
    console.log('Tokens found, starting refresh...');
    await refresh();
  } else {
    console.log('No tokens found. Visit http://localhost:3000/auth/strava to authenticate.');
  }
});
