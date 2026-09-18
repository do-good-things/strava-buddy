let REGIONS = [];
const home = () => ({ center: [-122.52, 37.82], zoom: window.innerWidth <= 600 ? 10 : 11 });
const LINE_COLOR = '#ff1493';
const NO_MATCH = ['==', ['id'], -1];
const ROUTE_OPACITY = 0.9;

let map, geojson, activeRegion = null, selectedId = null, overlapFilter = null;
let rideDetailVersion = 0;

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

// Footer marquee. The visible strip is repeated until it covers the viewport,
// then that whole group is duplicated once; the CSS shifts the track by 50%, so
// the loop restarts exactly where it began.
const MARQUEE_SPEED_PX_PER_SEC = 40;

function startFooterMarquee() {
  const track = document.getElementById('marquee-track');
  const original = track && track.querySelector('.marquee-item');
  if (!original) return;

  const containerWidth = track.parentElement.getBoundingClientRect().width;
  const itemWidth = original.getBoundingClientRect().width;
  if (!itemWidth || !containerWidth) return;

  // Repeats are hidden from assistive tech, and ids must not be cloned.
  const copyOf = node => {
    const copy = node.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    copy.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    return copy;
  };

  const group = document.createElement('div');
  group.className = 'marquee-group';
  group.appendChild(original); // the real element keeps its id and stays first
  // Two viewports' worth per group: the strip stays full across the whole
  // cycle rather than thinning out as the seam approaches.
  const repeats = Math.max(2, Math.ceil((containerWidth * 2) / itemWidth));
  for (let i = 1; i < repeats; i++) group.appendChild(copyOf(original));

  track.textContent = '';
  track.append(group, copyOf(group));

  const groupWidth = group.getBoundingClientRect().width;
  track.style.animationDuration = `${groupWidth / MARQUEE_SPEED_PX_PER_SEC}s`;
}

// Rebuild on resize so the strip still covers a widened window.
let marqueeResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(marqueeResizeTimer);
  marqueeResizeTimer = setTimeout(() => {
    const track = document.getElementById('marquee-track');
    const first = track && track.querySelector('.marquee-item');
    if (!first) return;
    track.textContent = '';
    first.removeAttribute('aria-hidden');
    track.appendChild(first);
    track.style.animationDuration = '';
    startFooterMarquee();
  }, 200);
});

// Reports when the rides were last pulled from Strava, which refresh.js stamps
// into rides.json. Deliberately not the file's mtime or a build date: a deploy
// that shipped no new rides would otherwise look like a fresh fetch.
function showLastUpdated(iso) {
  const el = document.getElementById('last-updated');
  if (!el || !iso) return;
  const when = new Date(iso);
  if (isNaN(when.getTime())) return;
  // Pacific time, so the label tracks PST/PDT rather than the viewer's zone.
  // Date and time are formatted separately because a single formatter joins
  // them with a comma, and the label reads with an @ between them.
  const zone = { timeZone: 'America/Los_Angeles' };
  const date = new Intl.DateTimeFormat('en-US', {
    ...zone, month: 'short', day: 'numeric', year: 'numeric',
  }).format(when);
  const time = new Intl.DateTimeFormat('en-US', {
    ...zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(when);
  // The separator is drawn by CSS, which hides it when this element is empty.
  el.textContent = `refreshed on ${date} @ ${time}`.toLowerCase();
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

  showLastUpdated(geojson.generated_at);
  startFooterMarquee(); // after the timestamp lands, so widths measure correctly
  refreshStats();

  // Split rides at large GPS gaps to avoid long straight lines over water/pauses
  geojson.features.forEach(f => {
    if (f.geometry.type === 'LineString') {
      const segments = splitGaps(f.geometry.coordinates);
      if (segments.length > 1) {
        f.geometry = { type: 'MultiLineString', coordinates: segments };
      } else if (segments.length === 1) {
        f.geometry.coordinates = segments[0];
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
    map.flyTo({ ...home(), duration: 1500 });
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
        const duration = window.innerWidth <= 600 ? 0 : 1500;
        map.resize();
        map.fitBounds(r.bounds, { padding: 40, duration });
      }
    });
  });

  // Init map
  mapboxgl.accessToken = MAPBOX_TOKEN;
  // Outdoors defaults to globe, which rasterizes map layers at wider zooms.
  // Mobile region fits reach those zooms; Mercator keeps them crisp throughout.
  map = new mapboxgl.Map({ container: 'map', style: 'mapbox://styles/mapbox/outdoors-v12', projection: 'mercator', attributionControl: false, fadeDuration: 0, ...home() });
  map.addControl(new MapboxGeocoder({ accessToken: MAPBOX_TOKEN, mapboxgl, marker: false, collapsed: true, placeholder: 'Search', flyTo: { speed: 5, curve: 1, zoom: 11 } }), 'top-right');
  const geoInput = document.querySelector('.mapboxgl-ctrl-geocoder input');
  if (geoInput) { geoInput.spellcheck = false; geoInput.autocomplete = 'off'; geoInput.autocorrect = 'off'; geoInput.autocapitalize = 'off'; }

  map.once('style.load', () => {
    // Remove labels/POIs and hide translucent water overlays. Keep the base
    // map layers at their native opacity so region fits remain crisp.
    const FADE = 1;
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
  });

  map.on('load', () => {
    const rideWidth = () => 2;
    if (window.ResizeObserver) {
      let resizeFrame = 0;
      const resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => map.resize());
      });
      resizeObserver.observe(map.getContainer());
    }
    let overlapClickInProgress = false;
    map.addSource('rides', { type: 'geojson', data: geojson, tolerance: 0.5 });
    map.addLayer({ id: 'rides-hit', type: 'line', source: 'rides', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': 14, 'line-opacity': 0 } });
    map.addLayer({ id: 'rides-layer', type: 'line', source: 'rides', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': LINE_COLOR, 'line-width': rideWidth(), 'line-opacity': 0.9 } });
    map.addLayer({ id: 'rides-dim', type: 'line', source: 'rides', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#aaaaaa', 'line-width': rideWidth(), 'line-opacity': 1 }, filter: NO_MATCH });
    map.addLayer({ id: 'rides-highlight', type: 'line', source: 'rides', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': LINE_COLOR, 'line-width': rideWidth(), 'line-opacity': 1 }, filter: NO_MATCH });
    function dimFilter(hoveredId) {
      const ids = Array.isArray(hoveredId) ? hoveredId : [hoveredId];
      const base = ['match', ['id'], ids, false, true];
      const filter = activeRouteFilter();
      return filter ? ['all', filter, base] : base;
    }
    function highlightFilter(hoveredId) {
      const ids = Array.isArray(hoveredId) ? hoveredId : [hoveredId];
      const base = ['match', ['id'], ids, true, false];
      const filter = activeRouteFilter();
      return filter ? ['all', filter, base] : base;
    }
    function fitRoutes(ids, onSettled) {
      const bounds = new mapboxgl.LngLatBounds();
      ids.forEach(id => {
        const geom = geojson.features[id].geometry;
        const coords = geom.type === 'MultiLineString' ? geom.coordinates.flat() : geom.coordinates;
        coords.forEach(coord => bounds.extend(coord));
      });
      if (!bounds.isEmpty()) {
        map.stop();
        map.once('moveend', () => requestAnimationFrame(onSettled || placeRideSplash));
        map.fitBounds(bounds, { padding: 60, duration: 1000 });
      } else if (onSettled) {
        onSettled();
      }
    }
    map.on('mouseleave', 'rides-hit', () => { if (selectedId === null) { map.setFilter('rides-dim', NO_MATCH); map.setFilter('rides-highlight', NO_MATCH); } });
    map.on('mousemove', 'rides-hit', e => {
      if (selectedId === null && e.features.length) {
        const ids = [...new Set(e.features.map(feature => feature.id))];
        map.setFilter('rides-dim', dimFilter(ids));
        map.setFilter('rides-highlight', highlightFilter(ids));
      }
    });

    function selectRide(id, { fit = true } = {}) {
      hideRideSplash();
      const detailVersion = rideDetailVersion;
      selectedId = id;
      setActiveTab(document.querySelector('.region-btn'));
      activeRegion = null;
      // Keep geographic-region hit testing active so a new map tap can open
      // all rides at that point, independently of the current overlap group.
      map.setFilter('rides-hit', applyFilter._current);
      // Reuse the same dim/highlight layers as geographic-region hover so a
      // chosen overlapping ride has exactly the same visual treatment.
      map.setFilter('rides-dim', dimFilter(selectedId));
      map.setFilter('rides-highlight', highlightFilter(selectedId));
      map.setFilter('rides-layer', activeRouteFilter());
      map.setPaintProperty('rides-layer', 'line-opacity', ROUTE_OPACITY);
      map.getCanvas().style.cursor = '';
      setActiveOverlapOption(selectedId);
      const ride = geojson.features[selectedId].properties;
      if (!fit) {
        showRideSplash(ride);
        return;
      }
      fitRoutes([selectedId], () => {
        if (selectedId === id && detailVersion === rideDetailVersion) showRideSplash(ride);
      });
    }

    map.on('click', 'rides-hit', e => {
      if (!e.features.length) return;
      const ids = [...new Set(e.features.map(feature => feature.id))];
      overlapClickInProgress = true;
      setTimeout(() => { overlapClickInProgress = false; }, 0);
      if (ids.length > 1) {
        // Opening the chooser is not a selection. Keep the overlapping rides
        // visible until the user explicitly chooses one, and hide unrelated
        // routes while the chooser is open.
        selectedId = null;
        overlapFilter = ['match', ['id'], ids, true, false];
        hideRideDetail();
        map.setFilter('rides-layer', activeRouteFilter());
        map.setFilter('rides-hit', applyFilter._current);
        map.setFilter('rides-dim', NO_MATCH);
        map.setFilter('rides-highlight', NO_MATCH);
        map.setPaintProperty('rides-layer', 'line-opacity', ROUTE_OPACITY);
        fitRoutes(ids);
        showOverlapChooser(ids, id => selectRide(id));
        return;
      }
      selectRide(ids[0]);
    });

    map.on('click', e => {
      // The layer click that opens the chooser also bubbles to this map-level
      // handler. Let that opening click finish; clear on the next click away.
      if (overlapClickInProgress) {
        overlapClickInProgress = false;
        return;
      }
      if (selectedId === null && overlapFilter === null) return;
      if (selectedId !== null && map.queryRenderedFeatures(e.point, { layers: ['rides-hit'] }).length) return;
      selectedId = null;
      overlapFilter = null;
      hideRideDetail();
      // Restore the geographic filter that was active before the overlap
      // chooser opened, rather than resetting the whole map to "all".
      applyFilter(applyFilter._current);
    });
    // Mapbox's click event can be swallowed by touch navigation on mobile.
    // Listen at the page level as well so tapping elsewhere reliably clears a
    // selected ride or an open overlap chooser.
    document.addEventListener('pointerdown', e => {
      if (e.target.closest('.overlap-options, .mapboxgl-ctrl')) return;
      if (selectedId === null && overlapFilter === null) return;
      // Clear old details immediately; the subsequent map click can select
      // the rides at the new point, or leave everything dismissed on empty space.
      selectedId = null;
      overlapFilter = null;
      hideRideDetail();
      applyFilter(applyFilter._current);
    }, true);
  });
}

function fmtTime(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }

function showOverlapChooser(ids, onSelect) {
  const chooser = document.getElementById('overlap-chooser');
  chooser.replaceChildren();
  chooser.style.maxHeight = '';
  const options = document.createElement('div');
  options.className = 'overlap-options';
  const orderedIds = [...ids].sort((a, b) => {
    const aTime = new Date(geojson.features[a].properties.date).getTime();
    const bTime = new Date(geojson.features[b].properties.date).getTime();
    return (Number.isNaN(bTime) ? -Infinity : bTime) - (Number.isNaN(aTime) ? -Infinity : aTime);
  });
  orderedIds.forEach(id => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'overlap-option';
    button.dataset.rideId = id;
    const date = new Date(geojson.features[id].properties.date);
    const pad = value => String(value).padStart(2, '0');
    button.textContent = Number.isNaN(date.getTime())
      ? 'unknown date'
      : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    button.addEventListener('click', () => onSelect(id));
    options.appendChild(button);
  });
  chooser.appendChild(options);
}

function setActiveOverlapOption(id) {
  document.querySelectorAll('.overlap-option').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.rideId) === id);
  });
}

function hideRideDetail() {
  const chooser = document.getElementById('overlap-chooser');
  chooser.replaceChildren();
  chooser.style.maxHeight = '';
  hideRideSplash();
}

function showRideSplash(p) {
  const splash = document.getElementById('ride-splash');
  splash.replaceChildren();
  const title = document.createElement('div');
  title.className = 'splash-title';
  title.textContent = p.name;
  const miles = document.createElement('div');
  miles.className = 'splash-detail';
  miles.textContent = `${(p.distance / 1609.34).toFixed(1)} mi`;
  const moving = document.createElement('div');
  moving.className = 'splash-detail';
  moving.textContent = `${fmtTime(p.moving_time)} ride time`;
  const elapsed = document.createElement('div');
  elapsed.className = 'splash-detail';
  elapsed.textContent = `${fmtTime(p.elapsed_time)} elapsed time`;
  splash.append(title, miles, moving, elapsed);
  splash.classList.add('visible');
  splash.style.visibility = 'hidden';
  requestAnimationFrame(placeRideSplash);
}

function hideRideSplash() {
  // Invalidate pending zoom callbacks so dismissed details cannot reappear.
  rideDetailVersion++;
  const splash = document.getElementById('ride-splash');
  splash.classList.remove('visible');
  splash.style.visibility = '';
  splash.replaceChildren();
}

function placeRideSplash() {
  const splash = document.getElementById('ride-splash');
  const wrap = document.querySelector('.map-wrap');
  if (!splash || !wrap || !splash.classList.contains('visible')) return;
  const padding = 16;
  const width = splash.offsetWidth;
  const height = splash.offsetHeight;
  const maxLeft = Math.max(padding, wrap.clientWidth - width - padding);
  const maxTop = Math.max(padding, wrap.clientHeight - height - padding);
  const wrapRect = wrap.getBoundingClientRect();
  const chooser = document.getElementById('overlap-chooser');
  const mobileSelectedChooser = window.innerWidth <= 600 && selectedId !== null && chooser?.children.length;
  chooser.style.maxHeight = '';
  if (mobileSelectedChooser) {
    // Reserve only the space the ride details need, plus a gap above them.
    const availableHeight = Math.max(0, maxTop - chooser.offsetTop - padding);
    chooser.style.maxHeight = `${availableHeight}px`;
    const options = chooser.querySelector('.overlap-options');
    const activeOption = options?.querySelector('.active');
    if (activeOption) {
      const optionRect = activeOption.getBoundingClientRect();
      const listRect = options.getBoundingClientRect();
      if (optionRect.bottom > listRect.bottom) options.scrollTop += optionRect.bottom - listRect.bottom;
      else if (optionRect.top < listRect.top) options.scrollTop -= listRect.top - optionRect.top;
    }
  }
  const obstacles = [...wrap.querySelectorAll('#overlap-chooser, .mapboxgl-ctrl-geocoder, .mapboxgl-ctrl-group')]
    .filter(el => el !== splash && el.getClientRects().length)
    .map(el => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left - wrapRect.left - padding,
        top: rect.top - wrapRect.top - padding,
        right: rect.right - wrapRect.left + padding,
        bottom: rect.bottom - wrapRect.top + padding,
      };
    });
  if (selectedId !== null && map) {
    const geometry = geojson.features[selectedId].geometry;
    const routeParts = geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates];
    routeParts.forEach(coords => {
      for (let i = 1; i < coords.length; i += 3) {
        const start = map.project(coords[i - 1]);
        const end = map.project(coords[Math.min(i + 2, coords.length - 1)]);
        obstacles.push({
          left: Math.min(start.x, end.x) - 8,
          top: Math.min(start.y, end.y) - 8,
          right: Math.max(start.x, end.x) + 8,
          bottom: Math.max(start.y, end.y) + 8,
          isRoute: true,
        });
      }
    });
  }
  const overlaps = (left, top, obstacle) => left < obstacle.right && left + width > obstacle.left && top < obstacle.bottom && top + height > obstacle.top;
  const random = (max, min) => min + Math.random() * Math.max(0, max - min);
  let left = padding, top = padding;
  let placed = false;
  if (mobileSelectedChooser) {
    const controls = obstacles.filter(obstacle => !obstacle.isRoute);
    if (!controls.some(obstacle => overlaps(padding, maxTop, obstacle))) {
      left = padding;
      top = maxTop;
      placed = true;
    }
  }
  for (let attempt = 0; attempt < 80 && !placed; attempt++) {
    const candidateLeft = random(maxLeft, padding);
    const candidateTop = random(maxTop, padding);
    if (!obstacles.some(obstacle => overlaps(candidateLeft, candidateTop, obstacle))) {
      left = candidateLeft;
      top = candidateTop;
      placed = true;
      break;
    }
  }
  if (!placed) {
    for (let row = 0; row <= 8 && !placed; row++) {
      for (let column = 0; column <= 12 && !placed; column++) {
        const candidateLeft = padding + (maxLeft - padding) * (column / 12);
        const candidateTop = padding + (maxTop - padding) * (row / 8);
        if (!obstacles.some(obstacle => overlaps(candidateLeft, candidateTop, obstacle))) {
          left = candidateLeft;
          top = candidateTop;
          placed = true;
        }
      }
    }
  }
  // On small maps a selected route can occupy nearly every open pixel. Keep
  // the splash visible by retrying against only interactive controls before
  // falling back to the lower edge of the map.
  if (!placed) {
    const controls = obstacles.filter(obstacle => !obstacle.isRoute);
    for (let row = 0; row <= 8 && !placed; row++) {
      for (let column = 0; column <= 12 && !placed; column++) {
        const candidateLeft = padding + (maxLeft - padding) * (column / 12);
        const candidateTop = padding + (maxTop - padding) * (row / 8);
        if (!controls.some(obstacle => overlaps(candidateLeft, candidateTop, obstacle))) {
          left = candidateLeft;
          top = candidateTop;
          placed = true;
        }
      }
    }
  }
  if (!placed) {
    left = padding;
    top = maxTop;
    placed = true;
  }
  splash.style.left = `${Math.round(left)}px`;
  splash.style.top = `${Math.round(top)}px`;
  splash.style.visibility = 'visible';
}

window.addEventListener('resize', () => {
  if (document.getElementById('ride-splash')?.classList.contains('visible')) requestAnimationFrame(placeRideSplash);
});

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
  overlapFilter = null;
  map.setFilter('rides-layer', filter);
  map.setFilter('rides-hit', filter);
  map.setFilter('rides-dim', NO_MATCH);
  map.setFilter('rides-highlight', NO_MATCH);
  map.setPaintProperty('rides-layer', 'line-opacity', ROUTE_OPACITY);
  applyFilter._current = filter;
}
applyFilter._current = null;

function activeRouteFilter() {
  if (applyFilter._current && overlapFilter) return ['all', applyFilter._current, overlapFilter];
  return overlapFilter || applyFilter._current || null;
}

function computeStats(features) {
  let totalDist = 0, totalMoving = 0, totalElapsed = 0;
  const countries = new Set();
  const continents = new Set();
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
    else if (lat > 18 && lat < 23 && lng > -161 && lng < -154) { countries.add('USA'); continents.add('North America'); }
  });
  return {
    totalDist,
    totalMoving,
    totalElapsed,
    countries,
    continents,
    rideCount: features.length
  };
}

function refreshStats() {
  const stats = computeStats(geojson.features);
  const mi = Math.round(stats.totalDist / 1609.34).toLocaleString();
  const card = document.getElementById('stats-card');
  if (!card) return;
  card.innerHTML = `<span class="stats-value">${mi}</span> miles<br>`
    + `<span class="stats-value">${fmtTime(stats.totalMoving)}</span> riding time<br>`
    + `<span class="stats-value">${fmtTime(stats.totalElapsed)}</span> elapsed time<br>`
    + `<span class="stats-value">${stats.continents.size}</span> continents<br>`
    + `<span class="stats-value">${stats.countries.size}</span> countries`;
}

init();
