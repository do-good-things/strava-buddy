require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, '.tokens.json');

async function getAccessToken() {
  let tokenData;
  try {
    tokenData = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch {
    throw new Error('No .tokens.json found. Run fetch-rides.js first to authenticate.');
  }

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

async function main() {
  const TOKEN = await getAccessToken();
  let page = 1;
  let allRides = [];

  while (true) {
    const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${TOKEN}` },
      params: { per_page: 200, page },
    });

    console.log(`Page ${page}: ${data.length} activities`);
    const rides = data.filter(a => a.type === 'Ride' || a.sport_type === 'Ride');
    allRides.push(...rides);

    if (data.length < 200) break;
    page++;
  }

  console.log(`\nTotal rides found: ${allRides.length}`);
  allRides.sort((a, b) => b.distance - a.distance);

  const fmt = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  console.log('\n=== TOP 5 LONGEST RIDES ===\n');
  allRides.slice(0, 5).forEach((r, i) => {
    const date = new Date(r.start_date_local).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    console.log(`${i + 1}. ${r.name}`);
    console.log(`   ${date}`);
    console.log(`   ${(r.distance / 1609.34).toFixed(1)} mi | ${fmt(r.moving_time)} | ${Math.round(r.total_elevation_gain * 3.281)} ft elev`);
    console.log('');
  });
}

main().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
