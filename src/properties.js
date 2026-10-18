import { HttpError, randomToken, slugify } from './util.js';

export const TYPES = ['land', 'residential', 'commercial'];
export const STATUSES = ['available', 'under_offer', 'sold'];
export const VISIBILITIES = ['public', 'unlisted', 'draft'];
// sqyd = square yards (gaj); bigha differs by state, so it is never converted.
export const AREA_UNITS = ['m2', 'ha', 'acre', 'sqft', 'sqyd', 'bigha'];

const text = (max, { required = false } = {}) => (value, field) => {
  const s = String(value ?? '').trim();
  if (required && !s) throw new HttpError(400, 'This field is required.', field);
  if (s.length > max) throw new HttpError(400, `Keep this under ${max} characters.`, field);
  return s;
};

const oneOf = (options) => (value, field) => {
  if (!options.includes(value)) throw new HttpError(400, `Choose one of: ${options.join(', ')}.`, field);
  return value;
};

const number = ({ min = -Infinity, max = Infinity, integer = false, exclusiveMin = false } = {}) => (value, field) => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
  const tooLow = exclusiveMin ? n <= min : n < min;
  if (!Number.isFinite(n) || tooLow || n > max || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, 'Enter a valid number.', field);
  }
  return n;
};

const bool = (value) => (value === true || value === 1 || value === 'true' ? 1 : 0);

const rows = (shape, maxRows) => (value, field) => {
  if (!Array.isArray(value)) throw new HttpError(400, 'Expected a list.', field);
  const out = [];
  for (const item of value) {
    const row = {};
    let empty = true;
    for (const [key, spec] of Object.entries(shape)) {
      if (spec === 'bool') {
        row[key] = Boolean(item?.[key]);
        continue;
      }
      const s = String(item?.[key] ?? '').trim();
      if (s.length > spec) throw new HttpError(400, `Keep each entry under ${spec} characters.`, field);
      if (s) empty = false;
      row[key] = s;
    }
    if (!empty) out.push(row);
  }
  if (out.length > maxRows) throw new HttpError(400, `Up to ${maxRows} rows.`, field);
  return JSON.stringify(out);
};

// API field name -> column and parser. Updates may send any subset.
const FIELDS = {
  title: ['title', text(160, { required: true })],
  titleHi: ['title_hi', text(160)],
  type: ['type', oneOf(TYPES)],
  status: ['status', oneOf(STATUSES)],
  visibility: ['visibility', oneOf(VISIBILITIES)],
  featured: ['featured', bool],
  sortOrder: ['sort_order', (v, f) => number({ min: -1e6, max: 1e6, integer: true })(v, f) ?? 0],
  price: ['price', number({ min: 0 })],
  priceNote: ['price_note', text(60)],
  location: ['location', text(80)],
  locationHi: ['location_hi', text(80)],
  address: ['address', text(200)],
  addressHi: ['address_hi', text(200)],
  latitude: ['latitude', number({ min: -90, max: 90 })],
  longitude: ['longitude', number({ min: -180, max: 180 })],
  area: ['area', number({ min: 0, exclusiveMin: true })],
  areaUnit: ['area_unit', oneOf(AREA_UNITS)],
  bedrooms: ['bedrooms', number({ min: 0, max: 999, integer: true })],
  bathrooms: ['bathrooms', number({ min: 0, max: 999, integer: true })],
  summary: ['summary', text(200)],
  summaryHi: ['summary_hi', text(200)],
  description: ['description', text(20000)],
  descriptionHi: ['description_hi', text(20000)],
  details: ['details', rows({ label: 60, value: 200, labelHi: 60, valueHi: 200, key: 'bool' }, 40)],
  nearby: ['nearby', rows({ place: 80, placeHi: 80, distance: 40 }, 20)],
};

export function normalizeProperty(body) {
  const out = {};
  for (const [name, [column, parse]] of Object.entries(FIELDS)) {
    if (Object.hasOwn(body, name)) out[column] = parse(body[name], name);
  }
  return out;
}

const PUBLIC_ORDER = "ORDER BY (status = 'sold'), sort_order, id DESC";

export function createPropertyRepo(db) {
  const byId = db.prepare('SELECT * FROM properties WHERE id = ?');
  const bySlug = db.prepare('SELECT * FROM properties WHERE slug = ?');
  const byToken = db.prepare('SELECT * FROM properties WHERE share_token = ?');
  const mediaOf = db.prepare('SELECT * FROM media WHERE property_id = ? ORDER BY role, sort_order, id');

  function uniqueSlug(base, exceptId = 0) {
    let slug = base;
    for (let i = 2; ; i++) {
      const hit = bySlug.get(slug);
      if (!hit || hit.id === exceptId) return slug;
      slug = `${base.slice(0, 74)}-${i}`;
    }
  }

  function galleryFor(ids) {
    const map = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return map;
    const rows = db
      .prepare(
        `SELECT * FROM media WHERE role = 'gallery' AND property_id IN (${ids.map(() => '?').join(',')})
         ORDER BY sort_order, id`,
      )
      .all(...ids);
    for (const row of rows) map.get(row.property_id).push(row);
    return map;
  }

  return {
    get: (id) => byId.get(id),
    getBySlug: (slug) => bySlug.get(slug),
    getByToken: (token) => byToken.get(token),
    mediaOf: (id) => mediaOf.all(id),
    galleryFor,

    listPublic({ type, status, location, featured, limit } = {}) {
      const where = ["visibility = 'public'"];
      const params = [];
      const filter = (sql, value) => {
        where.push(sql);
        params.push(value);
      };
      if (TYPES.includes(type)) filter('type = ?', type);
      if (STATUSES.includes(status)) filter('status = ?', status);
      if (location) filter('location = ?', String(location));
      if (featured) where.push('featured = 1');
      const max = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 500);
      return db
        .prepare(`SELECT * FROM properties WHERE ${where.join(' AND ')} ${PUBLIC_ORDER} LIMIT ${max}`)
        .all(...params);
    },

    listAll() {
      return db.prepare('SELECT * FROM properties ORDER BY sort_order, id DESC').all();
    },

    create(body) {
      const fields = normalizeProperty({ visibility: 'draft', ...body });
      if (!fields.title) throw new HttpError(400, 'Give the property a title.', 'title');
      fields.slug = uniqueSlug(slugify(body.slug || fields.title));
      fields.share_token = randomToken(9);
      const cols = Object.keys(fields);
      const info = db
        .prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`)
        .run(fields);
      return byId.get(info.lastInsertRowid);
    },

    update(id, body) {
      const current = byId.get(id);
      if (!current) return null;
      const fields = normalizeProperty(body);
      if (Object.hasOwn(body, 'slug')) fields.slug = uniqueSlug(slugify(body.slug || current.title), id);
      if (Object.keys(fields).length) {
        const sets = Object.keys(fields).map((c) => `${c} = @${c}`);
        db.prepare(
          `UPDATE properties SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`,
        ).run({ ...fields, id });
      }
      return byId.get(id);
    },

    newShareToken(id) {
      db.prepare('UPDATE properties SET share_token = ? WHERE id = ?').run(randomToken(9), id);
      return byId.get(id);
    },

    touch(id) {
      db.prepare("UPDATE properties SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
    },

    remove(id) {
      const media = mediaOf.all(id);
      db.prepare('DELETE FROM properties WHERE id = ?').run(id);
      return media;
    },
  };
}
