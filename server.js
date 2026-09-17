if (require.main === module) require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('node:path');
const { publishedStore, readJson } = require('./lib/storage');
const { snapshotAvailable, clientSnapshot } = require('./lib/public-data');

function createApp({ store = publishedStore(), now = Date.now, mapboxToken = process.env.MAPBOX_TOKEN } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  const snapshot = async () => {
    const data = await readJson(store, 'current.json');
    return snapshotAvailable(data, now()) ? data : null;
  };
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { const ready = !!await snapshot(); res.status(ready ? 200 : 503).json({ ready }); }
    catch { res.status(503).json({ ready: false }); }
  });
  app.get('/sarah/config.js', (req, res) => {
    res.set('Cache-Control', 'no-store').type('application/javascript');
    res.send(`const MAPBOX_TOKEN = ${JSON.stringify(mapboxToken || '')};`);
  });
  app.get('/sarah/map.json', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const data = await snapshot();
      if (!data) return res.status(503).json({ error: 'The map is temporarily unavailable while it refreshes.' });
      res.json(clientSnapshot(data));
    } catch { res.status(503).json({ error: 'The map is temporarily unavailable.' }); }
  });
  app.get('/sarah/photos/:file', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (!/^[a-f0-9-]{36}\.jpg$/.test(req.params.file)) return res.status(404).end();
    try {
      const data = await snapshot();
      const url = `/sarah/photos/${req.params.file}`;
      if (!data || !clientSnapshot(data).rides.features.some(f => f.properties.photos.includes(url))) return res.status(404).end();
      const bytes = await store.get(`photos/${req.params.file}`);
      if (!bytes) return res.status(404).end();
      res.type('jpeg').send(bytes);
    } catch { res.status(503).end(); }
  });
  // Never expose the old raw ride/profile files, even on an older deployment
  // image or a workstation that still has them. Only allowlisted assets exist.
  app.use('/sarah/data', (req, res) => res.status(404).end());
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
  for (const [route, file] of [
    ['/', 'index.html'], ['/index.html', 'index.html'],
    ['/sarah', 'sarah/index.html'], ['/sarah/', 'sarah/index.html'], ['/sarah/index.html', 'sarah/index.html'],
    ['/sarah/js/app.js', 'sarah/js/app.js'], ['/sarah/css/styles.css', 'sarah/css/styles.css'], ['/favicon.svg', 'favicon.svg'],
  ]) app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
  app.use((req, res) => res.status(404).end());
  return app;
}
if (require.main === module) createApp().listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('ridesometime web server started'));
module.exports = { createApp };
