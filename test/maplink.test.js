import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoordinates, resolveMapLink } from '../src/maplink.js';

test('reads coordinates from the usual formats', () => {
  const pin = { lat: 28.6129, lng: 77.2295 };
  assert.deepEqual(
    parseCoordinates('https://www.google.com/maps/place/X/@28.61,77.20,17z/data=!3m1!4b1!8m2!3d28.6129!4d77.2295'),
    pin,
    'prefers the dropped pin over the map centre',
  );
  assert.deepEqual(parseCoordinates('https://maps.google.com/?q=28.6129,77.2295'), pin);
  assert.deepEqual(parseCoordinates('28.6129, 77.2295'), pin);
  assert.deepEqual(parseCoordinates('28°36\'46.4"N 77°13\'46.2"E'), { lat: 28.612889, lng: 77.2295 });
  assert.equal(parseCoordinates('near the river'), null);
  assert.equal(parseCoordinates('128.1, 77.2'), null, 'rejects impossible latitudes');
});

test('follows a short link through Google redirects', async () => {
  const hops = {
    'https://maps.app.goo.gl/abc': 'https://www.google.com/maps?q=Some+Place&ftid=0x1',
    'https://www.google.com/maps?q=Some+Place&ftid=0x1':
      'https://www.google.com/maps/place/Some+Place/@12.97,77.59,17z/data=!4m6!3m5!8m2!3d12.9716!4d77.5946',
  };
  const fetchImpl = async (url) => ({
    status: 302,
    ok: false,
    headers: new Headers({ location: hops[url] }),
  });
  assert.deepEqual(await resolveMapLink('https://maps.app.goo.gl/abc', { fetchImpl }), { lat: 12.9716, lng: 77.5946 });
});

test('never fetches non-Google hosts, even via a redirect', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { status: 302, ok: false, headers: new Headers({ location: 'http://169.254.169.254/latest' }) };
  };
  assert.equal(await resolveMapLink('https://maps.app.goo.gl/x', { fetchImpl }), null);
  assert.deepEqual(seen, ['https://maps.app.goo.gl/x']);
  assert.equal(await resolveMapLink('https://example.com/maps', { fetchImpl }), null);
  assert.equal(seen.length, 1);
});
