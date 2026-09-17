const { readJson, writeJson } = require('./storage');

async function accessToken({ store, axios, env = process.env, now = Date.now }) {
  let tokens = await readJson(store, 'tokens.json');
  // Bootstrap once. From then on use the rotated token in persistent storage.
  if (!tokens && env.STRAVA_REFRESH_TOKEN) tokens = { refresh_token: env.STRAVA_REFRESH_TOKEN };
  if (!tokens?.refresh_token) throw new Error('Missing Strava authorization. Seed tokens.json or set STRAVA_REFRESH_TOKEN on the worker.');
  if (tokens.access_token && tokens.expires_at > Math.floor(now() / 1000) + 60) return tokens.access_token;
  let response;
  try {
    response = await axios.post('https://www.strava.com/oauth/token', {
      client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: tokens.refresh_token, grant_type: 'refresh_token',
    }, { timeout: 30000 });
  } catch (err) { throw new Error(`Strava authorization failed (${err.response?.status || 'network error'}).`); }
  const next = response.data;
  if (!next?.access_token || !next.refresh_token || !Number.isFinite(next.expires_at)) throw new Error('Invalid Strava token response');
  await writeJson(store, 'tokens.json', { access_token: next.access_token, refresh_token: next.refresh_token, expires_at: next.expires_at });
  return next.access_token;
}
module.exports = { accessToken };
