let REGIONS = [];
const HOME = { center: [-122.52, 37.82], zoom: window.innerWidth <= 600 ? 10 : 11 };
const LINE_COLOR = '#ff1493';
const NO_MATCH = ['==', ['id'], -1];

let map, geojson, activeRegion = null, selectedId = null;

// Split a LineString into MultiLineString when consecutive points are > maxGapKm apart
function splitGaps(coords, maxGapKm = 5) {
  if (coords.length < 2) return [coords];
  const segments = [];
  let seg = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1], [lng2, lat2] = coords[i];
    const dlat = (lat2 - lat1) * Math.PI / 180, dlng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dlng / 2) ** 2;
    const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (km > maxGapKm) {
      if (seg.length >= 2) segments.push(seg);
      seg = [coords[i]];
    } else {
      seg.push(coords[i]);
    }
  }
  if (seg.length >= 2) segments.push(seg);
  return segments;
}

async function init() {
  const [ridesRes, ebikeRes, regionsRes] = await Promise.all([
    fetch('/sarah/data/rides.json'),
    fetch('/sarah/data/ebike-rides.json'),
    fetch('/sarah/data/regions.json')
  ]);
  if (!ridesRes.ok) { console.error('Failed to load ride data'); return; }
  geojson = await ridesRes.json();
  if (ebikeRes.ok) {
    const ebike = await ebikeRes.json();
    ebike.features.forEach(f => { f.properties.ebike = true; });
    geojson.features.push(...ebike.features);
  }
  if (regionsRes.ok) REGIONS = await regionsRes.json();

  refreshStats();

  // Split rides at large GPS gaps to avoid long straight lines over water/pauses
  geojson.features.forEach(f => {
    if (f.geometry.type === 'LineString') {
      const segments = splitGaps(f.geometry.coordinates);
      if (segments.length > 1) {
        f.geometry = { type: 'MultiLineString', coordinates: segments };
      } else if (segments.length === 1) {
        f.geometry.coordinates = segments[0];
      } else {
        f.geometry.coordinates = [];
      }
    }
  });

  // Tag rides with region + age
  const dates = geojson.features.map(f => new Date(f.properties.date).getTime());
  const minDate = Math.min(...dates), dateRange = Math.max(...dates) - minDate || 1;
  geojson.features.forEach((f, i) => {
    f.id = i;
    const allCoords = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates;
    const [lng, lat] = allCoords[Math.floor(allCoords.length / 2)] || [0, 0];
    f.properties.region = (REGIONS.find(r => {
      const [[minLng, minLat], [maxLng, maxLat]] = r.bounds;
      return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
    }) || { name: 'other' }).name;
    f.properties.age = (new Date(f.properties.date).getTime() - minDate) / dateRange;
  });

  // Count rides per region
  const counts = {};
  geojson.features.forEach(f => { counts[f.properties.region] = (counts[f.properties.region] || 0) + 1; });

  // Build tabs
  const regionsEl = document.getElementById('regions');
  addTab(regionsEl, 'all', geojson.features.length, (btn) => {
    setActiveTab(btn);
    activeRegion = null;
    selectedId = null;
    hideRideDetail();
    applyFilter(null);
    map.flyTo({ ...HOME, duration: 1500 });
  });
  REGIONS.forEach(r => {
    addTab(regionsEl, r.name, counts[r.name] || 0, (btn) => {
      hideRideDetail();
      if (btn.classList.contains('active')) {
        setActiveTab(document.querySelector('.region-btn'));
        activeRegion = null;
        selectedId = null;
        applyFilter(null);
      } else {
        setActiveTab(btn);
        activeRegion = r;
        selectedId = null;
        applyFilter(['==', ['get', 'region'], r.name]);
        map.fitBounds(r.bounds, { padding: 40, duration: 1500 });
      }
    });
  });

  // Init map
  mapboxgl.accessToken = MAPBOX_TOKEN;
  map = new mapboxgl.Map({ container: 'map', style: 'mapbox://styles/mapbox/outdoors-v12', ...HOME });
  map.addControl(new MapboxGeocoder({ accessToken: MAPBOX_TOKEN, mapboxgl, marker: false, collapsed: true, placeholder: 'Search', flyTo: { speed: 5, curve: 1, zoom: 11 } }), 'top-right');
  map.addControl(new mapboxgl.NavigationControl());
  const geoInput = document.querySelector('.mapboxgl-ctrl-geocoder input');
  if (geoInput) { geoInput.spellcheck = false; geoInput.autocomplete = 'off'; geoInput.autocorrect = 'off'; geoInput.autocapitalize = 'off'; }

  map.on('load', () => {
    // Remove labels/POIs, hide translucent water overlays, then lightly fade base layers
    const FADE = 0.55;
    map.getStyle().layers.forEach(layer => {
      if (layer.id.match(/label|poi|place|shield|road-number|contour/i)) {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
        return;
      }
      if (/^(water-depth|water-shadow|waterway-shadow)$/.test(layer.id)) {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
        return;
      }
      if (layer.id === 'water' || layer.id === 'waterway') return;
      const opacityProp = { fill: 'fill-opacity', line: 'line-opacity', background: 'background-opacity', symbol: 'text-opacity', 'fill-extrusion': 'fill-extrusion-opacity', circle: 'circle-opacity', raster: 'raster-opacity' }[layer.type];
      if (opacityProp) {
        const current = map.getPaintProperty(layer.id, opacityProp);
        map.setPaintProperty(layer.id, opacityProp, (typeof current === 'number' ? current : 1) * FADE);
      }
    });

    const mobileQuery = window.matchMedia('(max-width: 600px)');
    const rideWidth = () => mobileQuery.matches ? 2 : 3;
    map.addSource('rides', { type: 'geojson', data: geojson, tolerance: 0.5 });
    map.addLayer({ id: 'rides-hit', type: 'line', source: 'rides', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': 14, 'line-opacity': 0 } });
    map.addLayer({ id: 'rides-layer', type: 'line', source: 'rides', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': LINE_COLOR, 'line-width': rideWidth(), 'line-opacity': 0.9 } });
    map.addLayer({ id: 'rides-dim', type: 'line', source: 'rides', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#aaaaaa', 'line-width': rideWidth(), 'line-opacity': 1 }, filter: NO_MATCH });
    map.addLayer({ id: 'rides-highlight', type: 'line', source: 'rides', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': LINE_COLOR, 'line-width': rideWidth(), 'line-opacity': 1 }, filter: NO_MATCH });
    mobileQuery.addEventListener('change', () => {
      const w = rideWidth();
      ['rides-layer', 'rides-dim', 'rides-highlight'].forEach(id => map.setPaintProperty(id, 'line-width', w));
    });

    function dimFilter(hoveredId) {
      const base = ['!=', ['id'], hoveredId];
      return applyFilter._current ? ['all', applyFilter._current, base] : base;
    }
    function highlightFilter(hoveredId) {
      const base = ['==', ['id'], hoveredId];
      return applyFilter._current ? ['all', applyFilter._current, base] : base;
    }
    map.on('mouseenter', 'rides-hit', () => { if (selectedId === null) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'rides-hit', () => { map.getCanvas().style.cursor = ''; if (selectedId === null) { map.setFilter('rides-dim', NO_MATCH); map.setFilter('rides-highlight', NO_MATCH); } });
    map.on('mousemove', 'rides-hit', e => { if (selectedId === null && e.features.length) { const id = e.features[0].id; map.setFilter('rides-dim', dimFilter(id)); map.setFilter('rides-highlight', highlightFilter(id)); } });

    map.on('click', 'rides-hit', e => {
      if (!e.features.length) return;
      selectedId = e.features[0].id;
      setActiveTab(document.querySelector('.region-btn'));
      activeRegion = null;
      map.setFilter('rides-hit', NO_MATCH);
      map.setFilter('rides-dim', NO_MATCH);
      map.setFilter('rides-highlight', NO_MATCH);
      map.setFilter('rides-layer', ['==', ['id'], selectedId]);
      map.getCanvas().style.cursor = '';
      showRideDetail(geojson.features[selectedId].properties);
      const bounds = new mapboxgl.LngLatBounds();
      const geom = geojson.features[selectedId].geometry;
      const clickCoords = geom.type === 'MultiLineString' ? geom.coordinates.flat() : geom.coordinates;
      clickCoords.forEach(c => bounds.extend(c));
      map.fitBounds(bounds, { padding: 60, duration: 1000 });
    });

    map.on('click', e => {
      if (selectedId === null) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['rides-hit'] }).length) return;
      selectedId = null;
      hideRideDetail();
      applyFilter(null);
    });
  });
}

function fmtTime(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }

function toGpx(feature) {
  const name = feature.properties.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const geom = feature.geometry;
  const segments = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
  const trksegs = segments.map(seg =>
    '    <trkseg>\n' + seg.map(([lng, lat]) => `      <trkpt lat="${lat}" lon="${lng}"></trkpt>`).join('\n') + '\n    </trkseg>'
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ridesometime" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk>\n    <name>${name}</name>\n${trksegs}\n  </trk>\n</gpx>`;
}

function downloadGpx() {
  if (selectedId === null) return;
  const feature = geojson.features[selectedId];
  const gpx = toGpx(feature);
  const slug = feature.properties.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function showRideDetail(p) {
  const mi = (p.distance / 1609.34).toFixed(1);
  document.getElementById('ride-name').textContent = p.name;
  document.getElementById('ride-stats').innerHTML = `${p.ebike ? '⚡ ' : ''}${mi} mi<br>${fmtTime(p.moving_time)} riding time<br>${fmtTime(p.elapsed_time)} total`;
  document.getElementById('gpx-btn').onclick = downloadGpx;
  document.getElementById('info-panel').style.display = 'none';
  document.getElementById('ride-detail').classList.add('visible');
}

function hideRideDetail() {
  document.getElementById('ride-detail').classList.remove('visible');
  document.getElementById('info-panel').style.display = '';
}

function addTab(parent, name, count, onClick) {
  const btn = document.createElement('button');
  btn.className = 'region-btn' + (name === 'all' ? ' active' : '');
  btn.innerHTML = `${name}<span class="count">${count}</span>`;
  btn.addEventListener('click', () => onClick(btn));
  parent.appendChild(btn);
}

function setActiveTab(btn) {
  document.querySelectorAll('.region-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function applyFilter(filter) {
  map.setFilter('rides-layer', filter);
  map.setFilter('rides-hit', filter);
  map.setFilter('rides-dim', NO_MATCH);
  map.setFilter('rides-highlight', NO_MATCH);
  applyFilter._current = filter;
}
applyFilter._current = null;

function computeStats(features) {
  let totalDist = 0, totalMoving = 0, totalElapsed = 0;
  const countries = new Set();
  const continents = new Set();
  const states = new Set();
  const cities = new Set();
  features.forEach(f => {
    const p = f.properties;
    totalDist += p.distance || 0;
    totalMoving += p.moving_time || 0;
    totalElapsed += p.elapsed_time || 0;
    const allCoords = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates;
    const mid = allCoords[Math.floor(allCoords.length / 2)] || [0, 0];
    const [lng, lat] = mid;
    // Country + continent detection
    if (lat > 49 && lat < 51 && lng > -124 && lng < -122) { countries.add('Canada'); continents.add('North America'); }
    else if (lat > 20 && lat < 50 && lng > -130 && lng < -60) { countries.add('USA'); continents.add('North America'); }
    else if (lat > 34 && lat < 36 && lng > 136 && lng < 140) { countries.add('Japan'); continents.add('Asia'); }
    else if (lat > 46 && lat < 48 && lng > 6 && lng < 9) { countries.add('Switzerland'); continents.add('Europe'); }
    // US state detection
    if (lat > 32 && lat < 42 && lng > -125 && lng < -114) states.add('California');
    else if (lat > 46 && lat < 49 && lng > -125 && lng < -117) states.add('Washington');
    else if (lat > 38.5 && lat < 40 && lng > -121 && lng < -119) states.add('Nevada');
    else if (lat > 20 && lat < 22 && lng > -160 && lng < -154) { states.add('Hawaii'); countries.add('USA'); continents.add('North America'); }
    else if (lat > 37 && lat < 40 && lng > -80 && lng < -75) states.add('Virginia');
    else if (lat > 38.5 && lat < 40 && lng > -77.5 && lng < -76) states.add('Maryland');
    else if (lat > 33 && lat < 37 && lng > -77 && lng < -75) states.add('North Carolina');
    // City detection: use regions as cities
    for (const r of REGIONS) {
      const [[minLng, minLat], [maxLng, maxLat]] = r.bounds;
      if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
        cities.add(r.name);
        break;
      }
    }
  });
  return {
    totalDist,
    totalMoving,
    totalElapsed,
    countries,
    continents,
    states,
    cities,
    rideCount: features.length
  };
}

function refreshStats() {
  const stats = computeStats(geojson.features);
  const mi = Math.round(stats.totalDist / 1609.34).toLocaleString();
  const card = document.getElementById('stats-card');
  card.innerHTML = `<span class="stats-value">${mi}</span> miles<br>`
    + `<span class="stats-value">${fmtTime(stats.totalMoving)}</span> riding time<br>`
    + `<span class="stats-value">${fmtTime(stats.totalElapsed)}</span> elapsed time<br>`
    + `<span class="stats-value">${stats.continents.size}</span> continents<br>`
    + `<span class="stats-value">${stats.countries.size}</span> countries<br>`
    + `<span class="stats-value">${stats.cities.size}</span> cities`;
}

init();
