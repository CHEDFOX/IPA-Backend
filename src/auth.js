import crypto from 'node:crypto';
import { HttpError, randomToken, readCookie, sha256 } from './util.js';

export const SESSION_COOKIE = 'ipa_session';
const SESSION_DAYS = 30;

export function createAuth({ db, config }) {
  const insert = db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)');
  const find = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const expected = sha256(config.adminPassword);
  const hashToken = (token) => sha256(token).toString('hex');

  function passwordMatches(input) {
    return crypto.timingSafeEqual(sha256(String(input ?? '')), expected);
  }

  function cookieAttributes(req) {
    const secure = config.cookieSecure ?? req.secure;
    return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  function startSession(req, res) {
    purge.run(Date.now());
    const token = randomToken(32);
    insert.run(hashToken(token), Date.now() + SESSION_DAYS * 86_400_000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_DAYS * 86_400}; ${cookieAttributes(req)}`);
  }

  function endSession(req, res) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) remove.run(hashToken(token));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(req)}`);
  }

  function isSignedIn(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return false;
    const row = find.get(hashToken(token));
    return Boolean(row && row.expires_at > Date.now());
  }

  // Other sites cannot send a custom header without a CORS preflight we never grant,
  // so requiring one on writes blocks cross-site request forgery on top of SameSite.
  function requireAdminHeader(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-ipa-admin') !== '1') {
      return next(new HttpError(403, 'Missing admin request header.'));
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (!isSignedIn(req)) return next(new HttpError(401, 'Please sign in.'));
    requireAdminHeader(req, res, next);
  }

  return { passwordMatches, startSession, endSession, isSignedIn, requireAdmin, requireAdminHeader };
}
