import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createMediaStore, detectFfmpeg } from '../src/media.js';

const PASSWORD = 'correct horse battery';
let server;
let base;
let dataDir;
let cookie = '';
const ffmpeg = await detectFfmpeg();

async function call(method, url, { body, form, admin = true, headers = {} } = {}) {
  const h = { ...headers };
  if (admin) {
    h['x-ipa-admin'] = '1';
    if (cookie) h.cookie = cookie;
  }
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

async function jpeg(width, height, color = '#4a7a50') {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

function filesForm(files) {
  const form = new FormData();
  for (const { name, data, type } of files) form.append('files', new Blob([data], { type }), name);
  return form;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-test-'));
  const config = loadConfig({ ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir, PUBLIC_URL: 'http://media.test' });
  const db = openDb(config.dataDir);
  const media = createMediaStore({ dataDir, ffmpeg });
  const notifier = { revalidate() {}, enquiry() {} };
  server = createApp({ config, db, media, notifier }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('auth', () => {
  test('admin routes need a session', async () => {
    const res = await call('GET', '/api/admin/properties');
    assert.equal(res.status, 401);
  });

  test('wrong password is rejected', async () => {
    const res = await call('POST', '/api/admin/login', { body: { password: 'nope' } });
    assert.equal(res.status, 401);
  });

  test('login needs the admin header', async () => {
    const res = await call('POST', '/api/admin/login', { body: { password: PASSWORD }, admin: false });
    assert.equal(res.status, 403);
  });

  test('correct password starts a session', async () => {
    const res = await call('POST', '/api/admin/login', { body: { password: PASSWORD } });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /ipa_session=.+HttpOnly/);
    cookie = setCookie.split(';')[0];
    const me = await call('GET', '/api/admin/me');
    assert.equal(me.status, 200);
  });

  test('writes without the admin header are refused even when signed in', async () => {
    const res = await call('POST', '/api/admin/properties', {
      body: { title: 'X' },
      admin: false,
      headers: { cookie },
    });
    assert.equal(res.status, 403);
  });
});

describe('properties and media', () => {
  let property;

  test('creates a draft with a slug and private link', async () => {
    const res = await call('POST', '/api/admin/properties', {
      body: { title: 'Riverside Plot 12', type: 'land', area: '2.4', areaUnit: 'ha', price: '185,000' },
    });
    assert.equal(res.status, 201);
    property = res.data;
    assert.equal(property.slug, 'riverside-plot-12');
    assert.equal(property.visibility, 'draft');
    assert.equal(property.area, 2.4);
    assert.equal(property.price, 185000);
    assert.ok(property.shareToken.length >= 10);
  });

  test('validates input', async () => {
    const res = await call('PUT', `/api/admin/properties/${property.id}`, { body: { latitude: 120 } });
    assert.equal(res.status, 400);
    assert.equal(res.data.field, 'latitude');
  });

  test('drafts are hidden from the public API but open by private link', async () => {
    const list = await call('GET', '/api/properties', { admin: false });
    assert.equal(list.data.items.length, 0);
    const bySlug = await call('GET', `/api/properties/${property.slug}`, { admin: false });
    assert.equal(bySlug.status, 404);
    const byToken = await call('GET', `/api/share/${property.shareToken}`, { admin: false });
    assert.equal(byToken.status, 200);
    assert.equal(byToken.data.title, 'Riverside Plot 12');
  });

  test('uploads photos and makes web sizes', async () => {
    const form = filesForm([
      { name: 'one.jpg', data: await jpeg(3000, 2000), type: 'image/jpeg' },
      { name: 'two.jpg', data: await jpeg(800, 1200, '#336699'), type: 'image/jpeg' },
      { name: 'notes.txt', data: Buffer.from('hello'), type: 'text/plain' },
    ]);
    const res = await call('POST', `/api/admin/properties/${property.id}/media?role=gallery`, { form });
    assert.equal(res.status, 201);
    assert.equal(res.data.created.length, 2);
    assert.equal(res.data.errors.length, 1);
    const [first, second] = res.data.created;
    assert.deepEqual(
      first.sizes.map((s) => s.width),
      [640, 1280, 2048],
    );
    assert.equal(second.sizes.at(-1).width, 800, 'never upscales');
    assert.match(first.og, /^http:\/\/media\.test\/media\/.+-og\.jpg$/);

    const file = new URL(first.sizes[0].url).pathname;
    const served = await fetch(base + file);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/webp');
    assert.match(served.headers.get('cache-control'), /immutable/);
  });

  test('reorders the gallery and the first photo becomes the cover', async () => {
    const current = (await call('GET', `/api/admin/properties/${property.id}`)).data;
    const ids = current.gallery.map((m) => m.id).reverse();
    const res = await call('PUT', `/api/admin/properties/${property.id}/media/order`, { body: { ids } });
    assert.equal(res.data.gallery[0].id, ids[0]);
    assert.equal(res.data.cover.sizes[0].url, res.data.gallery[0].sizes[0].url);
  });

  test('accepts a PDF brochure and rejects fakes', async () => {
    const fake = filesForm([{ name: 'b.pdf', data: Buffer.from('not a pdf'), type: 'application/pdf' }]);
    const bad = await call('POST', `/api/admin/properties/${property.id}/media?role=brochure`, { form: fake });
    assert.equal(bad.status, 400);
    const real = filesForm([{ name: 'b.pdf', data: Buffer.from('%PDF-1.4\n%%EOF'), type: 'application/pdf' }]);
    const ok = await call('POST', `/api/admin/properties/${property.id}/media?role=brochure`, { form: real });
    assert.equal(ok.status, 201);
    assert.match(ok.data.property.brochure.url, /\.pdf$/);
  });

  test('uploads a video with a poster frame', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
    const clip = path.join(dataDir, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', clip]);
    const form = filesForm([{ name: 'clip.mp4', data: fs.readFileSync(clip), type: 'video/mp4' }]);
    const res = await call('POST', `/api/admin/properties/${property.id}/media?role=gallery`, { form });
    assert.equal(res.status, 201);
    const video = res.data.created[0];
    assert.equal(video.kind, 'video');
    assert.equal(video.width, 320);
    assert.ok(video.duration > 1.5);
    assert.ok(video.poster.sizes.length > 0);
    const range = await fetch(base + new URL(video.url).pathname, { headers: { range: 'bytes=0-99' } });
    assert.equal(range.status, 206);
  });

  test('publishing shows the property in the public list', async () => {
    await call('PUT', `/api/admin/properties/${property.id}`, {
      body: {
        visibility: 'public',
        featured: true,
        location: 'North Valley',
        details: [
          { label: 'Zoning', value: 'Agricultural', key: true },
          { label: '', value: '' },
        ],
      },
    });
    const list = await call('GET', '/api/properties?type=land&featured=1', { admin: false });
    assert.equal(list.data.items.length, 1);
    assert.equal(list.data.items[0].photoCount, 2);
    const detail = await call('GET', `/api/properties/${property.slug}`, { admin: false });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.details, [{ label: 'Zoning', value: 'Agricultural', key: true }]);
    assert.equal(detail.data.shareToken, undefined, 'private token stays private');
    const site = await call('GET', '/api/site', { admin: false });
    assert.deepEqual(site.data.locations, ['North Valley']);
    assert.equal(site.data.counts.land, 1);
  });

  test('a new private link replaces the old one', async () => {
    const res = await call('POST', `/api/admin/properties/${property.id}/private-link`);
    assert.notEqual(res.data.shareToken, property.shareToken);
    const old = await call('GET', `/api/share/${property.shareToken}`, { admin: false });
    assert.equal(old.status, 404);
  });

  test('QR code downloads as PNG', async () => {
    const res = await call('GET', `/api/admin/properties/${property.id}/qr.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });

  test('deleting a property removes its files', async () => {
    const detail = (await call('GET', `/api/admin/properties/${property.id}`)).data;
    const fileUrl = detail.gallery[0].sizes[0].url;
    const res = await call('DELETE', `/api/admin/properties/${property.id}`);
    assert.equal(res.status, 200);
    const served = await fetch(base + new URL(fileUrl).pathname);
    assert.equal(served.status, 404);
  });
});

describe('enquiries and settings', () => {
  test('stores an enquiry and lists it for the admin', async () => {
    const res = await call('POST', '/api/enquiries', {
      admin: false,
      body: { name: 'Sam', contact: '+1 555 0100', message: 'Can I visit?' },
    });
    assert.equal(res.status, 201);
    const list = await call('GET', '/api/admin/enquiries');
    assert.equal(list.data.items[0].name, 'Sam');
    assert.equal(list.data.items[0].read, false);
  });

  test('drops honeypot submissions silently', async () => {
    await call('POST', '/api/enquiries', {
      admin: false,
      body: { name: 'Bot', contact: 'bot@example.com', website: 'http://spam' },
    });
    const list = await call('GET', '/api/admin/enquiries');
    assert.ok(!list.data.items.some((e) => e.name === 'Bot'));
  });

  test('rejects an enquiry without contact details', async () => {
    const res = await call('POST', '/api/enquiries', { admin: false, body: { name: 'Sam', contact: '' } });
    assert.equal(res.status, 400);
  });

  test('saves settings and validates currency', async () => {
    const bad = await call('PUT', '/api/admin/settings', { body: { currency: 'XXQ' } });
    assert.equal(bad.status, 400);
    const ok = await call('PUT', '/api/admin/settings', { body: { siteName: 'IPA Land', currency: 'aed' } });
    assert.equal(ok.data.settings.currency, 'AED');
    const site = await call('GET', '/api/site', { admin: false });
    assert.equal(site.data.settings.siteName, 'IPA Land');
  });

  test('hero image upload replaces the previous one', async () => {
    const upload = async () => {
      const form = new FormData();
      form.append('file', new Blob([await jpeg(1600, 900)], { type: 'image/jpeg' }), 'hero.jpg');
      return call('POST', '/api/admin/site-media?role=hero', { form });
    };
    const first = await upload();
    const second = await upload();
    assert.equal(second.status, 201);
    assert.notEqual(first.data.hero.og, second.data.hero.og);
    const site = await call('GET', '/api/site', { admin: false });
    assert.equal(site.data.hero.og, second.data.hero.og);
  });
});
