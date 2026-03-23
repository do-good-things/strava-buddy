require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const polyline = require('@mapbox/polyline');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'public', 'data');
const TOKENS_PATH = path.join(__dirname, '.tokens.json');
const REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour

// Load saved tokens on startup
let tokenData = null;
try {
  tokenData = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  console.log('Loaded saved tokens');
} catch { /* no saved tokens */ }

app.use(express.json());

// Redirect user to Strava OAuth
app.get('/auth/strava', (req, res) => {
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${process.env.STRAVA_CLIENT_ID}&response_type=code&redirect_uri=http://localhost:${PORT}/auth/callback&approval_prompt=force&scope=read,activity:read`;
  res.redirect(authUrl);
});

// OAuth callback — exchange code for tokens
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
    res.redirect('/');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Authentication failed');
  }
});

// Refresh the access token if expired
async function getAccessToken() {
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
    tokenData = { ...tokenData, ...response.data };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));
    return tokenData.access_token;
  } catch (err) {
    console.error('Token refresh failed:', err.response?.data || err.message);
    return null;
  }
}

// Fetch all rides and write static JSON files
async function refreshRideData() {
  const token = await getAccessToken();
  if (!token) {
    console.log('Refresh skipped: not authenticated');
    return;
  }

  try {
    // Fetch profile
    const { data: profile } = await axios.get('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${token}` },
    });
    fs.writeFileSync(path.join(DATA_DIR, 'profile.json'), JSON.stringify(profile, null, 2));

    // Fetch all activities, collect ride IDs
    let page = 1;
    const rides = [];

    while (true) {
      const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: `Bearer ${token}` },
        params: { per_page: 200, page },
      });

      console.log(`Refresh: page ${page}, ${data.length} activities`);

      for (const a of data) {
        if ((a.type === 'Ride' || a.sport_type === 'Ride') && a.map?.summary_polyline) {
          rides.push(a);
        }
      }

      if (data.length < 200) break;
      page++;
    }

    console.log(`Found ${rides.length} rides, fetching detailed polylines...`);

    // Fetch detailed polyline for each ride
    const features = [];
    for (let i = 0; i < rides.length; i++) {
      const a = rides[i];
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
        if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${rides.length} detailed polylines fetched`);
      } catch (err) {
        console.warn(`  Skipped activity ${a.id}: ${err.response?.status || err.message}`);
      }
    }

    const geojson = { type: 'FeatureCollection', features };
    fs.writeFileSync(path.join(DATA_DIR, 'rides.json'), JSON.stringify(geojson));
    console.log(`Refreshed: ${features.length} rides saved at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('Refresh failed:', err.response?.data || err.message);
  }
}

// Check auth status
app.get('/api/status', (req, res) => {
  res.json({ authenticated: !!tokenData });
});

// Serve static files after API routes
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Strava Buddy running at http://localhost:${PORT}`);
  console.log(`Auto-refresh every ${REFRESH_INTERVAL / 60000} minutes`);

  // Refresh on startup only if data files are missing
  const ridesExist = fs.existsSync(path.join(DATA_DIR, 'rides.json'));
  if (!ridesExist) {
    console.log('No ride data found, fetching now...');
    refreshRideData();
  }

  // Schedule hourly refresh
  setInterval(refreshRideData, REFRESH_INTERVAL);
});
