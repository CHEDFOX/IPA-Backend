// Reads coordinates out of whatever location the owner has: a Google Maps link (including
// short maps.app.goo.gl share links), "lat, lng", or degrees-minutes-seconds from a survey.

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PATTERNS = [
  new RegExp(`!3d${NUM}!4d${NUM}`), // the dropped pin in a place link
  new RegExp(`[?&](?:q|query|ll|destination|daddr|center)=${NUM},\\s*\\+?${NUM}`),
  new RegExp(`/(?:search|place|dir/[^/]*)/${NUM},\\s*\\+?${NUM}`),
  new RegExp(`@${NUM},${NUM}`), // map centre
  new RegExp(`^\\s*${NUM}\\s*[,\\s]\\s*${NUM}\\s*$`), // plain "lat, lng"
];
const DMS =
  /(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["″]|'')?\s*([NS])[\s,]+(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["″]|'')?\s*([EW])/i;

const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const round = (n) => Math.round(n * 1e6) / 1e6;

export function parseCoordinates(input) {
  let text = String(input || '');
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(text.replace(/\+/g, ' '));
      if (decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m && valid(Number(m[1]), Number(m[2]))) return { lat: round(Number(m[1])), lng: round(Number(m[2])) };
  }
  const d = text.match(DMS);
  if (d) {
    const deg = (h, m, s, dir) => (Number(h) + Number(m) / 60 + Number(s) / 3600) * (/[SW]/i.test(dir) ? -1 : 1);
    const lat = deg(d[1], d[2], d[3], d[4]);
    const lng = deg(d[5], d[6], d[7], d[8]);
    if (valid(lat, lng)) return { lat: round(lat), lng: round(lng) };
  }
  return null;
}

// Only Google's own hosts are ever fetched.
export function isGoogleMapsHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === 'goo.gl' ||
    host === 'maps.app.goo.gl' ||
    /^([a-z0-9-]+\.)*google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)
  );
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Follows a share link's redirects (Google hosts only) until coordinates appear. */
export async function resolveMapLink(input, { fetchImpl = fetch, maxHops = 6 } = {}) {
  const direct = parseCoordinates(input);
  if (direct) return direct;

  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }
  for (let hop = 0; hop <= maxHops; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!isGoogleMapsHost(url.hostname)) return null;
    const res = await fetchImpl(url.href, {
      redirect: 'manual',
      headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      const found = parseCoordinates(url.href);
      if (found) return found;
      continue;
    }
    if (!res.ok) return null;
    // Last resort: the map page embeds its viewport as [[[zoom, lng, lat]...
    const html = (await res.text()).slice(0, 500_000);
    const state = html.match(/APP_INITIALIZATION_STATE=\[\[\[[\d.]+,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
    if (state && valid(Number(state[2]), Number(state[1]))) {
      return { lat: round(Number(state[2])), lng: round(Number(state[1])) };
    }
    return parseCoordinates(html.match(/https:\/\/www\.google\.[a-z.]+\/maps\/[^"'\s]+/)?.[0]);
  }
  return null;
}
