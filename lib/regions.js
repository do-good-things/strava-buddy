// A fresh lookup cache per refresh; never publish raw geocoding responses.
function createRegionGenerator(axios, mapboxToken) {
const BOUNDS_PADDING = 0.15;

// A region is named at the broadest administrative level that still describes it
// tightly. Grouping starts at country level and descends (country -> state ->
// county) only while a group is too geographically spread out for one name to be
// honest. So Japan's rides stay "Japan", while the US has to split into states.
const MAX_REGION_SPAN_KM = 500;
const ADMIN_LEVELS = ['country', 'region', 'district'];

// Curated geographies no geocoder can express, because they span counties, states,
// or national borders. These take precedence over administrative naming.
// Entries with `districts` are matched first, so a specific metro wins over the
// broader region containing it.
// Add one when the automatic name comes out too narrow (a 3,000-person town
// standing in for all of Puget Sound) or when it splits somewhere you think of as
// a single ride destination.
const MACRO_REGIONS = [
  {
    name: 'Bay Area',
    country: 'United States', regions: ['California'],
    districts: ['Marin County', 'San Francisco County', 'San Mateo County',
      'Santa Clara County', 'Alameda County', 'Contra Costa County',
      'Sonoma County', 'Napa County', 'Solano County', 'Santa Cruz County'],
  },
  {
    name: 'Tahoe',
    country: 'United States', regions: ['California', 'Nevada'],
    districts: ['Nevada County', 'Placer County', 'El Dorado County',
      'Sierra County', 'Plumas County', 'Washoe County', 'Douglas County',
      'Carson City'],
  },
  {
    name: 'Southern California',
    country: 'United States', regions: ['California'],
    districts: ['San Diego County', 'Los Angeles County', 'Orange County',
      'Santa Barbara County', 'Ventura County', 'Riverside County',
      'San Bernardino County', 'Imperial County'],
  },
  {
    name: 'Outer Banks',
    country: 'United States', regions: ['North Carolina'],
    districts: ['Dare County', 'Currituck County', 'Hyde County', 'Carteret County'],
  },
  // Straddles the US/Canada border, so it matches on state/province alone.
  { name: 'Pacific Northwest', regions: ['Washington', 'Oregon', 'British Columbia'] },
  { name: 'Mid-Atlantic', regions: ['Virginia', 'Maryland', 'Delaware', 'District of Columbia'] },
];

// Last-resort rename of an already-resolved label. Prefer MACRO_REGIONS above: it
// describes a real geography, so it keeps working as new rides land inside it,
// whereas an entry here only patches one name after the fact.
const NAME_OVERRIDES = {};

// --- Region generation ---

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dlat = (lat2 - lat1) * Math.PI / 180;
  const dlng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dlat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dlng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getRideMidpoint(feature) {
  const geom = feature.geometry;
  const coords = geom.type === 'MultiLineString'
    ? geom.coordinates.flat()
    : geom.coordinates;
  const mid = coords[Math.floor(coords.length / 2)];
  return [mid[1], mid[0]]; // [lat, lng]
}

// Greatest distance between any two rides in a group.
function groupSpanKm(points) {
  let span = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      span = Math.max(span, haversineKm(points[i][0], points[i][1], points[j][0], points[j][1]));
    }
  }
  return span;
}

// Reverse geocoding is cached for the duration of this refresh. The private worker
// state can add persistent caching later without publishing raw geocoder data.
const geocache = {};

async function lookupAdmin(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (geocache[key]) return geocache[key];

  const token = mapboxToken;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?types=place,district,region,country&access_token=${encodeURIComponent(token)}`;
  try {
    const { data } = await axios.get(url, { timeout: 30000 });
    if (!Array.isArray(data.features)) throw new Error('Invalid geocoding response');
    const admin = {};
    for (const f of data.features || []) {
      const type = (f.place_type || [])[0];
      if (type && !admin[type]) admin[type] = f.text;
      // Broader areas containing this feature arrive as context entries.
      for (const c of f.context || []) {
        const ctype = (c.id || '').split('.')[0];
        if (!admin[ctype]) admin[ctype] = c.text;
      }
    }
    geocache[key] = admin;
    return admin;
  } catch (err) {
    throw new Error(`Reverse geocoding failed (${err.response?.status || 'network error'}); refresh aborted.`);
  }
}

const MACROS_BY_PRECEDENCE = [...MACRO_REGIONS]
  .sort((a, b) => (b.districts ? 1 : 0) - (a.districts ? 1 : 0));

function matchMacroRegion(admin) {
  for (const macro of MACROS_BY_PRECEDENCE) {
    if (macro.country && admin.country !== macro.country) continue;
    if (macro.regions && !macro.regions.includes(admin.region)) continue;
    if (macro.districts && !macro.districts.includes(admin.district)) continue;
    return macro.name;
  }
  return null;
}

// Descend country -> state -> county, stopping as soon as a group is compact
// enough that a single name honestly covers it.
//
// The home country is always descended past: "Japan" is a useful label for a trip
// abroad, but riding at home reads as "Alaska" or "Tahoe", never "United States".
function splitByAdmin(members, level, homeCountry) {
  const field = ADMIN_LEVELS[level];
  const groups = new Map();
  for (const m of members) {
    const key = m.admin[field] || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const out = [];
  for (const [name, group] of groups) {
    const atLastLevel = level === ADMIN_LEVELS.length - 1;
    const isHomeCountry = field === 'country' && name === homeCountry;
    const compact = groupSpanKm(group.map(m => m.point)) <= MAX_REGION_SPAN_KM;
    if (atLastLevel || (compact && !isHomeCountry)) {
      out.push({ name, members: group });
    } else {
      out.push(...splitByAdmin(group, level + 1, homeCountry));
    }
  }
  return out;
}

// Whichever country holds the most rides.
function findHomeCountry(members) {
  const tally = new Map();
  for (const m of members) {
    if (!m.admin.country) continue;
    tally.set(m.admin.country, (tally.get(m.admin.country) || 0) + 1);
  }
  let home = null, best = 0;
  for (const [country, n] of tally) if (n > best) { home = country; best = n; }
  return home;
}

async function generateRegions(rideFeatures) {
  const members = [];
  for (const feature of rideFeatures) {
    const point = getRideMidpoint(feature);
    const admin = await lookupAdmin(point[0], point[1]);
    members.push({ point, admin, macro: matchMacroRegion(admin) });
  }


  const named = new Map();
  const addTo = (name, member) => {
    if (!named.has(name)) named.set(name, []);
    named.get(name).push(member);
  };

  for (const m of members) if (m.macro) addTo(m.macro, m);

  const unmatched = members.filter(m => !m.macro);
  if (unmatched.length) {
    const homeCountry = findHomeCountry(members);
    for (const group of splitByAdmin(unmatched, 0, homeCountry)) {
      const name = NAME_OVERRIDES[group.name] || group.name;
      for (const m of group.members) addTo(name, m);
    }
  }

  const regions = [...named.entries()]
    .map(([name, ms]) => {
      const lats = ms.map(m => m.point[0]);
      const lngs = ms.map(m => m.point[1]);
      return {
        name,
        bounds: [
          [+(Math.min(...lngs) - BOUNDS_PADDING).toFixed(4), +(Math.min(...lats) - BOUNDS_PADDING).toFixed(4)],
          [+(Math.max(...lngs) + BOUNDS_PADDING).toFixed(4), +(Math.max(...lats) + BOUNDS_PADDING).toFixed(4)],
        ],
        count: ms.length,
      };
    })
    .sort((a, b) => b.count - a.count);

  console.log(`\n${regions.length} region(s) from ${rideFeatures.length} rides:\n`);
  for (const r of regions) console.log(`  ${r.name}: ${r.count} ride(s)`);

  return regions;
}


return generateRegions;
}
module.exports = { createRegionGenerator };
