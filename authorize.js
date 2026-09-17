require('dotenv').config({ quiet: true });

const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const axios = require('axios');
const readline = require('node:readline/promises');

const port = Number(process.env.AUTH_PORT || 3000);
const redirectUri = process.env.STRAVA_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
const tokenPath = path.join(__dirname, '.tokens.json');
const scope = 'read,activity:read';

if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
  throw new Error('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env first.');
}

const app = express();

async function exchangeCode(code) {
  const { data } = await axios.post('https://www.strava.com/oauth/token', {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    code,
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
}

function authorizationUrl() {
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id', process.env.STRAVA_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('approval_prompt', 'force');
  url.searchParams.set('scope', scope);
  return url.toString();
}

app.get('/auth/strava', (req, res) => {
  res.redirect(authorizationUrl());
});

app.get('/auth/callback', async (req, res) => {
  if (!req.query.code) return res.status(400).send('Missing authorization code.');
  try {
    await exchangeCode(req.query.code);
    res.send('Authorization complete. You can close this tab and stop the terminal command.');
  } catch (err) {
    console.error(`Authorization failed: ${err.response?.data?.message || err.message}`);
    res.status(500).send('Authorization failed. Check the terminal for details.');
  }
});

app.get('/', (req, res) => res.type('text').send(`Open /auth/strava to begin Strava authorization.\nCallback: ${redirectUri}\n`));

if (process.argv.includes('--manual')) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Open this URL in your browser:\n${authorizationUrl()}`);
  input.question('After approval, paste the full redirect URL or code here: ').then(async value => {
    input.close();
    const match = value.match(/[?&]code=([^&]+)/);
    const code = decodeURIComponent(match ? match[1] : value.trim());
    try { await exchangeCode(code); }
    catch (err) { console.error(`Authorization failed: ${err.response?.data?.message || err.message}`); process.exitCode = 1; }
  });
} else {
  const server = app.listen(port, () => {
    console.log(`Strava authorization server running at http://localhost:${port}`);
    console.log(`Open http://localhost:${port}/auth/strava in your browser.`);
    console.log(`Authorization URL: ${authorizationUrl()}`);
    console.log(`Callback must be registered in Strava as ${redirectUri}`);
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Stop the other local server first.`);
    else console.error(`Authorization server failed: ${err.message}`);
    process.exitCode = 1;
  });
}
