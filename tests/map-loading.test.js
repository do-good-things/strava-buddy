const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const polyline = require('@mapbox/polyline');
const { packMapData } = require('../lib/map-data');

const source = fs.readFileSync(path.join(__dirname, '../public/sarah/js/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  let resolveFetch, map;
  const status = { hidden: false, textContent: 'Loading rides…' };
  const regions = { appendChild() {} };
  class TestMap {
    constructor() { this.events = new Map(); this.sources = new Map(); map = this; }
    on(name, handler) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(handler); }
    once(name, handler) { this.on(name, handler); }
    off() {}
    emit(name) { (this.events.get(name) || []).forEach(handler => handler()); }
    addControl() {}
    getStyle() { return { layers: [] }; }
    addSource(name, source) { this.sources.set(name, source); }
    addLayer() {}
    isSourceLoaded(name) { return this.sources.has(name); }
  }
  const context = vm.createContext({
    window: { innerWidth: 390, addEventListener() {} },
    document: {
      getElementById(id) { return id === 'map-status' ? status : id === 'regions' ? regions : null; },
      querySelector() { return null; },
      createElement() { return { addEventListener() {} }; },
      addEventListener() {},
    },
    fetch() { return new Promise(resolve => { resolveFetch = resolve; }); },
    mapboxgl: { Map: TestMap }, MapboxGeocoder: class {}, MAPBOX_TOKEN: 'test', polyline,
    console: { error() {} },
  });
  vm.runInContext(source, context);
  const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-122, 37], [-122.001, 37.001]] }, properties: { date: '2026-09-18', distance: 100 } };
  const data = packMapData({ type: 'FeatureCollection', features: [feature] }, { features: [] }, []);
  return { map, status, context, resolveFetch, data };
}

for (const first of ['map', 'rides']) {
  test(`base map starts before download completes and routes load when ${first} finishes first`, async () => {
    const env = setup();
    assert.ok(env.map, 'the Map is created while the fetch is still pending');
    assert.equal(env.map.sources.size, 0);
    if (first === 'map') env.map.emit('load');
    env.resolveFetch({ ok: true, json: async () => env.data });
    await tick();
    if (first === 'rides') {
      assert.equal(env.map.sources.size, 0, 'sources wait for style readiness');
      env.map.emit('load');
      await tick();
    }
    const routes = env.map.sources.get('rides');
    assert.ok(routes);
    assert.equal(routes.data.features[0].id, 0, 'overlap chooser indexes remain stable');
    assert.equal(routes.data.features[0].geometry.coordinates.length, 2);
    assert.equal(env.status.hidden, true);
  });
}

test('a failed route download leaves the base map available and explains the failure', async () => {
  const env = setup();
  env.resolveFetch({ ok: false, status: 503 });
  await tick();
  assert.ok(env.map);
  assert.match(env.status.textContent, /couldn’t load/);
  assert.equal(env.status.hidden, false);
});
