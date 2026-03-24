require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const polyline = require('@mapbox/polyline');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const TOKENS_DIR = path.join(STORAGE_DIR, '.tokens');
const VANITY_PATH = path.join(STORAGE_DIR, '.vanity.json');
const VANITY_LIMIT = 10;

// Ensure directories exist
fs.mkdirSync(TOKENS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Multi-user token helpers ---

function loadUserTokens(athleteId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(TOKENS_DIR, `${athleteId}.json`), 'utf8'));
  } catch { return null; }
}

function saveUserTokens(athleteId, data) {
  fs.writeFileSync(path.join(TOKENS_DIR, `${athleteId}.json`), JSON.stringify(data, null, 2));
}

function getAllUserIds() {
  try {
    return fs.readdirSync(TOKENS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch { return []; }
}

// --- Vanity URL helpers ---

function loadVanity() {
  try { return JSON.parse(fs.readFileSync(VANITY_PATH, 'utf8')); } catch { return {}; }
}

function saveVanity(map) {
  fs.writeFileSync(VANITY_PATH, JSON.stringify(map, null, 2));
}

function assignVanity(athleteId, firstname) {
  const map = loadVanity();
  // Already has a vanity name
  if (Object.values(map).includes(String(athleteId))) return;
  // Limit reached
  if (Object.keys(map).length >= VANITY_LIMIT) return;

  let name = firstname.toLowerCase().replace(/[^a-z]/g, '');
  if (!name) return;

  // Handle collisions by appending a number
  let candidate = name;
  let i = 2;
  while (map[candidate]) {
    candidate = name + i;
    i++;
  }

  map[candidate] = String(athleteId);
  saveVanity(map);
  console.log(`Vanity URL assigned: /${candidate} -> ${athleteId}`);
}

function resolveVanity(name) {
  const map = loadVanity();
  return map[name] || null;
}

// --- Token refresh ---

async function getAccessToken(athleteId) {
  const tokenData = loadUserTokens(athleteId);
  if (!tokenData) return null;

  const now = Math.floor(Date.now() / 1000);
  if (tokenData.expires_at > now) return tokenData.access_token;

  try {
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: tokenData.refresh_token,
      grant_type: 'refresh_token',
    });
    const updated = { ...tokenData, ...response.data };
    saveUserTokens(athleteId, updated);
    return updated.access_token;
  } catch (err) {
    console.error(`Token refresh failed for ${athleteId}:`, err.response?.data || err.message);
    return null;
  }
}

// --- Region clustering ---

function haversineKm(lat1, lng1, lat2, lng2) {
  const dlat = (lat2 - lat1) * Math.PI / 180;
  const dlng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dlng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getRideMidpoint(feature) {
  const coords = feature.geometry.coordinates;
  const mid = coords[Math.floor(coords.length / 2)];
  return { lng: mid[0], lat: mid[1] };
}

// Hierarchical agglomerative clustering with recursive splitting.
// First separates major geographic groups (e.g., US vs Japan vs Europe),
// then recursively splits large groups into sub-regions.
function clusterRides(features) {
  const points = features.map((f, i) => ({ ...getRideMidpoint(f), idx: i }));
  if (points.length === 0) return [];

  function clusterDist(a, b) {
    return haversineKm(a.lat, a.lng, b.lat, b.lng);
  }

  function centroid(pts) {
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    return { lat, lng };
  }

  // Run hierarchical clustering on a set of points, returning the merge history
  function hierarchicalCluster(pts) {
    let clusters = pts.map(p => ({ points: [p], ...centroid([p]) }));
    const merges = [];

    while (clusters.length > 1) {
      let minDist = Infinity, minI = 0, minJ = 1;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const d = clusterDist(clusters[i], clusters[j]);
          if (d < minDist) { minDist = d; minI = i; minJ = j; }
        }
      }
      const merged = {
        points: [...clusters[minI].points, ...clusters[minJ].points],
        ...centroid([...clusters[minI].points, ...clusters[minJ].points]),
      };
      merges.push({ dist: minDist, clusterCount: clusters.length });
      clusters[minI] = merged;
      clusters.splice(minJ, 1);
    }
    return merges;
  }

  // Find natural cuts: significant jumps in merge distance
  function findCutCount(merges) {
    if (merges.length < 2) return 1;

    // Collect all jumps (ratio of consecutive merge distances)
    const jumps = [];
    for (let i = 1; i < merges.length; i++) {
      const ratio = merges[i].dist / (merges[i - 1].dist || 1);
      jumps.push({ ratio, clusterCount: merges[i].clusterCount });
    }

    // Find the biggest jump that yields a reasonable number of clusters
    jumps.sort((a, b) => b.ratio - a.ratio);
    for (const j of jumps) {
      if (j.ratio > 2.0 && j.clusterCount <= 10 && j.clusterCount >= 2) {
        return j.clusterCount;
      }
    }
    return 1;
  }

  // Build clusters stopping at targetCount
  function buildClusters(pts, targetCount) {
    let clusters = pts.map(p => ({ points: [p], ...centroid([p]) }));
    while (clusters.length > targetCount) {
      let minDist = Infinity, minI = 0, minJ = 1;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const d = clusterDist(clusters[i], clusters[j]);
          if (d < minDist) { minDist = d; minI = i; minJ = j; }
        }
      }
      const merged = {
        points: [...clusters[minI].points, ...clusters[minJ].points],
        ...centroid([...clusters[minI].points, ...clusters[minJ].points]),
      };
      clusters[minI] = merged;
      clusters.splice(minJ, 1);
    }
    return clusters;
  }

  // First pass: find top-level groups
  const topMerges = hierarchicalCluster(points);
  const topCount = findCutCount(topMerges);
  let result = buildClusters(points, topCount);

  // Second pass: recursively split any cluster that has its own natural sub-groups
  // This handles "United States" being split into Bay Area, Seattle, Tahoe, etc.
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const cluster of result) {
      if (cluster.points.length < 4) { next.push(cluster); continue; }

      const subMerges = hierarchicalCluster(cluster.points);
      const subCount = findCutCount(subMerges);
      if (subCount > 1) {
        const subs = buildClusters(cluster.points, subCount);
        next.push(...subs);
        changed = true;
      } else {
        next.push(cluster);
      }
    }
    result = next;
    // Safety: don't exceed 10 total clusters
    if (result.length >= 10) break;
  }

  return result;
}

// Reverse geocode at a granularity appropriate to the cluster's geographic spread.
async function reverseGeocode(lat, lng, spreadKm) {
  const baseParams = { access_token: process.env.MAPBOX_TOKEN, language: 'en', limit: 1 };
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`;

  // Pick the right geographic level based on cluster spread
  let types;
  if (spreadKm > 500) types = 'country';
  else if (spreadKm > 50) types = 'region';
  else types = 'place';

  try {
    const { data } = await axios.get(url, { params: { ...baseParams, types } });
    if (data.features && data.features.length > 0) return data.features[0].text;

    // Fallback to broader type
    const fallback = types === 'place' ? 'region' : types === 'region' ? 'country' : null;
    if (fallback) {
      const { data: fb } = await axios.get(url, { params: { ...baseParams, types: fallback } });
      if (fb.features && fb.features.length > 0) return fb.features[0].text;
    }
  } catch (e) {
    console.warn('Reverse geocode failed:', e.message);
  }
  return null;
}

function clusterSpreadKm(cluster) {
  let maxDist = 0;
  for (let i = 0; i < cluster.points.length; i++) {
    for (let j = i + 1; j < cluster.points.length; j++) {
      const d = haversineKm(cluster.points[i].lat, cluster.points[i].lng, cluster.points[j].lat, cluster.points[j].lng);
      if (d > maxDist) maxDist = d;
    }
  }
  return maxDist;
}

async function computeRegions(features) {
  if (features.length === 0) return [];

  const clusters = clusterRides(features);

  // Sort by count descending, take top 10, require at least 2 rides
  clusters.sort((a, b) => b.points.length - a.points.length);
  const topClusters = clusters.slice(0, 10).filter(c => c.points.length >= 2);

  const regions = [];
  for (const cluster of topClusters) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const p of cluster.points) {
      minLng = Math.min(minLng, p.lng);
      minLat = Math.min(minLat, p.lat);
      maxLng = Math.max(maxLng, p.lng);
      maxLat = Math.max(maxLat, p.lat);
    }

    const spreadKm = clusterSpreadKm(cluster);
    const name = await reverseGeocode(cluster.lat, cluster.lng, spreadKm);
    if (!name) continue;

    // Skip duplicate names
    if (regions.some(r => r.name === name)) continue;

    const padLng = Math.max((maxLng - minLng) * 0.1, 0.05);
    const padLat = Math.max((maxLat - minLat) * 0.1, 0.05);

    regions.push({
      name,
      bounds: [[minLng - padLng, minLat - padLat], [maxLng + padLng, maxLat + padLat]],
      count: cluster.points.length,
    });
  }

  return regions;
}

// --- Data fetching ---

async function refreshRideData(athleteId) {
  const token = await getAccessToken(athleteId);
  if (!token) {
    console.log(`Refresh skipped for ${athleteId}: not authenticated`);
    return;
  }

  const userDataDir = path.join(DATA_DIR, String(athleteId));
  fs.mkdirSync(userDataDir, { recursive: true });

  try {
    // Fetch profile
    const { data: profile } = await axios.get('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${token}` },
    });
    fs.writeFileSync(path.join(userDataDir, 'profile.json'), JSON.stringify(profile, null, 2));

    // Fetch all activities using summary polylines
    let page = 1;
    const features = [];

    while (true) {
      const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: `Bearer ${token}` },
        params: { per_page: 200, page },
      });

      console.log(`[${athleteId}] page ${page}, ${data.length} activities`);

      for (const a of data) {
        if ((a.type === 'Ride' || a.sport_type === 'Ride') && a.map?.summary_polyline) {
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
            geometry: polyline.toGeoJSON(a.map.summary_polyline),
          });
        }
      }

      if (data.length < 200) break;
      page++;
    }

    const geojson = { type: 'FeatureCollection', features };
    fs.writeFileSync(path.join(userDataDir, 'rides.json'), JSON.stringify(geojson));

    // Compute regions by clustering ride midpoints
    const regions = await computeRegions(features);
    fs.writeFileSync(path.join(userDataDir, 'regions.json'), JSON.stringify(regions));

    console.log(`[${athleteId}] Refreshed: ${features.length} rides, ${regions.length} regions`);
  } catch (err) {
    console.error(`[${athleteId}] Refresh failed:`, err.response?.data || err.message);
  }
}

async function refreshAllUsers() {
  const userIds = getAllUserIds();
  console.log(`Daily refresh: ${userIds.length} user(s)`);
  for (const id of userIds) {
    await refreshRideData(id);
  }
}

// --- Legacy migration ---

function migrateLegacyData() {
  const legacyTokensPath = path.join(__dirname, '.tokens.json');
  if (!fs.existsSync(legacyTokensPath)) return;

  try {
    const legacy = JSON.parse(fs.readFileSync(legacyTokensPath, 'utf8'));
    const athleteId = legacy.athlete?.id;
    if (!athleteId) return;

    const newTokenPath = path.join(TOKENS_DIR, `${athleteId}.json`);
    if (!fs.existsSync(newTokenPath)) {
      saveUserTokens(athleteId, legacy);
    }

    const userDataDir = path.join(DATA_DIR, String(athleteId));
    fs.mkdirSync(userDataDir, { recursive: true });

    const oldRides = path.join(DATA_DIR, 'rides.json');
    const oldProfile = path.join(DATA_DIR, 'profile.json');
    if (fs.existsSync(oldRides) && !fs.existsSync(path.join(userDataDir, 'rides.json'))) {
      fs.renameSync(oldRides, path.join(userDataDir, 'rides.json'));
    }
    if (fs.existsSync(oldProfile) && !fs.existsSync(path.join(userDataDir, 'profile.json'))) {
      fs.renameSync(oldProfile, path.join(userDataDir, 'profile.json'));
    }

    // Assign vanity URL for legacy user
    if (legacy.athlete?.firstname) {
      assignVanity(athleteId, legacy.athlete.firstname);
    }
    console.log(`Migrated legacy data for athlete ${athleteId}`);
  } catch (e) {
    console.warn('Legacy migration failed:', e.message);
  }
}

// --- Schedule daily refresh at midnight PST ---

function scheduleMidnightRefresh() {
  const now = new Date();
  // PST is UTC-8, PDT is UTC-7. Use America/Los_Angeles for correct offset.
  const pstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const midnight = new Date(pstNow);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);

  // Convert back to local time for setTimeout
  const msUntilMidnight = midnight.getTime() - pstNow.getTime();
  console.log(`Next refresh in ${Math.round(msUntilMidnight / 60000)} minutes (midnight PST)`);

  setTimeout(() => {
    refreshAllUsers();
    // Then repeat every 24 hours
    setInterval(refreshAllUsers, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// --- Routes ---

app.use(express.json());

// Explicit page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));

// Redirect user to Strava OAuth
app.get('/auth/strava', (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&approval_prompt=force&scope=read,activity:read`;
  res.redirect(authUrl);
});

// OAuth callback — exchange code for tokens, redirect to user page
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
    const response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const athlete = response.data.athlete;
    const athleteId = athlete.id;
    saveUserTokens(athleteId, response.data);

    // Assign vanity URL for first 10 users
    assignVanity(athleteId, athlete.firstname);

    // Write profile from OAuth response
    const userDataDir = path.join(DATA_DIR, String(athleteId));
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'profile.json'), JSON.stringify(athlete, null, 2));

    // Fetch ride data in the background
    refreshRideData(athleteId);

    // Redirect to vanity URL if available, otherwise athlete ID
    const vanity = loadVanity();
    const vanityName = Object.entries(vanity).find(([, id]) => id === String(athleteId));
    res.redirect(vanityName ? `/${vanityName[0]}` : `/${athleteId}`);
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Authentication failed');
  }
});

// Serve Mapbox token dynamically (config.js is gitignored)
app.get('/config.js', (req, res) => {
  res.type('js').send(`const MAPBOX_TOKEN = '${process.env.MAPBOX_TOKEN}';`);
});

// Serve per-user data files from storage directory
app.use('/data', express.static(DATA_DIR));

// Static file serving (favicon, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Dynamic user map page — must come after static routes
app.get('/:id', (req, res, next) => {
  let athleteId = req.params.id;

  // Check if it's a vanity name
  if (!/^\d+$/.test(athleteId)) {
    const resolved = resolveVanity(athleteId.toLowerCase());
    if (!resolved) return next();
    athleteId = resolved;
  }

  const userDataDir = path.join(DATA_DIR, athleteId);
  if (!fs.existsSync(path.join(userDataDir, 'profile.json'))) return res.redirect('/');

  // Read map.html and inject the athlete ID so vanity URLs work
  let html = fs.readFileSync(path.join(__dirname, 'public', 'map.html'), 'utf8');
  html = html.replace(
    "const ATHLETE_ID = window.location.pathname.replace(/^\\//, '').replace(/\\/$/, '');",
    `const ATHLETE_ID = '${athleteId}';`
  );
  res.type('html').send(html);
});

// --- Start ---

app.listen(PORT, () => {
  console.log(`ridesometime running at http://localhost:${PORT}`);

  migrateLegacyData();
  scheduleMidnightRefresh();
});
