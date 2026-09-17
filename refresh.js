if (require.main === module) require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const axios = require('axios');
const { LocalStore, publishedStore } = require('./lib/storage');
const { accessToken } = require('./lib/auth');
const { createReader } = require('./lib/refresh-rides');
const { createRegionGenerator } = require('./lib/regions');
const { downloadPhoto } = require('./lib/photos');
const { runRefresh, pruneExpired } = require('./lib/refresh-job');

async function main(env = process.env) {
  if (process.argv.slice(2).some(arg => arg !== '--full')) throw new Error('Usage: node refresh.js [--full]');
  if (env.RAILWAY_ENVIRONMENT_ID && !env.PRIVATE_DATA_DIR) throw new Error('Set PRIVATE_DATA_DIR to the worker volume mount path.');
  const directory = path.resolve(env.PRIVATE_DATA_DIR || path.join(__dirname, '.runtime', 'private'));
  const store = new LocalStore(directory);
  const published = publishedStore(env);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, 'refresh.lock');
  // A crashed process can leave a lock. Jobs are capped at two hours; stale
  // locks older than three hours are safe to recover on the next daily run.
  try { if (Date.now() - (await fs.stat(lockPath)).mtimeMs > 3 * 3600000) await fs.unlink(lockPath); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (err) { if (err.code === 'EEXIST') throw new Error('Another refresh is running.'); throw err; }
  const timeout = setTimeout(() => {
    console.error('Refresh exceeded its two-hour limit; exiting so the next scheduled run can proceed.');
    process.exit(1);
  }, 2 * 3600000);
  try {
    // Local-only convenience: import credentials without printing their values.
    if (!env.RAILWAY_ENVIRONMENT_ID && !await store.get('tokens.json')) {
      try {
        const tokens = JSON.parse(await fs.readFile(path.join(__dirname, '.tokens.json'), 'utf8'));
        await store.put('tokens.json', JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: tokens.expires_at }));
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    await pruneExpired({ privateStore: store, publicStore: published });
    const run = token => runRefresh({
      privateStore: store, publicStore: published, read: createReader(axios, token),
      generateRegions: createRegionGenerator(axios, env.MAPBOX_TOKEN),
      download: url => downloadPhoto(axios, url), full: process.argv.includes('--full'),
    });
    let token = await accessToken({ store, axios, env });
    let result;
    try {
      result = await run(token);
    } catch (err) {
      // Strava access tokens can be revoked before their recorded expiry. Rotate
      // once on a 401, then retry using the persisted refresh token.
      if (!/Strava request failed \(401\)/.test(err.message)) throw err;
      token = await accessToken({ store, axios, env, force: true });
      result = await run(token);
    }
    console.log(`Published ${result.rides.length + result.ebikeRides.length} rides: ${result.reused} cached routes, ${result.fetched} fetched.`);
  } finally {
    clearTimeout(timeout);
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}
if (require.main === module) main().catch(err => {
  // Avoid printing Axios/S3 error objects or request URLs containing secrets.
  console.error(`Refresh failed: ${err.name === 'Error' ? err.message : err.name}`);
  process.exitCode = 1;
});
module.exports = { main };
