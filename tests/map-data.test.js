const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { gunzipSync, brotliDecompressSync } = require('node:zlib');
const polyline = require('@mapbox/polyline');
const { packMapData, createMapDataCache } = require('../lib/map-data');

const fixture = coordinates => ({ type: 'Feature', properties: { name: 'Ride', date: '2026-09-18' }, geometry: { type: 'LineString', coordinates } });
const collection = features => ({ type: 'FeatureCollection', features });

test('the compact payload preserves every production coordinate and ride property', async () => {
  const dir = path.join(__dirname, '../public/sarah/data');
  const [rides, ebikes, regions] = await Promise.all(['rides.json', 'ebike-rides.json', 'regions.json']
    .map(async file => JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))));
  const before = JSON.stringify([rides, ebikes, regions]);
  const packed = packMapData(rides, ebikes, regions);
  assert.equal(packed.rides.generated_at, rides.generated_at);
  assert.deepEqual(packed.regions, regions);
  const original = [...rides.features, ...ebikes.features];
  assert.equal(packed.rides.features.length, original.length);
  packed.rides.features.forEach((feature, i) => {
    const parts = feature.geometry.polylines.map(encoded => polyline.toGeoJSON(encoded).coordinates);
    assert.deepEqual(feature.geometry.type === 'LineString' ? parts[0] : parts, original[i].geometry.coordinates);
    assert.deepEqual(feature.properties, { ...original[i].properties, ...(i >= rides.features.length ? { ebike: true } : {}) });
  });
  assert.equal(JSON.stringify([rides, ebikes, regions]), before, 'source data is not mutated');
});

test('multipart routes and e-bike flags survive transport', () => {
  const feature = fixture([]);
  feature.geometry = { type: 'MultiLineString', coordinates: [[[179.12345, -33.54321], [179.12346, -33.54322]], [[-122.12345, 37.12345], [-122.12346, 37.12346]]] };
  const packed = packMapData(collection([]), collection([feature]), []);
  const ride = packed.rides.features[0];
  assert.equal(ride.properties.ebike, true);
  assert.deepEqual(ride.geometry.polylines.map(encoded => polyline.toGeoJSON(encoded).coordinates), feature.geometry.coordinates);
});

test('cache shares work, supports both compression formats, and refreshes after data changes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strava-map-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const rides = collection([fixture([[-122, 37], [-122.1, 37.1]])]);
  await Promise.all([
    fs.writeFile(path.join(dir, 'rides.json'), JSON.stringify(rides)),
    fs.writeFile(path.join(dir, 'ebike-rides.json'), JSON.stringify(collection([]))),
    fs.writeFile(path.join(dir, 'regions.json'), '[]'),
  ]);
  const getData = createMapDataCache(dir);
  const [first, concurrent] = await Promise.all([getData(), getData()]);
  assert.equal(first, concurrent);
  assert.equal(first, await getData());
  assert.deepEqual(gunzipSync(first.bodies.gzip), first.bodies.identity);
  assert.deepEqual(brotliDecompressSync(first.bodies.br), first.bodies.identity);
  rides.features[0].properties.name = 'Updated ride name';
  await fs.writeFile(path.join(dir, 'rides.json'), JSON.stringify(rides));
  const second = await getData();
  assert.notEqual(second.etag, first.etag);
  assert.equal(JSON.parse(second.bodies.identity).rides.features[0].properties.name, 'Updated ride name');
});

test('a failed refresh can recover on the next request', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strava-map-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await Promise.all(['rides.json', 'ebike-rides.json', 'regions.json'].map(file => fs.writeFile(path.join(dir, file), '{')));
  const getData = createMapDataCache(dir);
  await assert.rejects(getData());
  await Promise.all([
    fs.writeFile(path.join(dir, 'rides.json'), JSON.stringify(collection([]))),
    fs.writeFile(path.join(dir, 'ebike-rides.json'), JSON.stringify(collection([]))),
    fs.writeFile(path.join(dir, 'regions.json'), '[]'),
  ]);
  assert.equal(JSON.parse((await getData()).bodies.identity).rides.features.length, 0);
});
