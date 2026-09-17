require('dotenv').config({ quiet: true });

const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const axios = require('axios');

const port = Number(process.env.AUTH_PORT || 3000);
const redirectUri = process.env.STRAVA_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
const tokenPath = path.join(__dirname, '.tokens.json');
const scope = 'read,activity:read';

if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
  throw new Error('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env first.');
}

const app = express();

app.get('/auth/strava', (req, res) => {
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id', process.env.STRAVA_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('approval_prompt', 'force');
  url.searchParams.set('scope', scope);
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  if (!req.query.code) return res.status(400).send('Missing authorization code.');
  try {
    const { data } = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code: req.query.code,
      grant_type: 'authorization_code',
    }, { timeout: 30000 });
    if (!data.access_token || !data.refresh_token || !Number.isFinite(data.expires_at)) {
      throw new Error('Strava returned an incomplete token response.');
    }
    await fs.writeFile(tokenPath, JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    }, null, 2), { mode: 0o600 });
    console.log(`Authorization saved to ${tokenPath}`);
    console.log(`Granted scope: ${data.scope || scope}`);
    res.send('Authorization complete. You can close this tab and stop the terminal command.');
  } catch (err) {
    console.error(`Authorization failed: ${err.response?.data?.message || err.message}`);
    res.status(500).send('Authorization failed. Check the terminal for details.');
  }
});

app.get('/', (req, res) => res.redirect('/auth/strava'));

app.listen(port, () => {
  console.log(`Strava authorization server running at http://localhost:${port}`);
  console.log(`Open http://localhost:${port}/auth/strava in your browser.`);
  console.log(`Callback must be registered in Strava as ${redirectUri}`);
});
