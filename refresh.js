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
const DATA_DIR = path.join(__dirname, 'public', 'sarah', 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const TOKENS_PATH = path.join(__dirname, '.tokens.json');
const GEOCACHE_PATH = path.join(__dirname, '.geocache.json');

const BOUNDS_PADDING = 0.15;

// A region is named at the broadest administrative level that still describes it
// tightly. Grouping starts at country level and descends (country -> state ->
// county) only while a group is too geographically spread out for one name to be
// honest. So Japan's rides stay "Japan", while the US has to split into states.
const MAX_REGION_SPAN_KM = 500;
const ADMIN_LEVELS = ['country', 'region', 'district'];

// Curated geographies no geocoder can express, because they span counties, states,
// or national borders. These take precedence over administrative naming.
// Entries with `districts` are matched first, so a specific metro wins over the
// broader region containing it.
// Add one when the automatic name comes out too narrow (a 3,000-person town
// standing in for all of Puget Sound) or when it splits somewhere you think of as
// a single ride destination.
const MACRO_REGIONS = [
  {
    name: 'Bay Area',
    country: 'United States', regions: ['California'],
    districts: ['Marin County', 'San Francisco County', 'San Mateo County',
      'Santa Clara County', 'Alameda County', 'Contra Costa County',
      'Sonoma County', 'Napa County', 'Solano County', 'Santa Cruz County'],
  },
  {
    name: 'Tahoe',
    country: 'United States', regions: ['California', 'Nevada'],
    districts: ['Nevada County', 'Placer County', 'El Dorado County',
      'Sierra County', 'Plumas County', 'Washoe County', 'Douglas County',
      'Carson City'],
  },
  {
    name: 'Southern California',
    country: 'United States', regions: ['California'],
    districts: ['San Diego County', 'Los Angeles County', 'Orange County',
      'Santa Barbara County', 'Ventura County', 'Riverside County',
      'San Bernardino County', 'Imperial County'],
  },
  {
    name: 'Outer Banks',
    country: 'United States', regions: ['North Carolina'],
    districts: ['Dare County', 'Currituck County', 'Hyde County', 'Carteret County'],
  },
  // Straddles the US/Canada border, so it matches on state/province alone.
  { name: 'Pacific Northwest', regions: ['Washington', 'Oregon', 'British Columbia'] },
  { name: 'Mid-Atlantic', regions: ['Virginia', 'Maryland', 'Delaware', 'District of Columbia'] },
];

// Last-resort rename of an already-resolved label. Prefer MACRO_REGIONS above: it
// describes a real geography, so it keeps working as new rides land inside it,
// whereas an entry here only patches one name after the fact.
const NAME_OVERRIDES = {};

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

async function downloadPhoto(url, destPath) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(destPath, res.data);
}

async function fetchActivityPhotos(activityId, token) {
  const { data } = await axios.get(`https://www.strava.com/api/v3/activities/${activityId}/photos`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { size: 1024, photo_sources: true },
  });
  const activityDir = path.join(PHOTOS_DIR, String(activityId));
  fs.mkdirSync(activityDir, { recursive: true });
  const saved = [];
  for (let i = 0; i < data.length; i++) {
    const photo = data[i];
    const url = photo.urls?.['1024'] || photo.urls?.[Object.keys(photo.urls || {})[0]];
    if (!url) continue;
    const filename = `${i}.jpg`;
    const destPath = path.join(activityDir, filename);
    if (!fs.existsSync(destPath)) await downloadPhoto(url, destPath);
    saved.push(`photos/${activityId}/${filename}`);
  }
  return saved;
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
        let photos = [];
        if ((a.total_photo_count || 0) > 0) {
          try {
            photos = await fetchActivityPhotos(a.id, token);
          } catch (err) {
            console.warn(`  Photos failed for ${a.id}: ${err.response?.status || err.message}`);
          }
        }
        features.push({
          type: 'Feature',
          properties: {
            name: a.name,
            date: a.start_date_local,
            distance: a.distance,
            moving_time: a.moving_time,
            elapsed_time: a.elapsed_time,
            elevation_gain: a.total_elevation_gain,
            photos,
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

// --- Region generation ---

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

// Greatest distance between any two rides in a group.
function groupSpanKm(points) {
  let span = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      span = Math.max(span, haversineKm(points[i][0], points[i][1], points[j][0], points[j][1]));
    }
  }
  return span;
}

// Reverse geocoding is cached on disk by rounded coordinate, so each refresh only
// pays for ground the map has not covered before.
let geocache = {};
try { geocache = JSON.parse(fs.readFileSync(GEOCACHE_PATH, 'utf8')); } catch { /* no cache yet */ }

async function lookupAdmin(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (geocache[key]) return geocache[key];

  const token = process.env.MAPBOX_TOKEN;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?types=place,district,region,country&access_token=${encodeURIComponent(token)}`;
  try {
    const { data } = await axios.get(url);
    const admin = {};
    for (const f of data.features || []) {
      const type = (f.place_type || [])[0];
      if (type && !admin[type]) admin[type] = f.text;
      // Broader areas containing this feature arrive as context entries.
      for (const c of f.context || []) {
        const ctype = (c.id || '').split('.')[0];
        if (!admin[ctype]) admin[ctype] = c.text;
      }
    }
    geocache[key] = admin;
    return admin;
  } catch (err) {
    console.warn(`  Warning: reverse geocode failed for (${lat}, ${lng}): ${err.message}`);
    return {};
  }
}

const MACROS_BY_PRECEDENCE = [...MACRO_REGIONS]
  .sort((a, b) => (b.districts ? 1 : 0) - (a.districts ? 1 : 0));

function matchMacroRegion(admin) {
  for (const macro of MACROS_BY_PRECEDENCE) {
    if (macro.country && admin.country !== macro.country) continue;
    if (macro.regions && !macro.regions.includes(admin.region)) continue;
    if (macro.districts && !macro.districts.includes(admin.district)) continue;
    return macro.name;
  }
  return null;
}

// Descend country -> state -> county, stopping as soon as a group is compact
// enough that a single name honestly covers it.
//
// The home country is always descended past: "Japan" is a useful label for a trip
// abroad, but riding at home reads as "Alaska" or "Tahoe", never "United States".
function splitByAdmin(members, level, homeCountry) {
  const field = ADMIN_LEVELS[level];
  const groups = new Map();
  for (const m of members) {
    const key = m.admin[field] || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const out = [];
  for (const [name, group] of groups) {
    const atLastLevel = level === ADMIN_LEVELS.length - 1;
    const isHomeCountry = field === 'country' && name === homeCountry;
    const compact = groupSpanKm(group.map(m => m.point)) <= MAX_REGION_SPAN_KM;
    if (atLastLevel || (compact && !isHomeCountry)) {
      out.push({ name, members: group });
    } else {
      out.push(...splitByAdmin(group, level + 1, homeCountry));
    }
  }
  return out;
}

// Whichever country holds the most rides.
function findHomeCountry(members) {
  const tally = new Map();
  for (const m of members) {
    if (!m.admin.country) continue;
    tally.set(m.admin.country, (tally.get(m.admin.country) || 0) + 1);
  }
  let home = null, best = 0;
  for (const [country, n] of tally) if (n > best) { home = country; best = n; }
  return home;
}

async function generateRegions(rideFeatures) {
  const members = [];
  for (const feature of rideFeatures) {
    const point = getRideMidpoint(feature);
    const admin = await lookupAdmin(point[0], point[1]);
    members.push({ point, admin, macro: matchMacroRegion(admin) });
  }
  fs.writeFileSync(GEOCACHE_PATH, JSON.stringify(geocache));

  const named = new Map();
  const addTo = (name, member) => {
    if (!named.has(name)) named.set(name, []);
    named.get(name).push(member);
  };

  for (const m of members) if (m.macro) addTo(m.macro, m);

  const unmatched = members.filter(m => !m.macro);
  if (unmatched.length) {
    const homeCountry = findHomeCountry(members);
    for (const group of splitByAdmin(unmatched, 0, homeCountry)) {
      const name = NAME_OVERRIDES[group.name] || group.name;
      for (const m of group.members) addTo(name, m);
    }
  }

  const regions = [...named.entries()]
    .map(([name, ms]) => {
      const lats = ms.map(m => m.point[0]);
      const lngs = ms.map(m => m.point[1]);
      return {
        name,
        bounds: [
          [+(Math.min(...lngs) - BOUNDS_PADDING).toFixed(4), +(Math.min(...lats) - BOUNDS_PADDING).toFixed(4)],
          [+(Math.max(...lngs) + BOUNDS_PADDING).toFixed(4), +(Math.max(...lats) + BOUNDS_PADDING).toFixed(4)],
        ],
        count: ms.length,
      };
    })
    .sort((a, b) => b.count - a.count);

  console.log(`\n${regions.length} region(s) from ${rideFeatures.length} rides:\n`);
  for (const r of regions) console.log(`  ${r.name}: ${r.count} ride(s)`);

  return regions;
}

// --- Main pipeline ---

async function refresh() {
  const token = await getAccessToken();
  if (!token) {
    console.log('Not authenticated. Visit http://localhost:3000/auth/strava');
    return;
  }

  fs.mkdirSync(PHOTOS_DIR, { recursive: true });

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
