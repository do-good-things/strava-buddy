require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const polyline = require('@mapbox/polyline');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'public', 'data');
const TOKENS_DIR = path.join(__dirname, '.tokens');

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
    console.log(`[${athleteId}] Refreshed: ${features.length} rides saved`);
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
app.get('/about-us', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));

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

    const athleteId = response.data.athlete.id;
    saveUserTokens(athleteId, response.data);

    // Write profile from OAuth response
    const userDataDir = path.join(DATA_DIR, String(athleteId));
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'profile.json'), JSON.stringify(response.data.athlete, null, 2));

    // Fetch ride data in the background
    refreshRideData(athleteId);

    res.redirect(`/${athleteId}`);
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Authentication failed');
  }
});

// Static file serving (data files, config.js, favicon, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Dynamic user map page — must come after static routes
app.get('/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  res.sendFile(path.join(__dirname, 'public', 'map.html'));
});

// --- Start ---

app.listen(PORT, () => {
  console.log(`ridesometime running at http://localhost:${PORT}`);

  migrateLegacyData();
  scheduleMidnightRefresh();
});
