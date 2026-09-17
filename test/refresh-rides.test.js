const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncRides, createReader } = require('../lib/refresh-rides');

const route = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const activity = (id, overrides = {}) => ({
  id, name: `Synthetic ride ${id}`, start_date_local: '2026-01-01T10:00:00Z',
  distance: 1000, moving_time: 120, elapsed_time: 150, total_elevation_gain: 10,
  type: 'Ride', sport_type: 'Ride', visibility: 'everyone', map: { summary_polyline: route }, ...overrides,
});
function api(activities, { fail } = {}) {
  const calls = [];
  const read = async (endpoint, params) => {
    calls.push(endpoint);
    if (fail?.(endpoint, params)) throw new Error('Synthetic API failure');
    if (endpoint === '/athlete') return { id: 1 };
    if (endpoint === '/athlete/activities') return activities.slice((params.page - 1) * 200, params.page * 200);
    const a = activities.find(a => endpoint === `/activities/${a.id}`);
    return { ...a, map: { polyline: route } };
  };
  return { read, calls };
}
async function saved(activities) {
  const result = await syncRides({ read: api(activities).read });
  return [...result.rides, ...result.ebikeRides];
}

test('unchanged refresh uses no detail requests; includes both ride types', async () => {
  const activities = [activity(1), activity(2, { type: 'EBikeRide', sport_type: 'EBikeRide' })];
  const existing = await saved(activities);
  const mock = api(activities);
  const result = await syncRides({ read: mock.read, existing });
  assert.deepEqual(mock.calls, ['/athlete/activities']);
  assert.equal(result.reused, 2);
  assert.equal(result.rides.length, 1);
  assert.equal(result.ebikeRides.length, 1);
});

test('fetches only changed and new rides, including older uploads', async () => {
  const existing = await saved([activity(1), activity(2)]);
  const mock = api([activity(1), activity(2, { name: 'Edited' }), activity(3, { start_date_local: '2020-01-01T10:00:00Z' })]);
  const result = await syncRides({ read: mock.read, existing });
  assert.equal(result.fetched, 2);
  assert.deepEqual(mock.calls, ['/athlete/activities', '/activities/2', '/activities/3']);
  assert.equal(result.rides[1].properties.name, 'Edited');
});

test('removes deleted, private, followers-only and no-longer-ride activities', async () => {
  const existing = await saved([1, 2, 3, 4, 5].map(id => activity(id)));
  const result = await syncRides({ existing, read: api([
    activity(1), activity(2, { private: true }),
    activity(3, { visibility: 'followers_only' }), activity(4, { type: 'Run', sport_type: 'Run' }),
  ]).read });
  assert.deepEqual(result.rides.map(f => f.properties.strava_id), [1]);
});

test('ride-to-ebike changes move the feature without duplicating it', async () => {
  const existing = await saved([activity(1)]);
  const result = await syncRides({ existing, read: api([activity(1, { type: 'EBikeRide', sport_type: 'EBikeRide' })]).read });
  assert.equal(result.rides.length, 0);
  assert.equal(result.ebikeRides.length, 1);
});

test('legacy migration reuses only unambiguous exact matches, then saves IDs', async () => {
  const activities = [activity(1), activity(2, { name: 'Same' }), activity(3, { name: 'Same' })];
  const existing = await saved(activities);
  for (const f of existing) { delete f.properties.strava_id; delete f.properties.summary_hash; }
  const result = await syncRides({ existing, read: api(activities).read });
  assert.equal(result.migrated, 1);
  assert.equal(result.fetched, 2);
  assert.deepEqual(result.rides.map(f => f.properties.strava_id), [1, 2, 3]);
});

test('full refresh bypasses both ID and legacy caches', async () => {
  const existing = await saved([activity(1), activity(2)]);
  delete existing[1].properties.strava_id;
  const result = await syncRides({ existing, full: true, read: api([activity(1), activity(2)]).read });
  assert.equal(result.fetched, 2);
  assert.equal(result.reused, 0);
});

test('scans every summary page and deduplicates IDs', async () => {
  const activities = Array.from({ length: 201 }, (_, i) => activity(i + 1));
  activities[200] = activities[0];
  const mock = api(activities);
  const result = await syncRides({ read: mock.read });
  assert.equal(mock.calls.filter(c => c === '/athlete/activities').length, 2);
  assert.equal(result.rides.length, 200);
});

test('transient errors retry, but authentication and rate limits stop safely', async () => {
  let requests = 0;
  const delays = [];
  const read = createReader({ get: async () => {
    if (++requests < 3) throw { response: { status: 503 } };
    return { data: 'ok', headers: {} };
  } }, 'synthetic', { sleep: async ms => delays.push(ms) });
  assert.equal(await read('/athlete'), 'ok');
  assert.deepEqual(delays, [1000, 2000]);
  for (const status of [401, 429]) {
    let count = 0;
    const reader = createReader({ get: async () => { count++; throw { response: { status, headers: { 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '1,1000' } } }; } }, 'synthetic');
    await assert.rejects(reader('/athlete'), status === 429 ? /rate limit/ : /401/);
    assert.equal(count, 1);
  }
});

test('daily quota headers stop before issuing another request', async () => {
  let count = 0;
  const read = createReader({ get: async () => {
    count++;
    return { data: [], headers: { 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '1,1000' } };
  } }, 'synthetic');
  await read('/athlete/activities');
  await assert.rejects(read('/activities/1'), /quota exhausted/);
  assert.equal(count, 1);
});

test('short quota exhaustion waits until the next quarter-hour and resumes', async () => {
  let count = 0;
  const delays = [];
  const read = createReader({ get: async () => ({ data: ++count, headers: {
    'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '100,100',
  } }) }, 'synthetic', { now: () => 890000, sleep: async ms => delays.push(ms), log: () => {} });
  await read('/athlete');
  assert.equal(await read('/athlete/activities'), 2);
  assert.deepEqual(delays, [11000]);
});

test('429 short-term limit retries without hammering the API', async () => {
  let count = 0;
  const delays = [];
  const read = createReader({ get: async () => {
    if (++count === 1) throw { response: { status: 429 } };
    return { data: 'ok' };
  } }, 'synthetic', { now: () => 890000, sleep: async ms => delays.push(ms), log: () => {} });
  assert.equal(await read('/athlete'), 'ok');
  assert.deepEqual(delays, [11000]);
});

test('a changed summary polyline triggers a new detailed route', async () => {
  const existing = await saved([activity(1)]);
  const result = await syncRides({ existing, read: api([activity(1, { map: { summary_polyline: `${route}??` } })]).read });
  assert.equal(result.fetched, 1);
});

