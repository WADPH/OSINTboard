/**
 * Coordinates for Address / Place nodes: parsing + map links.
 *
 * parseCoords understands what people typically paste:
 *   40.4093, 49.8671          40.4093 49.8671          40.4093;49.8671
 *   40.4093N 49.8671E         N 40.4093, E 49.8671
 *   40°24'33.5"N 49°52'01.6"E (Google Maps "copy coordinates" DMS)
 *   Google Maps URLs (@lat,lon / ?q=lat,lon / !3dlat!4dlon), OpenStreetMap
 *   URLs (mlat/mlon, #map=z/lat/lon), geo:lat,lon
 */

const NUM = '[-+]?\\d{1,3}(?:\\.\\d+)?';

function valid(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

const num = (s) => parseFloat(s);
const result = (lat, lon) => (valid(lat, lon) ? { lat, lon } : null);

function fromUrl(text) {
  const patterns = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, // Google place URLs (exact pin)
    /@(-?\d+\.\d+),(-?\d+\.\d+)/, // Google viewport
    /[?&](?:q|query|ll|center|destination|daddr)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i,
    /[?&]mlat=(-?\d+\.\d+).*?[?&]mlon=(-?\d+\.\d+)/i, // OSM marker
    /#map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/, // OSM view
    /^geo:(-?\d+\.\d+),(-?\d+\.\d+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return result(num(m[1]), num(m[2]));
  }
  return null;
}

function fromDms(text) {
  // 40°24'33.5"N  /  40° 24' 33.5" N  /  40°24.558'N  /  40.4093°N
  const part =
    /(\d{1,3}(?:\.\d+)?)\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*["″”]\s*)?([NSEW])/gi;
  const parts = [...text.matchAll(part)];
  if (parts.length !== 2) return null;
  let lat = null;
  let lon = null;
  for (const [, d, m, s, hemi] of parts) {
    let v = num(d) + (m ? num(m) / 60 : 0) + (s ? num(s) / 3600 : 0);
    const h = hemi.toUpperCase();
    if (h === 'S' || h === 'W') v = -v;
    if (h === 'N' || h === 'S') lat = v;
    else lon = v;
  }
  return lat === null || lon === null ? null : result(lat, lon);
}

function fromHemisphereDecimal(text) {
  // 40.4093N 49.8671E  /  N40.4093 E49.8671
  const m =
    text.match(/^\s*(\d{1,3}(?:\.\d+)?)\s*([NS])[\s,;]+(\d{1,3}(?:\.\d+)?)\s*([EW])\s*$/i) ||
    text.match(/^\s*([NS])\s*(\d{1,3}(?:\.\d+)?)[\s,;]+([EW])\s*(\d{1,3}(?:\.\d+)?)\s*$/i);
  if (!m) return null;
  const [a, b, c, d] = m.slice(1);
  const latFirstNumber = /\d/.test(a);
  const lat = latFirstNumber ? num(a) : num(b);
  const latH = latFirstNumber ? b : a;
  const lon = latFirstNumber ? num(c) : num(d);
  const lonH = latFirstNumber ? d : c;
  return result(
    latH.toUpperCase() === 'S' ? -lat : lat,
    lonH.toUpperCase() === 'W' ? -lon : lon
  );
}

function fromPlainPair(text, strict) {
  // In free text (a node's label) require decimals so "Street 12, 4" or a
  // house number never turns into a map pin. The dedicated coordinates field
  // also accepts integers.
  const m = text.match(new RegExp(`^\\s*(${NUM})\\s*[,;\\s]\\s*(${NUM})\\s*$`));
  if (!m) return null;
  if (strict && !(m[1].includes('.') && m[2].includes('.'))) return null;
  return result(num(m[1]), num(m[2]));
}

/**
 * @param {string} text
 * @param {{ strict?: boolean }} opts strict: text is free-form (a label), so
 *   only unambiguous coordinate formats count.
 * @returns {{ lat: number, lon: number } | null}
 */
export function parseCoords(text, { strict = false } = {}) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || t.length > 2000) return null;
  return fromUrl(t) || fromDms(t) || fromHemisphereDecimal(t) || fromPlainPair(t, strict);
}

// 6 decimals ≈ 10 cm — more is just noise from DMS conversion
const fix = (v) => Number(v.toFixed(6));
export const formatCoords = ({ lat, lon }) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

/** Google Maps: pin at coordinates, or a search for free text. */
export function googleMapsUrl({ coords, query }) {
  const q = coords ? `${fix(coords.lat)},${fix(coords.lon)}` : query;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export function osmUrl(coords, zoom = 16) {
  const lat = fix(coords.lat);
  const lon = fix(coords.lon);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;
}

// --- Static mini map from OpenStreetMap tiles (Web Mercator) ---

export const TILE_SIZE = 256;

/** World pixel position of a coordinate at a zoom level. */
export function project({ lat, lon }, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/**
 * Tiles covering a (2*halfW × 2*halfH) px box centered on coords.
 * Each tile: { key, url, left, top } with left/top relative to the center.
 */
export function tilesAround(coords, zoom, halfW, halfH) {
  const c = project(coords, zoom);
  const n = 2 ** zoom;
  const tiles = [];
  for (let ty = Math.floor((c.y - halfH) / TILE_SIZE); ty <= Math.floor((c.y + halfH) / TILE_SIZE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor((c.x - halfW) / TILE_SIZE); tx <= Math.floor((c.x + halfW) / TILE_SIZE); tx++) {
      const wx = ((tx % n) + n) % n; // wrap around the antimeridian
      tiles.push({
        key: `${zoom}/${tx}/${ty}`,
        url: `https://tile.openstreetmap.org/${zoom}/${wx}/${ty}.png`,
        left: Math.round(tx * TILE_SIZE - c.x),
        top: Math.round(ty * TILE_SIZE - c.y),
      });
    }
  }
  return tiles;
}
