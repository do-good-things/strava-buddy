const { readJson, writeJson } = require('./storage');
const { syncRides } = require('./refresh-rides');
const { syncPhotos } = require('./photos');
const { MAX_AGE, fresh, buildSnapshot } = require('./public-data');

async function pruneExpired({ privateStore, publicStore, now = Date.now }) {
  let state = await readJson(privateStore, 'state.json') || { version: 1, features: [] };
  if (state.version !== 1 || !Array.isArray(state.features)) throw new Error('Invalid private refresh state');
  // Remove expired private entries even if this run later fails upstream.
  state.features = state.features.filter(f => fresh(f.properties.detail_fetched_at, now()));
  for (const f of state.features) f.properties.photos = (f.properties.photos || []).filter(p => fresh(p.fetched_at, now()));
  await writeJson(privateStore, 'state.json', state);
  for (const object of await publicStore.list('photos/')) {
    if (now() - object.modified >= MAX_AGE) await publicStore.delete(object.key);
  }
  const oldSnapshot = await readJson(publicStore, 'current.json');
  if (oldSnapshot && Date.parse(oldSnapshot.expires_at) <= now()) await publicStore.delete('current.json');

  return state;
}

async function runRefresh({ privateStore, publicStore, read, generateRegions, download, full = false, now = Date.now, log = () => {} }) {
  log(`Refresh started (${full ? 'full' : 'incremental'} mode).`);
  const state = await pruneExpired({ privateStore, publicStore, now });
  log(`Loaded ${state.features.length} cached route(s).`);
  const cached = new Map(state.features.map(f => [f.properties.strava_id, f]));
  const checkpoint = () => writeJson(privateStore, 'state.json', { version: 1, features: [...cached.values()] });

  try {
    const result = await syncRides({
      read, existing: state.features, full, now,
      onList: async ids => {
        log(`Strava summary scan found ${ids.length} public ride(s).`);
        const present = new Set(ids);
        for (const id of cached.keys()) if (!present.has(id)) cached.delete(id);
        await checkpoint();
      },
      onFeature: async feature => {
        cached.set(feature.properties.strava_id, feature);
        await checkpoint(); // Save expensive detailed routes before photo downloads.
        log(`Route checkpoint saved for activity ${feature.properties.strava_id}; syncing photos.`);
        feature.properties.photos = await syncPhotos(feature, { read, store: publicStore, download, now, log });
        await checkpoint();
      },
      log,
    });
    const features = [...result.rides, ...result.ebikeRides];
    log(`Routes and photos complete: ${features.length} ride(s). Generating regions.`);
    const regions = await generateRegions(features);
    log(`Generated ${regions.length} region(s). Publishing snapshot.`);
    const snapshot = buildSnapshot(features, regions, now());
    // One atomic object replacement is the publication boundary. A failed job
    // never switches the web service to a partial new dataset.
    await writeJson(publicStore, 'current.json', snapshot);
    await writeJson(privateStore, 'state.json', { version: 1, features });
    const keep = new Set(features.flatMap(f => f.properties.photos.map(p => `photos/${p.key}.jpg`)));
    for (const object of await publicStore.list('photos/')) if (!keep.has(object.key)) await publicStore.delete(object.key);
    await writeJson(privateStore, 'status.json', { last_success: new Date(now()).toISOString(), result: 'success' });
    log(`Snapshot published successfully with ${features.length} ride(s).`);
    return result;
  } catch (err) {
    await writeJson(privateStore, 'status.json', { last_failure: new Date(now()).toISOString(), result: 'failed' });
    throw err;
  }
}
module.exports = { runRefresh, pruneExpired };
