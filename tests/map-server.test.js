const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const app = require('../server');

test('map endpoint negotiates compression, caches responses, and keeps private profile blocked', async t => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/sarah/data/map-rides.json`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.match(response.headers.get('cache-control'), /max-age=300/);
  assert.match(response.headers.get('vary'), /Accept-Encoding/);
  const data = await response.json();
  assert.equal(data.format, 'polyline5');
  assert.ok(data.rides.features.length > 0);
  assert.equal('profile' in data, false);
  // Node fetch adds Cache-Control: no-cache to conditional requests; use HTTP
  // directly to exercise an ordinary browser cache revalidation instead.
  const cachedStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/sarah/data/map-rides.json`, { headers: { 'If-None-Match': response.headers.get('etag') } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(cachedStatus, 304);
  const identity = await fetch(`${base}/sarah/data/map-rides.json`, { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(identity.headers.get('content-encoding'), null);
  assert.deepEqual(await identity.json(), data);
  const br = await fetch(`${base}/sarah/data/map-rides.json`, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(br.headers.get('content-encoding'), 'br');
  assert.deepEqual(await br.json(), data);
  assert.equal((await fetch(`${base}/sarah/data/profile.json`)).status, 404);
  const codec = await fetch(`${base}/sarah/js/polyline.js`);
  assert.equal(codec.status, 200);
  assert.match(await codec.text(), /polyline.toGeoJSON/);
});
