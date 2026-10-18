import express from 'express';
import { getSettings } from '../settings.js';
import { HttpError, rateLimit } from '../util.js';

function cors(origins) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

const shortCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=30');
  next();
};

export function publicRouter({ db, repo, serializer, config, notifier }) {
  const router = express.Router();
  router.use(cors(config.corsOrigins));

  const siteMedia = db.prepare('SELECT * FROM media WHERE property_id IS NULL AND role = ? ORDER BY id DESC LIMIT 1');
  const locations = db.prepare(
    "SELECT DISTINCT location FROM properties WHERE visibility = 'public' AND location <> '' ORDER BY location",
  );
  const typeCounts = db.prepare("SELECT type, COUNT(*) AS n FROM properties WHERE visibility = 'public' GROUP BY type");
  const insertEnquiry = db.prepare(
    `INSERT INTO enquiries (property_id, property_title, name, contact, message, page_url)
     VALUES (@property_id, @property_title, @name, @contact, @message, @page_url)`,
  );

  function fullProperty(row) {
    return serializer.property(row, repo.mediaOf(row.id));
  }

  router.get('/health', (req, res) => res.json({ ok: true }));

  router.get('/site', shortCache, (req, res) => {
    const hero = siteMedia.get('hero');
    const portrait = siteMedia.get('portrait');
    const counts = { land: 0, residential: 0, commercial: 0, total: 0 };
    for (const { type, n } of typeCounts.all()) {
      counts[type] = n;
      counts.total += n;
    }
    res.json({
      settings: getSettings(db),
      hero: hero ? serializer.media(hero) : null,
      portrait: portrait ? serializer.media(portrait) : null,
      locations: locations.all().map((r) => r.location),
      counts,
    });
  });

  router.get('/properties', shortCache, (req, res) => {
    const rows = repo.listPublic({
      type: req.query.type,
      status: req.query.status,
      location: req.query.location,
      featured: req.query.featured === '1' || req.query.featured === 'true',
      limit: req.query.limit,
    });
    const galleries = repo.galleryFor(rows.map((r) => r.id));
    res.json({ items: rows.map((r) => serializer.card(r, galleries.get(r.id))) });
  });

  router.get('/properties/:slug', shortCache, (req, res, next) => {
    const row = repo.getBySlug(req.params.slug);
    if (!row || row.visibility !== 'public') return next(new HttpError(404, 'Property not found.'));
    res.json(fullProperty(row));
  });

  // Private links work for any listing, including unlisted and draft ones.
  router.get('/share/:token', (req, res, next) => {
    const row = repo.getByToken(req.params.token);
    if (!row) return next(new HttpError(404, 'Property not found.'));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.json(fullProperty(row));
  });

  router.post(
    '/enquiries',
    rateLimit({ windowMs: 10 * 60_000, max: 8, message: 'Too many messages. Please try again in a few minutes.' }),
    (req, res, next) => {
      const body = req.body || {};
      // Bots fill every field, including this hidden one; pretend success and drop it.
      if (body.website) return res.status(201).json({ ok: true });

      const name = String(body.name ?? '').trim();
      const contact = String(body.contact ?? '').trim();
      const message = String(body.message ?? '').trim();
      if (!name || name.length > 100) return next(new HttpError(400, 'Please enter your name.', 'name'));
      if (contact.length < 5 || contact.length > 150) {
        return next(new HttpError(400, 'Please enter a phone number or email address.', 'contact'));
      }
      if (message.length > 3000) return next(new HttpError(400, 'Please keep the message shorter.', 'message'));

      const property = Number.isInteger(body.propertyId) ? repo.get(body.propertyId) : null;
      const enquiry = {
        property_id: property?.id ?? null,
        property_title: property?.title ?? '',
        name,
        contact,
        message,
        page_url: String(body.pageUrl ?? '').slice(0, 500),
      };
      insertEnquiry.run(enquiry);
      notifier.enquiry(enquiry);
      res.status(201).json({ ok: true });
    },
  );

  return router;
}
