const DAY = 86400000;
const MAX_AGE = 7 * DAY;
const REFRESH_AGE = 6 * DAY;
const SNAPSHOT_AGE = 36 * 3600000;

function fresh(timestamp, now, age = MAX_AGE) {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && time <= now && now - time < age;
}
function publicFeature(feature, now) {
  const p = feature.properties;
  if (!fresh(p.detail_fetched_at, now)) return null;
  const geometry = feature.geometry;
  if (!['LineString', 'MultiLineString'].includes(geometry?.type)) throw new Error('Invalid route geometry');
  const projectLine = line => line.map(point => {
    const [lng, lat] = point;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new Error('Invalid route coordinates');
    return [lng, lat]; // Never return elevation/time coordinates or foreign GeoJSON members.
  });
  const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    type: 'Feature',
    geometry: { type: geometry.type, coordinates: geometry.type === 'LineString' ? projectLine(geometry.coordinates) : geometry.coordinates.map(projectLine) },
    properties: {
      name: String(p.name || ''),
      mileage: number(p.distance) / 1609.344,
      riding_time: number(p.moving_time), elapsed_time: number(p.elapsed_time),
      photos: (p.photos || []).filter(photo => fresh(photo.fetched_at, now) && /^[a-f0-9-]{36}$/.test(photo.key))
        .map(photo => `/sarah/photos/${photo.key}.jpg`),
    },
  };
}
function buildSnapshot(features, regions, now = Date.now()) {
  const included = features.filter(f => fresh(f.properties.detail_fetched_at, now));
  const expirations = [now + SNAPSHOT_AGE];
  for (const f of included) {
    expirations.push(Date.parse(f.properties.detail_fetched_at) + MAX_AGE);
    for (const photo of f.properties.photos || []) if (fresh(photo.fetched_at, now)) expirations.push(Date.parse(photo.fetched_at) + MAX_AGE);
  }
  return {
    version: 1, generated_at: new Date(now).toISOString(), expires_at: new Date(Math.min(...expirations)).toISOString(),
    rides: { type: 'FeatureCollection', features: included.map(f => publicFeature(f, now)) },
    regions: regions.map(r => ({ name: String(r.name), bounds: r.bounds.map(p => [Number(p[0]), Number(p[1])]) })),
  };
}
function snapshotAvailable(snapshot, now = Date.now()) {
  return snapshot?.version === 1 && fresh(snapshot.generated_at, now, SNAPSHOT_AGE)
    && Date.parse(snapshot.expires_at) > now;
}
// Apply the same explicit allowlist when serving, even if a bucket was seeded
// with an old or incorrectly structured snapshot. No generic object proxy exists.
function clientSnapshot(snapshot) {
  return {
    generated_at: snapshot.generated_at, expires_at: snapshot.expires_at,
    rides: { type: 'FeatureCollection', features: snapshot.rides.features.map(f => publicFeature({
      geometry: f.geometry,
      properties: {
        name: f.properties.name, distance: f.properties.mileage * 1609.344,
        moving_time: f.properties.riding_time, elapsed_time: f.properties.elapsed_time,
        detail_fetched_at: snapshot.generated_at,
        photos: (f.properties.photos || []).map(url => ({
          key: typeof url === 'string' ? /^\/sarah\/photos\/([a-f0-9-]{36})\.jpg$/.exec(url)?.[1] : '',
          fetched_at: snapshot.generated_at,
        })),
      },
    }, Date.parse(snapshot.generated_at))) },
    regions: snapshot.regions.map(r => ({ name: String(r.name), bounds: r.bounds.map(p => [Number(p[0]), Number(p[1])]) })),
  };
}
module.exports = { DAY, MAX_AGE, REFRESH_AGE, SNAPSHOT_AGE, fresh, publicFeature, buildSnapshot, snapshotAvailable, clientSnapshot };
