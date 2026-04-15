require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve Mapbox token to the frontend
app.get('/sarah/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`const MAPBOX_TOKEN = ${JSON.stringify(process.env.MAPBOX_TOKEN)};`);
});

// Block direct access to profile.json (contains PII)
app.get('/sarah/data/profile.json', (req, res) => res.status(404).end());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Redirect 404s to home
app.use((req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`ridesometime running at http://localhost:${PORT}`);
});
