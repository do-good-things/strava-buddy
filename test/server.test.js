const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server');
const { buildSnapshot } = require('../lib/public-data');

// Exercise Express's real routing and response serialization without binding a
// port or reading local credentials/athlete files.
async function request(app, url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    const req = new http.IncomingMessage(socket);
    req.method = 'GET'; req.url = url; req.headers = { host: 'localhost' }; req.httpVersionMajor = 1; req.httpVersionMinor = 1;
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: raw.slice(raw.indexOf('\r\n\r\n') + 4) });
    });
    res.on('error', reject);
    app(req, res);
  });
}
function fixture() {
  const now = Date.now();
  const key = randomUUID();
  const snapshot = buildSnapshot([{ geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] }, properties: {
    name: 'Synthetic ride', distance: 1609.344, moving_time: 120, elapsed_time: 140,
    detail_fetched_at: new Date(now).toISOString(), strava_id: 999,
    photos: [{ key, fetched_at: new Date(now).toISOString() }],
  } }], [], now);
  const objects = new Map([['current.json', Buffer.from(JSON.stringify(snapshot))], [`photos/${key}.jpg`, Buffer.from('image')]]);
  const app = createApp({ store: { get: async key => objects.get(key) || null }, now: () => now, mapboxToken: 'synthetic-public-token' });
  return { app, key, objects, snapshot, now };
}

test('map endpoint returns only allowlisted fields and never caches them', async () => {
  const { app } = fixture();
  const res = await request(app, '/sarah/map.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body.rides.features[0].properties).sort(), ['elapsed_time', 'mileage', 'name', 'photos', 'riding_time']);
  assert.doesNotMatch(res.body, /strava_id|detail_fetched_at|999/);
});

test('raw data, legacy photos, credentials and arbitrary bucket keys are inaccessible', async () => {
  const { app } = fixture();
  for (const url of ['/sarah/data/rides.json', '/sarah/data/profile.json', '/sarah/data/ebike-rides.json', '/sarah/data/photos/999/0.jpg', '/.tokens.json', '/.env', '/state.json', '/current.json', '/sarah/../.runtime/private/tokens.json']) {
    assert.equal((await request(app, url)).status, 404, url);
  }
});

test('only photos referenced by the current unexpired snapshot are served', async () => {
  const { app, key, objects } = fixture();
  assert.equal((await request(app, `/sarah/photos/${key}.jpg`)).status, 200);
  const unlisted = randomUUID();
  objects.set(`photos/${unlisted}.jpg`, Buffer.from('orphan'));
  assert.equal((await request(app, `/sarah/photos/${unlisted}.jpg`)).status, 404);
  assert.equal((await request(app, '/sarah/photos/../../tokens.json')).status, 404);
});

test('expired snapshot is unavailable, including its photos; health remains up', async () => {
  const { snapshot, now, key } = fixture();
  const app = createApp({ store: { get: async () => Buffer.from(JSON.stringify(snapshot)) }, now: () => now + 37 * 3600000 });
  assert.equal((await request(app, '/sarah/map.json')).status, 503);
  assert.equal((await request(app, `/sarah/photos/${key}.jpg`)).status, 404);
  assert.equal((await request(app, '/readyz')).status, 503);
  assert.equal((await request(app, '/healthz')).status, 200);
});

test('storage failure returns a generic error without credentials or internal paths', async () => {
  const app = createApp({ store: { get: async () => { throw new Error('secret-key /private/path'); } } });
  const res = await request(app, '/sarah/map.json');
  assert.equal(res.status, 503);
  assert.doesNotMatch(res.body, /secret|private/);
});
