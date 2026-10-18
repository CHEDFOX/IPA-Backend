import { HttpError, parseJson } from './util.js';

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export const SETTINGS = {
  siteName: { default: 'IPA', max: 60 },
  siteNameHi: { default: '', max: 60 },
  tagline: { default: 'Real estate & land', max: 80 },
  taglineHi: { default: '', max: 80 },
  heroTitle: { default: 'Land and property, ready to view.', max: 120 },
  heroTitleHi: { default: '', max: 120 },
  heroText: {
    default:
      'A short, curated list of plots, homes and commercial sites. Every listing has photos, video, a map and the facts that matter before you visit.',
    max: 400,
  },
  heroTextHi: { default: '', max: 400 },
  aboutTitle: { default: '', max: 120 },
  aboutTitleHi: { default: '', max: 120 },
  aboutText: { default: '', max: 2000 },
  aboutTextHi: { default: '', max: 2000 },
  contactTitle: { default: 'Looking for something specific?', max: 120 },
  contactTitleHi: { default: '', max: 120 },
  contactText: {
    default: 'Tell us the area, size and budget you have in mind, and we will send you matching listings.',
    max: 400,
  },
  contactTextHi: { default: '', max: 400 },
  phone: { default: '', max: 40 },
  whatsapp: { default: '', max: 40 },
  email: { default: '', max: 120 },
  address: { default: '', max: 200 },
  addressHi: { default: '', max: 200 },
  currency: { default: 'INR', max: 3 },
  instagram: { default: '', max: 200 },
  facebook: { default: '', max: 200 },
  footerNote: { default: 'Listings are for information only and are not an offer.', max: 200 },
  footerNoteHi: { default: '', max: 200 },
};

export function getSettings(db) {
  const stored = Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, parseJson(r.value, null)]),
  );
  const out = {};
  for (const [key, spec] of Object.entries(SETTINGS)) {
    out[key] = typeof stored[key] === 'string' ? stored[key] : spec.default;
  }
  return out;
}

export function saveSettings(db, input) {
  const changes = {};
  for (const [key, spec] of Object.entries(SETTINGS)) {
    if (!Object.hasOwn(input, key)) continue;
    const value = String(input[key] ?? '').trim();
    if (value.length > spec.max) throw new HttpError(400, `Keep this under ${spec.max} characters.`, key);
    changes[key] = value;
  }
  if ('currency' in changes) {
    changes.currency = changes.currency.toUpperCase();
    if (!CURRENCIES.has(changes.currency)) {
      throw new HttpError(400, 'Use a 3-letter currency code such as USD, EUR or AED.', 'currency');
    }
  }
  if ('siteName' in changes && !changes.siteName) {
    throw new HttpError(400, 'The site needs a name.', 'siteName');
  }
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(changes)) upsert.run(key, JSON.stringify(value));
  })();
  return getSettings(db);
}
