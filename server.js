require('dotenv').config();
const express = require('express');
const path = require('path');
const { createMapDataCache } = require('./lib/map-data');

const app = express();
const PORT = process.env.PORT || 3000;
const getMapData = createMapDataCache(path.join(__dirname, 'public', 'sarah', 'data'));

// Serve the installed browser-compatible codec; no extra CDN dependency.
app.get('/sarah/js/polyline.js', (req, res) => {
  res.sendFile(require.resolve('@mapbox/polyline'));
});

app.get('/sarah/data/map-rides.json', async (req, res, next) => {
  try {
    const data = await getMapData();
    const encoding = req.acceptsEncodings('br', 'gzip', 'identity');
    if (!encoding) return res.sendStatus(406);
    res.type('json');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('ETag', data.etag);
    res.vary('Accept-Encoding');
    if (encoding !== 'identity') res.set('Content-Encoding', encoding);
    res.send(data.bodies[encoding]);
  } catch (error) {
    next(error);
  }
});

// Serve Mapbox token to the frontend
app.get('/sarah/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`const MAPBOX_TOKEN = ${JSON.stringify(process.env.MAPBOX_TOKEN)};`);
});

// Browsers request /favicon.ico by name whatever the page declares. Without
// this the catch-all below answers with the landing page HTML, which they
// discard, so the tab keeps whatever icon it had cached.
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

// Block direct access to profile.json (contains PII)
app.get('/sarah/data/profile.json', (req, res) => res.status(404).end());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Redirect 404s to home
app.use((req, res) => {
  res.redirect('/');
});

if (require.main === module) {
  // Do the encoding once before accepting traffic, rather than on the first
  // visitor's request. The cache also notices data updates from refresh.js.
  getMapData().then(() => {
    app.listen(PORT, () => {
      console.log(`ridesometime running at http://localhost:${PORT}`);
    });
  }).catch(error => {
    console.error('Unable to prepare map data:', error);
    process.exitCode = 1;
  });
}

module.exports = app;
