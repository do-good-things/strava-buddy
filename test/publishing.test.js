const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { buildSnapshot, clientSnapshot, publicFeature, DAY, snapshotAvailable } = require('../lib/public-data');
const { runRefresh } = require('../lib/refresh-job');
const { syncPhotos, stripMetadata, imageUrl } = require('../lib/photos');
const { accessToken } = require('../lib/auth');
const { syncRides } = require('../lib/refresh-rides');
const { readJson, writeJson } = require('../lib/storage');

const time = Date.parse('2026-09-17T10:00:00Z');
const now = () => time;
const iso = new Date(time).toISOString();
const route = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const activity = (id, other = {}) => ({ id, name: `Synthetic ride ${id}`, type: 'Ride', sport_type: 'Ride',
  start_date_local: '2020-01-01T10:00:00Z', visibility: 'everyone', total_photo_count: 0,
  distance: 1609.344, moving_time: 100, elapsed_time: 120, total_elevation_gain: 40,
  map: { summary_polyline: route }, ...other });
class MemoryStore {
  constructor() { this.objects = new Map(); }
  async get(key) { return this.objects.get(key)?.body || null; }
  async put(key, value) { this.objects.set(key, { body: Buffer.from(value), modified: time }); }
  async delete(key) { this.objects.delete(key); }
  async list(prefix = '') { return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, v]) => ({ key, modified: v.modified })); }
}
function mockApi(activities, failure = () => false) {
  const calls = [];
  const read = async (endpoint, params) => {
    calls.push(endpoint);
    if (failure(endpoint, params)) throw new Error('synthetic failure');
    if (endpoint === '/athlete/activities') return activities.slice((params.page - 1) * 200, params.page * 200);
    if (endpoint.endsWith('/photos')) return [{ unique_id: 'secret-photo-id', urls: { 1024: 'https://images.cloudfront.net/synthetic.jpg' } }];
    const a = activities.find(a => endpoint === `/activities/${a.id}`);
    return { ...a, map: { polyline: route } };
  };
  return { read, calls };
}
function options(activities) {
  return { privateStore: new MemoryStore(), publicStore: new MemoryStore(), read: mockApi(activities).read,
    generateRegions: async () => [], download: async () => Buffer.from('synthetic image'), now };
}

test('published ride contains exactly the approved fields, with 2D geometry and anonymous photo links', () => {
  const key = randomUUID();
  const feature = { id: 123, bbox: ['private'], geometry: { type: 'LineString', coordinates: [[1, 2, 99], [3, 4, 88]], secret: true }, properties: {
    name: 'Synthetic', distance: 1609.344, moving_time: 100, elapsed_time: 120,
    date: 'private', strava_id: 123, elevation_gain: 999, summary_hash: 'private', detail_fetched_at: iso,
    photos: [{ key, source: 'private url hash', fetched_at: iso }],
  } };
  const snapshot = buildSnapshot([feature], [], time);
  // Defense in depth: accidental extra properties at the publication boundary
  // must still not leave the web endpoint.
  snapshot.rides.features[0].properties.secret = 'leak';
  snapshot.rides.features[0].id = 123;
  const publicData = clientSnapshot(snapshot);
  const f = publicData.rides.features[0];
  assert.deepEqual(Object.keys(f.properties).sort(), ['elapsed_time', 'mileage', 'name', 'photos', 'riding_time']);
  assert.deepEqual(Object.keys(f).sort(), ['geometry', 'properties', 'type']);
  assert.equal(f.properties.mileage, 1);
  assert.deepEqual(f.geometry.coordinates, [[1, 2], [3, 4]]);
  assert.deepEqual(f.properties.photos, [`/sarah/photos/${key}.jpg`]);
  assert.doesNotMatch(JSON.stringify(publicData), /private|strava_id|elevation|summary_hash|secret/);
});

test('cache expires, and a snapshot cannot extend its oldest included route or photo', () => {
  const feature = { geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] }, properties: {
    name: 'old', detail_fetched_at: new Date(time - 6.9 * DAY).toISOString(),
  } };
  const snapshot = buildSnapshot([feature], [], time);
  assert.equal(Date.parse(snapshot.expires_at), time + 0.1 * DAY);
  assert.equal(snapshotAvailable(snapshot, time + DAY), false);
  assert.equal(publicFeature(feature, time + DAY), null);
});

test('six-day-old details are fetched even when their summaries match', async () => {
  const activities = [activity(1)];
  const first = await syncRides({ read: mockApi(activities).read, now: () => time - 6 * DAY });
  const next = await syncRides({ read: mockApi(activities).read, existing: first.rides, now });
  assert.equal(next.fetched, 1);
});

test('old data with no trustworthy fetch timestamp cannot be grandfathered into a fresh cache', async () => {
  const first = await syncRides({ read: mockApi([activity(1)]).read, now });
  delete first.rides[0].properties.detail_fetched_at;
  const next = await syncRides({ read: mockApi([activity(1)]).read, existing: first.rides, now });
  assert.equal(next.fetched, 1);
});

test('daily photo list catches replacements with unchanged photo counts', async () => {
  const store = new MemoryStore();
  let url = 'https://images.cloudfront.net/one.jpg', downloads = 0;
  const feature = { properties: { strava_id: 1, photo_count: 1, photos: [] } };
  const opts = { store, read: async () => [{ unique_id: 'same', urls: { 1024: url } }], download: async () => { downloads++; return Buffer.from('image'); }, now };
  feature.properties.photos = await syncPhotos(feature, opts);
  const oldKey = feature.properties.photos[0].key;
  feature.properties.photos = await syncPhotos(feature, opts);
  assert.equal(downloads, 1);
  url = 'https://images.cloudfront.net/two.jpg';
  feature.properties.photos = await syncPhotos(feature, opts);
  assert.equal(downloads, 2);
  assert.notEqual(feature.properties.photos[0].key, oldKey);
  const removed = await syncPhotos(feature, { ...opts, read: async () => [] });
  assert.deepEqual(removed, []);
});

test('photos are downloaded again at six days, even when URLs are unchanged', async () => {
  const store = new MemoryStore();
  const feature = { properties: { strava_id: 1, photo_count: 1, photos: [] } };
  const opts = { store, read: async () => [{ urls: { 1024: 'https://images.cloudfront.net/one.jpg' } }], download: async () => Buffer.from('image') };
  feature.properties.photos = await syncPhotos(feature, { ...opts, now: () => time - 6 * DAY });
  const old = feature.properties.photos[0].key;
  const photos = await syncPhotos(feature, { ...opts, now });
  assert.notEqual(photos[0].key, old);
});

test('photo transformation removes EXIF and other embedded metadata', async () => {
  const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff1493' } })
    .withExif({ IFD0: { Artist: 'Private owner', ImageDescription: 'Private location' } }).jpeg().toBuffer();
  assert.ok((await sharp(source).metadata()).exif);
  const output = await stripMetadata(source);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.iptc, undefined);
  assert.equal(metadata.format, 'jpeg');
});

test('photo downloads reject private network addresses and non-HTTPS URLs', () => {
  for (const url of ['http://images.cloudfront.net/a', 'https://127.0.0.1/a', 'https://cloudfront.net.attacker.test/a', 'https://user:pass@images.cloudfront.net/a']) assert.throws(() => imageUrl(url));
});

for (const stage of ['page2', 'detail', 'photos', 'regions', 'publish']) {
  test(`${stage} failure preserves the previously published complete snapshot`, async () => {
    const activities = stage === 'page2' ? Array.from({ length: 201 }, (_, i) => activity(i + 1)) : [activity(1, { total_photo_count: 1 })];
    const opts = options(activities);
    const previous = { version: 1, generated_at: iso, expires_at: new Date(time + DAY).toISOString(), rides: { features: [] } };
    await writeJson(opts.publicStore, 'current.json', previous);
    const before = await opts.publicStore.get('current.json');
    opts.read = mockApi(activities, (endpoint, params) => stage === 'page2' && params.page === 2
      || stage === 'detail' && endpoint === '/activities/1'
      || stage === 'photos' && endpoint.endsWith('/photos')).read;
    if (stage === 'regions') opts.generateRegions = async () => { throw new Error('geocoding failed'); };
    if (stage === 'publish') {
      const put = opts.publicStore.put.bind(opts.publicStore);
      opts.publicStore.put = (key, value) => { if (key === 'current.json') throw new Error('publish failed'); return put(key, value); };
    }
    await assert.rejects(runRefresh(opts));
    assert.deepEqual(await opts.publicStore.get('current.json'), before);
  });
}

test('failed photo download saves detail checkpoint so retry does not refetch it', async () => {
  const opts = options([activity(1, { total_photo_count: 1 })]);
  opts.download = async () => { throw new Error('image failure'); };
  await assert.rejects(runRefresh(opts));
  const mock = mockApi([activity(1, { total_photo_count: 1 })]);
  opts.read = mock.read;
  opts.download = async () => Buffer.from('image');
  await runRefresh(opts);
  assert.ok(!mock.calls.includes('/activities/1'));
  assert.equal((await readJson(opts.publicStore, 'current.json')).rides.features.length, 1);
});

test('successful removal deletes obsolete published photos and private state', async () => {
  const opts = options([activity(1, { total_photo_count: 1 })]);
  await runRefresh(opts);
  assert.equal((await opts.publicStore.list('photos/')).length, 1);
  opts.read = mockApi([]).read;
  await runRefresh(opts);
  assert.equal((await opts.publicStore.list('photos/')).length, 0);
  assert.equal((await readJson(opts.privateStore, 'state.json')).features.length, 0);
});

test('token rotation persists only required token fields and uses saved tokens on later runs', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const axios = { post: async (url, body) => {
    calls++;
    assert.ok(['bootstrap', 'rotated'].includes(body.refresh_token));
    return { data: { access_token: 'new', refresh_token: 'rotated', expires_at: time / 1000 + 3600, athlete: { private: true } } };
  } };
  const env = { STRAVA_REFRESH_TOKEN: 'bootstrap' };
  assert.equal(await accessToken({ store, axios, env, now }), 'new');
  assert.deepEqual(Object.keys(await readJson(store, 'tokens.json')).sort(), ['access_token', 'expires_at', 'refresh_token']);
  assert.equal(await accessToken({ store, axios, env, now }), 'new');
  assert.equal(calls, 1);
  assert.equal(await accessToken({ store, axios, env, now, force: true }), 'new');
  assert.equal(calls, 2);
});

module.exports = { MemoryStore };
