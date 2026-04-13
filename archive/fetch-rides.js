// Local script to fetch ride data from Strava and write static JSON files.
// Usage:
//   1. Create a .env file with STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET
//   2. Run: node fetch-rides.js
//   3. Visit http://localhost:3000/auth/strava to authenticate (first time only)
//   4. Rides will be fetched and saved to public/data/

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const polyline = require('@mapbox/polyline');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'public', 'data');
const TOKENS_PATH = path.join(__dirname, '.tokens.json');

let tokenData = null;
try {
  tokenData = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  console.log('Loaded saved tokens');
} catch { /* no saved tokens */ }

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
    console.log('Authenticated! Fetching rides...');
    await fetchRides();
    res.send('Done! Rides fetched and saved. You can close this tab.');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Authentication failed');
  }
});

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

async function fetchRides() {
  const token = await getAccessToken();
  if (!token) {
    console.log('Not authenticated. Visit http://localhost:3000/auth/strava');
    return;
  }

  // Fetch profile
  const { data: profile } = await axios.get('https://www.strava.com/api/v3/athlete', {
    headers: { Authorization: `Bearer ${token}` },
  });
  fs.writeFileSync(path.join(DATA_DIR, 'profile.json'), JSON.stringify(profile, null, 2));
  console.log('Profile saved.');

  // Fetch all activities
  let page = 1;
  const rides = [];

  while (true) {
    const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${token}` },
      params: { per_page: 200, page },
    });

    console.log(`Page ${page}: ${data.length} activities`);

    for (const a of data) {
      if ((a.type === 'Ride' || a.sport_type === 'Ride') && a.map?.summary_polyline) {
        rides.push(a);
      }
    }

    if (data.length < 200) break;
    page++;
  }

  console.log(`Found ${rides.length} rides, fetching detailed polylines...`);

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
  console.log(`Done: ${features.length} rides saved to public/data/rides.json`);
  process.exit(0);
}

const server = app.listen(PORT, async () => {
  console.log(`Fetch server running at http://localhost:${PORT}`);

  if (tokenData) {
    console.log('Tokens found, fetching rides...');
    await fetchRides();
  } else {
    console.log('No tokens found. Visit http://localhost:3000/auth/strava to authenticate.');
  }
});
