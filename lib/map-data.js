const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync, brotliCompressSync, constants } = require('node:zlib');
const polyline = require('@mapbox/polyline');

// Strava's source coordinates already have five decimal places. Encode their
// deltas for transport without removing points or simplifying ride geometry.
function packMapData(rides, ebikeRides, regions) {
  const pack = (feature, ebike) => ({
    ...feature,
    properties: { ...feature.properties, ...(ebike ? { ebike: true } : {}) },
    geometry: {
      type: feature.geometry.type,
      polylines: (feature.geometry.type === 'MultiLineString'
        ? feature.geometry.coordinates : [feature.geometry.coordinates])
        .map(coordinates => polyline.fromGeoJSON({ type: 'LineString', coordinates })),
    },
  });
  return {
    format: 'polyline5',
    regions,
    rides: {
      ...rides,
      features: [
        ...rides.features.map(feature => pack(feature, false)),
        ...ebikeRides.features.map(feature => pack(feature, true)),
      ],
    },
  };
}

function createMapDataCache(dataDir) {
  const files = ['rides.json', 'ebike-rides.json', 'regions.json'].map(file => path.join(dataDir, file));
  let cached, pending;
  return async function getMapData() {
    const stats = await Promise.all(files.map(file => fs.stat(file)));
    const version = stats.map(stat => `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`).join('|');
    if (cached?.version === version) return cached;
    if (pending?.version === version) return pending.promise;
    const promise = (async () => {
      const data = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(file, 'utf8'))));
      const body = Buffer.from(JSON.stringify(packMapData(...data)));
      const result = {
        version,
        etag: `W/"${createHash('sha256').update(body).digest('hex')}"`,
        bodies: {
          identity: body,
          gzip: gzipSync(body),
          br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
        },
      };
      cached = result;
      return result;
    })();
    pending = { version, promise };
    try {
      return await promise;
    } finally {
      if (pending?.promise === promise) pending = null;
    }
  };
}

module.exports = { packMapData, createMapDataCache };
