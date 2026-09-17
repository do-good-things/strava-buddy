const { createHash, randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { fresh, REFRESH_AGE } = require('./public-data');

function imageUrl(value) {
  const url = new URL(value);
  const allowed = ['cloudfront.net', 'strava.com', 'strava.net'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !allowed.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    // Include only the hostname so operators can diagnose a new CDN without
    // exposing the photo path or query string in logs.
    throw new Error(`Photo source host is not approved: ${url.hostname}`);
  }
  return url.href;
}
async function downloadPhoto(axios, url) {
  // Do not send the Strava bearer token to an image CDN or follow redirects.
  const response = await axios.get(imageUrl(url), {
    responseType: 'arraybuffer', timeout: 30000, maxRedirects: 0,
    maxContentLength: 20 * 1024 * 1024,
  });
  return stripMetadata(response.data);
}
async function stripMetadata(bytes) {
  // Re-encoding removes EXIF/GPS, capture dates, captions and embedded metadata.
  return sharp(bytes, { limitInputPixels: 40000000 }).rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
}
async function syncPhotos(feature, { read, store, download, now = Date.now, log = () => {} }) {
  const p = feature.properties;
  if (p.photo_count === 0) return [];
  log(`Photos: activity ${p.strava_id} has ${p.photo_count} photo(s).`);
  const photos = [], seen = new Set();
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error('Photo listing exceeded the supported page count');
    const batch = await read(`/activities/${p.strava_id}/photos`, { size: 1024, photo_sources: true, per_page: 200, page });
    if (!Array.isArray(batch)) throw new Error('Invalid photo list');
    log(`Photos: activity ${p.strava_id}, page ${page} returned ${batch.length}.`);
    for (const photo of batch) {
      const url = photo.urls?.['1024'] || Object.values(photo.urls || {})[0];
      if (!url) throw new Error('Photo returned without a downloadable image');
      const source = createHash('sha256').update(`${photo.unique_id || photo.id || ''}:${imageUrl(url)}`).digest('hex');
      if (seen.has(source)) throw new Error('Duplicate photo response; cannot safely complete pagination');
      seen.add(source);
      let saved = (p.photos || []).find(item => item.source === source && fresh(item.fetched_at, now(), REFRESH_AGE));
      if (saved && !await store.get(`photos/${saved.key}.jpg`)) saved = null;
      if (saved) photos.push(saved);
      else {
        log(`Photos: downloading photo ${photos.length + 1} for activity ${p.strava_id}.`);
        const bytes = await download(url);
        const item = { source, key: randomUUID(), fetched_at: new Date(now()).toISOString() };
        await store.put(`photos/${item.key}.jpg`, bytes, 'image/jpeg');
        photos.push(item);
      }
    }
    if (batch.length < 200) break;
  }
  return photos;
}
module.exports = { syncPhotos, downloadPhoto, stripMetadata, imageUrl };
