import path from 'node:path';

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function trimSlash(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

// Express accepts a number of hops, a boolean, or a named range ("loopback").
function trustProxy(value) {
  if (value === undefined || value === '') return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

// The site may be visited with or without "www.", so allow both by default.
function withWww(url) {
  const other = new URL(url.origin);
  other.hostname = url.hostname.startsWith('www.') ? url.hostname.slice(4) : `www.${url.hostname}`;
  return url.hostname === 'localhost' || /^[\d.]+$/.test(url.hostname) ? [url.origin] : [url.origin, other.origin];
}

export function loadConfig(env = process.env) {
  const port = int(env.PORT, 4000);
  const siteUrl = trimSlash(env.SITE_URL) || 'http://localhost:3000';
  const corsOrigins = list(env.CORS_ORIGINS);
  return {
    port,
    host: env.HOST || '127.0.0.1',
    publicUrl: trimSlash(env.PUBLIC_URL) || `http://localhost:${port}`,
    siteUrl,
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    adminPassword: env.ADMIN_PASSWORD || '',
    corsOrigins: corsOrigins.length ? corsOrigins : withWww(new URL(siteUrl)),
    revalidateUrl: (env.WEB_REVALIDATE_URL || '').trim(),
    revalidateSecret: env.REVALIDATE_SECRET || '',
    maxUploadMb: int(env.MAX_UPLOAD_MB, 1024),
    keepOriginals: env.KEEP_ORIGINALS !== 'false',
    trustProxy: trustProxy(env.TRUST_PROXY),
    // null = decide per request (secure when the request came in over HTTPS)
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : null,
    smtpUrl: env.SMTP_URL || '',
    notifyEmail: env.NOTIFY_EMAIL || '',
    mailFrom: env.MAIL_FROM || '',
  };
}

export function assertConfig(config) {
  if (config.adminPassword.length < 10) {
    throw new Error('ADMIN_PASSWORD must be set and at least 10 characters long (see .env.example).');
  }
}
