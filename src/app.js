import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { createAuth } from './auth.js';
import { createPropertyRepo } from './properties.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';
import { createSerializer } from './serialize.js';
import { HttpError } from './util.js';

const ADMIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin');

const ADMIN_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function createApp({ config, db, media, notifier }) {
  const app = express();
  const repo = createPropertyRepo(db);
  const serializer = createSerializer(config.publicUrl);
  const auth = createAuth({ db, config });
  const deps = { db, repo, serializer, media, auth, config, notifier };

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Uploaded files get random, never-reused names, so they can be cached for a year.
  app.use(
    '/media',
    (req, res, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    },
    express.static(media.mediaDir, { immutable: true, maxAge: '365d', index: false, dotfiles: 'deny', fallthrough: false }),
  );

  app.use(
    '/admin',
    (req, res, next) => {
      res.setHeader('Content-Security-Policy', ADMIN_CSP);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cache-Control', 'no-cache');
      next();
    },
    express.static(ADMIN_DIR, { index: 'index.html' }),
  );
  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api/admin', adminRouter(deps));
  app.use('/api', publicRouter(deps));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `Files must be under ${config.maxUploadMb} MB.` : err.message,
      });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, field: err.field });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    if (err.status === 404 || err.statusCode === 404) return res.status(404).json({ error: 'Not found.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}
