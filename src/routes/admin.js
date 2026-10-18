import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { resolveMapLink } from '../maplink.js';
import { getSettings, saveSettings } from '../settings.js';
import { HttpError, rateLimit } from '../util.js';

const PROPERTY_ROLES = ['gallery', 'plan', 'brochure'];
const SITE_ROLES = ['hero', 'portrait'];

export function adminRouter({ db, repo, serializer, media, auth, config, notifier }) {
  const router = express.Router();
  const upload = multer({
    dest: media.tmpDir,
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 40 },
  });

  const insertMedia = db.prepare(
    `INSERT INTO media (property_id, role, kind, key, original_name, mime, bytes, width, height, duration, file, original, variants, sort_order)
     VALUES (@property_id, @role, @kind, @key, @original_name, @mime, @bytes, @width, @height, @duration, @file, @original, @variants, @sort_order)`,
  );
  const mediaById = db.prepare('SELECT * FROM media WHERE id = ?');
  const nextSort = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM media WHERE property_id IS ? AND role = ?',
  );
  const mediaInRole = db.prepare('SELECT * FROM media WHERE property_id IS ? AND role = ?');
  const deleteMedia = db.prepare('DELETE FROM media WHERE id = ?');

  function loadProperty(req, res, next) {
    const row = repo.get(Number(req.params.id));
    if (!row) return next(new HttpError(404, 'Property not found.'));
    req.property = row;
    next();
  }

  const full = (row) => serializer.adminProperty(row, repo.mediaOf(row.id));
  const changed = () => notifier.revalidate();

  // Process uploads one at a time (keeps memory flat on a small VPS) and report per-file errors.
  async function storeUploads(files, { propertyId, role, single }) {
    const created = [];
    const errors = [];
    for (const file of files) {
      try {
        const result = await media.processUpload(file, role);
        if (single) {
          for (const old of mediaInRole.all(propertyId, role)) {
            deleteMedia.run(old.id);
            await media.removeFiles(old);
          }
        }
        const info = insertMedia.run({
          property_id: propertyId,
          role,
          kind: result.kind,
          key: result.key,
          original_name: (file.originalname || '').slice(0, 200),
          mime: result.mime,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
          duration: result.duration,
          file: result.file,
          original: result.original,
          variants: JSON.stringify(result.variants),
          sort_order: nextSort.get(propertyId, role).n,
        });
        created.push(serializer.media(mediaById.get(info.lastInsertRowid)));
      } catch (err) {
        errors.push({ name: file.originalname, error: err instanceof HttpError ? err.message : 'Upload failed.' });
        if (!(err instanceof HttpError)) console.error(err);
      }
    }
    return { created, errors };
  }

  router.post(
    '/login',
    rateLimit({ windowMs: 15 * 60_000, max: 10, message: 'Too many attempts. Try again in 15 minutes.' }),
    auth.requireAdminHeader,
    (req, res, next) => {
      if (!auth.passwordMatches(req.body?.password)) return next(new HttpError(401, 'Wrong password.'));
      auth.startSession(req, res);
      res.json({ ok: true });
    },
  );

  router.post('/logout', auth.requireAdminHeader, (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  router.use(auth.requireAdmin);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/me', (req, res) => {
    const unread = db.prepare('SELECT COUNT(*) AS n FROM enquiries WHERE is_read = 0').get().n;
    res.json({
      siteUrl: config.siteUrl,
      maxUploadMb: config.maxUploadMb,
      videoProcessing: media.ffmpeg,
      unreadEnquiries: unread,
      siteName: getSettings(db).siteName,
    });
  });

  // Properties

  router.get('/properties', (req, res) => {
    const rows = repo.listAll();
    const galleries = repo.galleryFor(rows.map((r) => r.id));
    res.json({
      items: rows.map((r) => ({ ...serializer.card(r, galleries.get(r.id)), shareToken: r.share_token })),
    });
  });

  router.post('/properties', (req, res) => {
    const row = repo.create(req.body || {});
    changed();
    res.status(201).json(full(row));
  });

  router.get('/properties/:id', loadProperty, (req, res) => res.json(full(req.property)));

  router.put('/properties/:id', loadProperty, (req, res) => {
    const row = repo.update(req.property.id, req.body || {});
    changed();
    res.json(full(row));
  });

  router.post('/properties/:id/private-link', loadProperty, (req, res) => {
    const row = repo.newShareToken(req.property.id);
    changed();
    res.json(full(row));
  });

  router.delete('/properties/:id', loadProperty, async (req, res) => {
    const removed = repo.remove(req.property.id);
    await Promise.all(removed.map((m) => media.removeFiles(m)));
    changed();
    res.json({ ok: true });
  });

  router.get('/properties/:id/qr.png', loadProperty, async (req, res) => {
    const p = req.property;
    const url = req.query.private === '1' ? `${config.siteUrl}/p/${p.share_token}` : `${config.siteUrl}/properties/${p.slug}`;
    const png = await QRCode.toBuffer(url, {
      width: 1200,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#141814', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${p.slug}-qr.png"`);
    res.send(png);
  });

  // Turns a pasted location (Google Maps link, short share link, "lat, lng" or degrees) into coordinates.
  router.post('/resolve-location', async (req, res, next) => {
    const input = String(req.body?.input ?? '').trim().slice(0, 2000);
    if (!input) return next(new HttpError(400, 'Paste a Google Maps link or coordinates.'));
    let found = null;
    try {
      found = await resolveMapLink(input);
    } catch {
      return next(new HttpError(502, 'Google Maps did not answer. Try again, or paste the coordinates instead.'));
    }
    if (!found) {
      return next(
        new HttpError(
          422,
          'No coordinates found in that. In Google Maps, press and hold the exact spot, then copy the numbers shown (like 28.6129, 77.2295) and paste them here.',
        ),
      );
    }
    res.json(found);
  });

  // Property media

  router.post('/properties/:id/media', loadProperty, upload.array('files', 40), async (req, res, next) => {
    const role = req.query.role || 'gallery';
    if (!PROPERTY_ROLES.includes(role)) return next(new HttpError(400, 'Unknown media role.'));
    const files = req.files || [];
    if (!files.length) return next(new HttpError(400, 'Choose at least one file.'));
    const result = await storeUploads(role === 'gallery' ? files : files.slice(0, 1), {
      propertyId: req.property.id,
      role,
      single: role !== 'gallery',
    });
    if (result.created.length) {
      repo.touch(req.property.id);
      changed();
    }
    res.status(result.created.length ? 201 : 400).json({ ...result, property: full(repo.get(req.property.id)) });
  });

  router.put('/properties/:id/media/order', loadProperty, (req, res, next) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
    if (!ids) return next(new HttpError(400, 'Expected a list of media ids.'));
    const setOrder = db.prepare("UPDATE media SET sort_order = ? WHERE id = ? AND property_id = ? AND role = 'gallery'");
    db.transaction(() => ids.forEach((id, i) => setOrder.run(i, id, req.property.id)))();
    repo.touch(req.property.id);
    changed();
    res.json(full(repo.get(req.property.id)));
  });

  router.patch('/media/:id', (req, res, next) => {
    const row = mediaById.get(Number(req.params.id));
    if (!row) return next(new HttpError(404, 'Media not found.'));
    const alt = String(req.body?.alt ?? '').trim();
    if (alt.length > 200) return next(new HttpError(400, 'Keep the description under 200 characters.', 'alt'));
    db.prepare('UPDATE media SET alt = ? WHERE id = ?').run(alt, row.id);
    if (row.property_id) repo.touch(row.property_id);
    changed();
    res.json(serializer.media(mediaById.get(row.id)));
  });

  router.delete('/media/:id', async (req, res, next) => {
    const row = mediaById.get(Number(req.params.id));
    if (!row) return next(new HttpError(404, 'Media not found.'));
    deleteMedia.run(row.id);
    await media.removeFiles(row);
    if (row.property_id) repo.touch(row.property_id);
    changed();
    res.json({ ok: true });
  });

  // Site settings and site-wide images

  function siteImages() {
    const pick = (role) => {
      const row = mediaInRole.all(null, role).at(-1);
      return row ? serializer.media(row) : null;
    };
    return { hero: pick('hero'), portrait: pick('portrait') };
  }

  router.get('/settings', (req, res) => res.json({ settings: getSettings(db), ...siteImages() }));

  router.put('/settings', (req, res) => {
    const settings = saveSettings(db, req.body || {});
    changed();
    res.json({ settings, ...siteImages() });
  });

  router.post('/site-media', upload.single('file'), async (req, res, next) => {
    const role = req.query.role;
    if (!SITE_ROLES.includes(role)) return next(new HttpError(400, 'Unknown image slot.'));
    if (!req.file) return next(new HttpError(400, 'Choose an image.'));
    const result = await storeUploads([req.file], { propertyId: null, role, single: true });
    if (result.created.length) changed();
    res.status(result.created.length ? 201 : 400).json({ ...result, ...siteImages() });
  });

  router.delete('/site-media/:role', async (req, res, next) => {
    if (!SITE_ROLES.includes(req.params.role)) return next(new HttpError(400, 'Unknown image slot.'));
    for (const row of mediaInRole.all(null, req.params.role)) {
      deleteMedia.run(row.id);
      await media.removeFiles(row);
    }
    changed();
    res.json(siteImages());
  });

  // Enquiries

  router.get('/enquiries', (req, res) => {
    const rows = db
      .prepare(
        `SELECT e.*, p.slug AS property_slug FROM enquiries e
         LEFT JOIN properties p ON p.id = e.property_id
         ORDER BY e.id DESC LIMIT 500`,
      )
      .all();
    res.json({
      items: rows.map((e) => ({
        id: e.id,
        propertyId: e.property_id,
        propertyTitle: e.property_title,
        propertySlug: e.property_slug,
        name: e.name,
        contact: e.contact,
        message: e.message,
        pageUrl: e.page_url,
        read: Boolean(e.is_read),
        createdAt: e.created_at,
      })),
    });
  });

  router.patch('/enquiries/:id', (req, res) => {
    db.prepare('UPDATE enquiries SET is_read = ? WHERE id = ?').run(req.body?.read === false ? 0 : 1, Number(req.params.id));
    res.json({ ok: true });
  });

  router.delete('/enquiries/:id', (req, res) => {
    db.prepare('DELETE FROM enquiries WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  return router;
}
